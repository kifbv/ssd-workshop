// The AI tasks' AWS side (ticket 3.21): the table (live marker, settings, the two day counters), the media bucket (read
// only), Claude Haiku 4.5 on Bedrock and Amazon Transcribe. The rules live in ./ai.ts.
//
// The function's role (infra/lib/api-stack.ts) may read the live marker's `liveAt` (`APP#*`), app write tokens (3.24's
// projected read), the settings (SETTINGS_READ_ATTRIBUTES) and `APPAI#*` / `APPAI_WRITER#*` / `APPAI_TOTAL`, and update
// only those three counters, naming only APP_AI_WRITE_ATTRIBUTES; no call returns an item's attributes. In the bucket it may read
// `app-media/` and `transcripts/` and write and delete only `transcripts/`; Transcribe: start, get and delete jobs named
// `ssd-workshop-*` in eu-central-1, writing only to `transcripts/`.
//
// Items: `APPAI#<nickname>` / `AI_USAGE`, `APPAI_WRITER#<writer nickname>` / `AI_USAGE` (try 2) and `APPAI_TOTAL` /
// `AI_USAGE`, each `day` (UTC, YYYY-MM-DD) and `costUsd`.
//
// Every SDK call is bounded (./ai.ts counts on it for its deadline): the table through clientSettings (2 attempts of 1 s
// + 1.5 s), each S3, Transcribe and Bedrock call raced against its limit (S3_CALL_LIMIT_MS, TRANSCRIBE_CALL_LIMIT_MS,
// the call's timeoutMs) and aborted at it, since a socket timeout alone does not bound a body that trickles in.
import {
  GetItemCommand,
  TransactWriteItemsCommand,
  UpdateItemCommand,
  type AttributeValue,
  type GetItemCommandOutput,
  type TransactWriteItem,
  type TransactWriteItemsCommandOutput,
  type UpdateItemCommandOutput,
} from "@aws-sdk/client-dynamodb";
import { ConverseCommand, type ConverseCommandOutput, type ToolInputSchema } from "@aws-sdk/client-bedrock-runtime";
import { DeleteObjectCommand, GetObjectCommand, type DeleteObjectCommandOutput, type GetObjectCommandOutput } from "@aws-sdk/client-s3";
import {
  DeleteTranscriptionJobCommand,
  GetTranscriptionJobCommand,
  StartTranscriptionJobCommand,
  type DeleteTranscriptionJobCommandOutput,
  type GetTranscriptionJobCommandOutput,
  type LanguageCode,
  type StartTranscriptionJobCommandOutput,
} from "@aws-sdk/client-transcribe";
import type { RecordingKind } from "../app-media/formats.js";
import { MAX_MEDIA_FILE_BYTES } from "../app-media/media.js";
import { appAiTotalKey, appAiUsageKey, appAiWriterKey, appLiveKey, type ItemKey } from "../keys.js";
import type { DocumentType } from "@smithy/types";
import type { WorkshopSettings } from "../workshop/settings.js";
import { readSettings } from "../workshop/store.js";
import { S3_CALL_LIMIT_MS, TRANSCRIBE_CALL_LIMIT_MS, type AppAiModel, type AppAiStore, type MediaReader, type ModelAnswer, type ModelCall, type Transcriber, type TranscriptionStatus } from "./ai.js";
import { ALL_APPS_AI_DAILY_BUDGET_USD, APP_AI_DAILY_BUDGET_USD, MAX_OUTPUT_TOKENS, WRITER_AI_DAILY_BUDGET_USD, type AiSpend, type DaySpend } from "./budget.js";

/** The methods of DynamoDBClient this store uses, so tests can stub it. */
export interface AppAiSender {
  send(command: GetItemCommand): Promise<GetItemCommandOutput>;
  send(command: TransactWriteItemsCommand): Promise<TransactWriteItemsCommandOutput>;
  send(command: UpdateItemCommand): Promise<UpdateItemCommandOutput>;
}

const str = (value: string): AttributeValue => ({ S: value });
const num = (value: number): AttributeValue => ({ N: String(value) });
const keyOf = (key: ItemKey): Record<string, AttributeValue> => ({ pk: str(key.pk), sk: str(key.sk) });
const round = (usd: number): number => Math.round(usd * 1e8) / 1e8;

function cancellationCodes(error: unknown): (string | undefined)[] | undefined {
  if (!(error instanceof Error) || error.name !== "TransactionCanceledException") return undefined;
  return ((error as { CancellationReasons?: { Code?: string }[] }).CancellationReasons ?? []).map((r) => r.Code);
}
const RACE_CODES = ["ConditionalCheckFailed", "TransactionConflict"];

