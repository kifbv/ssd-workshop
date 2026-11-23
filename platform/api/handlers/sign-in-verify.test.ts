import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeTable } from "../fakes.js";
import type { HttpRequest, HttpResponse } from "../http.js";
import { ANSWER_AFTER_MS, CODE_TTL_SECONDS, hashCode } from "../sign-in/code-request.js";
import { settle } from "../sign-in/fakes.js";
import type { VerifyDeps } from "../sign-in/verify.js";
import { createHandler as createParticipantHandler, logEntry as participantLogEntry } from "./participant.js";
import { createHandler, handler, logEntry } from "./sign-in-verify.js";

const LISTED = "franck.tester@example.com";
const STRANGER = "someone.else@example.org";
const CODE = "482913";
const START = new Date("2026-11-23T10:00:00.000Z");
const START_S = START.getTime() / 1000;

const verify = (email: string, code: string): HttpRequest => ({
  body: JSON.stringify({ email, code }),
  headers: { "content-type": "application/json" },
});

/** Captures everything written to the console and to stdout/stderr. */
function captureOutput(): string[] {
  const captured: string[] = [];
  const keep = (...args: unknown[]) => {
    captured.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a) ?? String(a))).join(" "));
  };
  for (const method of ["log", "info", "warn", "error", "debug", "trace"] as const) {
    vi.spyOn(console, method).mockImplementation(keep);
  }
  for (const stream of [process.stdout, process.stderr]) {
    vi.spyOn(stream, "write").mockImplementation((chunk: unknown) => {
      captured.push(typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString("utf8"));
      return true;
    });
  }
  return captured;
}

describe("sign-in verify and participant logs (ticket 1.5)", () => {
  let captured: string[];
  let logged = 0;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    logged = 0;
    captured = captureOutput();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  function runner(table: FakeTable): (event: HttpRequest) => Promise<HttpResponse> {
    const deps: VerifyDeps = {
      store: table,
      now: () => START,
      randomBytes: (n) => Buffer.alloc(n, 4),
      randomUUID: () => "a1b2c3d4-0000-4000-8000-000000000001",
      log: (entry) => {
        logged++;
        logEntry(entry);
      },
      sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    };
    const run = createHandler(deps);
    return async (event) => {
      const before = logged;
      const pending = run(event);
      await settle(() => logged > before);
      await vi.advanceTimersByTimeAsync(ANSWER_AFTER_MS);
      return pending;
    };
  }

  it("never writes the address, the code, the session token or its hash, or the nickname to the logs", async () => {
    console.log("marker-console");
    process.stdout.write("marker-stdout");
    expect(captured.join("\n")).toContain("marker-console");
    expect(captured.join("\n")).toContain("marker-stdout");

    const table = new FakeTable();
    table.allow.set(LISTED, { group: "blue", role: "participant" });
    const seed = async () =>
      table.codes.set(LISTED, {
        codes: [{ codeHash: await hashCode(CODE, Buffer.alloc(16, 1)), expiresAt: START_S + CODE_TTL_SECONDS }],
        attempts: 0,
        version: 1,
      });
    await seed();
    const run = runner(table);

    // Not listed, wrong code, malformed bodies and a wrong content type holding the address and code.
    await run(verify(STRANGER, CODE));
    await run(verify(LISTED, "000000"));
    await run({ body: `{"email": "${LISTED}", "code": "${CODE}", oops}`, headers: { "content-type": "application/json" } });
    await run({ body: JSON.stringify({ email: LISTED, code: CODE }), headers: { "content-type": "text/plain" } });
    // A failure whose message holds the address and code.
    table.failOn = "getCode";
    table.failure = Object.assign(new Error(`ResourceNotFoundException for ${LISTED} code ${CODE}`), { name: "ResourceNotFoundException" });
    await run(verify(LISTED, CODE));
    table.failOn = undefined;
    // Burn: five wrong tries.
    for (let i = 0; i < 5; i++) await run(verify(LISTED, "111111"));
    // Signed in.
    await seed();
    const signed = await run(verify(LISTED, CODE));
    expect(signed.statusCode).toBe(200);
    const cookie = signed.cookies?.[0]?.split(";")[0] ?? "";
    const token = cookie.split("=")[1] ?? "";
    expect(token).toHaveLength(43);

    // The participant routes, with the session: a nickname refused, then saved.
    const participant = createParticipantHandler({ store: table, now: () => START, log: participantLogEntry });
    const nickname = (value: string): HttpRequest => ({
      routeKey: "POST /api/me/nickname",
      cookies: [cookie],
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nickname: value }),
    });
    expect((await participant(nickname("admin"))).statusCode).toBe(400);
    expect((await participant(nickname("Zephyrine-77"))).statusCode).toBe(200);
    expect((await participant({ routeKey: "GET /api/me", cookies: [cookie] })).statusCode).toBe(200);
    expect((await participant({ routeKey: "GET /api/me" })).statusCode).toBe(401);

    const logs = captured.join("\n").toLowerCase();
    for (const outcome of ["not-listed", "wrong-code", "invalid-request", "unsupported-media-type", "burned", "signed-in", "resourcenotfoundexception"]) {
      expect(logs, outcome).toContain(`${outcome}`);
    }
    expect(logs).toContain('"event":"participant"');
    expect(logs).toContain('"outcome":"reserved"');
    const tokenHash = [...table.sessions.keys()][0] ?? "?";
    for (const secret of [LISTED, STRANGER, "franck.tester", "someone.else", "example.com", "example.org", CODE, token, tokenHash, "zephyrine"]) {
      expect(logs, secret).not.toContain(secret.toLowerCase());
    }
  });
});

describe("handler (live wiring)", () => {
  it("answers a request without the JSON content type 415 before any AWS call", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const res = await handler({ body: "{}" });
    expect(res.statusCode).toBe(415);
    vi.restoreAllMocks();
  });
});
