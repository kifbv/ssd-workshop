import { describe, expect, it } from "vitest";
import { ALLOWED_EXTENSIONS } from "../build/check.js";
import { appArchiveUrl, DEPLOY_MAX_RECEIVES } from "../settings.js";
import {
  CACHE_CONTROL,
  contentTypeOf,
  DEPLOY_RESERVE_MS,
  DOWNLOAD_TIMEOUT_MS,
  DownloadProblem,
  MAX_REASON_CHARS,
  MAX_REASONS_CHARS,
  SERVICE_PROBLEM_REASON,
  TIME_UP_REASON,
  parseDeployJob,
  processDeploy,
  storedReason,
  storedReasons,
  type DeployDeps,
  type DeployLogEntry,
} from "./deploy.js";
import { FakeAppObjects, FakeCdn, FakeDeployRecords } from "./fakes.js";
import { COMMIT, TOP, githubTar, gzip } from "./tar-fixtures.js";

const NOW = new Date("2026-11-24T10:00:00.000Z");
const EARLIER = "2026-11-20T08:00:00.000Z";
const BUILD = "build-1";
const job = (extra: Record<string, unknown> = {}) => JSON.stringify({ buildId: BUILD, nickname: "Ada", commit: COMMIT, ...extra });
const PAGE = '<!doctype html><html><head><link rel="stylesheet" href="css/style.css"><script src="app.js" defer></script></head><body></body></html>';

function setup(archive: Uint8Array | (() => Promise<Uint8Array>)) {
  const objects = new FakeAppObjects();
  const cdn = new FakeCdn();
  const records = new FakeDeployRecords();
  records.builds.set(BUILD, { nickname: "Ada", status: "building" });
  const downloads: string[] = [];
  const downloadTimeouts: number[] = [];
  const logs: DeployLogEntry[] = [];
  let clock = NOW.getTime();
  const deps: DeployDeps = {
    download: async (url, timeoutMs) => {
      downloads.push(url);
      downloadTimeouts.push(timeoutMs);
      return typeof archive === "function" ? archive() : archive;
    },
    objects,
    cdn,
    records,
    now: () => new Date((clock += 5)),
    log: (entry) => logs.push(entry),
  };
  /** Moves the fake clock forward. */
  const advance = (ms: number): void => {
    clock += ms;
  };
  const now = (): number => clock;
  return { deps, objects, cdn, records, downloads, downloadTimeouts, logs, advance, now };
}

const passing = () => gzip(githubTar({ "index.html": PAGE, "app.js": "console.log(1);\n", "css/style.css": "p { color: red; }\n", "img/Logo.PNG": new Uint8Array([137, 80, 78, 71]) }));

/** Another app's files and Ada's previous version. */
function seed(objects: FakeAppObjects): void {
  for (const key of ["apps/ada/index.html", "apps/ada/old.js", "apps/ada/css/style.css", "apps/bob/index.html", "apps/adam/index.html"]) {
    objects.objects.set(key, { bytes: new TextEncoder().encode(`old ${key}`), contentType: "text/plain", cacheControl: CACHE_CONTROL });
  }
}

