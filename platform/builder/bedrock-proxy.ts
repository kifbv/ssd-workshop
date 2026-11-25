/**
 * The coding agent's only way to Claude (ticket 2.8, try 2): a small HTTP proxy on 127.0.0.1 that the runner starts
 * before the agent and closes after it. The agent's Claude Code calls it as its Bedrock endpoint
 * (`ANTHROPIC_BEDROCK_BASE_URL`, with `CLAUDE_CODE_SKIP_BEDROCK_AUTH=1`), so the agent's process holds no AWS
 * credential at all (decision "Spec delta, CHANGED ... Builder": the AI that writes code has no AWS rights).
 *
 * It forwards only `POST /<prefix>/model/<url-encoded build model id>/invoke` and `.../invoke-with-response-stream` (no
 * query) to the Bedrock runtime in eu-central-1 (without the prefix), signed (SigV4, service `bedrock`) with the
 * runner's own credentials (the task role, or the caller's for the eval), and streams the answer back. Anything else
 * (another model, path or method, a body over MAX_BODY_BYTES) gets 403 (or 413) and never leaves the machine.
 *
 * Try 3, mainly for the eval on a developer machine, where any browser page could POST to 127.0.0.1: the proxy also
 * refuses (403) a request whose `Host` is not exactly `127.0.0.1:<port>` (DNS rebinding), one with an `Origin` header
 * (browsers send it on cross-origin POSTs), a `content-type` other than exactly `application/json` (a page can send
 * `text/plain` without a preflight), an `accept` other than `application/json` or `application/vnd.amazon.eventstream`
 * (absent is fine: Bedrock's default), and a path without the run's 128-bit random prefix (`<prefix>`, only in the
 * agent's `ANTHROPIC_BEDROCK_BASE_URL`, never logged). At most MAX_IN_FLIGHT requests are forwarded at once (429
 * above). Upstream it sends `content-type: application/json` (a constant) and the accepted `accept`; the agent's other
 * headers (an `authorization` included) are dropped. A Bedrock answer other than 2xx keeps its status, but its body and
 * headers are replaced by a fixed JSON message, so no ARN or account id reaches the agent.
 *
 * Logs (optional): the method, the path's shape (`/model/<build>/invoke`, `/model/<other>/...`, or a known first segment
 * only), the outcome and the status; never a header, body, credential or the prefix.
 */
