import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeAppObjects, FakeCdn, FakeDeployRecords } from "../deploy/fakes.js";
import { DEPLOY_RESERVE_MS, DownloadProblem, TIME_UP_REASON } from "../deploy/deploy.js";
import { COMMIT, githubTar, gzip } from "../deploy/tar-fixtures.js";
import { DEPLOY_MAX_RECEIVES } from "../settings.js";
import { createHandler, logEntry } from "./deployer.js";

afterEach(() => {
  vi.restoreAllMocks();
});

function deps(download: () => Promise<Uint8Array>) {
  const records = new FakeDeployRecords();
  records.builds.set("b1", { nickname: "Ada", pushedCommit: COMMIT, status: "building" });
  return { records, deps: { compare: async () => "identical", download, objects: new FakeAppObjects(), cdn: new FakeCdn(), records, now: () => new Date(), log: logEntry } };
}

const body = JSON.stringify({ buildId: "b1", nickname: "Ada", commit: COMMIT });

describe("deployer handler (ticket 2.5)", () => {
  it("publishes a record's build and writes one JSON log line without the nickname or commit", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: string) => lines.push(line));
    const t = deps(async () => gzip(githubTar({ "index.html": "<p>hi</p>" })));
    await createHandler(t.deps)({ Records: [{ body, attributes: { ApproximateReceiveCount: "1" } }] });
    expect(t.records.builds.get("b1")?.status).toBe("live");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "")).toMatchObject({ event: "deployer", outcome: "live", files: 1 });
    expect(lines[0]).not.toContain("Ada");
    expect(lines[0]).not.toContain(COMMIT);
  });

  it("reads the receive count: retries before the last delivery, marks the build failed on it", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const failing = async (): Promise<Uint8Array> => {
      throw new DownloadProblem("GitHub answered 500 to the download of the commit; check that the repository and the commit exist.", true);
    };
    const first = deps(failing);
    await expect(createHandler(first.deps)({ Records: [{ body, attributes: { ApproximateReceiveCount: "1" } }] })).rejects.toThrow(/^deploy failed$/);
    const last = deps(failing);
    await createHandler(last.deps)({ Records: [{ body, attributes: { ApproximateReceiveCount: String(DEPLOY_MAX_RECEIVES) } }] });
    expect(last.records.builds.get("b1")?.status).toBe("failed");
  });

  it("takes the deadline from the Lambda context: with too little time left, the last delivery marks the build failed", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const t = deps(async () => gzip(githubTar({ "index.html": "<p>hi</p>" })));
    const context = { getRemainingTimeInMillis: () => DEPLOY_RESERVE_MS - 1 };
    await createHandler(t.deps)({ Records: [{ body, attributes: { ApproximateReceiveCount: String(DEPLOY_MAX_RECEIVES) } }] }, context);
    expect(t.records.builds.get("b1")).toMatchObject({ status: "failed", failureReasons: [TIME_UP_REASON] });
    // With time enough, the same record is published.
    const roomy = deps(async () => gzip(githubTar({ "index.html": "<p>hi</p>" })));
    await createHandler(roomy.deps)({ Records: [{ body, attributes: { ApproximateReceiveCount: "1" } }] }, { getRemainingTimeInMillis: () => 120_000 });
    expect(roomy.records.builds.get("b1")?.status).toBe("live");
  });

  it("drops a malformed record without throwing", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const t = deps(async () => new Uint8Array());
    await expect(createHandler(t.deps)({ Records: [{ body: "nope" }] })).resolves.toBeUndefined();
    expect(t.records.builds.get("b1")?.status).toBe("building");
  });
});
