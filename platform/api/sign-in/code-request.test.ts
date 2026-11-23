import { describe, expect, it } from "vitest";
import type { HttpRequest } from "../http.js";
import {
  BAD_REQUEST_MESSAGE,
  CODE_TTL_SECONDS,
  MAX_CODES_PER_WINDOW,
  NEUTRAL_MESSAGE,
  RATE_WINDOW_SECONDS,
  errorName,
  generateCode,
  hashCode,
  neutralResponse,
  parseCodeRequest,
  recentSends,
  requestCode,
  verifyCode,
  type CodeRequestDeps,
  type LogEntry,
} from "./code-request.js";
import { FakeMailer, FakeStore } from "./fakes.js";

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

describe("parseCodeRequest", () => {
  it("reads {\"email\"} and normalizes it", () => {
    expect(parseCodeRequest(body("  Jane.Doe@Example.COM "))).toBe(LISTED);
  });

  it("reads a base64 body (API Gateway sets isBase64Encoded)", () => {
    const encoded = Buffer.from(JSON.stringify({ email: LISTED })).toString("base64");
    expect(parseCodeRequest({ body: encoded, isBase64Encoded: true })).toBe(LISTED);
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
  it("criterion 1: a listed email gets one code email, and the stored code is a hash valid 10 minutes", async () => {
    const { deps, store, mailer, logs } = setup();
    const res = await requestCode(body("Jane.Doe@example.com"), deps);
    expect(res).toEqual(neutralResponse());

    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]?.to).toBe(LISTED);
    expect(mailer.sent[0]?.email.subject).toBe("Your SSD Workshop sign-in code: 042917");

    const stored = store.codes.get(LISTED);
    expect(stored).toMatchObject({ attempts: 0, createdAt: START.toISOString(), expiresAt: START_S + CODE_TTL_SECONDS });
    expect(CODE_TTL_SECONDS).toBe(600);
    expect(stored?.codeHash).not.toContain("042917");
    expect(await verifyCode("042917", stored?.codeHash ?? "")).toBe(true);
    expect(logs).toEqual([{ event: "sign-in-code", outcome: "sent" }]);
  });

  it("criterion 1: a new code replaces the previous one", async () => {
    const { deps, store, setCode } = setup();
    await requestCode(body(LISTED), deps);
    setCode(123456);
    await requestCode(body(LISTED), deps);
    const hash = store.codes.get(LISTED)?.codeHash ?? "";
    expect(await verifyCode("123456", hash)).toBe(true);
    expect(await verifyCode("042917", hash)).toBe(false);
  });

  it("criterion 2: an email not on the list gets byte-for-byte the same answer, nothing is sent or stored", async () => {
    const listed = setup();
    const stranger = setup();
    const a = await requestCode(body(LISTED), listed.deps);
    const b = await requestCode(body(STRANGER), stranger.deps);
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
    const { deps, mailer, setClock, logs } = setup();
    const answers: string[] = [];
    for (let i = 0; i < 6; i++) {
      setClock(new Date(START.getTime() + i * 60_000));
      answers.push(JSON.stringify(await requestCode(body(LISTED), deps)));
    }
    expect(MAX_CODES_PER_WINDOW).toBe(5);
    expect(mailer.sent).toHaveLength(5);
    expect(new Set(answers)).toEqual(new Set([JSON.stringify(neutralResponse())]));
    expect(logs.at(-1)).toEqual({ event: "sign-in-code", outcome: "rate-limited" });
  });

  it("criterion 3: the window slides: an hour after the first code, one more may be sent", async () => {
    const { deps, mailer, setClock, store } = setup();
    for (let i = 0; i < 5; i++) {
      setClock(new Date(START.getTime() + i * 60_000));
      await requestCode(body(LISTED), deps);
    }
    setClock(new Date(START.getTime() + (RATE_WINDOW_SECONDS - 1) * 1000));
    await requestCode(body(LISTED), deps);
    expect(mailer.sent).toHaveLength(5);

    setClock(new Date(START.getTime() + RATE_WINDOW_SECONDS * 1000));
    await requestCode(body(LISTED), deps);
    expect(mailer.sent).toHaveLength(6);
    // The record keeps only the window's sends and expires an hour after the newest.
    const record = store.requests.get(LISTED);
    expect(record?.sentAt).toHaveLength(5);
    expect(record?.expiresAt).toBe(START_S + 2 * RATE_WINDOW_SECONDS);
  });

  it("counts each address separately", async () => {
    const other = "other@example.com";
    const { deps, mailer } = setup([LISTED, other]);
    for (let i = 0; i < 5; i++) await requestCode(body(LISTED), deps);
    await requestCode(body(other), deps);
    expect(mailer.sent.map((s) => s.to)).toEqual([...Array(5).fill(LISTED), other]);
  });

  it("sends nothing when another request wrote the counter first (two requests at once)", async () => {
    const { deps, store, mailer, logs } = setup();
    store.putCodeRequests = async () => false;
    const res = await requestCode(body(LISTED), deps);
    expect(res).toEqual(neutralResponse());
    expect(mailer.sent).toEqual([]);
    expect(store.codes.size).toBe(0);
    expect(logs).toEqual([{ event: "sign-in-code", outcome: "conflict" }]);
  });

  it.each(["isAllowListed", "getCodeRequests", "putCodeRequests", "putCode"] as const)(
    "answers neutrally and logs only the error name when the table fails (%s)",
    async (method) => {
      const { deps, store, mailer, logs } = setup();
      store.failOn = method;
      store.failure = Object.assign(new Error(`failed for ${LISTED}`), { name: "ProvisionedThroughputExceededException" });
      const res = await requestCode(body(LISTED), deps);
      expect(JSON.stringify(res)).toBe(JSON.stringify(neutralResponse()));
      expect(mailer.sent).toEqual([]);
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatchObject({ outcome: "failed", error: "ProvisionedThroughputExceededException" });
    },
  );

  it("answers neutrally when SES fails, and the failed send still counts toward the five", async () => {
    const { deps, store, mailer, logs } = setup();
    mailer.failure = Object.assign(new Error(`rejected ${LISTED}`), { name: "MessageRejected" });
    const res = await requestCode(body(LISTED), deps);
    expect(JSON.stringify(res)).toBe(JSON.stringify(neutralResponse()));
    expect(logs).toEqual([{ event: "sign-in-code", outcome: "failed", step: "email", error: "MessageRejected" }]);
    expect(store.requests.get(LISTED)?.sentAt).toEqual([START_S]);
  });

  it("answers a malformed request 400 with a generic message that does not echo the input", async () => {
    const { deps, store, mailer, logs } = setup();
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
