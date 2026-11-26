// Ticket 2.4: the data API's rules, on the in-memory store (criteria 1 to 4; 5 is browser.test.ts,
// 6 is handlers/app-data.test.ts). Ticket 3.17 raised the limits: 10 MB per app, 350 KB per value,
// 500 keys, 50 MB written per app and UTC day (its criteria 1 to 4 are marked "3.17").
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HttpRequest, HttpResponse } from "../http.js";
import { FakeAppDataStore } from "./fakes.js";
import { hashAppToken } from "../app-token/token.js";
import {
  APP_DATA_MESSAGES,
  APP_DATA_ROUTES,
  CORS_HEADERS,
  DAILY_WRITE_BUDGET_BYTES,
  DATA_KEY_PATTERN,
  handleAppDataRequest,
  MAX_APP_DATA_BYTES,
  MAX_DEPTH,
  MAX_KEYS,
  MAX_VALUE_BYTES,
  MIN_WRITE_COST_BYTES,
  pauseBeforeRetry,
  PREFLIGHT_HEADERS,
  RETRY_PAUSE_MS,
  retryPauseMs,
  USAGE_ENTRY_BYTES,
  USAGE_ITEM_BASE_BYTES,
  usageItemBytes,
  VALUE_ITEM_OVERHEAD_BYTES,
  WRITE_ATTEMPTS,
  writeCost,
  type AppDataLogEntry,
} from "./data.js";

const NICK = "Ada-42";
const NOW = new Date("2026-11-24T10:00:00.000Z");
/** Ticket 3.24: the write token every write below carries unless it says otherwise (made for each live app, writer Bob). */
const WRITE_TOKEN = Buffer.alloc(32, 9).toString("base64url");
const tokenFor = (nickname: string): string => Buffer.from(`${nickname.toLowerCase()}`.padEnd(32, "-")).toString("base64url");

function setup(live: string[] = [NICK]) {
  const store = new FakeAppDataStore();
  for (const nickname of live) store.live.add(nickname.toLowerCase());
  store.tokens.tokens.set(hashAppToken(WRITE_TOKEN), { app: NICK.toLowerCase(), nickname: "Bob", expiresAt: NOW.getTime() / 1000 + 3 * 86400 });
  for (const nickname of live) store.tokens.tokens.set(hashAppToken(tokenFor(nickname)), { app: nickname.toLowerCase(), nickname: "Bob", expiresAt: NOW.getTime() / 1000 + 3 * 86400 });
  const logs: AppDataLogEntry[] = [];
  const clock = { now: NOW };
  let pauses = 0;
  const call = (request: HttpRequest): Promise<HttpResponse> =>
    handleAppDataRequest(request, {
      store,
      tokens: store.tokens,
      now: () => clock.now,
      log: (entry) => logs.push(entry),
      pause: async () => {
        pauses += 1;
      },
    });
  return { store, logs, call, clock, pauses: () => pauses };
}

const route = (method: string) => `${method} /api/apps/{nickname}/data/{key}`;

function request(
  method: string,
  key: string,
  options: { nickname?: string; body?: string; contentType?: string | null; cookies?: string[]; base64?: boolean; token?: string | null } = {},
): HttpRequest {
  const headers: Record<string, string> = { origin: "null", accept: "application/json" };
  // Ticket 3.24: writes carry the app's write token unless `token: null`.
  const token = options.token === undefined ? (method === "PUT" || method === "DELETE" ? tokenFor(options.nickname ?? NICK) : null) : options.token;
  if (token !== null) headers["authorization"] = `Bearer ${token}`;
  const contentType = options.contentType === undefined ? (method === "PUT" ? "application/json" : null) : options.contentType;
  if (contentType !== null) headers["content-type"] = contentType;
  return {
    routeKey: route(method),
    pathParameters: { nickname: options.nickname ?? NICK, key },
    headers,
    ...(options.body === undefined ? {} : { body: options.base64 === true ? Buffer.from(options.body).toString("base64") : options.body }),
    ...(options.base64 === true ? { isBase64Encoded: true } : {}),
    ...(options.cookies === undefined ? {} : { cookies: options.cookies }),
  };
}

const put = (key: string, value: unknown, options: Parameters<typeof request>[2] = {}) =>
  request("PUT", key, { body: JSON.stringify(value), ...options });

/** A JSON string value whose canonical text is exactly `bytes` bytes long. */
const valueOfBytes = (bytes: number): string => "x".repeat(bytes - 2);

const snapshot = (store: FakeAppDataStore) => JSON.stringify({ values: [...store.values], usage: [...store.usage], written: [...store.written] });

describe("the data API's routes and limits", () => {
  it("serves GET, PUT, DELETE and OPTIONS on /api/apps/{nickname}/data/{key}", () => {
    expect([...APP_DATA_ROUTES]).toEqual(["GET", "PUT", "DELETE", "OPTIONS"].map(route));
  });

  it("limits an app to 10 MB, a value to 350 KB and an app to 500 keys of 1 to 64 letters, digits, dashes and underscores (ticket 3.17)", () => {
    expect(MAX_APP_DATA_BYTES).toBe(10 * 1024 * 1024);
    expect(MAX_VALUE_BYTES).toBe(350 * 1024);
    expect(MAX_KEYS).toBe(500);
    for (const good of ["a", "High_score-1", "x".repeat(64), "0", "-", "_"]) expect(DATA_KEY_PATTERN.test(good), good).toBe(true);
    for (const bad of ["", "x".repeat(65), "a b", "a.b", "a/b", "a#b", "é", "a%2Fb", "../me"]) expect(DATA_KEY_PATTERN.test(bad), bad).toBe(false);
  });
});

