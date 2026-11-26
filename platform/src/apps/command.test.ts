// Ticket 3.25 (question 10): `npm run apps -- refresh` republishes every live app with the platform's workshop-data.js.
// The command's messages go to the real deployer (processDeploy) on the in-memory bucket and CDN.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CACHE_CONTROL, processDeploy, type DeployDeps, type DeployLogEntry } from "../../api/deploy/deploy.js";
import { FakeAppObjects, FakeCdn, FakeDeployRecords } from "../../api/deploy/fakes.js";
import { parseAppsArgs, runApps, USAGE, type AppsDeps } from "./command.js";

const DATA_CLIENT = new Uint8Array(readFileSync(fileURLToPath(new URL("../../../templates/basic/workshop-data.js", import.meta.url))));
const OLD_CLIENT = new TextEncoder().encode("// the client from before 3.25\n");
const NOW = new Date("2026-11-26T18:00:00.000Z");

/** A FIFO queue in memory: what was sent, delivered to the deployer in order. */
class FakeDeployQueue {
  readonly sent: { body: string; group: string; deduplicationId: string }[] = [];
  failFor: string | undefined;
  async send(nickname: string, deduplicationId: string): Promise<void> {
    if (nickname === this.failFor) throw Object.assign(new Error("SQS is down"), { name: "ServiceUnavailable" });
    this.sent.push({ body: JSON.stringify({ refresh: nickname }), group: nickname.toLowerCase(), deduplicationId });
  }
}

function setup(live: string[]) {
  const objects = new FakeAppObjects();
  // Every live app as published before 3.25: its pages and the old client.
  for (const nickname of live) {
    const prefix = `apps/${nickname.toLowerCase()}/`;
    for (const [path, bytes] of [["index.html", new TextEncoder().encode("<h1>App</h1>")], ["app.js", new TextEncoder().encode("go();")], ["workshop-data.js", OLD_CLIENT]] as const) {
      objects.objects.set(`${prefix}${path}`, { bytes, contentType: "text/plain", cacheControl: CACHE_CONTROL });
    }
  }
  const cdn = new FakeCdn();
  const records = new FakeDeployRecords();
  const logs: DeployLogEntry[] = [];
  const deployer: DeployDeps = {
    download: async () => {
      throw new Error("a refresh never downloads");
    },
    objects,
    cdn,
    records,
    now: () => NOW,
    log: (entry) => logs.push(entry),
    dataClient: DATA_CLIENT,
  };
  const queue = new FakeDeployQueue();
  const out: string[] = [];
  const err: string[] = [];
  let connected = 0;
  const deps: AppsDeps = {
    connect: () => {
      connected += 1;
      return { apps: { listLiveApps: async () => live }, queue };
    },
    now: () => NOW,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  };
  /** The deployer takes every message sent, as SQS would deliver them. */
  const deliver = async () => {
    for (const message of queue.sent) await processDeploy(message.body, 1, deployer);
  };
  return { objects, cdn, records, logs, queue, out, err, deps, deliver, connected: () => connected };
}

describe("npm run apps: arguments", () => {
  it("accepts refresh only, without touching AWS on a usage error", async () => {
    expect(parseAppsArgs(["refresh"])).toEqual({ command: "refresh" });
    for (const args of [[], ["refresh", "ada"], ["list"], ["Refresh"]]) expect("error" in parseAppsArgs(args), args.join(" ")).toBe(true);
    const s = setup(["Ada"]);
    expect(await runApps(["refresh", "now"], s.deps)).toBe(2);
    expect(s.err[0]).toContain(USAGE);
    expect(s.connected()).toBe(0);
  });
});