describe("criterion 1: a commit that passes the check is published under apps/<nickname>/ only, and the build is live", () => {
  it("downloads the commit's tarball from the app's public repository", async () => {
    const t = setup(passing());
    await processDeploy(job(), 1, t.deps);
    expect(t.downloads).toEqual([appArchiveUrl("Ada", COMMIT)]);
    expect(t.downloads[0]).toBe(`https://codeload.github.com/ssd-workshop-apps/ssd-ada/tar.gz/${COMMIT}`);
  });

  it("puts every file under apps/<lower-cased nickname>/ and nothing else, removes what the new version no longer has, and leaves other apps alone", async () => {
    const t = setup(passing());
    seed(t.objects);
    await processDeploy(job(), 1, t.deps);
    expect(t.objects.puts.every((key) => key.startsWith("apps/ada/"))).toBe(true);
    expect(t.objects.puts.sort()).toEqual(["apps/ada/app.js", "apps/ada/css/style.css", "apps/ada/img/Logo.PNG", "apps/ada/index.html"]);
    expect(t.objects.removed).toEqual(["apps/ada/old.js"]);
    expect([...t.objects.objects.keys()].sort()).toEqual([
      "apps/adam/index.html",
      "apps/ada/app.js",
      "apps/ada/css/style.css",
      "apps/ada/img/Logo.PNG",
      "apps/ada/index.html",
      "apps/bob/index.html",
    ].sort());
    expect(new TextDecoder().decode(t.objects.objects.get("apps/ada/index.html")?.bytes)).toBe(PAGE);
    expect(new TextDecoder().decode(t.objects.objects.get("apps/bob/index.html")?.bytes)).toBe("old apps/bob/index.html");
  });

  it("puts the pages last, so a new page never names a file that is not there yet", async () => {
    const t = setup(passing());
    await processDeploy(job(), 1, t.deps);
    expect(t.objects.puts.at(-1)).toBe("apps/ada/index.html");
  });

  it("gives every file a content type from its extension (any letter case) and a 60-second cache lifetime", async () => {
    const t = setup(passing());
    await processDeploy(job(), 1, t.deps);
    const stored = (key: string) => t.objects.objects.get(`apps/ada/${key}`);
    expect(stored("index.html")?.contentType).toBe("text/html; charset=utf-8");
    expect(stored("app.js")?.contentType).toBe("text/javascript; charset=utf-8");
    expect(stored("css/style.css")?.contentType).toBe("text/css; charset=utf-8");
    expect(stored("img/Logo.PNG")?.contentType).toBe("image/png");
    for (const [, object] of t.objects.objects) expect(object.cacheControl).toBe("public, max-age=60");
  });

  it("invalidates /apps/<nickname>/* after the files changed, then marks the app and the build live", async () => {
    const t = setup(passing());
    await processDeploy(job(), 1, t.deps);
    expect(t.cdn.invalidations).toHaveLength(1);
    expect(t.cdn.invalidations[0]?.paths).toEqual(["/apps/ada/*"]);
    expect(t.cdn.invalidations[0]?.reference).toMatch(/^build-1-\d+$/);
    const live = t.records.live.get("ada");
    expect(live?.nickname).toBe("Ada");
    expect(live?.liveAt).toMatch(/^2026-11-24T10:00:00\.\d{3}Z$/);
    expect(t.records.builds.get(BUILD)).toMatchObject({ status: "live", deployedCommit: COMMIT, finishedAt: expect.stringMatching(/^2026-11-24T/) });
    expect(t.records.builds.get(BUILD)?.failureReasons).toBeUndefined();
  });

  it("keeps the first time the app went live on a later deploy", async () => {
    const t = setup(passing());
    t.records.live.set("ada", { nickname: "Ada", liveAt: EARLIER });
    await processDeploy(job(), 1, t.deps);
    expect(t.records.live.get("ada")?.liveAt).toBe(EARLIER);
    expect(t.records.builds.get(BUILD)?.status).toBe("live");
  });

  it("logs one line with the outcome, file count, bytes and duration, and no nickname, commit or file name", async () => {
    const t = setup(passing());
    await processDeploy(job(), 1, t.deps);
    expect(t.logs).toEqual([{ event: "deployer", outcome: "live", files: 4, bytes: expect.any(Number), removed: 0, durationMs: expect.any(Number) }]);
    const text = JSON.stringify(t.logs);
    for (const secret of ["Ada", "ada", COMMIT, "index.html", BUILD]) expect(text).not.toContain(secret);
  });
});