describe("criterion 1: an app stores a value and reads it back as the same JSON", () => {
  it("round-trips numbers, text, lists, objects, booleans and null", async () => {
    const { call } = setup();
    const values: unknown[] = [42, -1.5, 0, "Hello, Ada", "", "naïve ☕ 😀", [1, "two", [3]], { name: "Ada's list", items: [1, 2, 3], done: false, nested: { a: null } }, true, false, null];
    for (const [index, value] of values.entries()) {
      const key = `k${index}`;
      const written = await call(put(key, value));
      expect(written.statusCode, key).toBe(204);
      expect(written.body, key).toBeUndefined();
      const read = await call(request("GET", key));
      expect(read.statusCode, key).toBe(200);
      expect(read.headers).toMatchObject({ "content-type": "application/json", "cache-control": "no-store" });
      expect(JSON.parse(read.body ?? ""), key).toEqual(value);
    }
  });

  it("3.17 criterion 1: stores a 300 KB value and reads it back unchanged, sent plain or base64", async () => {
    const { call, store } = setup();
    // An object of mixed text (accents, emoji: multi-byte UTF-8) whose canonical JSON is ~300 KB.
    const value = { title: "Galerie d'Ada ☕", items: Array.from({ length: 2400 }, (_, i) => ({ id: i, note: `Note ${i}: naïve 😀 ${"x".repeat(90)}` })) };
    const text = JSON.stringify(value);
    const bytes = Buffer.byteLength(text, "utf8");
    expect(bytes).toBeGreaterThan(300 * 1024);
    expect(bytes).toBeLessThanOrEqual(MAX_VALUE_BYTES);
    for (const base64 of [false, true]) {
      const key = base64 ? "b64" : "plain";
      expect((await call(request("PUT", key, { body: text, base64 }))).statusCode, key).toBe(204);
      const read = await call(request("GET", key));
      expect(read.statusCode, key).toBe(200);
      expect(read.body, key).toBe(text);
      expect(JSON.parse(read.body ?? ""), key).toEqual(value);
      expect(store.values.get(`ada-42/${key}`)?.bytes, key).toBe(bytes);
    }
    // A string value of exactly 300 KB too.
    expect((await call(put("exact", valueOfBytes(300 * 1024)))).statusCode).toBe(204);
    expect((await call(request("GET", "exact"))).body).toBe(JSON.stringify(valueOfBytes(300 * 1024)));
  });

  it("replaces a value, and answers a missing key 200 null", async () => {
    const { call } = setup();
    expect((await call(request("GET", "score"))).body).toBe("null");
    await call(put("score", 1));
    await call(put("score", { best: 2 }));
    expect((await call(request("GET", "score"))).body).toBe('{"best":2}');
  });

  it("deletes a value (204), after which it reads as null; deleting a missing key is also 204", async () => {
    const { call, store } = setup();
    await call(put("score", 7));
    expect((await call(request("DELETE", "score"))).statusCode).toBe(204);
    expect((await call(request("GET", "score"))).body).toBe("null");
    expect((await call(request("DELETE", "score"))).statusCode).toBe(204);
    expect(store.usage.get("ada-42")).toEqual({ bytes: 0, keys: 0 });
  });

  it("stores canonical JSON (whitespace dropped) and counts its UTF-8 bytes", async () => {
    const { call, store } = setup();
    await call(request("PUT", "list", { body: ' [ 1 ,\n 2 , "é" ] ' }));
    expect(store.values.get("ada-42/list")).toEqual({ json: '[1,2,"é"]', bytes: 10, updatedBy: "Bob", updatedAt: NOW.toISOString() });
    expect(store.usage.get("ada-42")).toEqual({ bytes: 10, keys: 1 });
  });

  it("reads a base64 body as API Gateway may send it", async () => {
    const { call } = setup();
    expect((await call(put("b", { ok: true }, { base64: true }))).statusCode).toBe(204);
    expect((await call(request("GET", "b"))).body).toBe('{"ok":true}');
  });

  it("matches the nickname regardless of case: Ada-42 and ada-42 are one app", async () => {
    const { call } = setup();
    await call(put("score", 3, { nickname: "ADA-42" }));
    expect((await call(request("GET", "score", { nickname: "ada-42" }))).body).toBe("3");
  });

  it("keeps each app's data apart", async () => {
    const { call } = setup([NICK, "grace"]);
    await call(put("score", 1));
    expect((await call(request("GET", "score", { nickname: "grace" }))).body).toBe("null");
  });
});

