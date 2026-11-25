// Ticket 2.8, try 2: the agent's Bedrock proxy forwards only the build model's two invoke calls, signed with the
// runner's credentials; everything else is refused on the machine. A local fake stands in for the Bedrock runtime.
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { SignatureV4 } from "@smithy/signature-v4";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { settle } from "../api/sign-in/fakes.js";
import { BUILD_AGENT_TIMEOUT_MS } from "../api/settings.js";
import { AGENT_MAX_RETRIES } from "./agent.js";
import {
  BACKOFF_MAX_MS,
  MAX_BODY_BYTES,
  MAX_IN_FLIGHT,
  NodeSha256,
  THROTTLE_RETRY_MS,
  backoffMs,
  UPSTREAM_ERROR_MESSAGE,
  allowedPaths,
  pathShape,
  startBedrockProxy,
  type BedrockProxy,
  type BedrockProxyOptions,
  type BedrockProxyLogEntry,
} from "./bedrock-proxy.js";

const MODEL = "eu.anthropic.claude-sonnet-4-6";
type BedrockProxyOptionsRetry = NonNullable<BedrockProxyOptions["retry"]>;
const CREDENTIALS = { accessKeyId: "AKIDTESTPROXY", secretAccessKey: "secret-test-key", sessionToken: "session-test-token" };

interface Seen {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  body: string;
}

let upstream: Server;
let upstreamUrl: string;
const seen: Seen[] = [];
/** How the fake Bedrock answers: a 200 stream, an error naming the account (as Bedrock's do), or held until released. */
let mode: "stream" | "error" | "hold" = "stream";
/** Ticket 3.4: the fake Bedrock first answers this many requests with `throttleStatus` (it throttles), then as `mode` says. */
let throttleLeft = 0;
let throttleStatus = 429;
const held: ServerResponse[] = [];
const ERROR_BODY = JSON.stringify({ message: "User: arn:aws:sts::123456789012:assumed-role/ssd-workshop-builder/x is not authorized" });

beforeAll(async () => {
  upstream = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      seen.push({ method: request.method ?? "", url: request.url ?? "", headers: request.headers, body: Buffer.concat(chunks).toString() });
      if (throttleLeft > 0) {
        throttleLeft -= 1;
        response.writeHead(throttleStatus, { "content-type": "application/json" });
        response.end(JSON.stringify({ message: "Too many requests, please wait before trying again." }));
        return;
      }
      if (mode === "error") {
        response.writeHead(403, { "content-type": "application/json", "x-amzn-errortype": "AccessDeniedException:arn:aws:iam::123456789012:x" });
        response.end(ERROR_BODY);
        return;
      }
      if (mode === "hold") {
        held.push(response);
        return;
      }
      // Streams its answer in two parts, as invoke-with-response-stream does.
      response.writeHead(200, { "content-type": "application/vnd.amazon.eventstream", "x-amzn-requestid": "req-1" });
      response.write("part-1;");
      setTimeout(() => response.end("part-2"), 20);
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", () => resolve()));
  upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => upstream.close(() => resolve())));

const proxies: BedrockProxy[] = [];
afterEach(async () => {
  seen.length = 0;
  mode = "stream";
  throttleLeft = 0;
  throttleStatus = 429;
  for (const response of held.splice(0)) response.end();
  await Promise.all(proxies.splice(0).map((proxy) => proxy.close()));
});

async function start(logs: BedrockProxyLogEntry[] = []): Promise<BedrockProxy> {
  const proxy = await startBedrockProxy({ modelId: MODEL, credentials: async () => CREDENTIALS, upstream: upstreamUrl, log: (entry) => logs.push(entry) });
  proxies.push(proxy);
  return proxy;
}

const BODY = JSON.stringify({ anthropic_version: "bedrock-2023-05-31", max_tokens: 10, messages: [{ role: "user", content: "hi" }] });
// fetch sends `accept: */*` unless told otherwise, which the proxy refuses.
const JSON_TYPE = { "content-type": "application/json", accept: "application/json" };