describe("criterion 2: a commit that fails the check uploads nothing, leaves the live version, and marks the build failed with the reasons", () => {
  const failing = () =>
    gzip(githubTar({ "index.html": '<script src="https://evil.example/x.js"></script>', "shell.php": "<?php ?>", "app.js": "ok();\n" }));

  it("puts and removes nothing, invalidates nothing and leaves the live marker as it was", async () => {
    const t = setup(failing());
    seed(t.objects);
    t.records.live.set("ada", { nickname: "Ada", liveAt: EARLIER });
    const before = new Map(t.objects.objects);
    await processDeploy(job(), 1, t.deps);
    expect(t.objects.puts).toEqual([]);
    expect(t.objects.removed).toEqual([]);
    expect(t.objects.objects).toEqual(before);
    expect(t.cdn.invalidations).toEqual([]);
    expect(t.records.live.get("ada")).toEqual({ nickname: "Ada", liveAt: EARLIER });
  });

  it("does not make an app live that never was", async () => {
    const t = setup(failing());
    await processDeploy(job(), 1, t.deps);
    expect(t.records.live.size).toBe(0);
  });

  it("marks the build failed with the check's reasons, naming each file (and line)", async () => {
    const t = setup(failing());
    await processDeploy(job(), 1, t.deps);
    const build = t.records.builds.get(BUILD);
    expect(build?.status).toBe("failed");
    expect(build?.deployedCommit).toBeUndefined();
    expect(build?.finishedAt).toMatch(/^2026-11-24T/);
    expect(build?.failureReasons).toEqual([
      expect.stringMatching(/^index\.html, line 1: It refers to an outside address \(https:\/\/evil\.example/),
      expect.stringMatching(/^shell\.php: /),
    ]);
    expect(t.logs).toEqual([{ event: "deployer", outcome: "failed", files: 3, bytes: expect.any(Number), problems: 2, durationMs: expect.any(Number) }]);
  });

  it("fails on a symlink, a hard link or another special entry in the tarball", async () => {
    const tar = githubTar({ "index.html": "<p>x</p>" }, [{ path: `${TOP}/link.html`, type: "2", linkName: "/etc/passwd" }]);
    const t = setup(gzip(tar));
    await processDeploy(job(), 1, t.deps);
    expect(t.objects.puts).toEqual([]);
    expect(t.records.builds.get(BUILD)?.failureReasons).toEqual([expect.stringMatching(/^link\.html: Links to other files are not allowed/)]);
  });

  it("fails with the archive's problem when it leaves its folder, unpacks too big or is not an archive", async () => {
    const cases: [Uint8Array, RegExp][] = [
      [gzip(githubTar({ "index.html": "x" }, [{ path: `${TOP}/../../apps/bob/index.html`, data: "x" }])), /leaves its folder/],
      [gzip(githubTar({ "index.html": "x", "big.txt": new Uint8Array(9 * 1024 * 1024) })), /over 8 MB unpacked/],
      [new TextEncoder().encode("Not Found"), /not a valid tar\.gz archive/],
    ];
    for (const [archive, reason] of cases) {
      const t = setup(archive);
      seed(t.objects);
      await processDeploy(job(), 1, t.deps);
      expect(t.objects.puts, String(reason)).toEqual([]);
      expect(t.objects.removed).toEqual([]);
      expect(t.cdn.invalidations).toEqual([]);
      expect(t.records.builds.get(BUILD)?.status).toBe("failed");
      expect(t.records.builds.get(BUILD)?.failureReasons).toEqual([expect.stringMatching(reason)]);
    }
  });

  it("fails when the download is over its limit, without retrying", async () => {
    const t = setup(async () => {
      throw new DownloadProblem("The repository's download is over 10 MB, so nothing was published.", false);
    });
    await processDeploy(job(), 1, t.deps);
    expect(t.records.builds.get(BUILD)).toMatchObject({ status: "failed", failureReasons: ["The repository's download is over 10 MB, so nothing was published."] });
  });

  it("caps each stored reason and their total length, so the build item stays far under DynamoDB's 400 KB", async () => {
    // 60 files with 2,000-character names (wrong type) and 100 with outside addresses: more than 50 problems, long reasons.
    const files: Record<string, string> = { "index.html": "x" };
    for (let i = 0; i < 60; i += 1) files[`${"d".repeat(90)}/${String(i).padStart(2000, "e")}.php`] = "x";
    for (let i = 0; i < 100; i += 1) files[`f${i}.html`] = "https://evil.example/\n".repeat(3);
    const t = setup(gzip(githubTar(files)));
    await processDeploy(job(), 1, t.deps);
    const reasons = t.records.builds.get(BUILD)?.failureReasons ?? [];
    expect(reasons.length).toBeGreaterThan(10);
    for (const reason of reasons) expect(reason.length).toBeLessThanOrEqual(MAX_REASON_CHARS);
    expect(reasons.join("").length).toBeLessThanOrEqual(MAX_REASONS_CHARS);
    expect(MAX_REASONS_CHARS).toBeLessThanOrEqual(20_000);
    expect(reasons.at(-1)).toMatch(/more problems?\.$/);
  });
});

describe("deploy messages", () => {
  it("reads { buildId, nickname, commit } strictly", () => {
    expect(parseDeployJob(job())).toEqual({ buildId: BUILD, nickname: "Ada", commit: COMMIT });
    const bad = [
      undefined,
      "",
      "not json",
      "null",
      "[]",
      job({ buildId: "" }),
      job({ buildId: "a#b" }),
      job({ buildId: 7 }),
      job({ nickname: "ab" }),
      job({ nickname: "a/b-c" }),
      job({ nickname: "../bob" }),
      job({ nickname: "x".repeat(21) }),
      job({ commit: COMMIT.toUpperCase() }),
      job({ commit: COMMIT.slice(1) }),
      job({ commit: "main" }),
      job({ extra: 1 }),
      JSON.stringify({ buildId: BUILD, nickname: "Ada" }),
    ];
    for (const body of bad) expect(parseDeployJob(body), String(body)).toBeUndefined();
  });

  it("logs a malformed message and drops it, without any call", async () => {
    const t = setup(passing());
    await expect(processDeploy("{\"nickname\":\"Ada\"}", 1, t.deps)).resolves.toBeUndefined();
    expect(t.downloads).toEqual([]);
    expect(t.objects.puts).toEqual([]);
    expect(t.records.builds.get(BUILD)?.status).toBe("building");
    expect(t.logs).toEqual([{ event: "deployer", outcome: "invalid", durationMs: expect.any(Number) }]);
  });

  it("logs a message for a build that does not exist and drops it, without downloading or publishing", async () => {
    const t = setup(passing());
    await expect(processDeploy(job({ buildId: "unknown" }), 1, t.deps)).resolves.toBeUndefined();
    expect(t.downloads).toEqual([]);
    expect(t.objects.puts).toEqual([]);
    expect(t.records.live.size).toBe(0);
    expect(t.logs).toEqual([{ event: "deployer", outcome: "no-build", durationMs: expect.any(Number) }]);
  });

  it("drops a message whose build belongs to another app, without downloading or publishing (the build is left as it was)", async () => {
    for (const nickname of ["Bob", "ada", "ADA"]) {
      const t = setup(passing());
      await expect(processDeploy(job({ nickname }), 1, t.deps)).resolves.toBeUndefined();
      expect(t.downloads, nickname).toEqual([]);
      expect(t.objects.puts).toEqual([]);
      expect(t.records.live.size).toBe(0);
      expect(t.records.builds.get(BUILD)).toEqual({ nickname: "Ada", status: "building" });
      expect(t.logs).toEqual([{ event: "deployer", outcome: "no-build", durationMs: expect.any(Number) }]);
    }
  });

  it("drops a message whose build is already live or failed, without downloading or publishing", async () => {
    for (const status of ["live", "failed"] as const) {
      const t = setup(passing());
      t.records.builds.set(BUILD, { nickname: "Ada", status, finishedAt: EARLIER });
      await processDeploy(job(), 1, t.deps);
      expect(t.downloads, status).toEqual([]);
      expect(t.objects.puts).toEqual([]);
      expect(t.records.builds.get(BUILD)).toEqual({ nickname: "Ada", status, finishedAt: EARLIER });
      expect(t.logs).toEqual([{ event: "deployer", outcome: "no-build", durationMs: expect.any(Number) }]);
    }
  });

  it("deploys a build that is queued, building, or deploying (a redelivery after a crash)", async () => {
    for (const status of ["queued", "building", "deploying"] as const) {
      const t = setup(passing());
      t.records.builds.set(BUILD, { nickname: "Ada", status });
      await processDeploy(job(), 1, t.deps);
      expect(t.records.builds.get(BUILD)?.status, status).toBe("live");
    }
  });

  it("marks the build deploying before it downloads", async () => {
    const t = setup(async () => {
      expect(t.records.builds.get(BUILD)?.status).toBe("deploying");
      return passing();
    });
    await processDeploy(job(), 1, t.deps);
    expect(t.records.builds.get(BUILD)?.status).toBe("live");
  });
});

describe("passing problems: retried by SQS, the build marked failed on the last delivery", () => {
  const unreachable = () => setup(async () => {
    throw new DownloadProblem("GitHub answered 502 for the commit's download.", true);
  });

  it("throws a bare error (SQS delivers again) before the last delivery, publishing nothing", async () => {
    const t = unreachable();
    await expect(processDeploy(job(), 1, t.deps)).rejects.toThrow(/^deploy failed$/);
    expect(t.records.builds.get(BUILD)?.status).toBe("deploying");
    expect(t.objects.puts).toEqual([]);
    expect(t.logs).toEqual([{ event: "deployer", outcome: "retry", error: "DownloadProblem", durationMs: expect.any(Number) }]);
  });

  it("marks the build failed with the reason on the last delivery", async () => {
    const t = unreachable();
    await expect(processDeploy(job(), DEPLOY_MAX_RECEIVES, t.deps)).resolves.toBeUndefined();
    expect(t.records.builds.get(BUILD)).toMatchObject({ status: "failed", failureReasons: ["GitHub answered 502 for the commit's download."] });
    expect(t.logs).toEqual([{ event: "deployer", outcome: "gave-up", error: "DownloadProblem", durationMs: expect.any(Number) }]);
  });

  it("an S3 failure: retried, then the build failed with a plain reason; the live marker is never touched", async () => {
    const t = setup(passing());
    t.records.live.set("ada", { nickname: "Ada", liveAt: EARLIER });
    t.objects.failPutOf = "apps/ada/app.js";
    await expect(processDeploy(job(), 2, t.deps)).rejects.toThrow(/^deploy failed$/);
    expect(t.cdn.invalidations).toEqual([]);
    await processDeploy(job(), 3, t.deps);
    expect(t.records.builds.get(BUILD)).toMatchObject({ status: "failed", failureReasons: [SERVICE_PROBLEM_REASON] });
    expect(t.records.live.get("ada")).toEqual({ nickname: "Ada", liveAt: EARLIER });
    expect(JSON.stringify(t.logs)).not.toContain("S3 is down");
  });

  it("a later delivery of the same message changes nothing once the build is live (at-least-once delivery is harmless)", async () => {
    const t = setup(passing());
    await processDeploy(job(), 1, t.deps);
    const first = new Map(t.objects.objects);
    const build = t.records.builds.get(BUILD);
    await processDeploy(job(), 2, t.deps);
    expect(t.objects.objects).toEqual(first);
    expect(t.downloads).toHaveLength(1);
    expect(t.records.builds.get(BUILD)).toEqual(build);
    expect(t.logs.at(-1)?.outcome).toBe("no-build");
  });

  it("a redelivery after a deploy stopped half-way (build still deploying) publishes the same files again", async () => {
    const t = setup(passing());
    t.objects.failPutOf = "apps/ada/app.js";
    await expect(processDeploy(job(), 1, t.deps)).rejects.toThrow(/^deploy failed$/);
    t.objects.failPutOf = undefined;
    await processDeploy(job(), 2, t.deps);
    expect(t.records.builds.get(BUILD)?.status).toBe("live");
    expect([...t.objects.objects.keys()].sort()).toEqual(["apps/ada/app.js", "apps/ada/css/style.css", "apps/ada/img/Logo.PNG", "apps/ada/index.html"]);
  });

  it("never marks a build failed that it could not check first (the table failed on the last delivery): dead-letter", async () => {
    const t = setup(passing());
    t.records.startDeploy = async () => {
      throw Object.assign(new Error("table is down"), { name: "InternalServerError" });
    };
    await expect(processDeploy(job(), DEPLOY_MAX_RECEIVES, t.deps)).rejects.toThrow(/^deploy failed$/);
    expect(t.records.builds.get(BUILD)).toEqual({ nickname: "Ada", status: "building" });
    expect(t.logs).toEqual([{ event: "deployer", outcome: "dead-letter", error: "InternalServerError", durationMs: expect.any(Number) }]);
  });

  it("logs dead-letter (not retry) when even marking the build failed fails on the last delivery, and throws so the message reaches the dead-letter queue", async () => {
    const t = unreachable();
    t.records.failMarkFailed = true;
    await expect(processDeploy(job(), DEPLOY_MAX_RECEIVES, t.deps)).rejects.toThrow(/^deploy failed$/);
    expect(t.logs).toEqual([{ event: "deployer", outcome: "dead-letter", error: "DownloadProblem", durationMs: expect.any(Number) }]);
    expect(JSON.stringify(t.logs)).not.toContain("table is down");
  });
});

describe("content types", () => {
  it("has one for every allowed extension, in any letter case", () => {
    for (const extension of ALLOWED_EXTENSIONS) {
      expect(contentTypeOf(`a${extension}`), extension).toMatch(/^[a-z]+\/[a-z0-9.+-]+/);
      expect(contentTypeOf(`A${extension.toUpperCase()}`)).toBe(contentTypeOf(`a${extension}`));
    }
    expect(contentTypeOf("PHOTO.JPG")).toBe("image/jpeg");
    expect(contentTypeOf("icon.svg")).toBe("image/svg+xml");
    expect(contentTypeOf("font.woff2")).toBe("font/woff2");
    expect(contentTypeOf("data.json")).toBe("application/json; charset=utf-8");
  });
});

describe("build updates remove what no longer holds (like the real REMOVE clauses)", () => {
  it("marking a build live removes the failure reasons of an earlier try", async () => {
    const t = setup(passing());
    t.records.builds.set(BUILD, { nickname: "Ada", status: "building", failureReasons: ["old reason"] });
    await processDeploy(job(), 1, t.deps);
    expect(t.records.builds.get(BUILD)?.status).toBe("live");
    expect(t.records.builds.get(BUILD)).not.toHaveProperty("failureReasons");
  });

  it("marking a build failed removes a deployed commit of an earlier try", async () => {
    const t = setup(gzip(githubTar({ "index.html": "x", "shell.php": "<?php ?>" })));
    t.records.builds.set(BUILD, { nickname: "Ada", status: "building", deployedCommit: COMMIT });
    await processDeploy(job(), 1, t.deps);
    expect(t.records.builds.get(BUILD)?.status).toBe("failed");
    expect(t.records.builds.get(BUILD)).not.toHaveProperty("deployedCommit");
  });
});

describe("stored reasons hold no control or other non-printable characters (they quote anyone's file names and lines)", () => {
  it("replaces each control, format, separator or lone surrogate character with ?, keeping the caps", () => {
    const tricky = "a\u0000b\u0007c\u001bd\te\nf\rg\u007fh\u0085i\u200bj\u202ek\u2028l\u2029m\ufeffn\ud800o\ue000p";
    const [stored] = storedReasons([{ file: `x${tricky}.php`, reason: tricky }]);
    const clean = "a?b?c?d?e?f?g?h?i?j?k?l?m?n?o?p";
    expect(stored).toBe(`x${clean}.php: ${clean}`);
    expect([...(stored ?? "")].filter((char) => (char.codePointAt(0) ?? 0) < 0x20 || ((char.codePointAt(0) ?? 0) >= 0x7f && (char.codePointAt(0) ?? 0) <= 0x9f))).toEqual([]);
    // Ordinary text, accents and emoji stay as they are.
    expect(storedReasons([{ reason: "Café 👍 «ok» — fine" }])).toEqual(["Café 👍 «ok» — fine"]);
    // A cut that would split a surrogate pair leaves no lone half.
    const [cut] = storedReasons([{ reason: `${"x".repeat(MAX_REASON_CHARS - 2)}👍👍` }]);
    expect(cut?.length).toBeLessThanOrEqual(MAX_REASON_CHARS);
    expect(cut).not.toMatch(/[\ud800-\udfff](?![\udc00-\udfff])/u);
    expect(storedReason("\u0000".repeat(2 * MAX_REASON_CHARS))).toBe(`${"?".repeat(MAX_REASON_CHARS - 1)}…`);
  });

  it("stores the check's reasons with control characters replaced", async () => {
    const t = setup(gzip(githubTar({ "index.html": "x", "bad\u001b[31m\nname.php": "x" })));
    await processDeploy(job(), 1, t.deps);
    const reasons = t.records.builds.get(BUILD)?.failureReasons ?? [];
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toMatch(/^bad\?\[31m\?name\.php: /);
  });
});

describe("the Lambda's deadline: the last delivery still marks the build failed when time runs out", () => {
  it("does not start the download with less than DEPLOY_RESERVE_MS left, and marks the build failed on the last delivery", async () => {
    const t = setup(passing());
    // Enough to mark the build deploying (a few fake ms), not enough for the download.
    await processDeploy(job(), DEPLOY_MAX_RECEIVES, t.deps, t.now() + DEPLOY_RESERVE_MS + 7);
    expect(t.downloads).toEqual([]);
    expect(t.objects.puts).toEqual([]);
    expect(t.records.builds.get(BUILD)).toMatchObject({ status: "failed", failureReasons: [TIME_UP_REASON] });
    expect(t.logs).toEqual([{ event: "deployer", outcome: "gave-up", error: "DeployTimeUp", durationMs: expect.any(Number) }]);
  });

  it("before the last delivery, throws so SQS delivers again", async () => {
    const t = setup(passing());
    await expect(processDeploy(job(), 1, t.deps, t.now() + DEPLOY_RESERVE_MS - 1)).rejects.toThrow(/^deploy failed$/);
    expect(t.downloads).toEqual([]);
    expect(t.records.builds.get(BUILD)?.status).toBe("deploying");
    expect(t.logs).toEqual([{ event: "deployer", outcome: "retry", error: "DeployTimeUp", durationMs: expect.any(Number) }]);
  });

  it("gives the download a time limit bounded by the time left (and at most DOWNLOAD_TIMEOUT_MS)", async () => {
    const roomy = setup(passing());
    await processDeploy(job(), 1, roomy.deps, roomy.now() + 120_000);
    expect(roomy.downloadTimeouts).toEqual([DOWNLOAD_TIMEOUT_MS]);
    const tight = setup(passing());
    const deadline = tight.now() + DEPLOY_RESERVE_MS + 5_000;
    await processDeploy(job(), 1, tight.deps, deadline);
    expect(tight.downloadTimeouts).toHaveLength(1);
    expect(tight.downloadTimeouts[0]).toBeLessThanOrEqual(5_000 + 1_000);
    expect(tight.downloadTimeouts[0]).toBeGreaterThan(4_000);
  });

  it("stops waiting for a download that hangs when the time left is used up, and marks the build failed", async () => {
    const t = setup(() => new Promise<Uint8Array>(() => undefined));
    const started = Date.now();
    // 60 real ms for the download phase (the fake clock moves only a few ms meanwhile).
    await processDeploy(job(), DEPLOY_MAX_RECEIVES, t.deps, t.now() + DEPLOY_RESERVE_MS + 70);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(t.records.builds.get(BUILD)).toMatchObject({ status: "failed", failureReasons: [TIME_UP_REASON] });
    expect(t.objects.puts).toEqual([]);
  });

  it("stops between batches of puts when time runs out: no clean-up, no invalidation, the live marker untouched", async () => {
    const files: Record<string, string> = { "index.html": PAGE, "app.js": "ok();\n", "css/style.css": "p {}\n" };
    for (let i = 0; i < 20; i += 1) files[`f${i}.txt`] = "x";
    const t = setup(gzip(githubTar(files)));
    seed(t.objects);
    t.records.live.set("ada", { nickname: "Ada", liveAt: EARLIER });
    const deadline = t.now() + 120_000;
    // Each put takes 40 fake seconds: the first batch ends with less than the reserve left.
    const put = t.objects.put.bind(t.objects);
    t.objects.put = async (...args) => {
      t.advance(40_000 / 8);
      return put(...args);
    };
    t.advance(0);
    await processDeploy(job(), DEPLOY_MAX_RECEIVES, t.deps, deadline);
    expect(t.objects.puts.length).toBeGreaterThan(0);
    expect(t.objects.puts.length).toBeLessThan(23);
    expect(t.objects.puts.some((key) => key.endsWith(".html"))).toBe(false);
    expect(t.objects.removed).toEqual([]);
    expect(t.cdn.invalidations).toEqual([]);
    expect(t.records.live.get("ada")).toEqual({ nickname: "Ada", liveAt: EARLIER });
    expect(t.records.builds.get(BUILD)).toMatchObject({ status: "failed", failureReasons: [TIME_UP_REASON] });
  });
});