const COUNTER_NAMES = { "#day": "day", "#costUsd": "costUsd" } as const;

/** A counter as read: a missing item or day is "no day yet"; a missing or broken amount reads as NaN (spent, ./budget.ts). */
function daySpend(item: Record<string, AttributeValue> | undefined): DaySpend {
  const day = item?.["day"]?.S;
  if (day === undefined) return { day: undefined, usd: 0 };
  const usd = item?.["costUsd"]?.N === undefined ? Number.NaN : Number(item["costUsd"].N);
  return { day, usd };
}

export class DynamoAppAiStore implements AppAiStore {
  constructor(
    private readonly client: AppAiSender,
    private readonly tableName: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private async get(key: ItemKey, names: Record<string, string>): Promise<Record<string, AttributeValue> | undefined> {
    const output = await this.client.send(
      new GetItemCommand({ TableName: this.tableName, Key: keyOf(key), ConsistentRead: true, ProjectionExpression: Object.keys(names).join(", "), ExpressionAttributeNames: names }),
    );
    return output.Item;
  }

  /** Live only with the marker's `liveAt`, which only the deployer writes. */
  async isLive(nickname: string): Promise<boolean> {
    return (await this.get(appLiveKey(nickname), { "#liveAt": "liveAt" }))?.["liveAt"]?.S !== undefined;
  }

  getSettings(): Promise<WorkshopSettings> {
    return readSettings(this.client, this.tableName);
  }

  async getSpend(nickname: string, writer: string): Promise<AiSpend> {
    const [app, mine, all] = await Promise.all([appAiUsageKey(nickname), appAiWriterKey(writer), appAiTotalKey()].map((key) => this.get(key, { ...COUNTER_NAMES })));
    return { app: daySpend(app), writer: daySpend(mine), all: daySpend(all) };
  }

  /** One counter's update: add under today and the budget, or start today over an earlier day (only forward). */
  private counterUpdate(key: ItemKey, read: DaySpend, today: string, costUsd: number, budget: number, type: string): TransactWriteItem {
    const common = { TableName: this.tableName, Key: keyOf(key), ExpressionAttributeNames: { "#type": "type", "#updatedAt": "updatedAt", ...COUNTER_NAMES } };
    const nowIso = this.now().toISOString();
    return read.day === today
      ? {
          Update: {
            ...common,
            UpdateExpression: "SET #type = :type, #costUsd = #costUsd + :cost, #updatedAt = :now",
            ConditionExpression: "#day = :today AND #costUsd < :budget",
            ExpressionAttributeValues: { ":type": str(type), ":cost": num(costUsd), ":now": str(nowIso), ":today": str(today), ":budget": num(budget) },
          },
        }
      : {
          Update: {
            ...common,
            UpdateExpression: "SET #type = :type, #day = :today, #costUsd = :cost, #updatedAt = :now",
            ConditionExpression: "attribute_not_exists(#day) OR #day < :today",
            ExpressionAttributeValues: { ":type": str(type), ":cost": num(costUsd), ":now": str(nowIso), ":today": str(today) },
          },
        };
  }

  async reserve(nickname: string, writer: string, spend: AiSpend, today: string, costUsd: number): Promise<"reserved" | "conflict"> {
    const cost = round(costUsd);
    try {
      await this.client.send(
        new TransactWriteItemsCommand({
          TransactItems: [
            this.counterUpdate(appAiUsageKey(nickname), spend.app, today, cost, APP_AI_DAILY_BUDGET_USD, "app-ai-usage"),
            this.counterUpdate(appAiWriterKey(writer), spend.writer, today, cost, WRITER_AI_DAILY_BUDGET_USD, "app-ai-writer"),
            this.counterUpdate(appAiTotalKey(), spend.all, today, cost, ALL_APPS_AI_DAILY_BUDGET_USD, "app-ai-total"),
          ],
        }),
      );
      return "reserved";
    } catch (error) {
      if (cancellationCodes(error)?.some((code) => code !== undefined && RACE_CODES.includes(code)) === true) return "conflict";
      throw error;
    }
  }

  async settle(nickname: string, writer: string, today: string, deltaUsd: number): Promise<void> {
    const delta = round(deltaUsd);
    if (delta === 0) return;
    const nowIso = this.now().toISOString();
    // Each counter on its own: one whose day has turned since is left alone (its condition fails, and that is fine).
    const results = await Promise.allSettled(
      [appAiUsageKey(nickname), appAiWriterKey(writer), appAiTotalKey()].map((key) =>
        this.client.send(
          new UpdateItemCommand({
            TableName: this.tableName,
            Key: keyOf(key),
            UpdateExpression: "SET #costUsd = #costUsd + :delta, #updatedAt = :now",
            ConditionExpression: "#day = :today",
            ExpressionAttributeNames: { "#updatedAt": "updatedAt", ...COUNTER_NAMES },
            ExpressionAttributeValues: { ":delta": num(delta), ":now": str(nowIso), ":today": str(today) },
          }),
        ),
      ),
    );
    const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected" && (r.reason as Error)?.name !== "ConditionalCheckFailedException");
    if (failed !== undefined) throw failed.reason;
  }
}

/** The methods of S3Client the AI tasks use. */
export interface AppAiBucketSender {
  send(command: GetObjectCommand, options?: { abortSignal?: AbortSignal }): Promise<GetObjectCommandOutput>;
  send(command: DeleteObjectCommand, options?: { abortSignal?: AbortSignal }): Promise<DeleteObjectCommandOutput>;
}

/** Runs `work` with an abort signal that fires after `ms`, and gives up (TimeoutError) at that time even if it does not stop. */
export async function withinLimit<T>(ms: number, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(Object.assign(new Error("the call took too long"), { name: "TimeoutError" }));
    }, ms);
  });
  try {
    return await Promise.race([work(controller.signal), limit]);
  } finally {
    clearTimeout(timer);
  }
}

