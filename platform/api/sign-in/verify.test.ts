import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeTable } from "../fakes.js";
import type { HttpRequest, HttpResponse } from "../http.js";
import { hashToken, SESSION_COOKIE } from "../session/session.js";
import { ANSWER_AFTER_MS, CODE_TTL_SECONDS, hashCode } from "./code-request.js";
import { settle } from "./fakes.js";
import {
  BAD_VERIFY_MESSAGE,
  MAX_ATTEMPTS,
  parseVerifyRequest,
  verifySignIn,
  WRONG_CODE_MESSAGE,
  type VerifyDeps,
  type VerifyLogEntry,
} from "./verify.js";

const LISTED = "jane.doe@example.com";
const STRANGER = "stranger@example.org";
const CODE = "123456";
const OTHER_CODE = "654321";
const START = new Date("2026-11-23T10:00:00.000Z");
const START_S = START.getTime() / 1000;
const COOKIE_PATTERN = new RegExp(
  `^${SESSION_COOKIE}=([A-Za-z0-9_-]{43}); HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=28800$`,
);
const UUIDS = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"];

const request = (body: unknown, contentType = "application/json"): HttpRequest => ({
  body: JSON.stringify(body),
  headers: { "content-type": contentType },
});
const verify = (email: string, code: string): HttpRequest => request({ email, code });

async function seedCode(table: FakeTable, email: string, code: string, issuedAt = START_S, attempts = 0): Promise<void> {
  const previous = table.codes.get(email);
  const entry = { codeHash: await hashCode(code, Buffer.alloc(16, 3)), expiresAt: issuedAt + CODE_TTL_SECONDS };
  table.codes.set(email, {
    codes: [...(previous?.codes ?? []), entry],
    attempts: previous?.attempts ?? attempts,
    version: (previous?.version ?? 0) + 1,
  });
}

function setup() {
  const table = new FakeTable();
  table.allow.set(LISTED, { group: "blue", role: "participant" });
  const logs: VerifyLogEntry[] = [];
  let clock = START;
  let uuid = 0;
  let byte = 0;
  const deps: VerifyDeps = {
    store: table,
    now: () => clock,
    randomBytes: (n) => Buffer.alloc(n, ++byte),
    randomUUID: () => UUIDS[uuid++] ?? "x",
    log: (entry) => logs.push(entry),
    sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  };
  return { table, logs, deps, setClock: (d: Date) => (clock = d) };
}

type Setup = ReturnType<typeof setup>;

/** Runs a request: lets the work finish (it logs its outcome), then moves the fake clock to the deadline. */
async function answer(req: HttpRequest, s: Setup): Promise<HttpResponse> {
  const before = s.logs.length;
  const pending = verifySignIn(req, s.deps);
  await settle(() => s.logs.length > before);
  await vi.advanceTimersByTimeAsync(ANSWER_AFTER_MS);
  return pending;
}