describe("criterion 2: a write past a limit is refused with 413 and a plain reason, and nothing is stored", () => {
  it("3.17 criterion 2: refuses a value over 350 KB (canonical JSON) with 413, keeping the stored one", async () => {
    const { call, store } = setup();
    expect((await call(put("big", valueOfBytes(MAX_VALUE_BYTES)))).statusCode).toBe(204);
    await call(put("big", "small"));
    const before = snapshot(store);
    const response = await call(put("big", valueOfBytes(MAX_VALUE_BYTES + 1)));
    expect(response.statusCode).toBe(413);
    expect(JSON.parse(response.body ?? "")).toEqual({ message: APP_DATA_MESSAGES.valueTooBig });
    expect(APP_DATA_MESSAGES.valueTooBig).toBe("This value is too big: a value can hold at most 350 KB.");
    expect(snapshot(store)).toBe(before);
  });

  it("refuses a body over 350 KB before parsing it, base64 or not", async () => {
    const { call, store } = setup();
    const padded = `${" ".repeat(MAX_VALUE_BYTES)}1`;
    expect((await call(request("PUT", "a", { body: padded }))).statusCode).toBe(413);
    expect((await call(request("PUT", "a", { body: padded, base64: true }))).statusCode).toBe(413);
    expect((await call(request("PUT", "a", { body: "x".repeat(MAX_VALUE_BYTES * 2), base64: false }))).statusCode).toBe(413);
    expect(store.values.size).toBe(0);
    // The largest value still passes base64 (the raw limit is not below it).
    expect((await call(put("max", valueOfBytes(MAX_VALUE_BYTES), { base64: true }))).statusCode).toBe(204);
  });

  it("refuses a value that canonical JSON makes longer than 350 KB (numbers written short)", async () => {
    const { call, store } = setup();
    // 1e21 stays "1e+21", but 1e20 becomes "100000000000000000000": 4 bytes sent, 21 stored.
    const body = `[${Array.from({ length: Math.ceil(MAX_VALUE_BYTES / 22) + 1 }, () => "1e20").join(",")}]`;
    expect(Buffer.byteLength(body)).toBeLessThanOrEqual(MAX_VALUE_BYTES);
    const response = await call(request("PUT", "n", { body }));
    expect(response.statusCode).toBe(413);
    expect(store.values.size).toBe(0);
  });

  it("3.17 criterion 3: refuses a write that would take the app past 10 MB, naming 10 MB, keeping everything as it was", async () => {
    const { call, store } = setup();
    const full = Math.floor(MAX_APP_DATA_BYTES / MAX_VALUE_BYTES); // 29 values of 350 KB
    expect(full).toBe(29);
    for (let i = 0; i < full; i += 1) expect((await call(put(`v${i}`, valueOfBytes(MAX_VALUE_BYTES)))).statusCode).toBe(204);
    const left = MAX_APP_DATA_BYTES - full * MAX_VALUE_BYTES; // 90 KB
    expect(left).toBe(90 * 1024);
    expect((await call(put("last", valueOfBytes(left)))).statusCode).toBe(204);
    expect(store.usage.get("ada-42")?.bytes).toBe(MAX_APP_DATA_BYTES);
    const before = snapshot(store);
    for (const [key, value] of [["more", 1], ["last", valueOfBytes(left + 1)]] as const) {
      const response = await call(put(key, value));
      expect(response.statusCode, key).toBe(413);
      expect(JSON.parse(response.body ?? ""), key).toEqual({ message: APP_DATA_MESSAGES.appFull });
    }
    expect(APP_DATA_MESSAGES.appFull).toBe("This app has no room left: an app can store at most 10 MB.");
    expect(snapshot(store)).toBe(before);
    // A smaller value in place of a bigger one still fits, and a delete makes room.
    expect((await call(put("last", valueOfBytes(left - 1)))).statusCode).toBe(204);
    expect((await call(request("DELETE", "v0"))).statusCode).toBe(204);
    expect((await call(put("more", 1))).statusCode).toBe(204);
  });

  it("refuses a 501st key, while the 500 keys can still be replaced", async () => {
    const { call, store } = setup();
    for (let i = 0; i < MAX_KEYS; i += 1) expect((await call(put(`k${i}`, i))).statusCode).toBe(204);
    const before = snapshot(store);
    const response = await call(put("one-more", 1));
    expect(response.statusCode).toBe(413);
    expect(JSON.parse(response.body ?? "")).toEqual({ message: APP_DATA_MESSAGES.tooManyKeys });
    expect(APP_DATA_MESSAGES.tooManyKeys).toBe("This app already has 500 keys, the most it can keep. Remove one to add another.");
    expect(snapshot(store)).toBe(before);
    expect((await call(put("k5", "changed"))).statusCode).toBe(204);
    expect(store.usage.get("ada-42")?.keys).toBe(MAX_KEYS);
  });

  it("never lets parallel writes pass 500 keys or 10 MB (the store's conditions hold, not the earlier read)", async () => {
    const { call, store } = setup();
    const keys = await Promise.all(Array.from({ length: MAX_KEYS + 30 }, (_, i) => call(put(`p${i}`, i))));
    expect(keys.filter((r) => r.statusCode === 204)).toHaveLength(MAX_KEYS);
    expect(keys.every((r) => [204, 409, 413].includes(r.statusCode))).toBe(true);
    expect(store.usage.get("ada-42")?.keys).toBe(MAX_KEYS);
    expect([...store.values.keys()].filter((k) => k.startsWith("ada-42/"))).toHaveLength(MAX_KEYS);

    const other = setup();
    const fit = Math.floor(MAX_APP_DATA_BYTES / MAX_VALUE_BYTES);
    const big = await Promise.all(Array.from({ length: fit + 4 }, (_, i) => other.call(put(`b${i}`, valueOfBytes(MAX_VALUE_BYTES)))));
    expect(big.filter((r) => r.statusCode === 204)).toHaveLength(fit);
    const total = [...other.store.values.values()].reduce((sum, v) => sum + v.bytes, 0);
    expect(total).toBeLessThanOrEqual(MAX_APP_DATA_BYTES);
    expect(other.store.usage.get("ada-42")).toEqual({ bytes: total, keys: fit });
  });

  it("tries again when another write got in between, pausing between tries, and answers 409 after 4 lost races, storing nothing", async () => {
    const { call, store, pauses } = setup();
    expect(WRITE_ATTEMPTS).toBe(4);
    await call(put("score", 1));
    let races = 0;
    store.beforeWrite = () => {
      races += 1;
      // A different size each time (the write's condition is on the stored value's size).
      store.values.set("ada-42/score", { json: "9".repeat(races + 1), bytes: races + 1 });
    };
    const response = await call(put("score", 2));
    expect(races).toBe(WRITE_ATTEMPTS);
    expect(pauses()).toBe(WRITE_ATTEMPTS - 1);
    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.body ?? "")).toEqual({ message: APP_DATA_MESSAGES.conflict });
    expect(store.values.get("ada-42/score")?.json).toBe("9".repeat(WRITE_ATTEMPTS + 1));

    let once = true;
    store.beforeWrite = () => {
      if (once) store.values.set("ada-42/score", { json: "77777", bytes: 5 });
      once = false;
    };
    expect((await call(put("score", 5))).statusCode).toBe(204);
    expect((await call(request("GET", "score"))).body).toBe("5");
  });
});

describe("the pause between tries after a lost race", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("is a random 20 to 80 ms, so writers that collided on the totals item do not collide again", () => {
    expect(RETRY_PAUSE_MS).toEqual({ min: 20, max: 80 });
    expect(retryPauseMs(() => 0)).toBe(20);
    expect(retryPauseMs(() => 0.5)).toBe(50);
    expect(retryPauseMs(() => 0.999999)).toBe(80);
    for (let i = 0; i < 200; i += 1) {
      const ms = retryPauseMs(Math.random);
      expect(Number.isInteger(ms) && ms >= 20 && ms <= 80, String(ms)).toBe(true);
    }
  });

  it("waits that long on a timer", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let done = false;
    void pauseBeforeRetry(() => 0.5).then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(49);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toBe(true);
  });

  it("is not taken after a write that succeeded or failed on a real limit", async () => {
    const { call, pauses } = setup();
    await call(put("score", 1));
    await call(put("big", valueOfBytes(MAX_VALUE_BYTES + 1)));
    for (let i = 0; i < MAX_KEYS; i += 1) await call(put(`k${i}`, i));
    expect((await call(put("one-more", 1))).statusCode).toBe(413);
    expect(pauses()).toBe(0);
  });
});