/** An object's bytes, or undefined when it is missing or larger than `max` (checked on the announced length first). */
function readObject(client: AppAiBucketSender, bucket: string, key: string, max: number): Promise<Buffer | undefined> {
  return withinLimit(S3_CALL_LIMIT_MS, async (abortSignal) => {
    let output: GetObjectCommandOutput;
    try {
      output = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }), { abortSignal });
    } catch (error) {
      if ((error as Error)?.name === "NoSuchKey" || (error as Error)?.name === "NotFound") return undefined;
      throw error;
    }
    if (output.Body === undefined || (output.ContentLength ?? 0) > max) return undefined;
    const bytes = Buffer.from(await output.Body.transformToByteArray());
    return bytes.length > max ? undefined : bytes;
  });
}

export class S3MediaReader implements MediaReader {
  constructor(
    private readonly client: AppAiBucketSender,
    private readonly bucketName: string,
  ) {}

  read(key: string): Promise<Buffer | undefined> {
    return readObject(this.client, this.bucketName, key, MAX_MEDIA_FILE_BYTES);
  }
}

/** The one method of BedrockRuntimeClient the model uses. */
export interface AppAiConverseSender {
  send(command: ConverseCommand, options?: { abortSignal?: AbortSignal }): Promise<ConverseCommandOutput>;
}

/**
 * Claude Haiku 4.5 through the Converse API: the photo first, then the text, and one tool the model must call; the call
 * is aborted (TimeoutError) after the call's `timeoutMs`, which ./ai.ts takes from the request's deadline.
 */
export class BedrockAppAiModel implements AppAiModel {
  constructor(
    private readonly client: AppAiConverseSender,
    private readonly modelId: string,
  ) {
    if (!modelId.startsWith("eu.anthropic.")) throw new Error("the model must be an EU inference profile (eu.anthropic.*)");
  }

  async answer(call: ModelCall): Promise<ModelAnswer> {
    const command = new ConverseCommand({
      modelId: this.modelId,
      system: [{ text: call.system }],
      messages: [
        {
          role: "user",
          content: [...(call.photo === undefined ? [] : [{ image: { format: "jpeg" as const, source: { bytes: new Uint8Array(call.photo) } } }]), { text: call.text }],
        },
      ],
      inferenceConfig: { maxTokens: MAX_OUTPUT_TOKENS, temperature: 0 },
      toolConfig: {
        tools: [{ toolSpec: { name: call.tool.name, description: call.tool.description, inputSchema: { json: call.tool.schema as DocumentType } as ToolInputSchema } }],
        toolChoice: { tool: { name: call.tool.name } },
      },
    });
    const output = await withinLimit(call.timeoutMs, (abortSignal) => this.client.send(command, { abortSignal }));
    const blocks = output.output?.message?.content ?? [];
    const use = blocks.find((block) => block.toolUse?.name === call.tool.name)?.toolUse;
    const text = blocks
      .map((block) => block.text ?? "")
      .join("")
      .trim();
    return { input: use?.input, text, inputTokens: output.usage?.inputTokens ?? 0, outputTokens: output.usage?.outputTokens ?? 0 };
  }
}

