// Ticket 2.8, try 2: the agent's Bedrock proxy forwards only the build model's two invoke calls, signed with the
// runner's credentials; everything else is refused on the machine. A local fake stands in for the Bedrock runtime.
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { SignatureV4 } from "@smithy/signature-v4";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { MAX_BODY_BYTES, NodeSha256, allowedPaths, pathShape, startBedrockProxy, type BedrockProxy, type BedrockProxyLogEntry } from "./bedrock-proxy.js";

const MODEL = "eu.anthropic.claude-sonnet-4-6";
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

beforeAll(async () => {
  upstream = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      seen.push({ method: request.method ?? "", url: request.url ?? "", headers: request.headers, body: Buffer.concat(chunks).toString() });
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
  await Promise.all(proxies.splice(0).map((proxy) => proxy.close()));
});

async function start(logs: BedrockProxyLogEntry[] = []): Promise<BedrockProxy> {
  const proxy = await startBedrockProxy({ modelId: MODEL, credentials: async () => CREDENTIALS, upstream: upstreamUrl, log: (entry) => logs.push(entry) });
  proxies.push(proxy);
  return proxy;
}

const BODY = JSON.stringify({ anthropic_version: "bedrock-2023-05-31", max_tokens: 10, messages: [{ role: "user", content: "hi" }] });

describe("the Bedrock proxy (finding 1: the agent holds no AWS credential)", () => {
  it("listens on 127.0.0.1 only, on a port of its own", async () => {
    const proxy = await start();
    expect(proxy.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
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
      const answer = await fetch(`${proxy.url}${path}`, { method, ...(method === "GET" ? {} : { body: BODY }) });
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
    const answer = await fetch(`${proxy.url}${allowedPaths(MODEL)[0]}`, { method: "POST", body: "x".repeat(MAX_BODY_BYTES + 1) });
    expect(answer.status).toBe(413);
    expect(seen).toEqual([]);
  });

  it("answers 502 when Bedrock cannot be reached", async () => {
    const proxy = await startBedrockProxy({ modelId: MODEL, credentials: async () => CREDENTIALS, upstream: "http://127.0.0.1:1" });
    proxies.push(proxy);
    const answer = await fetch(`${proxy.url}${allowedPaths(MODEL)[0]}`, { method: "POST", body: BODY });
    expect(answer.status).toBe(502);
  });

  it("stops listening when closed", async () => {
    const proxy = await startBedrockProxy({ modelId: MODEL, credentials: async () => CREDENTIALS, upstream: upstreamUrl });
    await proxy.close();
    await expect(fetch(`${proxy.url}${allowedPaths(MODEL)[0]}`, { method: "POST", body: BODY })).rejects.toThrow();
  });

  it("logs a path's shape only", () => {
    expect(pathShape(`/model/${MODEL}/invoke`, MODEL)).toBe("/model/<build>/invoke");
    expect(pathShape("/model/secret-model/count-tokens", MODEL)).toBe("/model/<other>/count-tokens");
    expect(pathShape(`/model/${MODEL}/invoke?a=b`, MODEL)).toBe("/model/<build>/invoke?<query>");
    expect(pathShape("/guardrail/some-id/version/1", MODEL)).toBe("/guardrail/...");
    expect(pathShape("http://x/y", MODEL)).toBe("<other>");
  });
});
