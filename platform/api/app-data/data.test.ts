// Ticket 2.4: the data API's rules, on the in-memory store (criteria 1 to 4; 5 is browser.test.ts,
// 6 is handlers/app-data.test.ts).
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HttpRequest, HttpResponse } from "../http.js";
import { FakeAppDataStore } from "./fakes.js";
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
  WRITE_ATTEMPTS,
  type AppDataLogEntry,
} from "./data.js";

const NICK = "Ada-42";
const NOW = new Date("2026-11-24T10:00:00.000Z");

function setup(live: string[] = [NICK]) {
  const store = new FakeAppDataStore();
  for (const nickname of live) store.live.add(nickname.toLowerCase());
  const logs: AppDataLogEntry[] = [];
  const clock = { now: NOW };
  let pauses = 0;
  const call = (request: HttpRequest): Promise<HttpResponse> =>
    handleAppDataRequest(request, {
      store,
      now: () => clock.now,
      log: (entry) => logs.push(entry),
      pause: async () => {
        pauses += 1;
      },
    });
  return { store, logs, call, clock, pauses: () => pauses };
}

const route = (method: string) => `${method} /api/apps/{nickname}/data/{key}`;

function request(method: string, key: string, options: { nickname?: string; body?: string; contentType?: string | null; cookies?: string[]; base64?: boolean } = {}): HttpRequest {
  const headers: Record<string, string> = { origin: "null", accept: "application/json" };
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

  it("limits an app to 1 MB, a value to 100 KB and an app to 100 keys of 1 to 64 letters, digits, dashes and underscores", () => {
    expect(MAX_APP_DATA_BYTES).toBe(1024 * 1024);
    expect(MAX_VALUE_BYTES).toBe(100 * 1024);
    expect(MAX_KEYS).toBe(100);
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
    expect(store.values.get("ada-42/list")).toEqual({ json: '[1,2,"é"]', bytes: 10 });
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
  it("refuses a value over 100 KB (canonical JSON), keeping the stored one", async () => {
    const { call, store } = setup();
    expect((await call(put("big", valueOfBytes(MAX_VALUE_BYTES)))).statusCode).toBe(204);
    await call(put("big", "small"));
    const before = snapshot(store);
    const response = await call(put("big", valueOfBytes(MAX_VALUE_BYTES + 1)));
    expect(response.statusCode).toBe(413);
    expect(JSON.parse(response.body ?? "")).toEqual({ message: APP_DATA_MESSAGES.valueTooBig });
    expect(APP_DATA_MESSAGES.valueTooBig).toBe("This value is too big: a value can hold at most 100 KB.");
    expect(snapshot(store)).toBe(before);
  });

  it("refuses a body over 100 KB before parsing it, base64 or not", async () => {
    const { call, store } = setup();
    const padded = `${" ".repeat(MAX_VALUE_BYTES)}1`;
    expect((await call(request("PUT", "a", { body: padded }))).statusCode).toBe(413);
    expect((await call(request("PUT", "a", { body: padded, base64: true }))).statusCode).toBe(413);
    expect((await call(request("PUT", "a", { body: "x".repeat(MAX_VALUE_BYTES * 2), base64: false }))).statusCode).toBe(413);
    expect(store.values.size).toBe(0);
  });

  it("refuses a value that canonical JSON makes longer than 100 KB (numbers written short)", async () => {
    const { call, store } = setup();
    // 1e21 stays "1e+21", but 1e20 becomes "100000000000000000000": 4 bytes sent, 21 stored.
    const body = `[${Array.from({ length: Math.ceil(MAX_VALUE_BYTES / 22) + 1 }, () => "1e20").join(",")}]`;
    expect(Buffer.byteLength(body)).toBeLessThanOrEqual(MAX_VALUE_BYTES);
    const response = await call(request("PUT", "n", { body }));
    expect(response.statusCode).toBe(413);
    expect(store.values.size).toBe(0);
  });

  it("refuses a write that would take the app past 1 MB, keeping everything as it was", async () => {
    const { call, store } = setup();
    const full = Math.floor(MAX_APP_DATA_BYTES / MAX_VALUE_BYTES); // 10 values of 100 KB
    for (let i = 0; i < full; i += 1) expect((await call(put(`v${i}`, valueOfBytes(MAX_VALUE_BYTES)))).statusCode).toBe(204);
    const left = MAX_APP_DATA_BYTES - full * MAX_VALUE_BYTES; // 24 KB
    expect((await call(put("last", valueOfBytes(left)))).statusCode).toBe(204);
    expect(store.usage.get("ada-42")?.bytes).toBe(MAX_APP_DATA_BYTES);
    const before = snapshot(store);
    for (const [key, value] of [["more", 1], ["last", valueOfBytes(left + 1)]] as const) {
      const response = await call(put(key, value));
      expect(response.statusCode, key).toBe(413);
      expect(JSON.parse(response.body ?? ""), key).toEqual({ message: APP_DATA_MESSAGES.appFull });
    }
    expect(APP_DATA_MESSAGES.appFull).toBe("This app has no room left: an app can store at most 1 MB.");
    expect(snapshot(store)).toBe(before);
    // A smaller value in place of a bigger one still fits, and a delete makes room.
    expect((await call(put("last", valueOfBytes(left - 1)))).statusCode).toBe(204);
    expect((await call(request("DELETE", "v0"))).statusCode).toBe(204);
    expect((await call(put("more", 1))).statusCode).toBe(204);
  });

  it("refuses a 101st key, while the 100 keys can still be replaced", async () => {
    const { call, store } = setup();
    for (let i = 0; i < MAX_KEYS; i += 1) expect((await call(put(`k${i}`, i))).statusCode).toBe(204);
    const before = snapshot(store);
    const response = await call(put("one-more", 1));
    expect(response.statusCode).toBe(413);
    expect(JSON.parse(response.body ?? "")).toEqual({ message: APP_DATA_MESSAGES.tooManyKeys });
    expect(APP_DATA_MESSAGES.tooManyKeys).toBe("This app already has 100 keys, the most it can keep. Remove one to add another.");
    expect(snapshot(store)).toBe(before);
    expect((await call(put("k5", "changed"))).statusCode).toBe(204);
    expect(store.usage.get("ada-42")?.keys).toBe(MAX_KEYS);
  });

  it("never lets parallel writes pass 100 keys or 1 MB (the store's conditions hold, not the earlier read)", async () => {
    const { call, store } = setup();
    const keys = await Promise.all(Array.from({ length: 130 }, (_, i) => call(put(`p${i}`, i))));
    expect(keys.filter((r) => r.statusCode === 204)).toHaveLength(MAX_KEYS);
    expect(keys.every((r) => [204, 409, 413].includes(r.statusCode))).toBe(true);
    expect(store.usage.get("ada-42")?.keys).toBe(MAX_KEYS);
    expect([...store.values.keys()].filter((k) => k.startsWith("ada-42/"))).toHaveLength(MAX_KEYS);

    const other = setup();
    const big = await Promise.all(Array.from({ length: 14 }, (_, i) => other.call(put(`b${i}`, valueOfBytes(MAX_VALUE_BYTES)))));
    expect(big.filter((r) => r.statusCode === 204)).toHaveLength(10);
    const total = [...other.store.values.values()].reduce((sum, v) => sum + v.bytes, 0);
    expect(total).toBeLessThanOrEqual(MAX_APP_DATA_BYTES);
    expect(other.store.usage.get("ada-42")).toEqual({ bytes: total, keys: 10 });
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

  it("allows 20 MB of writes per app and UTC day, counting each PUT as its value's bytes (at least 1 KB) and each DELETE as 1 KB", async () => {
    expect(DAILY_WRITE_BUDGET_BYTES).toBe(20 * 1024 * 1024);
    expect(MIN_WRITE_COST_BYTES).toBe(1024);
    expect(APP_DATA_MESSAGES.writeBudget).toBe("This app has saved a lot of data today. Saving starts again tomorrow.");
    const { call, store } = setup();
    await call(put("score", 1));
    expect(store.written.get("ada-42")).toEqual({ day: TODAY, bytes: 1024 });
    await call(put("big", valueOfBytes(MAX_VALUE_BYTES)));
    expect(store.written.get("ada-42")).toEqual({ day: TODAY, bytes: 1024 + MAX_VALUE_BYTES });
    await call(request("DELETE", "big"));
    expect(store.written.get("ada-42")).toEqual({ day: TODAY, bytes: 2048 + MAX_VALUE_BYTES });
    // Reads, refused writes and deleting a missing key cost nothing.
    await call(request("GET", "score"));
    await call(request("DELETE", "missing"));
    await call(put("bad key", 1));
    await call(put("too-big", valueOfBytes(MAX_VALUE_BYTES + 1)));
    expect(store.written.get("ada-42")).toEqual({ day: TODAY, bytes: 2048 + MAX_VALUE_BYTES });
  });

  it("refuses a PUT or DELETE past the budget with 429 and a plain reason, storing nothing; reads still work", async () => {
    const { call, store, logs } = setup();
    await call(put("score", 1));
    store.written.set("ada-42", { day: TODAY, bytes: DAILY_WRITE_BUDGET_BYTES - 2 * 1024 });
    expect((await call(put("score", 2))).statusCode).toBe(204);
    // A 100 KB value no longer fits, a small one still does (exactly reaching the budget).
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

  it("stops a loop of 100 KB replacements of one key after 20 MB", async () => {
    const { call, store } = setup();
    const allowed = Math.floor(DAILY_WRITE_BUDGET_BYTES / MAX_VALUE_BYTES); // 204
    for (let i = 0; i < allowed; i += 1) {
      expect((await call(put("same", valueOfBytes(MAX_VALUE_BYTES - (i % 2))))).statusCode, String(i)).toBe(204);
    }
    expect((await call(put("same", valueOfBytes(MAX_VALUE_BYTES)))).statusCode).toBe(429);
    expect(store.written.get("ada-42")?.bytes).toBeLessThanOrEqual(DAILY_WRITE_BUDGET_BYTES);
  });

  it("starts again at 0 on the next UTC day", async () => {
    const { call, store, clock } = setup();
    clock.now = new Date("2026-11-24T23:59:59.999Z");
    store.written.set("ada-42", { day: TODAY, bytes: DAILY_WRITE_BUDGET_BYTES });
    expect((await call(put("score", 1))).statusCode).toBe(429);
    clock.now = new Date("2026-11-25T00:00:00.000Z");
    expect((await call(put("score", 1))).statusCode).toBe(204);
    expect(store.written.get("ada-42")).toEqual({ day: "2026-11-25", bytes: 1024 });
    // An old day's count, however high, never holds a write back.
    store.written.set("ada-42", { day: YESTERDAY, bytes: DAILY_WRITE_BUDGET_BYTES * 3 });
    clock.now = NOW;
    expect((await call(request("DELETE", "score"))).statusCode).toBe(204);
    expect(store.written.get("ada-42")).toEqual({ day: TODAY, bytes: 1024 });
  });

  it("never lets parallel writes pass the budget (the store's condition holds, not the earlier read)", async () => {
    const { call, store } = setup();
    store.written.set("ada-42", { day: TODAY, bytes: DAILY_WRITE_BUDGET_BYTES - 50 * 1024 });
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
    expect(store.written.get("ada-42")).toEqual({ day: TODAY, bytes: saved * 1024 });
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
      "access-control-allow-headers": "content-type, accept",
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