function tokenOf(res: HttpResponse): string {
  const match = COOKIE_PATTERN.exec(res.cookies?.[0] ?? "");
  if (match?.[1] === undefined) throw new Error("no session cookie");
  return match[1];
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("parseVerifyRequest", () => {
  it("reads {email, code}, normalizing the address and trimming the code", () => {
    expect(parseVerifyRequest(verify(" Jane.Doe@Example.com ", " 123456 "))).toEqual({ email: LISTED, code: CODE });
    const encoded = Buffer.from(JSON.stringify({ email: LISTED, code: CODE })).toString("base64");
    expect(parseVerifyRequest({ body: encoded, isBase64Encoded: true })).toEqual({ email: LISTED, code: CODE });
  });

  it.each([
    ["no body", {}],
    ["not JSON", { body: "email=jane@example.com&code=123456" }],
    ["no code", { body: JSON.stringify({ email: LISTED }) }],
    ["a numeric code", { body: JSON.stringify({ email: LISTED, code: 123456 }) }],
    ["a 5-digit code", { body: JSON.stringify({ email: LISTED, code: "12345" }) }],
    ["a 7-digit code", { body: JSON.stringify({ email: LISTED, code: "1234567" }) }],
    ["letters in the code", { body: JSON.stringify({ email: LISTED, code: "12a456" }) }],
    ["no email", { body: JSON.stringify({ code: CODE }) }],
    ["a bad email", { body: JSON.stringify({ email: "jane", code: CODE }) }],
    ["a body over 2 KB", { body: JSON.stringify({ email: LISTED, code: CODE, pad: "x".repeat(2100) }) }],
  ] as [string, HttpRequest][])("refuses %s", (_name, req) => {
    expect(parseVerifyRequest(req)).toBeUndefined();
  });
});

describe("POST /api/sign-in/verify (ticket 1.5 criteria 1 to 3)", () => {
  it("criterion 1: WHEN the right code is sent within 10 minutes THEN a session cookie (HttpOnly, Secure, SameSite=Strict, 8 hours) is set and the code can't be used again", async () => {
    const s = setup();
    await seedCode(s.table, LISTED, CODE);
    s.setClock(new Date((START_S + CODE_TTL_SECONDS - 1) * 1000)); // 9 min 59 s later

    const res = await answer(verify(LISTED, CODE), s);
    expect(res.statusCode).toBe(200);
    expect(res.headers).toEqual({ "content-type": "application/json", "cache-control": "no-store" });
    expect(JSON.parse(res.body ?? "")).toEqual({ next: "nickname" });
    expect(res.cookies).toHaveLength(1);
    const token = tokenOf(res);

    // The token is stored only as its SHA-256 hash, valid 8 hours from now.
    expect([...s.table.sessions.keys()]).toEqual([hashToken(token)]);
    expect(hashToken(token)).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify([...s.table.sessions])).not.toContain(token);
    expect(s.table.sessions.get(hashToken(token))).toMatchObject({
      participantId: UUIDS[0],
      expiresAt: START_S + CODE_TTL_SECONDS - 1 + 8 * 3600,
    });
    // The code is gone: the same code is refused the second time.
    expect(s.table.codes.has(LISTED)).toBe(false);
    const again = await answer(verify(LISTED, CODE), s);
    expect(again.statusCode).toBe(401);
    expect(again.cookies).toBeUndefined();
    expect(s.table.sessions.size).toBe(1);
    expect(s.logs.map((l) => l.outcome)).toEqual(["signed-in", "no-code"]);
  });

  it("criterion 2: WHEN a wrong code is sent 5 times THEN the code is burned and even the right code is refused", async () => {
    const s = setup();
    await seedCode(s.table, LISTED, CODE);
    for (let i = 1; i < MAX_ATTEMPTS; i++) {
      expect((await answer(verify(LISTED, OTHER_CODE), s)).statusCode).toBe(401);
      expect(s.table.codes.get(LISTED)?.attempts).toBe(i);
    }
    expect(MAX_ATTEMPTS).toBe(5);
    expect((await answer(verify(LISTED, OTHER_CODE), s)).statusCode).toBe(401);
    expect(s.table.codes.has(LISTED)).toBe(false);

    const res = await answer(verify(LISTED, CODE), s);
    expect(res.statusCode).toBe(401);
    expect(res.cookies).toBeUndefined();
    expect(s.table.sessions.size).toBe(0);
    expect(s.logs.map((l) => l.outcome)).toEqual(["wrong-code", "wrong-code", "wrong-code", "wrong-code", "burned", "no-code"]);
  });

  it("criterion 2: the wrong tries are shared by all live codes, so a second code does not give 5 more", async () => {
    const s = setup();
    await seedCode(s.table, LISTED, CODE);
    for (let i = 0; i < 3; i++) await answer(verify(LISTED, "000000"), s);
    await seedCode(s.table, LISTED, OTHER_CODE, START_S + 60);
    for (let i = 0; i < 2; i++) await answer(verify(LISTED, "000000"), s);
    expect(s.table.codes.has(LISTED)).toBe(false);
    expect((await answer(verify(LISTED, OTHER_CODE), s)).statusCode).toBe(401);
  });

  it("criterion 3: WHEN a code older than 10 minutes is sent THEN it is refused", async () => {
    const s = setup();
    await seedCode(s.table, LISTED, CODE);
    s.setClock(new Date((START_S + CODE_TTL_SECONDS) * 1000)); // exactly 10 minutes: expired
    const res = await answer(verify(LISTED, CODE), s);
    expect(res.statusCode).toBe(401);
    expect(res.cookies).toBeUndefined();
    s.setClock(new Date((START_S + CODE_TTL_SECONDS + 3600) * 1000));
    expect((await answer(verify(LISTED, CODE), s)).statusCode).toBe(401);
    expect(s.table.sessions.size).toBe(0);
    expect(s.logs.map((l) => l.outcome)).toEqual(["no-code", "no-code"]);
  });

  it("criterion 3: a live newer code still works when an older one has expired", async () => {
    const s = setup();
    await seedCode(s.table, LISTED, OTHER_CODE);
    await seedCode(s.table, LISTED, CODE, START_S + 300);
    s.setClock(new Date((START_S + CODE_TTL_SECONDS + 1) * 1000));
    expect((await answer(verify(LISTED, OTHER_CODE), s)).statusCode).toBe(401);
    expect((await answer(verify(LISTED, CODE), s)).statusCode).toBe(200);
  });
});

