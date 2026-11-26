// An in-memory stand-in for the data API's table access (ticket 2.4), shared by its tests (not
// bundled: no handler imports it). It follows the same conditions as DynamoAppDataStore: a value is
// written only while the key's size is still the one that was read and the totals item exists as read,
// and the app's totals change in the same step, only while they stay within 10 MB and 500 keys and the
// day's writes within the daily write budget (a new day only over an older one).
//
// The table keeps each key's size twice, in the value item and in the totals item's `sizes` map, always
// changed together; the fake keeps it once, in `values`, and reads `sizes` from there.
//
// It does not reproduce DynamoDB's `TransactionConflict` (two transactions on the same item at the same
// moment cancel each other even when both conditions hold): only condition failures, which data.ts
// handles the same way (read again, pause, try again).
import { FakeAppTokenStore } from "../app-token/fakes.js";
import {
  DAILY_WRITE_BUDGET_BYTES,
  MAX_APP_DATA_BYTES,
  MAX_KEYS,
  type AppDataStore,
  type AppUsage,
  type DeleteResult,
  type PutResult,
  type StoredValue,
  type WriteCharge,
} from "./data.js";

type Totals = Pick<AppUsage, "bytes" | "keys">;

export class FakeAppDataStore implements AppDataStore {
  /** Lower-cased nicknames of live apps. */
  readonly live = new Set<string>();
  /** Values by `<lower-cased nickname>/<key>`, with their writer and time (ticket 3.24). */
  readonly values = new Map<string, { json: string; bytes: number; updatedBy?: string; updatedAt?: string }>();
  /** Ticket 3.24: the app write tokens the data API reads (`deps.tokens`). */
  readonly tokens = new FakeAppTokenStore();
  /** Totals by lower-cased nickname. */
  readonly usage = new Map<string, Totals>();
  /** The daily write count (`writeDay`, `writtenBytes` of the totals item) by lower-cased nickname. */
  readonly written = new Map<string, { day: string; bytes: number }>();
  /** What was read, in order (`live`, `value`, `usage`). */
  readonly reads: string[] = [];
  /** When set, every call fails with it. */
  failure: Error | undefined;
  /** Runs before each write's conditions are checked (simulates another writer in between). */
  beforeWrite: (() => void) | undefined;

  private check(): void {
    if (this.failure !== undefined) throw this.failure;
  }

  private static id(nickname: string, key: string): string {
    return `${nickname.toLowerCase()}/${key}`;
  }

  async isLive(nickname: string): Promise<boolean> {
    this.check();
    this.reads.push("live");
    return this.live.has(nickname.toLowerCase());
  }

  async getValue(nickname: string, key: string): Promise<StoredValue | undefined> {
    this.check();
    this.reads.push("value");
    const stored = this.values.get(FakeAppDataStore.id(nickname, key));
    if (stored === undefined) return undefined;
    const { json, updatedBy, updatedAt } = stored;
    return { json, ...(updatedBy === undefined ? {} : { updatedBy }), ...(updatedAt === undefined ? {} : { updatedAt }) };
  }

  /** The `sizes` map: each stored value's bytes by key. */
  private sizes(nickname: string): Map<string, number> {
    const prefix = `${nickname.toLowerCase()}/`;
    const sizes = new Map<string, number>();
    for (const [id, value] of this.values) if (id.startsWith(prefix)) sizes.set(id.slice(prefix.length), value.bytes);
    return sizes;
  }

  async getUsage(nickname: string): Promise<AppUsage> {
    this.check();
    this.reads.push("usage");
    const usage = this.usage.get(nickname.toLowerCase());
    const written = this.written.get(nickname.toLowerCase());
    return {
      bytes: usage?.bytes ?? 0,
      keys: usage?.keys ?? 0,
      writeDay: written?.day,
      writtenBytes: written?.bytes ?? 0,
      sizes: this.sizes(nickname),
      created: usage !== undefined,
    };
  }

  /** Like the totals item's budget condition: the count after this write, or undefined when it fails. */
  private charged(nickname: string, charge: WriteCharge): { day: string; bytes: number } | undefined {
    const written = this.written.get(nickname.toLowerCase());
    if (charge.sameDay) {
      if (written?.day !== charge.today || written.bytes + charge.cost > DAILY_WRITE_BUDGET_BYTES) return undefined;
      return { day: charge.today, bytes: written.bytes + charge.cost };
    }
    // ISO dates compare as text: only an older day (or none) starts a new count.
    return written === undefined || written.day < charge.today ? { day: charge.today, bytes: charge.cost } : undefined;
  }

  /** Like the transaction's one condition, on the totals item: the key's size, the limits and the budget. */
  async putValue(nickname: string, key: string, json: string, bytes: number, previousBytes: number | undefined, created: boolean, nowIso: string, charge: WriteCharge, updatedBy: string): Promise<PutResult> {
    this.check();
    this.beforeWrite?.();
    const id = FakeAppDataStore.id(nickname, key);
    if (this.usage.has(nickname.toLowerCase()) !== created) return "conflict";
    if (this.values.get(id)?.bytes !== previousBytes) return "conflict";
    const usage = this.usage.get(nickname.toLowerCase()) ?? { bytes: 0, keys: 0 };
    const next = { bytes: usage.bytes - (previousBytes ?? 0) + bytes, keys: usage.keys + (previousBytes === undefined ? 1 : 0) };
    const written = this.charged(nickname, charge);
    if (next.bytes > MAX_APP_DATA_BYTES || next.keys > MAX_KEYS || written === undefined) return "conflict";
    this.values.set(id, { json, bytes, updatedBy, updatedAt: nowIso });
    this.usage.set(nickname.toLowerCase(), next);
    this.written.set(nickname.toLowerCase(), written);
    return "saved";
  }

  async deleteValue(nickname: string, key: string, previousBytes: number, _nowIso: string, charge: WriteCharge): Promise<DeleteResult> {
    this.check();
    this.beforeWrite?.();
    const id = FakeAppDataStore.id(nickname, key);
    if (!this.usage.has(nickname.toLowerCase()) || this.values.get(id)?.bytes !== previousBytes) return "conflict";
    const written = this.charged(nickname, charge);
    if (written === undefined) return "conflict";
    const usage = this.usage.get(nickname.toLowerCase()) ?? { bytes: 0, keys: 0 };
    this.values.delete(id);
    this.usage.set(nickname.toLowerCase(), { bytes: usage.bytes - previousBytes, keys: usage.keys - 1 });
    this.written.set(nickname.toLowerCase(), written);
    return "deleted";
  }
}