describe("the daily write budget: replacing values in a loop cannot run up the table's write cost", () => {
  const TODAY = "2026-11-24";
  const YESTERDAY = "2026-11-23";
  const TOMORROW = "2026-11-25";
  /** What DynamoDB bills a write of a small value in a small app (value item 1 KB + totals item 1 KB), and of a 350 KB one. */
  const SMALL = 2 * 1024;
  /** 350 KB + 256 bytes of item overhead is 351 KB in whole KB, plus the 1 KB totals item. */
  const BIG = 351 * 1024 + 1024;
  /** The totals item of an app with 500 keys of 64 characters: 256 + 500 x 72 bytes, 36 KB in whole KB. */
  const LONG_KEYS_TOTALS = 36 * 1024;

  it("counts each write as what DynamoDB bills it: both items, in whole KB, at the larger of the old and new value", () => {
    expect(MIN_WRITE_COST_BYTES).toBe(1024);
    expect(VALUE_ITEM_OVERHEAD_BYTES).toBe(256);
    const none = new Map<string, number>();
    expect(writeCost(1, undefined, none, "score")).toBe(SMALL);
    expect(writeCost(768, undefined, none, "score")).toBe(SMALL);
    expect(writeCost(769, undefined, none, "score")).toBe(3 * 1024);
    expect(writeCost(MAX_VALUE_BYTES, undefined, none, "score")).toBe(BIG);
    // DynamoDB bills the larger of the old and the new item: replacing 350 KB with 1 byte, or deleting it.
    expect(writeCost(1, MAX_VALUE_BYTES, none, "score")).toBe(BIG);
    expect(writeCost(undefined, MAX_VALUE_BYTES, none, "score")).toBe(BIG);
    expect(writeCost(undefined, 1, none, "score")).toBe(SMALL);
    // Always at least max(1 KB, bytes, previous bytes).
    for (const [bytes, previous] of [[1, undefined], [5000, 70_000], [MAX_VALUE_BYTES, 3]] as const) {
      expect(writeCost(bytes, previous, none, "k")).toBeGreaterThanOrEqual(Math.max(1024, bytes, previous ?? 0));
    }
    // The totals item grows with the keys: 500 keys of 64 characters make it ~35.4 KB, rewritten by every write.
    const long = new Map(Array.from({ length: MAX_KEYS }, (_, i) => [String(i).padStart(64, "k"), 1] as const));
    expect(usageItemBytes(long, String(0).padStart(64, "k"))).toBe(USAGE_ITEM_BASE_BYTES + MAX_KEYS * (64 + USAGE_ENTRY_BYTES));
    expect(writeCost(1, 1, long, String(0).padStart(64, "k"))).toBe(1024 + LONG_KEYS_TOTALS);
  });

  it("allows 50 MB of writes per app and UTC day, counting PUTs and DELETEs as they are billed; reads and refused writes count nothing", async () => {
    expect(DAILY_WRITE_BUDGET_BYTES).toBe(50 * 1024 * 1024);
    expect(APP_DATA_MESSAGES.writeBudget).toBe("This app has saved a lot of data today. Saving starts again tomorrow.");
    const { call, store } = setup();
    await call(put("score", 1));
    expect(store.written.get("ada-42")).toEqual({ day: TODAY, bytes: SMALL });
    await call(put("big", valueOfBytes(MAX_VALUE_BYTES)));
    expect(store.written.get("ada-42")).toEqual({ day: TODAY, bytes: SMALL + BIG });
    // A DELETE counts the value it removes.
    await call(request("DELETE", "big"));
    expect(store.written.get("ada-42")).toEqual({ day: TODAY, bytes: SMALL + 2 * BIG });
    // Reads, refused writes and deleting a missing key cost nothing.
    await call(request("GET", "score"));
    await call(request("DELETE", "missing"));
    await call(put("bad key", 1));
    await call(put("too-big", valueOfBytes(MAX_VALUE_BYTES + 1)));
    expect(store.written.get("ada-42")).toEqual({ day: TODAY, bytes: SMALL + 2 * BIG });
  });

  it("counts the totals item an app with many long keys rewrites on every write", async () => {
    const { call, store } = setup();
    const keys = Array.from({ length: MAX_KEYS }, (_, i) => String(i).padStart(64, "k"));
    for (const key of keys) expect((await call(put(key, 1))).statusCode).toBe(204);
    const before = store.written.get("ada-42")?.bytes ?? 0;
    expect((await call(put(keys[0] ?? "", 2))).statusCode).toBe(204);
    expect((store.written.get("ada-42")?.bytes ?? 0) - before).toBe(1024 + LONG_KEYS_TOTALS);
  });

  it("refuses a PUT or DELETE past the budget with 429 and a plain reason, storing nothing; reads still work", async () => {
    const { call, store, logs } = setup();
    await call(put("score", 1));
    store.written.set("ada-42", { day: TODAY, bytes: DAILY_WRITE_BUDGET_BYTES - 2 * SMALL });
    expect((await call(put("score", 2))).statusCode).toBe(204);
    // A 350 KB value no longer fits, a small one still does (exactly reaching the budget).
    expect((await call(put("big", valueOfBytes(MAX_VALUE_BYTES)))).statusCode).toBe(429);
    expect((await call(put("score", 3))).statusCode).toBe(204);
    expect(store.written.get("ada-42")).toEqual({ day: TODAY, bytes: DAILY_WRITE_BUDGET_BYTES });
    const before = snapshot(store);
    for (const r of [put("score", 4), put("other", 1), request("DELETE", "score")]) {
      const response = await call(r);
      expect(response.statusCode, r.routeKey).toBe(429);
      expect(JSON.parse(response.body ?? ""), r.routeKey).toEqual({ message: APP_DATA_MESSAGES.writeBudget });
      expect(response.headers).toMatchObject({ ...CORS_HEADERS, "cache-control": "no-store" });
    }
    expect(snapshot(store)).toBe(before);
    expect((await call(request("GET", "score"))).body).toBe("3");
    expect(logs.filter((l) => l.status === 429).map((l) => l.outcome)).toEqual(["write-budget", "write-budget", "write-budget", "write-budget"]);
  });

  it("3.17 criterion 4: stops a loop of 350 KB replacements of one key once it has written 50 MB in the UTC day (145 writes)", async () => {
    const { call, store } = setup();
    const allowed = Math.floor(DAILY_WRITE_BUDGET_BYTES / BIG);
    expect(allowed).toBe(145);
    for (let i = 0; i < allowed; i += 1) {
      expect((await call(put("same", valueOfBytes(MAX_VALUE_BYTES - (i % 2))))).statusCode, String(i)).toBe(204);
    }
    const refused = await call(put("same", valueOfBytes(MAX_VALUE_BYTES)));
    expect(refused.statusCode).toBe(429);
    expect(JSON.parse(refused.body ?? "")).toEqual({ message: APP_DATA_MESSAGES.writeBudget });
    expect(store.written.get("ada-42")?.bytes).toBeLessThanOrEqual(DAILY_WRITE_BUDGET_BYTES);
  });

  it("3.17 criterion 4: refuses the next write, small or not, once an app has written exactly 50 MB in the UTC day, storing nothing", async () => {
    const { call, store } = setup();
    await call(put("score", 1));
    store.written.set("ada-42", { day: TODAY, bytes: 50 * 1024 * 1024 });
    const before = snapshot(store);
    for (const r of [put("score", 2), put("new", 1), request("DELETE", "score")]) {
      const response = await call(r);
      expect(response.statusCode, r.routeKey).toBe(429);
      expect(JSON.parse(response.body ?? ""), r.routeKey).toEqual({ message: "This app has saved a lot of data today. Saving starts again tomorrow." });
    }
    expect(snapshot(store)).toBe(before);
  });

  it("charges the 'PUT 350 KB, then PUT 1' trick honestly: replacing a big value counts the big value it overwrites", async () => {
    const { call, store } = setup();
    let writes = 0;
    for (;;) {
      const big = writes % 2 === 0;
      const before = store.written.get("ada-42")?.bytes ?? 0;
      const response = await call(put("same", big ? valueOfBytes(MAX_VALUE_BYTES) : 1));
      if (response.statusCode === 429) break;
      expect(response.statusCode).toBe(204);
      // Each write, the small one too, counts at least the 350 KB value item DynamoDB rewrites.
      expect((store.written.get("ada-42")?.bytes ?? 0) - before, String(writes)).toBe(BIG);
      writes += 1;
    }
    // Try 2 counted 101 KB a pair (100 KB + 1 KB) and let ~400 writes through a day (20 MB); then 50 in 5 MB; since 3.17, 145 in 50 MB.
    expect(writes).toBe(145);
    expect(store.written.get("ada-42")?.bytes).toBeLessThanOrEqual(DAILY_WRITE_BUDGET_BYTES);
  });

  it("starts again at 0 on the next UTC day", async () => {
    const { call, store, clock } = setup();
    clock.now = new Date("2026-11-24T23:59:59.999Z");
    store.written.set("ada-42", { day: TODAY, bytes: DAILY_WRITE_BUDGET_BYTES });
    expect((await call(put("score", 1))).statusCode).toBe(429);
    clock.now = new Date("2026-11-25T00:00:00.000Z");
    expect((await call(put("score", 1))).statusCode).toBe(204);
    expect(store.written.get("ada-42")).toEqual({ day: "2026-11-25", bytes: SMALL });
    // An old day's count, however high, never holds a write back.
    store.written.set("ada-42", { day: YESTERDAY, bytes: DAILY_WRITE_BUDGET_BYTES * 3 });
    clock.now = NOW;
    expect((await call(request("DELETE", "score"))).statusCode).toBe(204);
    expect(store.written.get("ada-42")).toEqual({ day: TODAY, bytes: SMALL });
  });

  it("never moves the day back: a stored day later than today (another instance's clock ahead) is a lost race, never a reset", async () => {
    const { call, store, pauses } = setup();
    await call(put("score", 1));
    store.written.set("ada-42", { day: TOMORROW, bytes: DAILY_WRITE_BUDGET_BYTES });
    const before = snapshot(store);
    for (const r of [put("score", 2), put("other", 1), request("DELETE", "score")]) {
      const response = await call(r);
      expect(response.statusCode, r.routeKey).toBe(409);
      expect(JSON.parse(response.body ?? ""), r.routeKey).toEqual({ message: APP_DATA_MESSAGES.conflict });
    }
    expect(pauses()).toBe(3 * (WRITE_ATTEMPTS - 1));
    expect(snapshot(store)).toBe(before);
    expect(store.written.get("ada-42")).toEqual({ day: TOMORROW, bytes: DAILY_WRITE_BUDGET_BYTES });
  });

  it("never lets parallel writes pass the budget (the store's condition holds, not the earlier read)", async () => {
    const { call, store } = setup();
    store.written.set("ada-42", { day: TODAY, bytes: DAILY_WRITE_BUDGET_BYTES - 50 * SMALL });
    const answers = await Promise.all(Array.from({ length: 90 }, (_, i) => call(put(`p${i}`, i))));
    expect(answers.filter((r) => r.statusCode === 204)).toHaveLength(50);
    expect(answers.every((r) => [204, 409, 429].includes(r.statusCode))).toBe(true);
    expect(store.written.get("ada-42")).toEqual({ day: TODAY, bytes: DAILY_WRITE_BUDGET_BYTES });
    expect(store.values.size).toBe(50);
  });

  it("counts every one of many parallel writes on the first write of a new day (one starts the day, the others add to it)", async () => {
    const { call, store } = setup();
    store.written.set("ada-42", { day: YESTERDAY, bytes: DAILY_WRITE_BUDGET_BYTES });
    const answers = await Promise.all(Array.from({ length: 30 }, (_, i) => call(put(`p${i}`, i))));
    const saved = answers.filter((r) => r.statusCode === 204).length;
    expect(saved).toBe(30);
    expect(store.written.get("ada-42")).toEqual({ day: TODAY, bytes: saved * SMALL });
  });
});