describe("POST /api/sign-in/verify: the same refusal for everyone, at the same time", () => {
  it("answers byte-for-byte the same 401 at exactly ANSWER_AFTER_MS for every kind of refusal", async () => {
    const cases: [string, (s: Setup) => Promise<HttpRequest>][] = [
      ["not listed", async () => verify(STRANGER, CODE)],
      ["listed, no code", async () => verify(LISTED, CODE)],
      ["wrong code", async (s) => (await seedCode(s.table, LISTED, CODE), verify(LISTED, OTHER_CODE))],
      [
        "expired code",
        async (s) => (await seedCode(s.table, LISTED, CODE, START_S - CODE_TTL_SECONDS - 1), verify(LISTED, CODE)),
      ],
      [
        "allow-list entry gone since the code was sent",
        async (s) => (await seedCode(s.table, LISTED, CODE), s.table.allow.delete(LISTED), verify(LISTED, CODE)),
      ],
      [
        "table failure",
        async (s) => (await seedCode(s.table, LISTED, CODE), (s.table.failOn = "getCode"), verify(LISTED, CODE)),
      ],
      [
        "session write failure",
        async (s) => (await seedCode(s.table, LISTED, CODE), (s.table.failOn = "putSession"), verify(LISTED, CODE)),
      ],
    ];
    const bodies = new Set<string>();
    for (const [name, prepare] of cases) {
      const s = setup();
      const req = await prepare(s);
      const before = s.logs.length;
      let done = false;
      const pending = verifySignIn(req, s.deps).then((r) => ((done = true), r));
      await settle(() => s.logs.length > before);
      await vi.advanceTimersByTimeAsync(ANSWER_AFTER_MS - 1);
      expect(done, name).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const res = await pending;
      expect(res.statusCode, name).toBe(401);
      expect(res.cookies, name).toBeUndefined();
      bodies.add(JSON.stringify([res.statusCode, res.headers, res.body]));
    }
    expect(bodies.size).toBe(1);
    expect(JSON.parse(JSON.parse([...bodies][0] ?? "")[2])).toEqual({ message: WRONG_CODE_MESSAGE });
  });

  it("answers a success at the same fixed time", async () => {
    const s = setup();
    await seedCode(s.table, LISTED, CODE);
    let done = false;
    const pending = verifySignIn(verify(LISTED, CODE), s.deps).then((r) => ((done = true), r));
    await settle(() => s.logs.length > 0);
    await vi.advanceTimersByTimeAsync(ANSWER_AFTER_MS - 1);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect((await pending).statusCode).toBe(200);
  });

  it("still answers the 401 at the deadline when the table never answers, and logs a timeout", async () => {
    const s = setup();
    await seedCode(s.table, LISTED, CODE);
    s.table.getCode = () => new Promise(() => undefined);
    const pending = verifySignIn(verify(LISTED, CODE), s.deps);
    await vi.advanceTimersByTimeAsync(ANSWER_AFTER_MS);
    const res = await pending;
    expect(res.statusCode).toBe(401);
    expect(s.logs).toEqual([{ event: "sign-in-verify", outcome: "failed", step: "code", error: "Timeout" }]);
  });

  it("answers a malformed request 400 and a non-JSON content type 415 at once, never echoing the input", async () => {
    const s = setup();
    const bad = await verifySignIn(request({ email: LISTED, code: "12" }), s.deps);
    expect(bad.statusCode).toBe(400);
    expect(JSON.parse(bad.body ?? "")).toEqual({ message: BAD_VERIFY_MESSAGE });
    expect(bad.body).not.toContain("jane");
    for (const contentType of ["text/plain", "application/x-www-form-urlencoded", ""]) {
      const res = await verifySignIn(request({ email: LISTED, code: CODE }, contentType), s.deps);
      expect(res.statusCode, contentType).toBe(415);
      expect(res.body).not.toContain("jane");
    }
    expect((await verifySignIn({ body: JSON.stringify({ email: LISTED, code: CODE }) }, s.deps)).statusCode).toBe(415);
    const charset = await answer(request({ email: LISTED, code: CODE }, "application/json; charset=utf-8"), s);
    expect(charset.statusCode).toBe(401);
  });
});

