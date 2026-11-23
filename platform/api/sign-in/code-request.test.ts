import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HttpRequest } from "../http.js";
import {
  ANSWER_AFTER_MS,
  BAD_REQUEST_MESSAGE,
  CODE_TTL_SECONDS,
  MAX_CODES_PER_WINDOW,
  MAX_LIVE_CODES,
  MAX_BODY_BYTES,
  MAX_RAW_BODY_BYTES,
  addCode,
  NEUTRAL_MESSAGE,
  RATE_WINDOW_SECONDS,
  errorName,
  generateCode,
  hashCode,
  neutralResponse,
  parseCodeRequest,
  recentSends,
  requestCode,
  verifyAnyCode,
  verifyCode,
  type CodeRequestDeps,
  type LogEntry,
} from "./code-request.js";
import { FakeMailer, FakeStore, settle } from "./fakes.js";

const LISTED = "jane.doe@example.com";
const STRANGER = "stranger@example.org";
const START = new Date("2026-11-23T10:00:00.000Z");
const START_S = START.getTime() / 1000;

const body = (email: string): HttpRequest => ({ body: JSON.stringify({ email }) });

function setup(allowed: string[] = [LISTED]) {
  const store = new FakeStore(allowed);
  const mailer = new FakeMailer();
  const logs: LogEntry[] = [];
  let clock = START;
  let nextCode = 42917;
  const deps: CodeRequestDeps = {
    store,
    mailer,
    now: () => clock,
    randomInt: () => nextCode,
    randomBytes: (n) => Buffer.alloc(n, 7),
    log: (entry) => logs.push(entry),
    // Fake timers (setTimeout only) drive the deadline.
    sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  };
  return {
    store,
    mailer,
    logs,
    deps,
    setClock: (d: Date) => (clock = d),
    setCode: (n: number) => (nextCode = n),
  };
}

type Setup = ReturnType<typeof setup>;

/** Runs a request: lets the work finish (it logs its outcome), then moves the fake clock to the deadline. */
async function answer(request: HttpRequest, s: Setup) {
  const before = s.logs.length;
  const pending = requestCode(request, s.deps);
  await settle(() => s.logs.length > before);
  await vi.advanceTimersByTimeAsync(ANSWER_AFTER_MS);
  return pending;
}

/** Tracks whether a promise has settled, to check when an answer is sent. */
function track<T>(promise: Promise<T>): { done: () => boolean; promise: Promise<T> } {
  let done = false;
  void promise.then(() => (done = true));
  return { done: () => done, promise };
}

describe("parseCodeRequest", () => {
  it("reads {\"email\"} and normalizes it", () => {
    expect(parseCodeRequest(body("  Jane.Doe@Example.COM "))).toBe(LISTED);
  });

  it("reads a base64 body (API Gateway sets isBase64Encoded)", () => {
    const encoded = Buffer.from(JSON.stringify({ email: LISTED })).toString("base64");
    expect(parseCodeRequest({ body: encoded, isBase64Encoded: true })).toBe(LISTED);
  });

  it("checks the raw body length before decoding: over 4 KB raw is refused even if it decodes small", () => {
    expect(MAX_BODY_BYTES).toBe(2048);
    expect(MAX_RAW_BODY_BYTES).toBe(4096);
    const encoded = Buffer.from(JSON.stringify({ email: LISTED })).toString("base64");
    // The base64 decoder skips whitespace, so this decodes to the same small, valid body.
    const padded = `${encoded}${"\n".repeat(MAX_RAW_BODY_BYTES)}`;
    expect(Buffer.from(padded, "base64").toString("utf8")).toBe(JSON.stringify({ email: LISTED }));
    expect(parseCodeRequest({ body: padded, isBase64Encoded: true })).toBeUndefined();
    // Just under the raw limit it is still read.
    const under = `${encoded}${"\n".repeat(MAX_RAW_BODY_BYTES - encoded.length)}`;
    expect(parseCodeRequest({ body: under, isBase64Encoded: true })).toBe(LISTED);
  });

  it.each([
    ["no body", {}],
    ["not JSON", { body: "email=jane@example.com" }],
    ["JSON null", { body: "null" }],
    ["a JSON array", { body: JSON.stringify([LISTED]) }],
    ["a JSON string", { body: JSON.stringify(LISTED) }],
    ["no email field", { body: JSON.stringify({ mail: LISTED }) }],
    ["email not a string", { body: JSON.stringify({ email: 42 }) }],
    ["not an email address", { body: JSON.stringify({ email: "jane" }) }],
    ["a key separator", { body: JSON.stringify({ email: "ja#ne@example.com" }) }],
    ["an address over 320 characters", { body: JSON.stringify({ email: `${"a".repeat(64)}@${"b".repeat(260)}.com` }) }],
    ["a body over 2 KB", { body: JSON.stringify({ email: LISTED, pad: "x".repeat(2100) }) }],
  ] as [string, HttpRequest][])("refuses %s", (_name, request) => {
    expect(parseCodeRequest(request)).toBeUndefined();
  });
});