describe("what each request reads: a write reads only the small totals item, never the value (billed on its whole size)", () => {
  it("reads the live marker and the totals item for a PUT or DELETE, refused or not, and the live marker and the value for a GET", async () => {
    const { call, store } = setup();
    await call(put("big", valueOfBytes(MAX_VALUE_BYTES)));
    expect(store.reads).toEqual(["live", "usage"]);
    for (const r of [put("big", 1), request("DELETE", "big"), request("DELETE", "missing")]) {
      store.reads.length = 0;
      await call(r);
      expect(store.reads, r.routeKey).toEqual(["live", "usage"]);
    }
    // Over the budget (429) and over a limit (413): still only the totals item.
    await call(put("big", valueOfBytes(MAX_VALUE_BYTES)));
    store.written.set("ada-42", { day: "2026-11-24", bytes: DAILY_WRITE_BUDGET_BYTES });
    for (const [r, status] of [[put("big", 1), 429], [request("DELETE", "big"), 429]] as const) {
      store.reads.length = 0;
      expect((await call(r)).statusCode, r.routeKey).toBe(status);
      expect(store.reads, r.routeKey).toEqual(["live", "usage"]);
    }
    store.reads.length = 0;
    expect((await call(request("GET", "big"))).statusCode).toBe(200);
    expect(store.reads).toEqual(["live", "value"]);
  });

  it("keeps keys that are also names of object properties (`__proto__`, `constructor`) apart from everything else", async () => {
    const { call, store } = setup();
    for (const key of ["__proto__", "constructor", "toString"]) {
      expect((await call(put(key, { key }))).statusCode, key).toBe(204);
      expect((await call(request("GET", key))).body, key).toBe(JSON.stringify({ key }));
    }
    expect((await call(put("__proto__", 1))).statusCode).toBe(204);
    expect(store.usage.get("ada-42")).toEqual({ bytes: 1 + JSON.stringify({ key: "constructor" }).length + JSON.stringify({ key: "toString" }).length, keys: 3 });
    expect((await call(request("DELETE", "__proto__"))).statusCode).toBe(204);
    expect(store.usage.get("ada-42")?.keys).toBe(2);
  });
});