/** The methods of TranscribeClient the AI tasks use. */
export interface TranscribeSender {
  send(command: StartTranscriptionJobCommand, options?: { abortSignal?: AbortSignal }): Promise<StartTranscriptionJobCommandOutput>;
  send(command: GetTranscriptionJobCommand, options?: { abortSignal?: AbortSignal }): Promise<GetTranscriptionJobCommandOutput>;
  send(command: DeleteTranscriptionJobCommand, options?: { abortSignal?: AbortSignal }): Promise<DeleteTranscriptionJobCommandOutput>;
}

/**
 * The languages Transcribe picks from (please veto): one variant each, as language identification requires; the workshop's
 * participants speak mostly French and English.
 */
export const TRANSCRIBE_LANGUAGES: LanguageCode[] = ["en-US", "fr-FR", "de-DE", "es-ES", "it-IT", "nl-NL", "pt-PT"];
/** A transcript file of 5 minutes of speech is a few hundred KB at most (with every word's timing). */
export const MAX_TRANSCRIPT_BYTES = 2 * 1024 * 1024;

const isNotFound = (error: unknown): boolean => ["NotFoundException", "BadRequestException"].includes((error as Error)?.name ?? "");

export class AwsTranscriber implements Transcriber {
  constructor(
    private readonly transcribe: TranscribeSender,
    private readonly s3: AppAiBucketSender,
    private readonly bucketName: string,
  ) {}

  async status(jobName: string): Promise<TranscriptionStatus> {
    let output: GetTranscriptionJobCommandOutput;
    try {
      output = await withinLimit(TRANSCRIBE_CALL_LIMIT_MS, (abortSignal) => this.transcribe.send(new GetTranscriptionJobCommand({ TranscriptionJobName: jobName }), { abortSignal }));
    } catch (error) {
      if (isNotFound(error)) return { state: "missing" };
      throw error;
    }
    const job = output.TranscriptionJob;
    if (job === undefined) return { state: "missing" };
    if (job.TranscriptionJobStatus === "COMPLETED") return { state: "done", language: job.LanguageCode };
    if (job.TranscriptionJobStatus === "FAILED") return { state: "failed" };
    return { state: "working" };
  }

  /**
   * `exists` on ConflictException (a job of that name is there). Every other error is thrown by name as the SDK gives it
   * (or TimeoutError from the limit): the route decides from the name whether a job may have started (try 3,
   * `UNSTARTED_TRANSCRIBE_ERRORS` in ./ai.ts).
   */
  async start(job: { name: string; mediaKey: string; format: RecordingKind; outputKey: string }): Promise<"started" | "exists"> {
    try {
      const command = new StartTranscriptionJobCommand({
        TranscriptionJobName: job.name,
        Media: { MediaFileUri: `s3://${this.bucketName}/${job.mediaKey}` },
        MediaFormat: job.format,
        IdentifyLanguage: true,
        LanguageOptions: TRANSCRIBE_LANGUAGES,
        OutputBucketName: this.bucketName,
        OutputKey: job.outputKey,
      });
      await withinLimit(TRANSCRIBE_CALL_LIMIT_MS, (abortSignal) => this.transcribe.send(command, { abortSignal }));
      return "started";
    } catch (error) {
      if ((error as Error)?.name === "ConflictException") return "exists";
      throw error;
    }
  }

  async transcript(outputKey: string): Promise<string | undefined> {
    const bytes = await readObject(this.s3, this.bucketName, outputKey, MAX_TRANSCRIPT_BYTES);
    if (bytes === undefined) return undefined;
    try {
      const parsed = JSON.parse(bytes.toString("utf8")) as { results?: { transcripts?: { transcript?: unknown }[] } };
      const text = parsed.results?.transcripts?.map((t) => (typeof t.transcript === "string" ? t.transcript : "")).join(" ");
      return text === undefined ? undefined : text;
    } catch {
      return undefined;
    }
  }

  /**
   * Deletes the job, then the result file (try 2: in this order, a request that finds the file gone finds the job gone
   * too, so it knows another request read the text first); `gone` when the job was already deleted.
   */
  async cleanUp(jobName: string, outputKey: string): Promise<"deleted" | "gone"> {
    let result: "deleted" | "gone" = "deleted";
    try {
      await withinLimit(TRANSCRIBE_CALL_LIMIT_MS, (abortSignal) => this.transcribe.send(new DeleteTranscriptionJobCommand({ TranscriptionJobName: jobName }), { abortSignal }));
    } catch (error) {
      if (!isNotFound(error)) throw error;
      result = "gone";
    }
    await withinLimit(S3_CALL_LIMIT_MS, (abortSignal) => this.s3.send(new DeleteObjectCommand({ Bucket: this.bucketName, Key: outputKey }), { abortSignal }));
    return result;
  }
}
