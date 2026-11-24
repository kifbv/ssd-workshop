// In-memory stand-ins for the deployer's outside world (ticket 2.5), shared by its tests (not bundled:
// no handler imports it): the apps bucket, CloudFront and the table's build and live marker items.
import type { AppObjects, Cdn, DeployRecords } from "./deploy.js";
import type { BuildStatus } from "../types.js";

export interface StoredObject {
  bytes: Uint8Array;
  contentType: string;
  cacheControl: string;
}

export class FakeAppObjects implements AppObjects {
  readonly objects = new Map<string, StoredObject>();
  /** Every key written and removed, in order. */
  readonly puts: string[] = [];
  readonly removed: string[] = [];
  /** When set, the put of this key fails. */
  failPutOf: string | undefined;

  async put(key: string, bytes: Uint8Array, contentType: string, cacheControl: string): Promise<void> {
    if (key === this.failPutOf) throw Object.assign(new Error("S3 is down"), { name: "ServiceUnavailable" });
    this.puts.push(key);
    this.objects.set(key, { bytes, contentType, cacheControl });
  }

  async list(prefix: string): Promise<string[]> {
    return [...this.objects.keys()].filter((key) => key.startsWith(prefix));
  }

  async remove(keys: readonly string[]): Promise<void> {
    for (const key of keys) {
      this.removed.push(key);
      this.objects.delete(key);
    }
  }
}

export class FakeCdn implements Cdn {
  readonly invalidations: { paths: string[]; reference: string }[] = [];

  async invalidate(paths: readonly string[], reference: string): Promise<void> {
    this.invalidations.push({ paths: [...paths], reference });
  }
}

export interface FakeBuild {
  /** As stored by ticket 2.7 (as the participant typed it). */
  nickname: string;
  status: BuildStatus;
  updatedAt?: string;
  deployedCommit?: string;
  failureReasons?: string[];
  finishedAt?: string;
}

export class FakeDeployRecords implements DeployRecords {
  /** Builds by id. */
  readonly builds = new Map<string, FakeBuild>();
  /** Live markers by lower-cased nickname. */
  readonly live = new Map<string, { nickname: string; liveAt: string }>();

  /** When set, markFailed fails (a table problem). */
  failMarkFailed = false;

  /** Like the real UpdateItem: SET the change, REMOVE the listed attributes; false when the build is missing or the condition fails. */
  private update(buildId: string, change: Partial<FakeBuild>, remove: ("failureReasons" | "deployedCommit")[] = [], condition: (build: FakeBuild) => boolean = () => true): boolean {
    const build = this.builds.get(buildId);
    if (build === undefined || !condition(build)) return false;
    const next: FakeBuild = { ...build, ...change };
    if (remove.includes("failureReasons")) delete next.failureReasons;
    if (remove.includes("deployedCommit")) delete next.deployedCommit;
    this.builds.set(buildId, next);
    return true;
  }

  async startDeploy(buildId: string, nickname: string, nowIso: string): Promise<boolean> {
    return this.update(buildId, { status: "deploying", updatedAt: nowIso }, [], (build) =>
      build.nickname === nickname && ["queued", "building", "deploying"].includes(build.status),
    );
  }

  async markLive(buildId: string, commit: string, nowIso: string): Promise<boolean> {
    return this.update(buildId, { status: "live", updatedAt: nowIso, deployedCommit: commit, finishedAt: nowIso }, ["failureReasons"]);
  }

  async markFailed(buildId: string, reasons: readonly string[], nowIso: string): Promise<boolean> {
    if (this.failMarkFailed) throw Object.assign(new Error("table is down"), { name: "InternalServerError" });
    return this.update(buildId, { status: "failed", updatedAt: nowIso, failureReasons: [...reasons], finishedAt: nowIso }, ["deployedCommit"]);
  }

  async markAppLive(nickname: string, nowIso: string): Promise<void> {
    const key = nickname.toLowerCase();
    this.live.set(key, { nickname, liveAt: this.live.get(key)?.liveAt ?? nowIso });
  }
}