describe("criterion 3: a nickname with no live app answers 404", () => {
  it("answers 404 for a valid nickname that is not live, for every method, without storing", async () => {
    const { call, store } = setup([]);
    for (const r of [request("GET", "k"), put("k", 1), request("DELETE", "k")]) {
      const response = await call(r);
      expect(response.statusCode, r.routeKey).toBe(404);
      expect(JSON.parse(response.body ?? ""), r.routeKey).toEqual({ message: APP_DATA_MESSAGES.notFound });
      expect(response.headers?.["access-control-allow-origin"]).toBe("*");
    }
    expect(store.values.size).toBe(0);
    expect(store.reads).toEqual(["live", "live", "live"]);
  });

  it("answers 404 for a nickname outside the rules or reserved, without reading the table", async () => {
    const { call, store } = setup();
    for (const nickname of ["ab", "x".repeat(21), "ada_42", "a.b", "../x", "", "API", "apps", "a#b", "ada%2D42"]) {
      expect((await call(request("GET", "k", { nickname }))).statusCode, nickname).toBe(404);
    }
    expect((await call({ routeKey: route("GET") })).statusCode).toBe(404);
    expect(store.reads).toEqual([]);
  });

  it("answers 404 for a route it does not serve", async () => {
    const { call } = setup();
    const response = await call({ ...request("GET", "k"), routeKey: "POST /api/apps/{nickname}/data/{key}" });
    expect(response.statusCode).toBe(404);
    expect(response.headers?.["access-control-allow-origin"]).toBe("*");
  });
});

describe("requests the API refuses", () => {
  it("answers 400 for a key outside the rules, for every method", async () => {
    const { call, store } = setup();
    for (const key of ["", "a b", "a.b", "x".repeat(65), "a#b"]) {
      for (const r of [request("GET", key), put(key, 1), request("DELETE", key)]) {
        const response = await call(r);
        expect(response.statusCode, `${r.routeKey} ${key}`).toBe(400);
        expect(JSON.parse(response.body ?? "")).toEqual({ message: APP_DATA_MESSAGES.badKey });
      }
    }
    expect(APP_DATA_MESSAGES.badKey).toBe("A key has 1 to 64 letters, digits, dashes or underscores.");
    expect(store.values.size).toBe(0);
  });

  it("answers 400 for a body that is not JSON or is missing", async () => {
    const { call, store } = setup();
    for (const body of ["{", "undefined", "", "'a'", "NaN"]) {
      const response = await call(request("PUT", "k", { body }));
      expect(response.statusCode, body).toBe(400);
      expect(JSON.parse(response.body ?? "")).toEqual({ message: APP_DATA_MESSAGES.badJson });
    }
    expect((await call(request("PUT", "k"))).statusCode).toBe(400);
    expect(store.values.size).toBe(0);
  });

  it("answers 400 for a value nested more than 100 levels deep (deeper ones overflow the stack), storing nothing", async () => {
    const { call, store } = setup();
    expect(MAX_DEPTH).toBe(100);
    const nested = (depth: number) => `${"[".repeat(depth)}${"]".repeat(depth)}`;
    expect((await call(request("PUT", "ok", { body: nested(MAX_DEPTH) }))).statusCode).toBe(204);
    expect((await call(request("GET", "ok"))).body).toBe(nested(MAX_DEPTH));
    const objects = `${'{"a":'.repeat(MAX_DEPTH)}1${"}".repeat(MAX_DEPTH)}`;
    expect((await call(request("PUT", "obj", { body: objects }))).statusCode).toBe(204);
    // Brackets inside strings do not count.
    expect((await call(put("text", "[".repeat(5000)))).statusCode).toBe(204);
    expect((await call(put("quoted", { 'a"[': ['\\"', "[{"] }))).statusCode).toBe(204);
    const before = snapshot(store);
    for (const body of [nested(MAX_DEPTH + 1), nested(50_000), `${'{"a":'.repeat(MAX_DEPTH)}[1]${"}".repeat(MAX_DEPTH)}`]) {
      const response = await call(request("PUT", "deep", { body }));
      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.body ?? "")).toEqual({ message: APP_DATA_MESSAGES.tooDeep });
    }
    expect(APP_DATA_MESSAGES.tooDeep).toBe("This value is nested too deeply: lists and objects can go at most 100 levels deep.");
    expect(snapshot(store)).toBe(before);
  });

  it("answers 415 for a PUT without the JSON content type", async () => {
    const { call, store } = setup();
    for (const contentType of [null, "text/plain", "application/x-www-form-urlencoded"]) {
      expect((await call(request("PUT", "k", { body: "1", contentType }))).statusCode, String(contentType)).toBe(415);
    }
    expect((await call(request("PUT", "k", { body: "1", contentType: "Application/JSON; charset=utf-8" }))).statusCode).toBe(204);
    expect(store.values.size).toBe(1);
  });

  it("answers 500 with a plain message when the table fails, logging only the error's name", async () => {
    const { call, store, logs } = setup();
    store.failure = Object.assign(new Error("secret detail Ada-42 score"), { name: "InternalServerError" });
    const response = await call(put("score", 1));
    expect(response.statusCode).toBe(500);
    expect(JSON.parse(response.body ?? "")).toEqual({ message: APP_DATA_MESSAGES.failed });
    expect(response.headers?.["access-control-allow-origin"]).toBe("*");
    expect(logs.at(-1)).toEqual({ event: "app-data", method: "PUT", outcome: "failed", status: 500, error: "InternalServerError" });
  });
});