describe("POST /api/sign-in/verify: participant record and conflicts", () => {
  it("creates a new person's record from the allow-list entry (role, group, step nickname, no email) and links it", async () => {
    const s = setup();
    s.table.allow.set(LISTED, { group: "red", role: "facilitator" });
    await seedCode(s.table, LISTED, CODE);
    await answer(verify(LISTED, CODE), s);
    expect(s.table.allow.get(LISTED)).toEqual({ group: "red", role: "facilitator", participantId: UUIDS[0] });
    const profile = s.table.profiles.get(UUIDS[0] ?? "");
    expect(profile).toEqual({ id: UUIDS[0], role: "facilitator", group: "red", step: "nickname", createdAt: START.toISOString() });
    expect(JSON.stringify([...s.table.profiles, ...s.table.sessions])).not.toContain("jane");
  });

  it("sends a returning person straight back to their step, with role and group refreshed from the allow-list", async () => {
    const s = setup();
    s.table.allow.set(LISTED, { group: "green", role: "admin", participantId: "p-1" });
    s.table.profiles.set("p-1", { id: "p-1", nickname: "Ada", role: "participant", group: "blue", step: "spec", createdAt: "x" });
    await seedCode(s.table, LISTED, CODE);
    const res = await answer(verify(LISTED, CODE), s);
    expect(JSON.parse(res.body ?? "")).toEqual({ next: "spec" });
    expect(s.table.profiles.get("p-1")).toMatchObject({ nickname: "Ada", role: "admin", group: "green", step: "spec" });
    expect(s.table.profiles.size).toBe(1);
    expect([...s.table.sessions.values()][0]?.participantId).toBe("p-1");
  });

  it("uses the participant another sign-in of the same person linked first", async () => {
    const s = setup();
    await seedCode(s.table, LISTED, CODE);
    const link = s.table.linkParticipant.bind(s.table);
    s.table.linkParticipant = async (email) => {
      await link(email, "first-one");
      return false;
    };
    await answer(verify(LISTED, CODE), s);
    expect([...s.table.sessions.values()][0]?.participantId).toBe("first-one");
    expect([...s.table.profiles.keys()]).toEqual(["first-one"]);
  });

  it("criterion 2: WHEN N wrong codes arrive at once (N < 5) THEN every one is counted and attempts is N", async () => {
    const s = setup();
    await seedCode(s.table, LISTED, CODE);
    const n = MAX_ATTEMPTS - 1;
    const pending = Array.from({ length: n }, () => verifySignIn(verify(LISTED, OTHER_CODE), s.deps));
    await settle(() => s.logs.length === n);
    await vi.advanceTimersByTimeAsync(ANSWER_AFTER_MS);
    for (const res of await Promise.all(pending)) expect(res.statusCode).toBe(401);
    expect(s.table.codes.get(LISTED)?.attempts).toBe(n);
    expect(s.logs.map((l) => l.outcome)).toEqual(Array(n).fill("wrong-code"));
  });

  it("criterion 2: WHEN 10 wrong codes arrive at once THEN at most 4 are refused before the burn, none goes uncounted, and the right code is refused after", async () => {
    const s = setup();
    await seedCode(s.table, LISTED, CODE);
    const burst = 10;
    let added = 0;
    const add = s.table.addWrongTry.bind(s.table);
    s.table.addWrongTry = async (email) => (added++, add(email));
    const pending = Array.from({ length: burst }, () => verifySignIn(verify(LISTED, OTHER_CODE), s.deps));
    await settle(() => s.logs.length === burst);
    await vi.advanceTimersByTimeAsync(ANSWER_AFTER_MS);
    for (const res of await Promise.all(pending)) expect(res.statusCode).toBe(401);
    const outcomes = s.logs.map((l) => l.outcome);
    // Every guess was counted (one atomic add each); none was dropped as a lost race.
    expect(added).toBe(burst);
    expect(outcomes).not.toContain("conflict");
    expect(outcomes.filter((o) => o === "wrong-code")).toHaveLength(MAX_ATTEMPTS - 1);
    // The rest burned the item or found it already burned (gone): refused either way.
    expect(outcomes.filter((o) => o === "burned").length).toBeGreaterThanOrEqual(1);
    expect(outcomes.filter((o) => o !== "wrong-code").every((o) => o === "burned" || o === "no-code")).toBe(true);
    expect(s.table.codes.has(LISTED)).toBe(false);

    const res = await answer(verify(LISTED, CODE), s);
    expect(res.statusCode).toBe(401);
    expect(s.table.sessions.size).toBe(0);
  });

  it("burns on the next read an item left at 5 wrong tries when the burning delete lost a race", async () => {
    const s = setup();
    await seedCode(s.table, LISTED, CODE, START_S, MAX_ATTEMPTS);
    const res = await answer(verify(LISTED, CODE), s);
    expect(res.statusCode).toBe(401);
    expect(s.table.codes.has(LISTED)).toBe(false);
    expect(s.logs.map((l) => l.outcome)).toEqual(["burned"]);
  });

  it("refuses a wrong code whose codes item vanished before it was counted, creating nothing", async () => {
    const s = setup();
    await seedCode(s.table, LISTED, CODE);
    const add = s.table.addWrongTry.bind(s.table);
    s.table.addWrongTry = async (email) => (s.table.codes.delete(email), add(email));
    const res = await answer(verify(LISTED, OTHER_CODE), s);
    expect(res.statusCode).toBe(401);
    expect(s.table.codes.has(LISTED)).toBe(false);
    expect(s.logs.map((l) => l.outcome)).toEqual(["no-code"]);
  });

  it("re-reads before using a right code when another request wrote the codes in between (versioned delete)", async () => {
    const s = setup();
    await seedCode(s.table, LISTED, CODE);
    s.table.beforeCodeRead = () => {
      const item = s.table.codes.get(LISTED);
      if (item) s.table.codes.set(LISTED, { ...item, version: item.version + 1 });
    };
    const res = await answer(verify(LISTED, CODE), s);
    expect(res.statusCode).toBe(200);
    expect(s.table.codes.has(LISTED)).toBe(false);
  });

  it("refuses a right code with a conflict when the codes keep changing", async () => {
    const s = setup();
    await seedCode(s.table, LISTED, CODE);
    s.table.deleteCode = async () => false;
    const res = await answer(verify(LISTED, CODE), s);
    expect(res.statusCode).toBe(401);
    expect(s.logs.map((l) => l.outcome)).toEqual(["conflict"]);
  });
});
