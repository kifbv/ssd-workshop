import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeConversationTable, FakeQueue } from "../conversation/fakes.js";
import { FakeTable } from "../fakes.js";
import type { HttpRequest, HttpResponse } from "../http.js";
import { ANSWER_AFTER_MS, CODE_TTL_SECONDS, hashCode } from "../sign-in/code-request.js";
import { settle } from "../sign-in/fakes.js";
import type { VerifyDeps } from "../sign-in/verify.js";
import { createHandler as createConversationHandler, logEntry as conversationLogEntry } from "./conversation.js";
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

describe("sessions follow the allow-list, and sign-out (ticket 3.1)", () => {
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

  it("criterion 5: WHEN the API logs a refused or signed-out call THEN no email address is in the log line", async () => {
    // The conversation table holds the participant table's items too: one table behind both functions.
    const table = new FakeConversationTable();
    table.allow.set(LISTED, { group: "blue", role: "participant" });
    let n = 0;
    const deps: VerifyDeps = {
      store: table,
      now: () => START,
      // A different token for every sign-in.
      randomBytes: (size) => Buffer.alloc(size, ++n),
      randomUUID: () => "a1b2c3d4-0000-4000-8000-000000000001",
      log: (entry) => {
        logged++;
        logEntry(entry);
      },
      sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    };
    const run = createHandler(deps);
    const signIn = async (): Promise<string> => {
      table.codes.set(LISTED, {
        codes: [{ codeHash: await hashCode(CODE, Buffer.alloc(16, 1)), expiresAt: START_S + CODE_TTL_SECONDS }],
        attempts: 0,
        version: 1,
      });
      const before = logged;
      const pending = run(verify(LISTED, CODE));
      await settle(() => logged > before);
      await vi.advanceTimersByTimeAsync(ANSWER_AFTER_MS);
      const signed = await pending;
      expect(signed.statusCode).toBe(200);
      return signed.cookies?.[0]?.split(";")[0] ?? "";
    };
    const participant = createParticipantHandler({ store: table, now: () => START, log: participantLogEntry });
    const me = (cookie: string): HttpRequest => ({ routeKey: "GET /api/me", cookies: [cookie] });
    const conversation = createConversationHandler({
      sessions: table,
      store: table,
      editLinks: table.appTokens,
      queue: new FakeQueue(),
      now: () => START,
      randomBytes: (size) => Buffer.alloc(size, 9),
      log: conversationLogEntry,
    });
    const history = (cookie: string): HttpRequest => ({ routeKey: "GET /api/conversation", cookies: [cookie] });
    const signOut = (cookie: string): HttpRequest => ({
      routeKey: "POST /api/sign-out",
      cookies: [cookie],
      headers: { "content-type": "application/json" },
      body: "{}",
    });

    // Signed in: the session item keeps the address only sealed.
    const first = await signIn();
    const stored = JSON.stringify([...table.sessions.values()]);
    expect(stored).not.toContain(LISTED);
    expect(stored).not.toContain("franck.tester");
    expect((await participant(me(first))).statusCode).toBe(200);
    // A role change applies at the next call.
    table.allow.set(LISTED, { group: "red", role: "facilitator", participantId: "a1b2c3d4-0000-4000-8000-000000000001" });
    expect(JSON.parse((await participant(me(first))).body ?? "")).toMatchObject({ role: "facilitator", group: "red" });
    // Signed out, then refused.
    const out = await participant(signOut(first));
    expect(out.statusCode).toBe(200);
    expect((await participant(me(first))).statusCode).toBe(401);
    expect((await participant(signOut(first))).statusCode).toBe(401);
    // Signed in twice more, then taken off the list: removed at the next call, on either function.
    const second = await signIn();
    const third = await signIn();
    expect((await conversation(history(third))).statusCode).toBe(200);
    table.allow.delete(LISTED);
    expect((await participant(me(second))).statusCode).toBe(401);
    expect((await conversation(history(third))).statusCode).toBe(401);
    expect(table.sessions.size).toBe(0);
    expect((await participant(me(second))).statusCode).toBe(401);
    expect((await conversation(history(third))).statusCode).toBe(401);

    const lines = captured.filter((line) => line.includes('"event":"participant"'));
    for (const outcome of ["signed-out", "removed", "unauthorized"]) expect(lines.join("\n"), outcome).toContain(`"outcome":"${outcome}"`);
    const conversationLines = captured.filter((line) => line.includes('"event":"conversation"')).join("\n");
    for (const outcome of ["ok", "removed", "unauthorized"]) expect(conversationLines, outcome).toContain(`"outcome":"${outcome}"`);
    const logs = captured.join("\n").toLowerCase();
    expect(logs).not.toContain("@");
    const tokens = [first, second, third].map((cookie) => cookie.split("=")[1] ?? "?");
    for (const secret of [LISTED, "franck.tester", "example.com", ...tokens]) {
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