describe("criterion 4: the platform's session cookie changes nothing, and no cookie is ever set", () => {
  it("gives the same answer with and without the session cookie, for every route and outcome", async () => {
    const withCookie = setup();
    const without = setup();
    const cookies = ["ssd_session=platform-session-token", "other=1"];
    const requests = [
      put("score", { best: 3 }),
      request("GET", "score"),
      request("GET", "missing"),
      put("bad key", 1),
      request("PUT", "k", { body: "{" }),
      put("big", valueOfBytes(MAX_VALUE_BYTES + 1)),
      request("GET", "k", { nickname: "nobody" }),
      request("OPTIONS", "score", { contentType: null }),
      request("DELETE", "score"),
      request("GET", "score"),
    ];
    for (const r of requests) {
      const a = await withCookie.call({ ...r, cookies, headers: { ...r.headers, cookie: cookies.join("; ") } });
      const b = await without.call(r);
      expect(a, r.routeKey).toEqual(b);
      expect(a.cookies, r.routeKey).toBeUndefined();
      expect(Object.keys(a.headers ?? {}).map((h) => h.toLowerCase()), r.routeKey).not.toContain("set-cookie");
    }
    expect(withCookie.logs).toEqual(without.logs);
  });

  it("never reads the request's cookies (a request whose cookies throw on access still works)", async () => {
    const { call } = setup();
    const base = put("score", 1);
    const headers = new Proxy(
      { ...base.headers },
      {
        get: (target, name) => {
          if (name === "cookie") throw new Error("cookie header read");
          return target[name as string];
        },
      },
    );
    const trap: HttpRequest = { ...base, headers };
    Object.defineProperty(trap, "cookies", {
      get: () => {
        throw new Error("cookies read");
      },
    });
    expect((await call(trap)).statusCode).toBe(204);
    expect((await call({ ...request("GET", "score"), headers, ...{} })).statusCode).toBe(200);
  });
});

describe("CORS: sandboxed apps (opaque origin) can read every answer", () => {
  it("answers the preflight 204 with the methods and headers workshop-data.js uses, any origin, no credentials", async () => {
    const { call, store } = setup([]);
    const response = await call({ ...request("OPTIONS", "score", { contentType: null }), headers: { origin: "null", "access-control-request-method": "PUT", "access-control-request-headers": "content-type" } });
    expect(response).toEqual({ statusCode: 204, headers: PREFLIGHT_HEADERS });
    expect(PREFLIGHT_HEADERS).toEqual({
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, PUT, DELETE",
      "access-control-allow-headers": "content-type, accept, authorization",
      "access-control-max-age": "600",
      "cache-control": "no-store",
    });
    expect(store.reads).toEqual([]);
  });

  it("puts Access-Control-Allow-Origin: * and never Allow-Credentials on every answer", async () => {
    const { call, store } = setup();
    store.live.add("late");
    const answers = [
      await call(put("score", 1)),
      await call(request("GET", "score")),
      await call(request("DELETE", "score")),
      await call(request("GET", "k", { nickname: "nobody" })),
      await call(put("bad key", 1)),
      await call(request("PUT", "k", { body: "1", contentType: "text/plain" })),
      await call(put("big", valueOfBytes(MAX_VALUE_BYTES + 1))),
    ];
    store.failure = new Error("x");
    answers.push(await call(request("GET", "score")));
    expect(answers.map((a) => a.statusCode)).toEqual([204, 200, 204, 404, 400, 415, 413, 500]);
    for (const answer of answers) {
      expect(answer.headers).toMatchObject(CORS_HEADERS);
      expect(answer.headers?.["access-control-allow-credentials"]).toBeUndefined();
    }
    expect(CORS_HEADERS).toEqual({ "access-control-allow-origin": "*" });
  });
});

describe("logs", () => {
  it("logs method, outcome, status and size only: never the nickname, the key or the value", async () => {
    const { call, logs } = setup();
    await call(put("secret_key", "secret value"));
    await call(request("GET", "secret_key"));
    await call(request("DELETE", "secret_key"));
    await call(request("GET", "k", { nickname: "nobody" }));
    expect(logs).toEqual([
      { event: "app-data", method: "PUT", outcome: "saved", status: 204, bytes: 14 },
      { event: "app-data", method: "GET", outcome: "read", status: 200, bytes: 14 },
      { event: "app-data", method: "DELETE", outcome: "deleted", status: 204 },
      { event: "app-data", method: "GET", outcome: "not-found", status: 404 },
    ]);
    const text = JSON.stringify(logs);
    for (const secret of ["secret", "Ada", "ada-42", "nobody"]) expect(text).not.toContain(secret);
  });
});