/** One request with exactly these headers (fetch would set Host itself and refuse some names). */
function raw(url: string, method: string, headers: Record<string, string>, body?: string): Promise<{ status: number; headers: IncomingMessage["headers"]; body: string }> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const outbound = httpRequest({ method, hostname: target.hostname, port: target.port, path: `${target.pathname}${target.search}`, headers, setHost: false }, (answer) => {
      const chunks: Buffer[] = [];
      answer.on("data", (chunk: Buffer) => chunks.push(chunk));
      answer.on("end", () => resolve({ status: answer.statusCode ?? 0, headers: answer.headers, body: Buffer.concat(chunks).toString() }));
    });
    outbound.on("error", reject);
    outbound.end(body);
  });
}

const hostOf = (proxy: BedrockProxy): string => new URL(proxy.url).host;
const prefixOf = (proxy: BedrockProxy): string => new URL(proxy.url).pathname;

describe("the Bedrock proxy (finding 1: the agent holds no AWS credential)", () => {
  it("accepts the raw form Claude Code sends for a model id with a colon and forwards it URL-encoded; another model's raw form stays refused", async () => {
    const colonModel = "eu.anthropic.claude-haiku-4-5-20251001-v1:0";
    const logs: BedrockProxyLogEntry[] = [];
    const proxy = await startBedrockProxy({ modelId: colonModel, credentials: async () => CREDENTIALS, upstream: upstreamUrl, log: (entry) => logs.push(entry) });
    try {
      const before = seen.length;
      const headers = { "content-type": "application/json", accept: "application/vnd.amazon.eventstream" };
      const ok = await fetch(`${proxy.url}/model/${colonModel}/invoke-with-response-stream`, { method: "POST", headers, body: BODY });
      expect(ok.status).toBe(200);
      await ok.text();
      const other = await fetch(`${proxy.url}/model/eu.anthropic.claude-opus-4-6-v1:0/invoke`, { method: "POST", headers, body: BODY });
      expect(other.status).toBe(403);
      expect(seen.slice(before).map((request) => request.url)).toEqual([`/model/${encodeURIComponent(colonModel)}/invoke-with-response-stream`]);
      expect(logs.map((entry) => [entry.shape, entry.outcome])).toEqual([
        ["/model/<build>/invoke-with-response-stream", "forwarded"],
        ["/model/<other>/invoke", "refused"],
      ]);
    } finally {
      await proxy.close();
    }
  });

  it("listens on 127.0.0.1 only, on a port of its own, under a 128-bit random path prefix of its own (try 3)", async () => {
    const proxy = await start();
    const other = await start();
    expect(proxy.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{32}$/);
    expect(prefixOf(other)).not.toBe(prefixOf(proxy));
  });

  it("forwards POST invoke and invoke-with-response-stream of the build model, signed with the runner's credentials, and streams the answer back", async () => {
    const proxy = await start();
    for (const path of allowedPaths(MODEL)) {
      const answer = await fetch(`${proxy.url}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/vnd.amazon.eventstream", authorization: "Bearer agent-made-this-up", "x-other": "1" },
        body: BODY,
      });
      expect(answer.status).toBe(200);
      expect(answer.headers.get("content-type")).toBe("application/vnd.amazon.eventstream");
      expect(await answer.text()).toBe("part-1;part-2");
    }
    expect(seen.map((request) => [request.method, request.url])).toEqual([
      ["POST", `/model/${MODEL}/invoke`],
      ["POST", `/model/${MODEL}/invoke-with-response-stream`],
    ]);
    for (const request of seen) {
      expect(request.body).toBe(BODY);
      expect(request.headers["x-other"]).toBeUndefined();
      expect(request.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDTESTPROXY\/\d{8}\/eu-central-1\/bedrock\/aws4_request, SignedHeaders=[a-z0-9;-]+, Signature=[0-9a-f]{64}$/);
      expect(request.headers["x-amz-security-token"]).toBe(CREDENTIALS.sessionToken);
      // The signature is the one SigV4 gives for this exact request at its own time.
      const date = String(request.headers["x-amz-date"]);
      const signingDate = new Date(`${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${date.slice(9, 11)}:${date.slice(11, 13)}:${date.slice(13, 15)}Z`);
      const signer = new SignatureV4({ service: "bedrock", region: "eu-central-1", credentials: CREDENTIALS, sha256: NodeSha256 });
      const url = new URL(upstreamUrl);
      const expected = await signer.sign(
        {
          method: "POST",
          protocol: "http:",
          hostname: url.hostname,
          port: Number(url.port),
          path: request.url,
          query: {},
          headers: { host: url.host, "content-type": "application/json", accept: "application/vnd.amazon.eventstream" },
          body: Buffer.from(BODY),
        },
        { signingDate },
      );
      expect(request.headers.authorization).toBe(expected.headers.authorization);
    }
  });

  it("refuses another model id, another path and another method with 403, and sends nothing upstream", async () => {
    const logs: BedrockProxyLogEntry[] = [];
    const proxy = await start(logs);
    const refused: [string, string][] = [
      ["POST", "/model/eu.anthropic.claude-opus-4-6-v1/invoke"],
      ["POST", "/model/anthropic.claude-sonnet-4-6/invoke-with-response-stream"],
      ["POST", `/model/${encodeURIComponent(`arn:aws:bedrock:eu-central-1::foundation-model/${MODEL}`)}/invoke`],
      ["POST", `/model/${MODEL}/converse`],
      ["POST", `/model/${MODEL}/count-tokens`],
      ["POST", `/model/${MODEL}/invoke?x=1`],
      ["POST", `/model/${MODEL}/invoke/`],
      ["POST", `//model/${MODEL}/invoke`],
      ["POST", `/model/${MODEL}/../other/invoke`],
      ["POST", "/guardrail/x/version/1/apply"],
      ["POST", "/async-invoke"],
      ["POST", "/"],
      ["GET", `/model/${MODEL}/invoke`],
      ["PUT", `/model/${MODEL}/invoke`],
      ["DELETE", `/model/${MODEL}/invoke-with-response-stream`],
      ["GET", "/latest/meta-data/iam/security-credentials/"],
    ];
    for (const [method, path] of refused) {
      const answer = await fetch(`${proxy.url}${path}`, { method, ...(method === "GET" ? {} : { headers: JSON_TYPE, body: BODY }) });
      expect(answer.status, `${method} ${path}`).toBe(403);
      await answer.text();
    }
    expect(seen).toEqual([]);
    expect(logs.every((entry) => entry.outcome === "refused" && entry.status === 403)).toBe(true);
    // Logs hold shapes only: never a model id the agent named.
    expect(JSON.stringify(logs)).not.toContain("opus");
    expect(JSON.stringify(logs)).not.toContain("guardrail/x");
  });

  it("refuses a body over the limit with 413", async () => {
    const proxy = await start();
    const answer = await fetch(`${proxy.url}${allowedPaths(MODEL)[0]}`, { method: "POST", headers: JSON_TYPE, body: "x".repeat(MAX_BODY_BYTES + 1) });
    expect(answer.status).toBe(413);
    expect(seen).toEqual([]);
  });

  it("answers 502 when Bedrock cannot be reached", async () => {
    const proxy = await startBedrockProxy({ modelId: MODEL, credentials: async () => CREDENTIALS, upstream: "http://127.0.0.1:1" });
    proxies.push(proxy);
    const answer = await fetch(`${proxy.url}${allowedPaths(MODEL)[0]}`, { method: "POST", headers: JSON_TYPE, body: BODY });
    expect(answer.status).toBe(502);
  });

  it("stops listening when closed", async () => {
    const proxy = await startBedrockProxy({ modelId: MODEL, credentials: async () => CREDENTIALS, upstream: upstreamUrl });
    await proxy.close();
    await expect(fetch(`${proxy.url}${allowedPaths(MODEL)[0]}`, { method: "POST", headers: JSON_TYPE, body: BODY })).rejects.toThrow();
  });

  it("logs a path's shape only", () => {
    expect(pathShape(`/model/${MODEL}/invoke`, MODEL)).toBe("/model/<build>/invoke");
    expect(pathShape("/model/secret-model/count-tokens", MODEL)).toBe("/model/<other>/count-tokens");
    expect(pathShape(`/model/${MODEL}/invoke?a=b`, MODEL)).toBe("/model/<build>/invoke?<query>");
    expect(pathShape("/guardrail/some-id/version/1", MODEL)).toBe("/guardrail/...");
    expect(pathShape("http://x/y", MODEL)).toBe("<other>");
  });
});

describe("the Bedrock proxy refuses what a browser page or a guess could send (try 3)", () => {
  const invoke = (proxy: BedrockProxy): string => `${proxy.url}${allowedPaths(MODEL)[1]}`;

  it("forwards only a content-type of exactly application/json, and sends that constant upstream", async () => {
    const logs: BedrockProxyLogEntry[] = [];
    const proxy = await start(logs);
    for (const type of ["text/plain", "text/plain;charset=UTF-8", "application/json; charset=utf-8", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x", "Application/JSON", ""]) {
      const answer = await raw(invoke(proxy), "POST", { host: hostOf(proxy), ...(type === "" ? {} : { "content-type": type }) }, BODY);
      expect(answer.status, type).toBe(403);
    }
    expect(seen).toEqual([]);
    const ok = await raw(invoke(proxy), "POST", { host: hostOf(proxy), "content-type": "application/json" }, BODY);
    expect(ok.status).toBe(200);
    expect(seen.map((request) => request.headers["content-type"])).toEqual(["application/json"]);
  });

  it("forwards accept only when it is application/json or application/vnd.amazon.eventstream, or absent (Bedrock's default)", async () => {
    const proxy = await start();
    for (const accept of ["text/html", "*/*", "application/json, text/plain", "application/vnd.amazon.eventstream; q=1"]) {
      const answer = await raw(invoke(proxy), "POST", { host: hostOf(proxy), "content-type": "application/json", accept }, BODY);
      expect(answer.status, accept).toBe(403);
    }
    expect(seen).toEqual([]);
    for (const accept of ["application/json", "application/vnd.amazon.eventstream", undefined]) {
      const answer = await raw(invoke(proxy), "POST", { host: hostOf(proxy), "content-type": "application/json", ...(accept === undefined ? {} : { accept }) }, BODY);
      expect(answer.status, String(accept)).toBe(200);
    }
    expect(seen.map((request) => request.headers.accept)).toEqual(["application/json", "application/vnd.amazon.eventstream", undefined]);
  });

  it("refuses a Host other than exactly 127.0.0.1:<port> (DNS rebinding), and any Origin header", async () => {
    const proxy = await start();
    const port = new URL(proxy.url).port;
    for (const host of [`localhost:${port}`, "127.0.0.1", `127.0.0.1:${Number(port) + 1}`, `evil.example:${port}`, `[::1]:${port}`, `127.0.0.1:${port}.evil.example`, ""]) {
      const answer = await raw(invoke(proxy), "POST", { ...(host === "" ? {} : { host }), "content-type": "application/json" }, BODY);
      expect(answer.status, host).toBe(403);
    }
    for (const origin of ["null", "https://evil.example", `http://127.0.0.1:${port}`]) {
      const answer = await raw(invoke(proxy), "POST", { host: hostOf(proxy), origin, "content-type": "application/json" }, BODY);
      expect(answer.status, origin).toBe(403);
    }
    expect(seen).toEqual([]);
  });

  it("refuses a missing or wrong path prefix, and never logs the prefix", async () => {
    const logs: BedrockProxyLogEntry[] = [];
    const proxy = await start(logs);
    const origin = new URL(proxy.url).origin;
    const prefix = prefixOf(proxy);
    const wrong = [
      `${origin}${allowedPaths(MODEL)[1]}`,
      `${origin}/${"0".repeat(32)}${allowedPaths(MODEL)[1]}`,
      `${origin}${prefix.toUpperCase()}${allowedPaths(MODEL)[1]}`,
      `${origin}${prefix}x${allowedPaths(MODEL)[1]}`,
      `${origin}${prefix.slice(0, -1)}${allowedPaths(MODEL)[1]}`,
      `${origin}/x${prefix}${allowedPaths(MODEL)[1]}`,
      `${origin}${prefix}${prefix}${allowedPaths(MODEL)[1]}`,
    ];
    for (const url of wrong) {
      const answer = await raw(url, "POST", { host: hostOf(proxy), "content-type": "application/json" }, BODY);
      expect(answer.status, url).toBe(403);
    }
    expect(seen).toEqual([]);
    const ok = await raw(invoke(proxy), "POST", { host: hostOf(proxy), "content-type": "application/json" }, BODY);
    expect(ok.status).toBe(200);
    // Upstream gets the Bedrock path without the prefix.
    expect(seen.map((request) => request.url)).toEqual([allowedPaths(MODEL)[1]]);
    expect(logs.length).toBe(wrong.length + 1);
    expect(JSON.stringify(logs)).not.toContain(prefix.slice(1));
    expect(JSON.stringify(logs)).not.toContain(prefix.slice(1, 9));
  });

  it("keeps the status of a Bedrock error but replaces its body and headers with a fixed message (no ARN or account id)", async () => {
    mode = "error";
    const proxy = await start();
    const answer = await raw(invoke(proxy), "POST", { host: hostOf(proxy), "content-type": "application/json" }, BODY);
    expect(seen).toHaveLength(1);
    expect(answer.status).toBe(403);
    expect(JSON.parse(answer.body)).toEqual({ message: UPSTREAM_ERROR_MESSAGE });
    expect(answer.body).not.toContain("arn:");
    expect(answer.body).not.toContain("123456789012");
    expect(JSON.stringify(answer.headers)).not.toContain("123456789012");
    expect(answer.headers["x-amzn-errortype"]).toBeUndefined();
  });

  it(`forwards at most ${MAX_IN_FLIGHT} requests at once and answers 429 above that`, async () => {
    expect(MAX_IN_FLIGHT).toBe(4);
    mode = "hold";
    const proxy = await start();
    const send = () => raw(invoke(proxy), "POST", { host: hostOf(proxy), "content-type": "application/json" }, BODY);
    const first = Array.from({ length: MAX_IN_FLIGHT }, () => send());
    await settle(() => held.length === MAX_IN_FLIGHT);
    const fifth = await send();
    expect(fifth.status).toBe(429);
    expect(seen).toHaveLength(MAX_IN_FLIGHT);
    for (const response of held.splice(0)) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    }
    expect((await Promise.all(first)).map((answer) => answer.status)).toEqual(Array.from({ length: MAX_IN_FLIGHT }, () => 200));
    // Once they are done, a new request goes through again.
    mode = "stream";
    expect((await send()).status).toBe(200);
  });
});

describe("ticket 3.4: Bedrock throttling (criterion 5)", () => {
  /** A fake clock that moves only when the proxy pauses, and every pause it took. */
  function fakeTime(random: () => number) {
    const clock = { now: 0, pauses: [] as number[] };
    const retry = {
      now: () => clock.now,
      sleep: async (ms: number) => {
        clock.pauses.push(ms);
        clock.now += ms;
      },
      random,
    };
    return { clock, retry };
  }

  async function startWith(retry: BedrockProxyOptionsRetry, logs: BedrockProxyLogEntry[] = []): Promise<BedrockProxy> {
    const proxy = await startBedrockProxy({ modelId: MODEL, credentials: async () => CREDENTIALS, upstream: upstreamUrl, log: (entry) => logs.push(entry), retry });
    proxies.push(proxy);
    return proxy;
  }
  const invoke = (proxy: BedrockProxy): string => `${proxy.url}${allowedPaths(MODEL)[1]}`;
  const send = (proxy: BedrockProxy) => raw(invoke(proxy), "POST", { host: hostOf(proxy), "content-type": "application/json" }, BODY);

  it("backs off with full jitter: a random pause up to 1 s x 2^try, never above 20 s", () => {
    expect([0, 1, 2, 3, 4, 5, 6, 10].map((retry) => backoffMs(retry, () => 0.999999))).toEqual([999, 1999, 3999, 7999, 15999, 19999, 19999, 19999]);
    expect(backoffMs(3, () => 0.5)).toBe(4000);
    expect(backoffMs(3, () => 0)).toBe(0);
  });

  for (const status of [429, 503]) {
    it(`WHEN Bedrock answers ${status} a few times THEN the proxy retries, signed again each time, and the agent gets the 200`, async () => {
      throttleLeft = 3;
      throttleStatus = status;
      const logs: BedrockProxyLogEntry[] = [];
      const { clock, retry } = fakeTime(() => 0.5);
      const proxy = await startWith(retry, logs);
      const answer = await send(proxy);
      expect(answer.status).toBe(200);
      expect(answer.body).toBe("part-1;part-2");
      expect(seen).toHaveLength(4);
      for (const request of seen) {
        expect(request.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDTESTPROXY\//);
        expect(request.body).toBe(BODY);
      }
      expect(clock.pauses).toEqual([500, 1000, 2000]);
      expect(logs.map((entry) => [entry.outcome, entry.status])).toEqual([
        ["throttled", status],
        ["throttled", status],
        ["throttled", status],
        ["forwarded", 200],
      ]);
    });
  }

  it("WHEN Bedrock keeps throttling THEN the proxy gives up only after about 2 minutes, so the agent's own retries outlast the 12-minute build limit", async () => {
    for (const random of [() => 0.5, () => 0.999999, () => 0.05]) {
      throttleLeft = 1_000_000;
      seen.length = 0;
      const logs: BedrockProxyLogEntry[] = [];
      const { clock, retry } = fakeTime(random);
      const proxy = await startWith(retry, logs);
      const answer = await send(proxy);
      // The 429 reaches the agent (Claude Code retries it itself), without Bedrock's text.
      expect(answer.status).toBe(429);
      expect(JSON.parse(answer.body)).toEqual({ message: UPSTREAM_ERROR_MESSAGE });
      expect(clock.now).toBeLessThanOrEqual(THROTTLE_RETRY_MS);
      expect(clock.now).toBeGreaterThan(THROTTLE_RETRY_MS - BACKOFF_MAX_MS);
      expect(seen).toHaveLength(clock.pauses.length + 1);
      expect(logs.at(-1)).toMatchObject({ outcome: "forwarded", status: 429 });
      // Claude Code sends a request 1 + CLAUDE_CODE_MAX_RETRIES times, each held here for over THROTTLE_RETRY_MS -
      // BACKOFF_MAX_MS (100 s): a throttled build is still waiting for Bedrock when its 12-minute limit stops it.
      expect((1 + AGENT_MAX_RETRIES) * clock.now).toBeGreaterThan(BUILD_AGENT_TIMEOUT_MS);
    }
  });

  it("does not retry other errors (a 403 goes back at once)", async () => {
    mode = "error";
    const { clock, retry } = fakeTime(() => 0.5);
    const proxy = await startWith(retry);
    expect((await send(proxy)).status).toBe(403);
    expect(seen).toHaveLength(1);
    expect(clock.pauses).toEqual([]);
  });

  it("WHEN the agent hangs up during a retry pause THEN the proxy stops retrying", async () => {
    throttleLeft = 1_000_000;
    let aborted = false;
    const pauses: number[] = [];
    const retry: BedrockProxyOptionsRetry = {
      now: () => 0,
      random: () => 0.5,
      // The pause lasts until the agent hangs up.
      sleep: (ms, signal) =>
        new Promise<void>((resolve) => {
          pauses.push(ms);
          signal.addEventListener("abort", () => {
            aborted = true;
            resolve();
          });
        }),
    };
    const proxy = await startWith(retry);
    const controller = new AbortController();
    const pending = fetch(invoke(proxy), { method: "POST", headers: JSON_TYPE, body: BODY, signal: controller.signal });
    await settle(() => pauses.length === 1);
    controller.abort();
    await expect(pending).rejects.toThrow();
    await settle(() => aborted);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(seen).toHaveLength(1);
    expect(pauses).toHaveLength(1);
  });
});