describe("recentSends (sliding 60-minute window)", () => {
  it("keeps only the sends of the last hour, oldest first", () => {
    const now = 10_000;
    expect(recentSends([now - 3600, now - 3599, now - 10, now], now)).toEqual([now - 3599, now - 10, now]);
    expect(recentSends([now, now - 5], now)).toEqual([now - 5, now]);
    expect(recentSends([], now)).toEqual([]);
  });

  it("drops times in the future (a clock that went back cannot lock someone out)", () => {
    expect(recentSends([200], 100)).toEqual([]);
  });
});

describe("generateCode", () => {
  it("zero-pads to six digits", () => {
    expect(generateCode(() => 0)).toBe("000000");
    expect(generateCode(() => 42)).toBe("000042");
    expect(generateCode(() => 999_999)).toBe("999999");
  });

  it("asks the random source for [0, 1 000 000)", () => {
    const calls: [number, number][] = [];
    generateCode((min, max) => {
      calls.push([min, max]);
      return 1;
    });
    expect(calls).toEqual([[0, 1_000_000]]);
  });

  it("refuses an out-of-range source", () => {
    expect(() => generateCode(() => 1_000_000)).toThrow();
    expect(() => generateCode(() => -1)).toThrow();
    expect(() => generateCode(() => 1.5)).toThrow();
  });
});

describe("hashCode and verifyCode", () => {
  const salt = Buffer.alloc(16, 1);

  it("stores scrypt$salt$hash, never the code", async () => {
    const hash = await hashCode("042917", salt);
    expect(hash).toMatch(/^scrypt\$[0-9a-f]{32}\$[0-9a-f]{64}$/);
    expect(hash).not.toContain("042917");
  });

  it("gives different hashes for the same code with different salts", async () => {
    expect(await hashCode("042917", salt)).not.toBe(await hashCode("042917", Buffer.alloc(16, 2)));
  });

  it("verifies the right code and refuses a wrong one or a malformed hash", async () => {
    const hash = await hashCode("042917", salt);
    expect(await verifyCode("042917", hash)).toBe(true);
    expect(await verifyCode("042918", hash)).toBe(false);
    expect(await verifyCode("042917", "plain")).toBe(false);
    expect(await verifyCode("042917", hash.replace("scrypt", "sha256"))).toBe(false);
    expect(await verifyCode("042917", `${hash}$x`)).toBe(false);
    expect(await verifyCode("042917", hash.slice(0, -2))).toBe(false);
  });

  it("refuses a salt shorter than 16 bytes", async () => {
    await expect(hashCode("042917", Buffer.alloc(8))).rejects.toThrow();
  });

  it("verifyAnyCode matches any unexpired entry, never an expired one", async () => {
    const entries = [
      { codeHash: await hashCode("111111", salt), expiresAt: 1000 },
      { codeHash: await hashCode("222222", salt), expiresAt: 2000 },
    ];
    expect(await verifyAnyCode("111111", entries, 999)).toBe(true);
    expect(await verifyAnyCode("222222", entries, 999)).toBe(true);
    expect(await verifyAnyCode("333333", entries, 999)).toBe(false);
    expect(await verifyAnyCode("111111", entries, 1000)).toBe(false);
    expect(await verifyAnyCode("222222", entries, 1000)).toBe(true);
    expect(await verifyAnyCode("111111", [], 0)).toBe(false);
  });
});

