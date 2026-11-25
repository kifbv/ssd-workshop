// Ticket 2.9: the launcher handler's routing. Records from a queue other than the launch and check queues (an event
// source mapping someone added) are ignored without any AWS call.
import { afterEach, describe, expect, it, vi } from "vitest";
import { LAUNCH_WAIT_SECONDS } from "../settings.js";
import { answerLaunch, handler, sourceOf } from "./builds-launcher.js";

const QUEUE = (name: string) => `arn:aws:sqs:eu-central-1:360206963848:${name}`;

describe("the builds launcher handler (ticket 2.9)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("knows the launch queue and the check queue by name, and nothing else", () => {
    expect(sourceOf(QUEUE("ssd-workshop-builds.fifo"))).toBe("launch");
    expect(sourceOf(QUEUE("ssd-workshop-builds-check"))).toBe("check");
    for (const other of [QUEUE("ssd-workshop-deploys.fifo"), QUEUE("ssd-workshop-builds-dlq.fifo"), QUEUE("evil-ssd-workshop-builds.fifo"), undefined, ""]) {
      expect(sourceOf(other), String(other)).toBe("other");
    }
  });

  it("ignores a record from any other source, before reading its settings or calling AWS", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const before = process.env.BUILDER_TASK_DEFINITION_ARN;
    delete process.env.BUILDER_TASK_DEFINITION_ARN;
    try {
      await expect(handler({ Records: [{ body: JSON.stringify({ buildId: "b-1" }), eventSourceARN: QUEUE("someone-elses-queue") }] })).resolves.toBeUndefined();
    } finally {
      if (before !== undefined) process.env.BUILDER_TASK_DEFINITION_ARN = before;
    }
    expect(log.mock.calls.map((call) => String(call[0]))).toEqual([JSON.stringify({ event: "launcher", outcome: "invalid", durationMs: 0 })]);
  });

  it("refuses to run without its settings (a bare error)", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    await expect(handler({ Records: [{ body: "{}", eventSourceARN: QUEUE("ssd-workshop-builds.fifo") }] })).rejects.toThrow(/^launcher not configured$/);
  });

  it("ticket 3.4: WHEN a build waits for a slot THEN its message comes back after 30 seconds (visibility, then a batch item failure); any other outcome consumes it", async () => {
    expect(LAUNCH_WAIT_SECONDS).toBe(30);
    const calls: [string, number][] = [];
    const visibility = {
      comeBackAfter: async (handle: string, seconds: number) => {
        calls.push([handle, seconds]);
      },
    };
    const record = { body: "{}", eventSourceARN: QUEUE("ssd-workshop-builds.fifo"), messageId: "m-1", receiptHandle: "h-1" };
    expect(await answerLaunch(record, "waiting", visibility)).toEqual({ batchItemFailures: [{ itemIdentifier: "m-1" }] });
    expect(calls).toEqual([["h-1", 30]]);
    for (const outcome of ["started", "duplicate", "ignored", "invalid", "failed"] as const) {
      expect(await answerLaunch(record, outcome, visibility), outcome).toEqual({ batchItemFailures: [] });
    }
    expect(calls).toHaveLength(1);
    // Setting the visibility failed: the message still comes back (after the queue's own visibility timeout).
    const broken = { comeBackAfter: async () => Promise.reject(new Error("sqs down")) };
    expect(await answerLaunch(record, "waiting", broken)).toEqual({ batchItemFailures: [{ itemIdentifier: "m-1" }] });
  });
});
