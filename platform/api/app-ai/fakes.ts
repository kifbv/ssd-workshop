// In-memory stand-ins for the AI tasks' table access, media bucket, Bedrock model and Amazon Transcribe (ticket 3.21),
// for its tests (not bundled: no handler imports them). The store follows DynamoAppAiStore's conditions: a reservation
// adds to the three day counters (app, writer, all apps) only while each still counts the day it was read with and is
// under its budget, a counter of
// an earlier day starting again at 0; a settlement adds only to counters that still count that day. Each call is atomic
// here, so DynamoDB's TransactionConflict does not happen (the store's own tests check the expressions).
import { FakeAppTokenStore } from "../app-token/fakes.js";
import { DEFAULT_SETTINGS, type WorkshopSettings } from "../workshop/settings.js";
import type { AppAiModel, AppAiStore, MediaReader, ModelAnswer, ModelCall, Transcriber, TranscriptionStatus } from "./ai.js";
import { ALL_APPS_AI_DAILY_BUDGET_USD, APP_AI_DAILY_BUDGET_USD, WRITER_AI_DAILY_BUDGET_USD, type AiSpend, type DaySpend } from "./budget.js";
import type { RecordingKind } from "../app-media/formats.js";

const round = (usd: number): number => Math.round(usd * 1e8) / 1e8;

export class FakeAppAiStore implements AppAiStore {
  /** Lower-cased nicknames of live apps. */
  readonly live = new Set<string>();
  settings: WorkshopSettings = { ...DEFAULT_SETTINGS, appAiEnabled: true };
  /** Day counters by lower-cased nickname. */
  readonly apps = new Map<string, DaySpend>();
  /** Day counters by lower-cased writer nickname (try 2). */
  readonly writers = new Map<string, DaySpend>();
  all: DaySpend = { day: undefined, usd: 0 };
  readonly tokens = new FakeAppTokenStore();
  readonly calls: string[] = [];
  failure: Error | undefined;
  /** Runs before each reserve's conditions are checked (another call in between). */
  beforeReserve: (() => void) | undefined;
  /** When set, the next settle fails with it. */
  settleFailure: Error | undefined;

  private check(call: string): void {
    this.calls.push(call);
    if (this.failure !== undefined) throw this.failure;
  }

  async isLive(nickname: string): Promise<boolean> {
    this.check("isLive");
    return this.live.has(nickname.toLowerCase());
  }

  async getSettings(): Promise<WorkshopSettings> {
    this.check("getSettings");
    return { ...this.settings };
  }

  async getSpend(nickname: string, writer: string): Promise<AiSpend> {
    this.check("getSpend");
    const none: DaySpend = { day: undefined, usd: 0 };
    return { app: { ...(this.apps.get(nickname.toLowerCase()) ?? none) }, writer: { ...(this.writers.get(writer.toLowerCase()) ?? none) }, all: { ...this.all } };
  }

  async reserve(nickname: string, writer: string, spend: AiSpend, today: string, costUsd: number): Promise<"reserved" | "conflict"> {
    this.check("reserve");
    this.beforeReserve?.();
    const app = this.apps.get(nickname.toLowerCase()) ?? { day: undefined, usd: 0 };
    const mine = this.writers.get(writer.toLowerCase()) ?? { day: undefined, usd: 0 };
    // As DynamoAppAiStore: a counter read as today's adds only while it is still today's and under its budget; one
    // read as an earlier day's starts again only while it still counts an earlier day (or none).
    const fits = (now: DaySpend, read: DaySpend, cap: number): boolean =>
      read.day === today ? now.day === today && now.usd < cap : now.day === undefined || now.day < today;
    if (!fits(app, spend.app, APP_AI_DAILY_BUDGET_USD) || !fits(mine, spend.writer, WRITER_AI_DAILY_BUDGET_USD) || !fits(this.all, spend.all, ALL_APPS_AI_DAILY_BUDGET_USD)) return "conflict";
    const add = (now: DaySpend): DaySpend => ({ day: today, usd: round((now.day === today ? now.usd : 0) + costUsd) });
    this.apps.set(nickname.toLowerCase(), add(app));
    this.writers.set(writer.toLowerCase(), add(mine));
    this.all = add(this.all);
    return "reserved";
  }

