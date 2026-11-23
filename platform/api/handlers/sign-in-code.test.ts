import { NodeHttpHandler } from "@smithy/node-http-handler";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  REGION as INFRA_REGION,
  SENDER_ADDRESS as INFRA_SENDER,
  SES_CONFIGURATION_SET as INFRA_CONFIGURATION_SET,
  TABLE_NAME as INFRA_TABLE_NAME,
} from "../../../infra/lib/config.js";
import type { HttpRequest } from "../http.js";
import { CONFIGURATION_SET, REGION, SENDER_ADDRESS, TABLE_NAME } from "../settings.js";
import { ANSWER_AFTER_MS, type CodeRequestDeps } from "../sign-in/code-request.js";
import { FakeMailer, FakeStore, settle } from "../sign-in/fakes.js";
import { HTTP_TIMEOUTS, clientSettings, createHandler, handler, logEntry } from "./sign-in-code.js";

const LISTED = "franck.tester@example.com";
const STRANGER = "someone.else@example.org";
const CODE = "482913";

const body = (email: string): HttpRequest => ({ body: JSON.stringify({ email }) });

describe("settings", () => {
  it("names the infra table, the workshop sender, its configuration set and eu-central-1", () => {
    expect(TABLE_NAME).toBe(INFRA_TABLE_NAME);
    expect(SENDER_ADDRESS).toBe(INFRA_SENDER);
    expect(CONFIGURATION_SET).toBe(INFRA_CONFIGURATION_SET);
    expect(REGION).toBe(INFRA_REGION);
    expect(SENDER_ADDRESS).toBe("ssd-workshop@rankly.games");
    expect(CONFIGURATION_SET).toBe("ssd-workshop-email");
    expect(REGION).toBe("eu-central-1");
  });
});

describe("POST /api/sign-in/code logs (ticket 1.4 criterion 5)", () => {
  let captured: string[];

  let logged = 0;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    logged = 0;
    captured = [];
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
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  function deps(store: FakeStore, mailer: FakeMailer): CodeRequestDeps {
    let t = Date.parse("2026-11-23T10:00:00.000Z");
    return {
      store,
      mailer,
      now: () => new Date((t += 1000)),
      randomInt: () => Number(CODE),
      randomBytes: (n) => Buffer.alloc(n, 9),
      log: (entry) => {
        logged++;
        logEntry(entry);
      },
      sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    };
  }

  /** Runs one request on the fake clock: the work logs its outcome, then the deadline passes. */
  function runner(store: FakeStore, mailer: FakeMailer): (event: HttpRequest) => Promise<unknown> {
    const run = createHandler(deps(store, mailer));
    return async (event) => {
      const before = logged;
      const pending = run(event);
      await settle(() => logged > before);
      await vi.advanceTimersByTimeAsync(ANSWER_AFTER_MS);
      return pending;
    };
  }

  it("never writes the address or the code to the logs, whatever happens", async () => {
    // The capture works: a marker written through each route is seen.
    console.log("marker-console");
    process.stdout.write("marker-stdout");
    expect(captured.join("\n")).toContain("marker-console");
    expect(captured.join("\n")).toContain("marker-stdout");

    const store = new FakeStore([LISTED]);
    const mailer = new FakeMailer();
    const run = runner(store, mailer);

    // Sent, then rate-limited (5 sends, then a sixth request).
    for (let i = 0; i < 6; i++) await run(body(LISTED.toUpperCase()));
    expect(mailer.sent).toHaveLength(5);
    expect(mailer.sent[0]?.email.text).toContain(CODE);
    // Not on the list.
    await run(body(STRANGER));
    // Malformed requests holding the address.
    await run({ body: `{"email": "${LISTED}", oops}` });
    await run({ body: JSON.stringify({ email: `${LISTED} ${CODE}` }) });
    // Table and SES failures whose messages hold the address and the code.
    const leaky = (name: string) => Object.assign(new Error(`${name} for ${LISTED} code ${CODE}`), { name });
    const failingStore = new FakeStore([LISTED]);
    failingStore.failOn = "isAllowListed";
    failingStore.failure = leaky("ResourceNotFoundException");
    await runner(failingStore, new FakeMailer())(body(LISTED));
    const failingMailer = new FakeMailer();
    failingMailer.failure = leaky("MessageRejected");
    await runner(new FakeStore([LISTED]), failingMailer)(body(LISTED));

    const logs = captured.join("\n").toLowerCase();
    expect(logs).toContain('"outcome":"sent"');
    expect(logs).toContain('"outcome":"rate-limited"');
    expect(logs).toContain('"outcome":"not-listed"');
    expect(logs).toContain('"outcome":"invalid-request"');
    expect(logs).toContain("messagerejected");
    expect(logs).toContain("resourcenotfoundexception");
    for (const secret of [LISTED, STRANGER, "franck.tester", "someone.else", "example.com", "example.org", CODE]) {
      expect(logs, secret).not.toContain(secret.toLowerCase());
    }
  });
});

describe("handler (live wiring)", () => {
  it("bounds every SDK call: 2 attempts, 1 s to connect, 1.5 s per request, eu-central-1", () => {
    const settings = clientSettings();
    expect(settings).toMatchObject({ region: "eu-central-1", maxAttempts: 2 });
    expect(settings.requestHandler).toBeInstanceOf(NodeHttpHandler);
    expect(HTTP_TIMEOUTS).toEqual({ connectionTimeout: 1000, requestTimeout: 1500 });
  });

  it("answers a malformed request 400 before any AWS call", async () => {
    const res = await handler({ body: "not json" });
    expect(res.statusCode).toBe(400);
  });
});