import { createHash, createHmac, randomBytes, type Hash, type Hmac } from "node:crypto";
import { createServer, request as httpRequest, type Agent as HttpAgent, type IncomingMessage, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import type { AddressInfo } from "node:net";
import { SignatureV4 } from "@smithy/signature-v4";
import { REGION } from "../api/settings.js";

/** The runner's AWS credentials, as the AWS SDK's credential providers give them. */
export interface ProxyCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export type CredentialSource = () => Promise<ProxyCredentials>;

export interface BedrockProxyLogEntry {
  event: "bedrock-proxy";
  method: string;
  /** The path's shape: never a value the agent chose beyond a fixed segment name. */
  shape: string;
  outcome: "forwarded" | "refused" | "busy" | "upstream-error";
  status: number;
}

export interface BedrockProxyOptions {
  /** The one model the agent may call (an `eu.anthropic.*` inference profile). */
  modelId: string;
  credentials: CredentialSource;
  /** Default: the Bedrock runtime in REGION. Tests pass a local fake (`http://127.0.0.1:<port>`). */
  upstream?: string;
  region?: string;
  /** For the upstream connection: the session's HTTPS proxy agent in local runs. */
  agent?: HttpAgent;
  log?: (entry: BedrockProxyLogEntry) => void;
}

export interface BedrockProxy {
  /** `http://127.0.0.1:<port>/<prefix>`, the agent's `ANTHROPIC_BEDROCK_BASE_URL` (the prefix is the run's secret). */
  url: string;
  close(): Promise<void>;
}

export const BEDROCK_RUNTIME_URL = `https://bedrock-runtime.${REGION}.amazonaws.com`;

/** A Claude request with the whole app in context stays far below this; Bedrock's own limit is 20 MB. */
export const MAX_BODY_BYTES = 20 * 1024 * 1024;

/** At most this many requests are forwarded at once (Claude Code runs one turn at a time, plus a few side calls). */
export const MAX_IN_FLIGHT = 4;

/** The body that replaces a Bedrock answer other than 2xx (its own may name the role ARN and the account). */
export const UPSTREAM_ERROR_MESSAGE = "Bedrock refused or could not answer the request.";

/** The only `content-type` the proxy accepts, and the one it sends upstream. */
const JSON_TYPE = "application/json";

/** The `accept` values the proxy passes on (none is fine too). */
const ACCEPTED = new Set([JSON_TYPE, "application/vnd.amazon.eventstream"]);

/** The Bedrock runtime operations the agent may use (InvokeModel, InvokeModelWithResponseStream). */
export const ALLOWED_OPERATIONS = ["invoke", "invoke-with-response-stream"] as const;

/** The exact paths the proxy forwards for `modelId` (the model id URL-encoded, as Bedrock expects it). */
export function allowedPaths(modelId: string): string[] {
  return ALLOWED_OPERATIONS.map((operation) => `/model/${encodeURIComponent(modelId)}/${operation}`);
}

/**
 * The paths the proxy accepts for `modelId`, each with the path it forwards: the encoded form, and the raw form Claude
 * Code sends for an id with a `:` (such as `eu.anthropic.claude-haiku-4-5-20251001-v1:0`), forwarded encoded.
 */
export function acceptedPaths(modelId: string): Map<string, string> {
  const accepted = new Map<string, string>();
  for (const operation of ALLOWED_OPERATIONS) {
    const forwarded = `/model/${encodeURIComponent(modelId)}/${operation}`;
    accepted.set(forwarded, forwarded);
    accepted.set(`/model/${modelId}/${operation}`, forwarded);
  }
  return accepted;
}

/** Bedrock runtime operations and first path segments the logs may name; anything else is `<op>` or `<other>`. */
const KNOWN_OPERATIONS = new Set(["invoke", "invoke-with-response-stream", "converse", "converse-stream", "count-tokens"]);
const KNOWN_SEGMENTS = new Set(["model", "inference-profiles", "foundation-models", "guardrail", "async-invoke", "latest"]);

/**
 * The shape of a request path (without the run's prefix) for the logs: the build model or `<other>`, and a known
 * operation; otherwise a known first segment. Never a text the agent chose, so never the prefix either.
 */
export function pathShape(url: string, modelId: string): string {
  const path = url.split("?")[0] ?? "";
  const match = /^\/model\/([^/]*)\/([^/]*)$/.exec(path);
  if (match) {
    const operation = KNOWN_OPERATIONS.has(match[2] ?? "") ? match[2] : "<op>";
    return `/model/${match[1] === encodeURIComponent(modelId) || match[1] === modelId ? "<build>" : "<other>"}/${operation}${url.includes("?") ? "?<query>" : ""}`;
  }
  const first = /^\/([a-z-]{1,40})(\/|$)/.exec(path);
  return first && KNOWN_SEGMENTS.has(first[1] ?? "") ? `/${first[1]}${first[2] === "/" ? "/..." : ""}` : "<other>";
}

type SourceData = string | ArrayBuffer | ArrayBufferView;

const bytesOf = (data: SourceData): Buffer =>
  typeof data === "string" ? Buffer.from(data, "utf8") : ArrayBuffer.isView(data) ? Buffer.from(data.buffer, data.byteOffset, data.byteLength) : Buffer.from(data);

/** SHA-256 (and HMAC-SHA-256 with a secret) on node:crypto, in the shape SignatureV4 asks for. */
export class NodeSha256 {
  private hash: Hash | Hmac;

  constructor(private readonly secret?: SourceData) {
    this.hash = this.fresh();
  }

  private fresh(): Hash | Hmac {
    return this.secret === undefined ? createHash("sha256") : createHmac("sha256", bytesOf(this.secret));
  }

  update(data: SourceData): void {
    this.hash.update(bytesOf(data));
  }

  async digest(): Promise<Uint8Array> {
    return new Uint8Array(this.hash.digest());
  }

  reset(): void {
    this.hash = this.fresh();
  }
}

class TooLarge extends Error {}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const announced = Number(request.headers["content-length"] ?? "0");
  if (announced > MAX_BODY_BYTES) throw new TooLarge();
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    total += buffer.length;
    if (total > MAX_BODY_BYTES) throw new TooLarge();
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

const HOP_BY_HOP = new Set(["connection", "keep-alive", "transfer-encoding", "proxy-connection", "upgrade", "trailer", "te"]);

function refuse(response: ServerResponse, status: number): void {
  response.writeHead(status, { "content-type": JSON_TYPE });
  const message =
    status === 413 ? "Request too large." : status === 502 ? "Bedrock could not be reached." : status === 429 ? "Too many requests at once." : "Only the build model can be called.";
  response.end(JSON.stringify({ message }));
}

export async function startBedrockProxy(options: BedrockProxyOptions): Promise<BedrockProxy> {
  const upstream = new URL(options.upstream ?? BEDROCK_RUNTIME_URL);
  const secure = upstream.protocol === "https:";
  const host = upstream.host;
  // The run's secret path prefix: 128 random bits, in the agent's base URL only.
  const prefix = `/${randomBytes(16).toString("hex")}`;
  const allowed = acceptedPaths(options.modelId);
  let expectedHost = "";
  let inFlight = 0;
  const signer = new SignatureV4({ service: "bedrock", region: options.region ?? REGION, credentials: options.credentials, sha256: NodeSha256 });
  /** The path without the run's prefix, or undefined when it does not start with exactly `<prefix>/`. */
  const unprefixed = (url: string): string | undefined => (url.startsWith(`${prefix}/`) ? url.slice(prefix.length) : undefined);
  const log = (method: string, url: string, outcome: BedrockProxyLogEntry["outcome"], status: number): void => {
    const path = unprefixed(url);
    options.log?.({ event: "bedrock-proxy", method, shape: path === undefined ? "<other>" : pathShape(path, options.modelId), outcome, status });
  };

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const method = request.method ?? "";
    const url = request.url ?? "";
    const received = unprefixed(url);
    const path = received === undefined ? undefined : allowed.get(received);
    const type = request.headers["content-type"];
    const accept = request.headers.accept;
    const fromHere = request.headers.host === expectedHost && request.headers.origin === undefined;
    const typed = type === JSON_TYPE && (accept === undefined || ACCEPTED.has(accept));
    if (method !== "POST" || path === undefined || !fromHere || !typed) {
      request.resume();
      log(method, url, "refused", 403);
      refuse(response, 403);
      return;
    }
    if (inFlight >= MAX_IN_FLIGHT) {
      request.resume();
      log(method, url, "busy", 429);
      refuse(response, 429);
      return;
    }
    inFlight += 1;
    response.once("close", () => {
      inFlight -= 1;
    });
    let body: Buffer;
    try {
      body = await readBody(request);
    } catch (error) {
      const status = error instanceof TooLarge ? 413 : 400;
      log(method, url, "refused", status);
      refuse(response, status);
      request.resume();
      return;
    }
    const headers: Record<string, string> = { host, "content-type": JSON_TYPE };
    if (accept !== undefined) headers.accept = accept;
    const signed = await signer.sign({
      method: "POST",
      protocol: upstream.protocol,
      hostname: upstream.hostname,
      ...(upstream.port === "" ? {} : { port: Number(upstream.port) }),
      path,
      query: {},
      headers,
      body,
    });
    const send = secure ? httpsRequest : httpRequest;
    const outbound = send({
      method: "POST",
      protocol: upstream.protocol,
      hostname: upstream.hostname,
      port: upstream.port === "" ? undefined : Number(upstream.port),
      path,
      headers: { ...(signed.headers as Record<string, string>), "content-length": String(body.length) },
      ...(options.agent === undefined ? {} : { agent: options.agent }),
    });
    // The agent stopped listening (aborted run): stop the call upstream too.
    response.on("close", () => {
      if (!response.writableFinished) outbound.destroy();
    });
    outbound.on("response", (answer) => {
      const status = answer.statusCode ?? 502;
      if (status < 200 || status > 299) {
        // Bedrock's own error text may name the role ARN and the account: only the status goes on.
        answer.resume();
        log(method, url, "forwarded", status);
        response.writeHead(status, { "content-type": JSON_TYPE });
        response.end(JSON.stringify({ message: UPSTREAM_ERROR_MESSAGE }));
        return;
      }
      const forwarded: Record<string, string | string[]> = {};
      for (const [name, value] of Object.entries(answer.headers)) {
        if (value !== undefined && !HOP_BY_HOP.has(name.toLowerCase())) forwarded[name] = value;
      }
      log(method, url, "forwarded", status);
      response.writeHead(status, forwarded);
      answer.pipe(response);
      answer.on("error", () => response.destroy());
    });
    outbound.on("error", () => {
      log(method, url, "upstream-error", 502);
      if (!response.headersSent) refuse(response, 502);
      else response.destroy();
    });
    outbound.end(body);
  };

  // Host is checked by the proxy itself (403), so a request without one is refused the same way.
  const server = createServer({ requireHostHeader: false }, (request, response) => {
    handle(request, response).catch(() => {
      log(request.method ?? "", request.url ?? "", "upstream-error", 502);
      if (!response.headersSent) refuse(response, 502);
      else response.destroy();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  expectedHost = `127.0.0.1:${port}`;
  return {
    url: `http://127.0.0.1:${port}${prefix}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