describe("npm run apps -- refresh (ticket 3.25, question 10)", () => {
  it("WHEN Franck runs it THEN every live app is republished with the platform's workshop-data.js, and nothing else changes", async () => {
    const s = setup(["Ada", "bob-2", "Cleo"]);
    // Another app's files that are not live (no marker) stay as they are.
    s.objects.objects.set("apps/draft/workshop-data.js", { bytes: OLD_CLIENT, contentType: "text/plain", cacheControl: CACHE_CONTROL });
    expect(await runApps(["refresh"], s.deps)).toBe(0);
    expect(s.queue.sent).toEqual([
      { body: '{"refresh":"Ada"}', group: "ada", deduplicationId: `refresh-ada-${NOW.getTime()}` },
      { body: '{"refresh":"bob-2"}', group: "bob-2", deduplicationId: `refresh-bob-2-${NOW.getTime()}` },
      { body: '{"refresh":"Cleo"}', group: "cleo", deduplicationId: `refresh-cleo-${NOW.getTime()}` },
    ]);
    await s.deliver();
    for (const app of ["ada", "bob-2", "cleo"]) {
      expect(s.objects.objects.get(`apps/${app}/workshop-data.js`)?.bytes, app).toEqual(DATA_CLIENT);
      expect(new TextDecoder().decode(s.objects.objects.get(`apps/${app}/app.js`)?.bytes)).toBe("go();");
    }
    expect(s.objects.objects.get("apps/draft/workshop-data.js")?.bytes).toEqual(OLD_CLIENT);
    expect(s.objects.puts.sort()).toEqual(["apps/ada/workshop-data.js", "apps/bob-2/workshop-data.js", "apps/cleo/workshop-data.js"]);
    expect(s.objects.removed).toEqual([]);
    expect(s.cdn.invalidations.map((i) => i.paths)).toEqual([["/apps/ada/workshop-data.js"], ["/apps/bob-2/workshop-data.js"], ["/apps/cleo/workshop-data.js"]]);
    expect(s.logs.map((entry) => entry.outcome)).toEqual(["refreshed", "refreshed", "refreshed"]);
    expect(s.records.builds.size + s.records.live.size).toBe(0);
    expect(s.out).toEqual(["Ada: refresh queued", "bob-2: refresh queued", "Cleo: refresh queued", "Asked the deployer to refresh 3 of 3 live apps; each gets the platform's workshop-data.js within a minute."]);
    expect(s.err).toEqual([]);
  });

  it("sends one message per app whatever letter case its marker holds, and skips a marker that is not a nickname", async () => {
    const s = setup(["Ada"]);
    s.deps.connect = () => ({ apps: { listLiveApps: async () => ["Ada", "ADA", "../x", "bob"] }, queue: s.queue });
    expect(await runApps(["refresh"], s.deps)).toBe(0);
    expect(s.queue.sent.map((m) => m.body)).toEqual(['{"refresh":"Ada"}', '{"refresh":"bob"}']);
  });

  it("WHEN there is no live app THEN it says so and sends nothing", async () => {
    const s = setup([]);
    expect(await runApps(["refresh"], s.deps)).toBe(0);
    expect(s.out).toEqual(["No live apps: nothing to refresh."]);
    expect(s.queue.sent).toEqual([]);
  });

  it("WHEN a send fails THEN the others still go, the failure is named by app, and running it again finishes the job", async () => {
    const s = setup(["Ada", "Bob"]);
    s.queue.failFor = "Ada";
    expect(await runApps(["refresh"], s.deps)).toBe(1);
    expect(s.err).toEqual(["Ada: the refresh message could not be sent (ServiceUnavailable)", "Run the command again for the app that failed (it is safe to repeat)."]);
    s.queue.failFor = undefined;
    expect(await runApps(["refresh"], s.deps)).toBe(0);
    await s.deliver();
    expect(s.objects.objects.get("apps/ada/workshop-data.js")?.bytes).toEqual(DATA_CLIENT);
    expect(s.objects.objects.get("apps/bob/workshop-data.js")?.bytes).toEqual(DATA_CLIENT);
  });

  it("WHEN the table cannot be read THEN it names only the error, never anything else", async () => {
    const s = setup(["Ada"]);
    s.deps.connect = () => ({ apps: { listLiveApps: async () => Promise.reject(Object.assign(new Error("secret detail"), { name: "AccessDeniedException" })) }, queue: s.queue });
    expect(await runApps(["refresh"], s.deps)).toBe(1);
    expect(s.err).toEqual(["The command failed (AccessDeniedException). Check your AWS credentials (AWS_PROFILE=franck)."]);
  });
});