describe("ticket 3.24: writes need an app write token, reads stay public", () => {
  const SIGN_IN = "Sign in to the workshop to save in this app.";

  it("criterion 1: WHEN a visitor without a token sends PUT or DELETE THEN the API answers 401 'Sign in to the workshop to save in this app.' and stores nothing, while GET still answers the value", async () => {
    const { call, store, logs } = setup();
    await call(put("score", 42));
    const before = snapshot(store);
    store.reads.length = 0;
    for (const response of [await call(put("score", 7, { token: null })), await call(request("DELETE", "score", { token: null }))]) {
      expect(response.statusCode).toBe(401);
      expect(JSON.parse(response.body ?? "")).toEqual({ message: SIGN_IN });
      expect(response.headers).toMatchObject(CORS_HEADERS);
      expect(response.headers?.["access-control-allow-credentials"]).toBeUndefined();
    }
    expect(APP_DATA_MESSAGES.signInToSave).toBe(SIGN_IN);
    expect(snapshot(store)).toBe(before);
    // Refused before the totals or the value are read: only the live markers.
    expect(store.reads).toEqual(["live", "live"]);
    expect(logs.slice(-2).map((l) => [l.method, l.outcome, l.status])).toEqual([
      ["PUT", "unauthorized", 401],
      ["DELETE", "unauthorized", 401],
    ]);
    const read = await call(request("GET", "score"));
    expect([read.statusCode, read.body]).toEqual([200, "42"]);
  });

  it("refuses a malformed header, an unknown (revoked) token and the platform's session cookie alone with the same 401", async () => {
    const { call, store } = setup();
    const unknown = Buffer.alloc(32, 3).toString("base64url");
    const answers = [
      await call(put("score", 1, { token: `${tokenFor(NICK)}x` })),
      await call({ ...put("score", 1, { token: null }), headers: { "content-type": "application/json", authorization: tokenFor(NICK) } }),
      await call(put("score", 1, { token: unknown })),
      await call(put("score", 1, { token: null, cookies: [`__Host-ssd_session=${tokenFor(NICK)}`] })),
    ];
    expect(answers.map((a) => [a.statusCode, JSON.parse(a.body ?? "").message])).toEqual(Array(4).fill([401, SIGN_IN]));
    expect(store.values.size).toBe(0);
  });

  it("criterion 2 (API part): a token lets its holder write to its own app only: another app's token gets 401", async () => {
    const { call, store } = setup([NICK, "grace"]);
    expect((await call(put("score", 1, { nickname: "grace", token: tokenFor(NICK) }))).statusCode).toBe(401);
    expect((await call(request("DELETE", "score", { nickname: "grace", token: tokenFor(NICK) }))).statusCode).toBe(401);
    expect(store.values.has("grace/score")).toBe(false);
    expect((await call(put("score", 1, { nickname: "grace", token: tokenFor("grace") }))).statusCode).toBe(204);
    // The app is matched regardless of the letter case of its address.
    expect((await call(put("score", 2, { nickname: "ADA-42", token: tokenFor(NICK) }))).statusCode).toBe(204);
  });

  it("criterion 4 (expiry): a token at or past its expiry answers 401, one second before it still writes", async () => {
    const { call, store, clock } = setup();
    store.tokens.tokens.set(hashAppToken(WRITE_TOKEN), { app: NICK.toLowerCase(), nickname: "Bob", expiresAt: NOW.getTime() / 1000 + 12 * 3600 });
    clock.now = new Date(NOW.getTime() + 12 * 3600 * 1000 - 1000);
    expect((await call(put("score", 1, { token: WRITE_TOKEN }))).statusCode).toBe(204);
    clock.now = new Date(NOW.getTime() + 12 * 3600 * 1000);
    expect((await call(put("score", 2, { token: WRITE_TOKEN }))).statusCode).toBe(401);
    expect((await call(request("DELETE", "score", { token: WRITE_TOKEN }))).statusCode).toBe(401);
    expect(store.values.get("ada-42/score")?.json).toBe("1");
  });

  it("criterion 5: WHEN a write succeeds THEN the value records updatedBy = the writer's nickname, and GET ...?info=1 answers {value, updatedBy, updatedAt}", async () => {
    const { call, store } = setup();
    expect((await call(put("board", { posts: ["hi"] }))).statusCode).toBe(204);
    expect(store.values.get("ada-42/board")).toMatchObject({ updatedBy: "Bob", updatedAt: NOW.toISOString() });
    const info = await call({ ...request("GET", "board"), queryStringParameters: { info: "1" } });
    expect(info.statusCode).toBe(200);
    expect(JSON.parse(info.body ?? "")).toEqual({ value: { posts: ["hi"] }, updatedBy: "Bob", updatedAt: NOW.toISOString() });
    expect(info.headers).toMatchObject({ "content-type": "application/json", ...CORS_HEADERS });
    // The plain GET contract is unchanged (any other `info` too).
    expect((await call(request("GET", "board"))).body).toBe('{"posts":["hi"]}');
    expect((await call({ ...request("GET", "board"), queryStringParameters: { info: "yes" } })).body).toBe('{"posts":["hi"]}');
    // A missing key, and a value from before this ticket (no writer), answer nulls.
    expect(JSON.parse((await call({ ...request("GET", "none"), queryStringParameters: { info: "1" } })).body ?? "")).toEqual({ value: null, updatedBy: null, updatedAt: null });
    store.values.set("ada-42/old", { json: "3", bytes: 1 });
    expect(JSON.parse((await call({ ...request("GET", "old"), queryStringParameters: { info: "1" } })).body ?? "")).toEqual({ value: 3, updatedBy: null, updatedAt: null });
  });

  it("criterion 6 (API part): the preflight allows `authorization`, and no answer carries Access-Control-Allow-Credentials", async () => {
    const { call } = setup();
    const preflight = await call({ ...request("OPTIONS", "score", { contentType: null }), headers: { origin: "null", "access-control-request-headers": "authorization,content-type" } });
    expect(preflight.headers?.["access-control-allow-headers"]?.split(", ")).toContain("authorization");
    const answers = [preflight, await call(put("score", 1)), await call(put("score", 1, { token: null })), await call({ ...request("GET", "score"), queryStringParameters: { info: "1" } })];
    for (const answer of answers) expect(Object.keys(answer.headers ?? {})).not.toContain("access-control-allow-credentials");
  });

  it("criterion 7 (data API part): no log entry holds the token or its hash, refused or accepted", async () => {
    const { call, logs } = setup();
    await call(put("score", 1, { token: WRITE_TOKEN }));
    await call(put("score", 1, { token: Buffer.alloc(32, 4).toString("base64url") }));
    await call(put("score", 1));
    await call(request("DELETE", "score"));
    const text = JSON.stringify(logs);
    for (const secret of [WRITE_TOKEN, hashAppToken(WRITE_TOKEN), tokenFor(NICK), hashAppToken(tokenFor(NICK)), Buffer.alloc(32, 4).toString("base64url"), "Bob"]) {
      expect(text).not.toContain(secret);
    }
    for (const entry of logs) expect(Object.keys(entry).every((k) => ["event", "method", "outcome", "status", "bytes", "error"].includes(k))).toBe(true);
  });

  it("answers 500 (logged by name) when the token cannot be read", async () => {
    const { call, store, logs } = setup();
    store.tokens.failure = Object.assign(new Error(`down ${tokenFor(NICK)}`), { name: "InternalServerError" });
    expect((await call(put("score", 1))).statusCode).toBe(500);
    expect(logs.at(-1)).toEqual({ event: "app-data", method: "PUT", outcome: "failed", status: 500, error: "InternalServerError" });
  });
});