describe("addCode", () => {
  it("expired entries are pruned, and at most 5 codes are kept (the newest)", () => {
    const e = (n: number) => ({ codeHash: `h${n}`, expiresAt: n });
    expect(addCode([e(100), e(200)], e(900), 150)).toEqual([e(200), e(900)]);
    expect(addCode([e(201), e(202), e(203), e(204), e(205)], e(900), 0)).toEqual([e(202), e(203), e(204), e(205), e(900)]);
    expect(MAX_LIVE_CODES).toBe(5);
  });
});

describe("errorName", () => {
  it("keeps an identifier-like name and replaces anything else", () => {
    const named = new Error("x");
    named.name = "MessageRejected";
    expect(errorName(named)).toBe("MessageRejected");
    const odd = new Error("x");
    odd.name = "jane@example.com";
    expect(errorName(odd)).toBe("Error");
    expect(errorName("a string")).toBe("Error");
  });
});

describe("requestCode", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("criterion 1: a listed email gets one code email, and the stored code is a hash valid 10 minutes", async () => {
    const s = setup();
    const { store, mailer, logs } = s;
    const res = await answer(body("Jane.Doe@example.com"), s);
    expect(res).toEqual(neutralResponse());

    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]?.to).toBe(LISTED);
    expect(mailer.sent[0]?.email.subject).toBe("Your SSD Workshop sign-in code: 042917");

    const stored = store.codes.get(LISTED);
    expect(stored).toMatchObject({ attempts: 0, version: 1, expiresAt: START_S + CODE_TTL_SECONDS });
    expect(stored?.codes).toHaveLength(1);
    expect(stored?.codes[0]?.expiresAt).toBe(START_S + CODE_TTL_SECONDS);
    expect(CODE_TTL_SECONDS).toBe(600);
    expect(stored?.codes[0]?.codeHash).not.toContain("042917");
    expect(await verifyCode("042917", stored?.codes[0]?.codeHash ?? "")).toBe(true);
    expect(logs).toEqual([{ event: "sign-in-code", outcome: "sent" }]);
  });

  it("a new code does not cancel the previous unexpired one", async () => {
    const s = setup();
    await answer(body(LISTED), s);
    const first = s.store.codes.get(LISTED);
    if (first === undefined) throw new Error("no code item");
    first.attempts = 2;
    s.setClock(new Date(START.getTime() + 60_000));
    s.setCode(123456);
    await answer(body(LISTED), s);
    const item = s.store.codes.get(LISTED);
    const now = START_S + 60;
    expect(await verifyAnyCode("123456", item?.codes ?? [], now)).toBe(true);
    expect(await verifyAnyCode("042917", item?.codes ?? [], now)).toBe(true);
    // One shared wrong-try counter, kept while earlier codes live; TTL = the latest expiry.
    expect(item).toMatchObject({ attempts: 2, version: 2, expiresAt: now + CODE_TTL_SECONDS });
  });

  it("expired entries are pruned on write (and the wrong tries reset with them)", async () => {
    const s = setup();
    await answer(body(LISTED), s);
    const first = s.store.codes.get(LISTED);
    if (first === undefined) throw new Error("no code item");
    first.attempts = 3;
    s.setClock(new Date(START.getTime() + CODE_TTL_SECONDS * 1000));
    s.setCode(123456);
    await answer(body(LISTED), s);
    const item = s.store.codes.get(LISTED);
    expect(item?.codes).toHaveLength(1);
    expect(await verifyCode("123456", item?.codes[0]?.codeHash ?? "")).toBe(true);
    expect(item?.attempts).toBe(0);
  });

  it("re-reads and retries the code write when another request wrote it in between", async () => {
    const s = setup();
    const put = s.store.putCode.bind(s.store);
    let calls = 0;
    s.store.putCode = async (...args) => (++calls === 1 ? false : put(...args));
    await answer(body(LISTED), s);
    expect(calls).toBe(2);
    expect(s.mailer.sent).toHaveLength(1);
  });

  it("sends nothing when the code write keeps conflicting", async () => {
    const s = setup();
    s.store.putCode = async () => false;
    await answer(body(LISTED), s);
    expect(s.mailer.sent).toEqual([]);
    expect(s.logs).toEqual([{ event: "sign-in-code", outcome: "conflict" }]);
  });

  it("criterion 2: an email not on the list gets byte-for-byte the same answer, nothing is sent or stored", async () => {
    const listed = setup();
    const stranger = setup();
    const a = await answer(body(LISTED), listed);
    const b = await answer(body(STRANGER), stranger);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    expect(b).toEqual({
      statusCode: 202,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
      body: JSON.stringify({ message: NEUTRAL_MESSAGE }),
    });
    expect(stranger.mailer.sent).toEqual([]);
    expect(stranger.store.written).toEqual([]);
    expect(stranger.store.codes.size).toBe(0);
    expect(stranger.store.requests.size).toBe(0);
  });

  it("criterion 3: the sixth request within an hour sends nothing and still gets the neutral answer", async () => {
    const s = setup();
    const { mailer, setClock, logs } = s;
    const answers: string[] = [];
    for (let i = 0; i < 6; i++) {
      setClock(new Date(START.getTime() + i * 60_000));
      answers.push(JSON.stringify(await answer(body(LISTED), s)));
    }
    expect(MAX_CODES_PER_WINDOW).toBe(5);
    expect(mailer.sent).toHaveLength(5);
    expect(new Set(answers)).toEqual(new Set([JSON.stringify(neutralResponse())]));
    expect(logs.at(-1)).toEqual({ event: "sign-in-code", outcome: "rate-limited" });
  });

  it("criterion 3: the window slides: an hour after the first code, one more may be sent", async () => {
    const s = setup();
    const { mailer, setClock, store } = s;
    for (let i = 0; i < 5; i++) {
      setClock(new Date(START.getTime() + i * 60_000));
      await answer(body(LISTED), s);
    }
    setClock(new Date(START.getTime() + (RATE_WINDOW_SECONDS - 1) * 1000));
    await answer(body(LISTED), s);
    expect(mailer.sent).toHaveLength(5);

    setClock(new Date(START.getTime() + RATE_WINDOW_SECONDS * 1000));
    await answer(body(LISTED), s);
    expect(mailer.sent).toHaveLength(6);
    // The record keeps only the window's sends and expires an hour after the newest.
    const record = store.requests.get(LISTED);
    expect(record?.sentAt).toHaveLength(5);
    expect(record?.expiresAt).toBe(START_S + 2 * RATE_WINDOW_SECONDS);
  });

  it("counts each address separately", async () => {
    const other = "other@example.com";
    const s = setup([LISTED, other]);
    for (let i = 0; i < 5; i++) await answer(body(LISTED), s);
    await answer(body(other), s);
    const { mailer } = s;
    expect(mailer.sent.map((s) => s.to)).toEqual([...Array(5).fill(LISTED), other]);
  });

  it("sends nothing when another request wrote the counter first (two requests at once)", async () => {
    const s = setup();
    const { store, mailer, logs } = s;
    store.putCodeRequests = async () => false;
    const res = await answer(body(LISTED), s);
    expect(res).toEqual(neutralResponse());
    expect(mailer.sent).toEqual([]);
    expect(store.codes.size).toBe(0);
    expect(logs).toEqual([{ event: "sign-in-code", outcome: "conflict" }]);
  });

  it.each(["isAllowListed", "getCodeRequests", "putCodeRequests", "getCode", "putCode"] as const)(
    "answers neutrally and logs only the error name when the table fails (%s)",
    async (method) => {
      const s = setup();
      const { store, mailer, logs } = s;
      store.failOn = method;
      store.failure = Object.assign(new Error(`failed for ${LISTED}`), { name: "ProvisionedThroughputExceededException" });
      const res = await answer(body(LISTED), s);
      expect(JSON.stringify(res)).toBe(JSON.stringify(neutralResponse()));
      expect(mailer.sent).toEqual([]);
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatchObject({ outcome: "failed", error: "ProvisionedThroughputExceededException" });
    },
  );

  it("answers neutrally when SES fails, and the failed send still counts toward the five", async () => {
    const s = setup();
    const { store, mailer, logs } = s;
    mailer.failure = Object.assign(new Error(`rejected ${LISTED}`), { name: "MessageRejected" });
    const res = await answer(body(LISTED), s);
    expect(JSON.stringify(res)).toBe(JSON.stringify(neutralResponse()));
    expect(logs).toEqual([{ event: "sign-in-code", outcome: "failed", step: "email", error: "MessageRejected" }]);
    expect(store.requests.get(LISTED)?.sentAt).toEqual([START_S]);
  });

  it("answers a malformed request 400 with a generic message that does not echo the input", async () => {
    const { deps, store, mailer, logs } = setup();
    // Not padded: it depends only on the input's syntax, so it is answered at once (no timer moved).
    const res = await requestCode({ body: JSON.stringify({ email: "jane@" }) }, deps);
    expect(res.statusCode).toBe(400);
    expect(res.body).toBe(JSON.stringify({ message: BAD_REQUEST_MESSAGE }));
    expect(res.body).not.toContain("jane");
    expect(res.headers).toEqual({ "content-type": "application/json", "cache-control": "no-store" });
    expect(mailer.sent).toEqual([]);
    expect(store.written).toEqual([]);
    expect(logs).toEqual([{ event: "sign-in-code", outcome: "invalid-request" }]);
  });
});

