// In-memory stand-ins for the media API's table access and bucket (ticket 3.18), shared by its tests and the reset's
// (not bundled: no handler imports them). The store follows DynamoAppMediaStore's conditions: a record is created only
// if absent, together with the totals, only while they stay within 500 MB, 2,000 files and the day's budget (a new day
// only over an older one); `finish` only while the record is `uploading` and the app live; `remove` only while the
// record is as read, leaving a tombstone (`deleted`). Each call is atomic here, so DynamoDB's TransactionConflict does not happen (the store's own tests
// check the expressions).
import { FakeAppTokenStore } from "../app-token/fakes.js";
import {
  DAILY_UPLOAD_BUDGET_BYTES,
  MAX_APP_MEDIA_BYTES,
  MAX_APP_MEDIA_FILES,
  type AppMediaStore,
  type MediaBucket,
  type MediaRecord,
  type MediaUsage,
  type NewMedia,
  type ReserveResult,
  type UploadCharge,
} from "./media.js";

interface StoredRecord extends MediaRecord {
  contentType: string;
  uploadedBy: string;
}

export class FakeAppMediaStore implements AppMediaStore {
  /** Lower-cased nicknames of live apps. */
  readonly live = new Set<string>();
  /** Records by `<lower-cased nickname>/<id>`. */
  readonly records = new Map<string, StoredRecord>();
  /** Totals by lower-cased nickname. */
  readonly usage = new Map<string, { bytes: number; files: number; uploadDay?: string; uploadedBytes: number }>();
  /** The app write tokens the API reads (`deps.tokens`). */
  readonly tokens = new FakeAppTokenStore();
  /** What was called, in order (to prove what was, or was not, touched). */
  readonly calls: string[] = [];
  /** When set, every call fails with it. */
  failure: Error | undefined;
  /** Runs before each reserve's conditions are checked (another upload in between). */
  beforeReserve: (() => void) | undefined;

  private static id(nickname: string, id: string): string {
    return `${nickname.toLowerCase()}/${id}`;
  }

  private check(call: string): void {
    this.calls.push(call);
    if (this.failure !== undefined) throw this.failure;
  }

  async isLive(nickname: string): Promise<boolean> {
    this.check("isLive");
    return this.live.has(nickname.toLowerCase());
  }

  async getUsage(nickname: string): Promise<MediaUsage> {
    this.check("getUsage");
    const usage = this.usage.get(nickname.toLowerCase());
    return { bytes: usage?.bytes ?? 0, files: usage?.files ?? 0, uploadDay: usage?.uploadDay, uploadedBytes: usage?.uploadedBytes ?? 0, created: usage !== undefined };
  }

  async getRecord(nickname: string, id: string): Promise<MediaRecord | undefined> {
    this.check("getRecord");
    const record = this.records.get(FakeAppMediaStore.id(nickname, id));
    return record && { bytes: record.bytes, status: record.status, createdAt: record.createdAt };
  }

  async reserve(nickname: string, id: string, file: NewMedia, nowIso: string, created: boolean, charge: UploadCharge): Promise<ReserveResult> {
    this.check("reserve");
    this.beforeReserve?.();
    const app = nickname.toLowerCase();
    if (this.records.has(FakeAppMediaStore.id(nickname, id))) return "taken";
    const usage = this.usage.get(app);
    if ((usage !== undefined) !== created) return "conflict";
    const current = usage ?? { bytes: 0, files: 0, uploadedBytes: 0 };
    if (current.bytes + file.bytes > MAX_APP_MEDIA_BYTES || current.files + 1 > MAX_APP_MEDIA_FILES) return "conflict";
    let uploaded: number;
    if (charge.sameDay) {
      if (current.uploadDay !== charge.today || current.uploadedBytes + charge.cost > DAILY_UPLOAD_BUDGET_BYTES) return "conflict";
      uploaded = current.uploadedBytes + charge.cost;
    } else {
      // ISO dates compare as text: only an older day (or none) starts a new count.
      if (current.uploadDay !== undefined && !(current.uploadDay < charge.today)) return "conflict";
      uploaded = charge.cost;
    }
    this.records.set(FakeAppMediaStore.id(nickname, id), { bytes: file.bytes, status: "uploading", createdAt: nowIso, contentType: file.contentType, uploadedBy: file.uploadedBy });
    this.usage.set(app, { bytes: current.bytes + file.bytes, files: current.files + 1, uploadDay: charge.today, uploadedBytes: uploaded });
    return "reserved";
  }

  async finish(nickname: string, id: string): Promise<boolean> {
    this.check("finish");
    const record = this.records.get(FakeAppMediaStore.id(nickname, id));
    if (record?.status !== "uploading" || !this.live.has(nickname.toLowerCase())) return false;
    record.status = "stored";
    return true;
  }

  async release(nickname: string, id: string, bytes: number): Promise<void> {
    this.check("release");
    const record = this.records.get(FakeAppMediaStore.id(nickname, id));
    const usage = this.usage.get(nickname.toLowerCase());
    if (record?.status !== "uploading" || usage === undefined) return;
    // A tombstone (try 3): the id stays taken.
    record.status = "deleted";
    usage.bytes -= bytes;
    usage.files -= 1;
  }

  async remove(nickname: string, id: string, read: MediaRecord): Promise<"deleted" | "conflict"> {
    this.check("remove");
    const record = this.records.get(FakeAppMediaStore.id(nickname, id));
    const usage = this.usage.get(nickname.toLowerCase());
    if (record === undefined || usage === undefined || record.status !== read.status || record.bytes !== read.bytes) return "conflict";
    // A tombstone: the id stays taken.
    record.status = "deleted";
    usage.bytes -= record.bytes;
    usage.files -= 1;
    return "deleted";
  }
}

/** The media bucket: objects by key, with the type and cache header they were stored with. */
export class FakeMediaBucket implements MediaBucket {
  readonly objects = new Map<string, { body: Buffer; contentType: string }>();
  readonly calls: string[] = [];
  /** When set, the next put fails with it. */
  putFailure: Error | undefined;
  /** Runs right after a put stored the object (something happening while the upload was in flight). */
  afterPut: (() => void) | undefined;

  /** When set, the next put stores the object and THEN fails with it (a timeout after S3 took the bytes). */
  putFailureAfterStoring: Error | undefined;

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    this.calls.push(`put ${key}`);
    if (this.putFailure !== undefined) {
      const failure = this.putFailure;
      this.putFailure = undefined;
      throw failure;
    }
    this.objects.set(key, { body: Buffer.from(body), contentType });
    if (this.putFailureAfterStoring !== undefined) {
      const failure = this.putFailureAfterStoring;
      this.putFailureAfterStoring = undefined;
      throw failure;
    }
    this.afterPut?.();
  }

  async delete(key: string): Promise<void> {
    this.calls.push(`delete ${key}`);
    this.objects.delete(key);
  }
}
