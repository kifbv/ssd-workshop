// Ticket 2.9: the launcher handler's routing. Records from a queue other than the launch and check queues (an event
// source mapping someone added) are ignored without any AWS call.
import { afterEach, describe, expect, it, vi } from "vitest";
import { handler, sourceOf } from "./builds-launcher.js";

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
});