  async settle(nickname: string, writer: string, today: string, deltaUsd: number): Promise<void> {
    this.check("settle");
    if (this.settleFailure !== undefined) {
      const failure = this.settleFailure;
      this.settleFailure = undefined;
      throw failure;
    }
    const app = this.apps.get(nickname.toLowerCase());
    if (app?.day === today) this.apps.set(nickname.toLowerCase(), { day: today, usd: round(app.usd + deltaUsd) });
    const mine = this.writers.get(writer.toLowerCase());
    if (mine?.day === today) this.writers.set(writer.toLowerCase(), { day: today, usd: round(mine.usd + deltaUsd) });
    if (this.all.day === today) this.all = { day: today, usd: round(this.all.usd + deltaUsd) };
  }
}

export class FakeMediaReader implements MediaReader {
  readonly objects = new Map<string, Buffer>();
  readonly reads: string[] = [];

  async read(key: string): Promise<Buffer | undefined> {
    this.reads.push(key);
    return this.objects.get(key);
  }
}

/** Bedrock: answers with `next` (a function of the call, or a fixed answer), or throws `failure`. */
export class FakeAppAiModel implements AppAiModel {
  readonly calls: ModelCall[] = [];
  next: ModelAnswer | ((call: ModelCall) => ModelAnswer) = { input: {}, text: "", inputTokens: 1000, outputTokens: 50 };
  failure: Error | undefined;

  async answer(call: ModelCall): Promise<ModelAnswer> {
    this.calls.push(call);
    if (this.failure !== undefined) throw this.failure;
    return typeof this.next === "function" ? this.next(call) : this.next;
  }
}

interface FakeJob {
  mediaKey: string;
  format: RecordingKind;
  outputKey: string;
  /** Looks at the job left before it is done (each `status` call takes one). */
  looksLeft: number;
  outcome: "done" | "failed";
}

/** Amazon Transcribe plus its result files in the bucket. */
export class FakeTranscriber implements Transcriber {
  readonly jobs = new Map<string, FakeJob>();
  /** Result files by key. */
  readonly results = new Map<string, string>();
  readonly calls: string[] = [];
  /** A new job is working for this many looks, then ends with `outcome`, writing `transcriptText`. */
  looksToFinish = 1;
  outcome: "done" | "failed" = "done";
  transcriptText = "Bonjour, ceci est un test.";
  language: string | undefined = "fr-FR";
  /** When set, the next start fails with it. */
  startFailure: Error | undefined;
  /** When set, the next start answers `exists` (someone else started the same job a moment before). */
  startExists = false;

  async status(jobName: string): Promise<TranscriptionStatus> {
    this.calls.push(`status ${jobName}`);
    const job = this.jobs.get(jobName);
    if (job === undefined) return { state: "missing" };
    if (job.looksLeft > 0) {
      job.looksLeft -= 1;
      if (job.looksLeft === 0 && job.outcome === "done") this.results.set(job.outputKey, this.transcriptText);
      return { state: "working" };
    }
    return job.outcome === "failed" ? { state: "failed" } : { state: "done", language: this.language };
  }

  async start(job: { name: string; mediaKey: string; format: RecordingKind; outputKey: string }): Promise<"started" | "exists"> {
    this.calls.push(`start ${job.name}`);
    if (this.startFailure !== undefined) {
      const failure = this.startFailure;
      this.startFailure = undefined;
      throw failure;
    }
    if (this.startExists || this.jobs.has(job.name)) {
      this.startExists = false;
      return "exists";
    }
    this.jobs.set(job.name, { mediaKey: job.mediaKey, format: job.format, outputKey: job.outputKey, looksLeft: this.looksToFinish, outcome: this.outcome });
    if (this.looksToFinish === 0 && this.outcome === "done") this.results.set(job.outputKey, this.transcriptText);
    return "started";
  }

  async transcript(outputKey: string): Promise<string | undefined> {
    this.calls.push(`transcript ${outputKey}`);
    return this.results.get(outputKey);
  }

  /** As AwsTranscriber: the job, then the file; `gone` when the job was not there. */
  async cleanUp(jobName: string, outputKey: string): Promise<"deleted" | "gone"> {
    this.calls.push(`cleanUp ${jobName}`);
    const existed = this.jobs.delete(jobName);
    this.results.delete(outputKey);
    return existed ? "deleted" : "gone";
  }
}
