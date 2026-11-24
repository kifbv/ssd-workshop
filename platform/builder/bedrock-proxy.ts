/**
 * The coding agent's only way to Claude (ticket 2.8, try 2): a small HTTP proxy on 127.0.0.1 that the runner starts
 * before the agent and closes after it. The agent's Claude Code calls it as its Bedrock endpoint
 * (`ANTHROPIC_BEDROCK_BASE_URL`, with `CLAUDE_CODE_SKIP_BEDROCK_AUTH=1`), so the agent's process holds no AWS
 * credential at all (decision "Spec delta, CHANGED ... Builder": the AI that writes code has no AWS rights).
 *
 * It forwards only `POST /model/<url-encoded build model id>/invoke` and `.../invoke-with-response-stream` (no query)
 * to the Bedrock runtime in eu-central-1, signed (SigV4, service `bedrock`) with the runner's own credentials (the
 * task role, or the caller's for the eval), and streams the answer back. Anything else (another model, path or
 * method, a body over MAX_BODY_BYTES) gets 403 (or 413) and never leaves the machine. Only `content-type` and
 * `accept` are passed on from the request; the agent's own headers (an `authorization` included) are dropped.
 *
 * Logs (optional): the method, the path's shape (`/model/<build>/invoke`, `/model/<other>/...`, or the first segment
 * only), the outcome and the status; never a header, body or credential.
 */
import { createHash, createHmac, type Hash, type Hmac } from "node:crypto";
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
  outcome: "forwarded" | "refused" | "upstream-error";
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
  /** `http://127.0.0.1:<port>`, the agent's `ANTHROPIC_BEDROCK_BASE_URL`. */
  url: string;
  close(): Promise<void>;
}

export const BEDROCK_RUNTIME_URL = `https://bedrock-runtime.${REGION}.amazonaws.com`;

/** A Claude request with the whole app in context stays far below this; Bedrock's own limit is 20 MB. */
export const MAX_BODY_BYTES = 20 * 1024 * 1024;

/** The Bedrock runtime operations the agent may use (InvokeModel, InvokeModelWithResponseStream). */
export const ALLOWED_OPERATIONS = ["invoke", "invoke-with-response-stream"] as const;

/** The exact paths the proxy forwards for `modelId`. */
export function allowedPaths(modelId: string): string[] {
  return ALLOWED_OPERATIONS.map((operation) => `/model/${encodeURIComponent(modelId)}/${operation}`);
}

/** The shape of a request path for the logs: the build model or `<other>`, and the operation; never more. */
export function pathShape(url: string, modelId: string): string {
  const path = url.split("?")[0] ?? "";
  const match = /^\/model\/([^/]*)\/([a-z-]{1,40})$/.exec(path);
  if (match) return `/model/${match[1] === encodeURIComponent(modelId) ? "<build>" : "<other>"}/${match[2]}${url.includes("?") ? "?<query>" : ""}`;
  const first = /^\/([a-z-]{1,40})(\/|$)/.exec(path);
  return first ? `/${first[1]}${first[2] === "/" ? "/..." : ""}` : "<other>";
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
  response.writeHead(status, { "content-type": "application/json" });
  const message = status === 413 ? "Request too large." : status === 502 ? "Bedrock could not be reached." : "Only the build model can be called.";
  response.end(JSON.stringify({ message }));
}

export async function startBedrockProxy(options: BedrockProxyOptions): Promise<BedrockProxy> {
  const upstream = new URL(options.upstream ?? BEDROCK_RUNTIME_URL);
  const secure = upstream.protocol === "https:";
  const host = upstream.host;
  const allowed = new Set(allowedPaths(options.modelId));
  const signer = new SignatureV4({ service: "bedrock", region: options.region ?? REGION, credentials: options.credentials, sha256: NodeSha256 });
  const log = (method: string, url: string, outcome: BedrockProxyLogEntry["outcome"], status: number): void =>
    options.log?.({ event: "bedrock-proxy", method, shape: pathShape(url, options.modelId), outcome, status });

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const method = request.method ?? "";
    const url = request.url ?? "";
    if (method !== "POST" || !allowed.has(url)) {
      request.resume();
      log(method, url, "refused", 403);
      refuse(response, 403);
      return;
    }
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
    const headers: Record<string, string> = { host, "content-type": String(request.headers["content-type"] ?? "application/json") };
    if (typeof request.headers.accept === "string") headers.accept = request.headers.accept;
    const signed = await signer.sign({
      method: "POST",
      protocol: upstream.protocol,
      hostname: upstream.hostname,
      ...(upstream.port === "" ? {} : { port: Number(upstream.port) }),
      path: url,
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
      path: url,
      headers: { ...(signed.headers as Record<string, string>), "content-length": String(body.length) },
      ...(options.agent === undefined ? {} : { agent: options.agent }),
    });
    // The agent stopped listening (aborted run): stop the call upstream too.
    response.on("close", () => {
      if (!response.writableFinished) outbound.destroy();
    });
    outbound.on("response", (answer) => {
      const forwarded: Record<string, string | string[]> = {};
      for (const [name, value] of Object.entries(answer.headers)) {
        if (value !== undefined && !HOP_BY_HOP.has(name.toLowerCase())) forwarded[name] = value;
      }
      log(method, url, "forwarded", answer.statusCode ?? 502);
      response.writeHead(answer.statusCode ?? 502, forwarded);
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

  const server = createServer((request, response) => {
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
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
