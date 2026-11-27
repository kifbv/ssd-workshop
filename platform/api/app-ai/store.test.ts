// Ticket 3.21: the AI tasks' DynamoDB requests, Bedrock call and Transcribe/S3 calls against stub clients: every
// placeholder defined and used, every attribute inside the IAM lists (APP_AI_WRITE_ATTRIBUTES, APP_AI_READ_ATTRIBUTES,
// the live marker's), the budgets written into the conditions, and the answers to cancellations and missing jobs.
import { GetItemCommand, TransactWriteItemsCommand, UpdateItemCommand, type TransactWriteItem } from "@aws-sdk/client-dynamodb";
import { ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { DeleteObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { DeleteTranscriptionJobCommand, GetTranscriptionJobCommand, StartTranscriptionJobCommand } from "@aws-sdk/client-transcribe";
import { describe, expect, it, vi } from "vitest";
import { APP_AI_LEADING_KEYS, APP_AI_MODEL_ID, APP_AI_READ_ATTRIBUTES, APP_AI_TRANSCRIPTION_JOB_PREFIX, APP_AI_TRANSCRIPTS_PREFIX, APP_AI_WRITE_ATTRIBUTES, APP_LIVE_READ_ATTRIBUTES } from "../../../infra/lib/config.js";
import { MODELS } from "../settings.js";
import { S3_CALL_LIMIT_MS, TRANSCRIBE_CALL_LIMIT_MS, TRANSCRIPTS_PREFIX, transcriptionJobName, transcriptKey } from "./ai.js";
import { MAX_OUTPUT_TOKENS } from "./budget.js";
import { AwsTranscriber, BedrockAppAiModel, DynamoAppAiStore, S3MediaReader, TRANSCRIBE_LANGUAGES, type AppAiBucketSender, type AppAiSender, type TranscribeSender } from "./store.js";

type Sent = { input: unknown; constructor: { name: string } };

function stub<T>(answers: (Record<string, unknown> | Error)[]): { client: T; sent: Sent[] } {
  const sent: Sent[] = [];
  const client = {
    send: async (command: Sent) => {
      sent.push(command);
      const answer = answers.shift();
      if (answer === undefined) throw new Error("unexpected call");
      if (answer instanceof Error) throw answer;
      return { $metadata: {}, ...answer };
    },
  } as unknown as T;
  return { client, sent };
}

const TABLE = "ssd-workshop-data";
const NOW = new Date("2026-11-27T10:00:00.000Z");
const TODAY = "2026-11-27";
const named = (name: string, extra: Record<string, unknown> = {}): Error => Object.assign(new Error(name), { name, ...extra });
const cancelled = (codes: string[]): Error => named("TransactionCanceledException", { CancellationReasons: codes.map((Code) => ({ Code })) });

interface Part {
  Key?: Record<string, { S?: string }>;
  UpdateExpression?: string;
  ConditionExpression?: string;
  ProjectionExpression?: string;
  ExpressionAttributeNames?: Record<string, string>;
  ExpressionAttributeValues?: Record<string, { S?: string; N?: string }>;
}

/** Placeholders defined and used both ways; gives the partition and every top-level attribute name the request names. */
function check(part: Part): { pk: string; names: string[] } {
  const text = `${part.UpdateExpression ?? ""} ${part.ConditionExpression ?? ""} ${part.ProjectionExpression ?? ""}`;
  const used = new Set(text.match(/[#:][A-Za-z_]+/g) ?? []);
  const defined = new Set([...Object.keys(part.ExpressionAttributeNames ?? {}), ...Object.keys(part.ExpressionAttributeValues ?? {})]);
  expect([...used].sort(), text).toEqual([...defined].sort());
  const names = [...new Set([...(text.match(/#[A-Za-z_]+/g) ?? []).map((p) => part.ExpressionAttributeNames?.[p] ?? "?"), ...Object.keys(part.Key ?? {})])];
  return { pk: part.Key?.["pk"]?.S ?? "", names };
}

const inLeadingKeys = (pk: string): boolean => APP_AI_LEADING_KEYS.some((pattern) => (pattern.endsWith("*") ? pk.startsWith(pattern.slice(0, -1)) : pk === pattern));

describe("DynamoAppAiStore", () => {
  it("reads the live marker's liveAt only, and the counters with consistent projected reads inside the IAM list", async () => {
    const { client, sent } = stub<AppAiSender>([{ Item: { liveAt: { S: "x" } } }, { Item: { day: { S: TODAY }, costUsd: { N: "0.25" } } }, { Item: { day: { S: TODAY }, costUsd: { N: "0.5" } } }, {}]);
    const store = new DynamoAppAiStore(client, TABLE, () => NOW);
    expect(await store.isLive("Ada-42")).toBe(true);
    expect(await store.getSpend("Ada-42", "Bob-Writer")).toEqual({ app: { day: TODAY, usd: 0.25 }, writer: { day: TODAY, usd: 0.5 }, all: { day: undefined, usd: 0 } });
    const live = check(sent[0]?.input as Part);
    expect(live.pk).toBe("APP#ada-42");
    for (const name of live.names) expect(APP_LIVE_READ_ATTRIBUTES as readonly string[]).toContain(name);
    for (const command of sent.slice(1)) {
      expect(command).toBeInstanceOf(GetItemCommand);
      expect((command.input as { ConsistentRead?: boolean }).ConsistentRead).toBe(true);
      const { pk, names } = check(command.input as Part);
      expect(inLeadingKeys(pk), pk).toBe(true);
      for (const name of names) expect(APP_AI_READ_ATTRIBUTES as readonly string[]).toContain(name);
    }
    expect(sent.slice(1).map((c) => check(c.input as Part).pk)).toEqual(["APPAI#ada-42", "APPAI_WRITER#bob-writer", "APPAI_TOTAL"]);
  });

  it("reads a counter with a day but no amount as broken (NaN, which the budget treats as spent)", async () => {
    const { client } = stub<AppAiSender>([{ Item: { day: { S: TODAY } } }, { Item: { day: { S: TODAY } } }, { Item: { day: { S: TODAY }, costUsd: { N: "1" } } }]);
    const spend = await new DynamoAppAiStore(client, TABLE).getSpend("ada-42", "bob");
    expect(spend.app.usd).toBeNaN();
    expect(spend.writer.usd).toBeNaN();
  });

  it("reserves in one transaction: add under today and the budget, or start today over an earlier day (only forward)", async () => {
    const { client, sent } = stub<AppAiSender>([{}]);
    const store = new DynamoAppAiStore(client, TABLE, () => NOW);
    const result = await store.reserve("Ada-42", "Bob-Writer", { app: { day: TODAY, usd: 0.5 }, writer: { day: TODAY, usd: 0.2 }, all: { day: "2026-11-26", usd: 9 } }, TODAY, 0.0123456789);
    expect(result).toBe("reserved");
    const items = (sent[0]?.input as { TransactItems: TransactWriteItem[] }).TransactItems;
    expect(items).toHaveLength(3);
    const [app, writer, all] = items.map((item) => item.Update as Part);
    expect([app, writer, all].map((part) => part?.Key?.["pk"]?.S)).toEqual(["APPAI#ada-42", "APPAI_WRITER#bob-writer", "APPAI_TOTAL"]);
    // The writer's $1 (try 2) is in its own condition, with the same rules as the app's.
    expect(writer?.ConditionExpression).toBe("#day = :today AND #costUsd < :budget");
    expect(writer?.ExpressionAttributeValues?.[":budget"]?.N).toBe("1");
    for (const part of [app, writer, all]) {
      const { pk, names } = check(part as Part);
      expect(inLeadingKeys(pk)).toBe(true);
      for (const name of names) expect(APP_AI_WRITE_ATTRIBUTES as readonly string[]).toContain(name);
      expect(part?.ExpressionAttributeValues?.[":cost"]?.N).toBe("0.01234568");
      expect(part?.ExpressionAttributeValues?.[":today"]?.S).toBe(TODAY);
      expect(Object.keys(part as object)).not.toContain("ReturnValues");
    }
    expect(app?.ConditionExpression).toBe("#day = :today AND #costUsd < :budget");
    expect(app?.ExpressionAttributeValues?.[":budget"]?.N).toBe("1");
    expect(all?.ConditionExpression).toBe("attribute_not_exists(#day) OR #day < :today");
    expect(all?.UpdateExpression).toContain("#costUsd = :cost");
  });

  it("puts the workshop's $10 into the all-apps condition on a same-day add", async () => {
    const { client, sent } = stub<AppAiSender>([{}]);
    await new DynamoAppAiStore(client, TABLE, () => NOW).reserve("ada-42", "bob", { app: { day: undefined, usd: 0 }, writer: { day: undefined, usd: 0 }, all: { day: TODAY, usd: 3 } }, TODAY, 0.01);
    const all = (sent[0]?.input as { TransactItems: TransactWriteItem[] }).TransactItems[2]?.Update as Part;
    expect(all.ExpressionAttributeValues?.[":budget"]?.N).toBe("10");
  });

  it("answers conflict to a failed condition or a TransactionConflict, and throws anything else", async () => {
    for (const codes of [["ConditionalCheckFailed", "None", "None"], ["None", "ConditionalCheckFailed", "None"], ["None", "None", "TransactionConflict"]]) {
      const { client } = stub<AppAiSender>([cancelled(codes)]);
      expect(await new DynamoAppAiStore(client, TABLE).reserve("ada-42", "bob", { app: { day: TODAY, usd: 0 }, writer: { day: TODAY, usd: 0 }, all: { day: TODAY, usd: 0 } }, TODAY, 0.01)).toBe("conflict");
    }
    const { client } = stub<AppAiSender>([named("ProvisionedThroughputExceededException")]);
    await expect(new DynamoAppAiStore(client, TABLE).reserve("ada-42", "bob", { app: { day: TODAY, usd: 0 }, writer: { day: TODAY, usd: 0 }, all: { day: TODAY, usd: 0 } }, TODAY, 0.01)).rejects.toThrow();
  });

  it("settles each counter only while it counts that day; a turned day is fine, another error is thrown", async () => {
    const { client, sent } = stub<AppAiSender>([{}, {}, named("ConditionalCheckFailedException")]);
    await new DynamoAppAiStore(client, TABLE, () => NOW).settle("ada-42", "bob", TODAY, -0.004);
    expect(sent).toHaveLength(3);
    expect(sent.map((c) => check(c.input as Part).pk)).toEqual(["APPAI#ada-42", "APPAI_WRITER#bob", "APPAI_TOTAL"]);
    for (const command of sent) {
      expect(command).toBeInstanceOf(UpdateItemCommand);
      const part = command.input as Part;
      const { pk, names } = check(part);
      expect(inLeadingKeys(pk)).toBe(true);
      for (const name of names) expect(APP_AI_WRITE_ATTRIBUTES as readonly string[]).toContain(name);
      expect(part.ConditionExpression).toBe("#day = :today");
      expect(part.ExpressionAttributeValues?.[":delta"]?.N).toBe("-0.004");
    }
    const failing = stub<AppAiSender>([{}, named("InternalServerError"), {}]);
    await expect(new DynamoAppAiStore(failing.client, TABLE).settle("ada-42", "bob", TODAY, 0.01)).rejects.toThrow();
    const none = stub<AppAiSender>([]);
    await new DynamoAppAiStore(none.client, TABLE).settle("ada-42", "bob", TODAY, 0);
    expect(none.sent).toEqual([]);
  });

  it("writes only items the transaction type allows (no Put, no Delete)", async () => {
    const { client, sent } = stub<AppAiSender>([{}]);
    await new DynamoAppAiStore(client, TABLE).reserve("ada-42", "bob", { app: { day: undefined, usd: 0 }, writer: { day: undefined, usd: 0 }, all: { day: undefined, usd: 0 } }, TODAY, 0.01);
    expect(sent[0]).toBeInstanceOf(TransactWriteItemsCommand);
    for (const item of (sent[0]?.input as { TransactItems: TransactWriteItem[] }).TransactItems) expect(Object.keys(item)).toEqual(["Update"]);
  });
});

const body = (bytes: Buffer) => ({ Body: { transformToByteArray: async () => new Uint8Array(bytes) }, ContentLength: bytes.length });

describe("S3MediaReader", () => {
  it("reads an object, and gives undefined for a missing one or one larger than the media API's 4 MB", async () => {
    const { client, sent } = stub<AppAiBucketSender>([body(Buffer.from("abc")), named("NoSuchKey"), { ...body(Buffer.from("x")), ContentLength: 5 * 1024 * 1024 }]);
    const reader = new S3MediaReader(client, "bucket");
    expect(await reader.read("app-media/ada-42/x")).toEqual(Buffer.from("abc"));
    expect(await reader.read("app-media/ada-42/y")).toBeUndefined();
    expect(await reader.read("app-media/ada-42/z")).toBeUndefined();
    expect(sent[0]).toBeInstanceOf(GetObjectCommand);
    expect(sent[0]?.input).toEqual({ Bucket: "bucket", Key: "app-media/ada-42/x" });
  });
});

describe("BedrockAppAiModel", () => {
  it("calls the Haiku 4.5 EU profile with the photo, the text, one forced tool and at most 1,024 tokens out", async () => {
    expect(MODELS.appAi.modelId).toBe(APP_AI_MODEL_ID);
    const { client, sent } = stub<{ send(c: ConverseCommand): Promise<never> }>([
      { output: { message: { role: "assistant", content: [{ toolUse: { toolUseId: "1", name: "pick_tags", input: { tags: ["cat"] } } }] } }, usage: { inputTokens: 1700, outputTokens: 40 } },
    ]);
    const model = new BedrockAppAiModel(client, MODELS.appAi.modelId);
    const answer = await model.answer({ system: "sys", text: "txt", photo: Buffer.from([0xff, 0xd8]), tool: { name: "pick_tags", description: "d", schema: { type: "object" } }, timeoutMs: 20_000 });
    expect(answer).toEqual({ input: { tags: ["cat"] }, text: "", inputTokens: 1700, outputTokens: 40 });
    const input = sent[0]?.input as { modelId: string; messages: { content: Record<string, unknown>[] }[]; inferenceConfig: { maxTokens: number }; toolConfig: { toolChoice: unknown; tools: unknown[] } };
    expect(input.modelId).toBe("eu.anthropic.claude-haiku-4-5-20251001-v1:0");
    expect(Object.keys(input.messages[0]?.content[0] ?? {})).toEqual(["image"]);
    expect(input.messages[0]?.content[1]).toEqual({ text: "txt" });
    expect(input.inferenceConfig.maxTokens).toBe(MAX_OUTPUT_TOKENS);
    expect(input.toolConfig.toolChoice).toEqual({ tool: { name: "pick_tags" } });
    expect(input.toolConfig.tools).toHaveLength(1);
    expect(() => new BedrockAppAiModel(client, "anthropic.claude-haiku-4-5-20251001-v1:0")).toThrow();
  });
});

describe("AwsTranscriber", () => {
  const job = { name: transcriptionJobName("Ada-42", "VoIcEvOiCeVoIcEvOiCe01"), mediaKey: "app-media/ada-42/VoIcEvOiCeVoIcEvOiCe01", format: "ogg" as const, outputKey: transcriptKey("Ada-42", "VoIcEvOiCeVoIcEvOiCe01") };

  it("names jobs ssd-workshop-app-ai-* and results under transcripts/, as the role's policy allows", () => {
    expect(job.name.startsWith(APP_AI_TRANSCRIPTION_JOB_PREFIX)).toBe(true);
    expect(job.name).toMatch(/^[0-9a-zA-Z._-]{1,200}$/);
    expect(TRANSCRIPTS_PREFIX).toBe(APP_AI_TRANSCRIPTS_PREFIX);
    expect(job.outputKey.startsWith(APP_AI_TRANSCRIPTS_PREFIX)).toBe(true);
  });

  it("starts a batch job on the stored file, language detected, results to the bucket's transcripts/ key", async () => {
    const t = stub<TranscribeSender>([{}, named("ConflictException")]);
    const transcriber = new AwsTranscriber(t.client, stub<AppAiBucketSender>([]).client, "bucket");
    expect(await transcriber.start(job)).toBe("started");
    expect(await transcriber.start(job)).toBe("exists");
    expect(t.sent[0]).toBeInstanceOf(StartTranscriptionJobCommand);
    expect(t.sent[0]?.input).toEqual({
      TranscriptionJobName: job.name,
      Media: { MediaFileUri: "s3://bucket/app-media/ada-42/VoIcEvOiCeVoIcEvOiCe01" },
      MediaFormat: "ogg",
      IdentifyLanguage: true,
      LanguageOptions: TRANSCRIBE_LANGUAGES,
      OutputBucketName: "bucket",
      OutputKey: job.outputKey,
    });
    // Language identification takes one variant per language.
    expect(new Set(TRANSCRIBE_LANGUAGES.map((l) => l.slice(0, 2))).size).toBe(TRANSCRIBE_LANGUAGES.length);
  });

  it("maps the job's status, and a missing job to missing", async () => {
    const t = stub<TranscribeSender>([
      { TranscriptionJob: { TranscriptionJobStatus: "IN_PROGRESS" } },
      { TranscriptionJob: { TranscriptionJobStatus: "QUEUED" } },
      { TranscriptionJob: { TranscriptionJobStatus: "COMPLETED", LanguageCode: "fr-FR" } },
      { TranscriptionJob: { TranscriptionJobStatus: "FAILED" } },
      named("BadRequestException"),
      named("NotFoundException"),
      named("ThrottlingException"),
    ]);
    const transcriber = new AwsTranscriber(t.client, stub<AppAiBucketSender>([]).client, "bucket");
    const states = [];
    for (let i = 0; i < 6; i += 1) states.push(await transcriber.status(job.name));
    expect(states).toEqual([{ state: "working" }, { state: "working" }, { state: "done", language: "fr-FR" }, { state: "failed" }, { state: "missing" }, { state: "missing" }]);
    await expect(transcriber.status(job.name)).rejects.toThrow();
    expect(t.sent[0]).toBeInstanceOf(GetTranscriptionJobCommand);
  });

  it("reads the transcript text from the result file, and deletes the job, then the file; gone when the job was already deleted", async () => {
    const file = Buffer.from(JSON.stringify({ results: { transcripts: [{ transcript: "Bonjour tout le monde." }], items: [] } }));
    const order: string[] = [];
    const s3 = stub<AppAiBucketSender>([body(file), body(Buffer.from("not json")), named("NoSuchKey"), {}, {}]);
    const t = stub<TranscribeSender>([{}, named("NotFoundException"), named("ThrottlingException")]);
    const logged = <T extends { send: (c: never) => unknown }>(client: T, label: string): T =>
      ({ send: (command: never) => (order.push(label), client.send(command)) }) as unknown as T;
    const transcriber = new AwsTranscriber(logged(t.client, "job"), logged(s3.client, "s3"), "bucket");
    expect(await transcriber.transcript(job.outputKey)).toBe("Bonjour tout le monde.");
    expect(await transcriber.transcript(job.outputKey)).toBeUndefined();
    expect(await transcriber.transcript(job.outputKey)).toBeUndefined();
    order.length = 0;
    expect(await transcriber.cleanUp(job.name, job.outputKey)).toBe("deleted");
    expect(order).toEqual(["job", "s3"]);
    expect(s3.sent[3]).toBeInstanceOf(DeleteObjectCommand);
    expect(s3.sent[3]?.input).toEqual({ Bucket: "bucket", Key: job.outputKey });
    expect(t.sent[0]).toBeInstanceOf(DeleteTranscriptionJobCommand);
    expect(t.sent[0]?.input).toEqual({ TranscriptionJobName: job.name });
    // Another request deleted the job first: still deletes the file, and says so.
    expect(await transcriber.cleanUp(job.name, job.outputKey)).toBe("gone");
    await expect(transcriber.cleanUp(job.name, job.outputKey)).rejects.toThrow("ThrottlingException");
  });
});

describe("time limits (try 2)", () => {
  /** A client whose calls never answer, recording the abort signal each call got. */
  function hanging<T>(): { client: T; signals: (AbortSignal | undefined)[] } {
    const signals: (AbortSignal | undefined)[] = [];
    const client = { send: (_command: unknown, options?: { abortSignal?: AbortSignal }) => (signals.push(options?.abortSignal), new Promise(() => undefined)) } as unknown as T;
    return { client, signals };
  }

  it("cuts off and aborts an S3 read at S3_CALL_LIMIT_MS, a Transcribe call at TRANSCRIBE_CALL_LIMIT_MS and the model at its timeoutMs", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const s3 = hanging<AppAiBucketSender>();
      const read = new S3MediaReader(s3.client, "bucket").read("app-media/ada-42/x");
      const readFailed = expect(read).rejects.toMatchObject({ name: "TimeoutError" });
      await vi.advanceTimersByTimeAsync(S3_CALL_LIMIT_MS);
      await readFailed;
      expect(s3.signals[0]?.aborted).toBe(true);

      const t = hanging<TranscribeSender>();
      const status = new AwsTranscriber(t.client, s3.client, "bucket").status("ssd-workshop-app-ai-x");
      const statusFailed = expect(status).rejects.toMatchObject({ name: "TimeoutError" });
      await vi.advanceTimersByTimeAsync(TRANSCRIBE_CALL_LIMIT_MS);
      await statusFailed;
      expect(t.signals[0]?.aborted).toBe(true);

      const bedrock = hanging<{ send(c: ConverseCommand): Promise<never> }>();
      const answer = new BedrockAppAiModel(bedrock.client, MODELS.appAi.modelId).answer({ system: "s", text: "t", tool: { name: "x", description: "d", schema: { type: "object" } }, timeoutMs: 9_000 });
      const answerFailed = expect(answer).rejects.toMatchObject({ name: "TimeoutError" });
      await vi.advanceTimersByTimeAsync(8_999);
      expect(bedrock.signals[0]?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await answerFailed;
      expect(bedrock.signals[0]?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