describe("requestCode answer time (fixed, so timing tells nothing)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Starts the request, lets the work finish, then checks the answer comes at exactly ANSWER_AFTER_MS. */
  async function expectAnswerAtDeadline(s: Setup, email: string) {
    const pending = track(requestCode(body(email), s.deps));
    await settle(() => s.logs.length > 0);
    expect(pending.done()).toBe(false);
    await vi.advanceTimersByTimeAsync(ANSWER_AFTER_MS - 1);
    expect(pending.done()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(pending.done()).toBe(true);
    expect(JSON.stringify(await pending.promise)).toBe(JSON.stringify(neutralResponse()));
  }

  it("a listed, an unlisted, a rate-limited and a failing request all resolve at exactly the fixed time", async () => {
    expect(ANSWER_AFTER_MS).toBe(3000);

    const listed = setup();
    await expectAnswerAtDeadline(listed, LISTED);
    expect(listed.logs).toEqual([{ event: "sign-in-code", outcome: "sent" }]);

    const unlisted = setup();
    await expectAnswerAtDeadline(unlisted, STRANGER);
    expect(unlisted.logs).toEqual([{ event: "sign-in-code", outcome: "not-listed" }]);

    const limited = setup();
    limited.store.requests.set(LISTED, { sentAt: [1, 2, 3, 4, 5].map((i) => START_S - i), version: 5, expiresAt: START_S + 3600 });
    await expectAnswerAtDeadline(limited, LISTED);
    expect(limited.logs).toEqual([{ event: "sign-in-code", outcome: "rate-limited" }]);

    const failing = setup();
    failing.store.failOn = "isAllowListed";
    await expectAnswerAtDeadline(failing, LISTED);
    expect(failing.logs).toMatchObject([{ outcome: "failed", step: "allow-list" }]);
  });

  it("a mailer that never resolves still gets the neutral 202 at the deadline, logged as a timeout", async () => {
    const s = setup();
    let called = false;
    s.mailer.send = () => {
      called = true;
      return new Promise<void>(() => undefined);
    };
    const pending = track(requestCode(body(LISTED), s.deps));
    await settle(() => called);
    await vi.advanceTimersByTimeAsync(ANSWER_AFTER_MS - 1);
    expect(pending.done()).toBe(false);
    expect(s.logs).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(pending.done()).toBe(true);
    expect(JSON.stringify(await pending.promise)).toBe(JSON.stringify(neutralResponse()));
    expect(s.logs).toEqual([{ event: "sign-in-code", outcome: "failed", step: "email", error: "Timeout" }]);
  });

  it("a table call that never resolves gets the same answer at the deadline", async () => {
    const s = setup();
    s.store.isAllowListed = () => new Promise<boolean>(() => undefined);
    const pending = track(requestCode(body(STRANGER), s.deps));
    await vi.advanceTimersByTimeAsync(ANSWER_AFTER_MS);
    expect(pending.done()).toBe(true);
    expect(JSON.stringify(await pending.promise)).toBe(JSON.stringify(neutralResponse()));
    expect(s.logs).toEqual([{ event: "sign-in-code", outcome: "failed", step: "allow-list", error: "Timeout" }]);
  });

  it("the 400 for a malformed request is not padded", async () => {
    const s = setup();
    const pending = track(requestCode({ body: "not json" }, s.deps));
    await settle(pending.done);
    expect((await pending.promise).statusCode).toBe(400);
  });
});
