// Ticket 3.18: the media store's DynamoDB requests and S3 calls, against stub clients: every placeholder defined and used,
// every attribute name inside the IAM list (APP_MEDIA_WRITE_ATTRIBUTES, APP_MEDIA_READ_ATTRIBUTES, the live marker's),
// the limits written into the conditions, and the answers to DynamoDB's cancellations.
import { GetItemCommand, TransactWriteItemsCommand, type TransactWriteItem } from "@aws-sdk/client-dynamodb";
import { DeleteObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { describe, expect, it } from "vitest";
import { APP_LIVE_READ_ATTRIBUTES, APP_MEDIA_READ_ATTRIBUTES, APP_MEDIA_WRITE_ATTRIBUTES } from "../../../infra/lib/config.js";
import { DAILY_UPLOAD_BUDGET_BYTES, MAX_APP_MEDIA_BYTES, MAX_APP_MEDIA_FILES, MEDIA_CACHE_CONTROL, type UploadCharge } from "./media.js";
import { DynamoAppMediaStore, FINISH_ATTEMPTS, S3MediaBucket, type AppMediaSender, type MediaBucketSender } from "./store.js";

type Sent = GetItemCommand | TransactWriteItemsCommand;

function stubClient(answers: (Record<string, unknown> | Error)[]): { client: AppMediaSender; sent: Sent[] } {
  const sent: Sent[] = [];
  const client = {
    send: async (command: Sent) => {
      sent.push(command);
      const answer = answers.shift();
      if (answer === undefined) throw new Error("unexpected call");
      if (answer instanceof Error) throw answer;
      return { $metadata: {}, ...answer };
    },
  } as unknown as AppMediaSender;
  return { client, sent };
}

const TABLE = "ssd-workshop-data";
const NOW_ISO = "2026-11-27T10:00:00.000Z";
const ID = "AbCdEfGhIjKlMnOpQrStUv";
const SAME_DAY: UploadCharge = { today: "2026-11-27", cost: 300_000, sameDay: true };
const NEW_DAY: UploadCharge = { today: "2026-11-27", cost: 300_000, sameDay: false };
const FILE = { bytes: 300_000, contentType: "image/jpeg", uploadedBy: "Bob" };
const cancelled = (codes: string[]): Error =>
  Object.assign(new Error("cancelled"), { name: "TransactionCanceledException", CancellationReasons: codes.map((Code) => ({ Code })) });

/** Per transaction item: its partition, and the top-level attribute names it writes or tests (IAM's `dynamodb:Attributes`). */
function itemsOf(command: Sent | undefined): { kind: string; pk: string; names: string[]; part: Record<string, unknown> }[] {
  const items = (command?.input as { TransactItems?: TransactWriteItem[] }).TransactItems ?? [];
  return items.map((item) => {
    const [kind, part] = Object.entries(item)[0] as [string, { Key?: Record<string, { S?: string }>; Item?: Record<string, { S?: string }>; UpdateExpression?: string; ConditionExpression?: string; ExpressionAttributeNames?: Record<string, string>; ExpressionAttributeValues?: Record<string, unknown> }];
    const text = `${part.UpdateExpression ?? ""} ${part.ConditionExpression ?? ""}`;
    const used = new Set(text.match(/[#:][A-Za-z_]+/g) ?? []);
    const defined = new Set([...Object.keys(part.ExpressionAttributeNames ?? {}), ...Object.keys(part.ExpressionAttributeValues ?? {})]);
    expect([...used].sort(), text).toEqual([...defined].sort());
    const names = [...(text.match(/#[A-Za-z_]+/g) ?? []).map((p) => part.ExpressionAttributeNames?.[p] ?? `undefined ${p}`), ...Object.keys(part.Item ?? {}), ...Object.keys(part.Key ?? {})];
    const pk = (part.Key ?? part.Item)?.["pk"]?.S ?? "";
    return { kind, pk, names: [...new Set(names)], part: part as Record<string, unknown> };
  });
}

/** Every write stays in the app's media partition and names only the media function's attributes (the live marker only tested). */
function expectWithinIam(command: Sent | undefined): void {
  for (const item of itemsOf(command)) {
    if (item.kind === "ConditionCheck") {
      expect(item.pk).toBe("APP#ada-42");
      for (const name of item.names) expect(APP_LIVE_READ_ATTRIBUTES as readonly string[], name).toContain(name);
      continue;
    }
    expect(item.pk).toBe("APPMEDIA#ada-42");
    for (const name of item.names) expect(APP_MEDIA_WRITE_ATTRIBUTES as readonly string[], name).toContain(name);
    expect(item.part["ReturnValues"]).toBeUndefined();
    expect(item.part["ReturnValuesOnConditionCheckFailure"]).toBeUndefined();
  }
}

describe("DynamoAppMediaStore reads", () => {
  it("reads the live marker's liveAt, the totals and a record, consistently and projected to listed names only", async () => {
    const { client, sent } = stubClient([
      { Item: { liveAt: { S: "x" } } },
      { Item: { bytes: { N: "1000" }, files: { N: "2" }, uploadDay: { S: "2026-11-27" }, uploadedBytes: { N: "5000" } } },
      { Item: { bytes: { N: "1000" }, status: { S: "stored" }, createdAt: { S: NOW_ISO } } },
      {},
      {},
    ]);
    const store = new DynamoAppMediaStore(client, TABLE);
    expect(await store.isLive("Ada-42")).toBe(true);
    expect(await store.getUsage("ADA-42")).toEqual({ bytes: 1000, files: 2, uploadDay: "2026-11-27", uploadedBytes: 5000, created: true });
    expect(await store.getRecord("ada-42", ID)).toEqual({ bytes: 1000, status: "stored", createdAt: NOW_ISO });
    expect(await store.getUsage("ada-42")).toEqual({ bytes: 0, files: 0, uploadDay: undefined, uploadedBytes: 0, created: false });
    expect(await store.getRecord("ada-42", ID)).toBeUndefined();
    const keys = sent.map((c) => (c.input as { Key: Record<string, { S: string }> }).Key);
    expect(keys.map((k) => `${k.pk?.S}/${k.sk?.S}`)).toEqual(["APP#ada-42/LIVE", "APPMEDIA#ada-42/MEDIA_USAGE", `APPMEDIA#ada-42/MEDIA#${ID}`, "APPMEDIA#ada-42/MEDIA_USAGE", `APPMEDIA#ada-42/MEDIA#${ID}`]);
    for (const [index, command] of sent.entries()) {
      const input = command.input as { ConsistentRead?: boolean; ProjectionExpression?: string; ExpressionAttributeNames?: Record<string, string> };
      expect(input.ConsistentRead).toBe(true);
      const used = input.ProjectionExpression?.split(", ") ?? [];
      expect(used.sort()).toEqual(Object.keys(input.ExpressionAttributeNames ?? {}).sort());
      const allowed = index === 0 ? APP_LIVE_READ_ATTRIBUTES : APP_MEDIA_READ_ATTRIBUTES;
      for (const name of Object.values(input.ExpressionAttributeNames ?? {})) expect(allowed as readonly string[], name).toContain(name);
    }
  });
});

describe("DynamoAppMediaStore writes", () => {
  it("reserve, first upload: creates the record (only if absent) and the totals item (only if absent) in one transaction", async () => {
    const { client, sent } = stubClient([{}]);
    expect(await new DynamoAppMediaStore(client, TABLE).reserve("Ada-42", ID, FILE, NOW_ISO, false, NEW_DAY)).toBe("reserved");
    const [record, usage] = itemsOf(sent[0]);
    expect(record?.kind).toBe("Put");
    expect(record?.part["ConditionExpression"]).toBe("attribute_not_exists(#pk)");
    expect(record?.part["Item"]).toMatchObject({ status: { S: "uploading" }, bytes: { N: "300000" }, contentType: { S: "image/jpeg" }, uploadedBy: { S: "Bob" }, createdAt: { S: NOW_ISO } });
    expect(usage?.kind).toBe("Update");
    expect(usage?.part["ConditionExpression"]).toBe("attribute_not_exists(#files)");
    expectWithinIam(sent[0]);
  });

  it("reserve, later uploads: the totals move only while within 500 MB, 2,000 files and the day's budget", async () => {
    for (const charge of [SAME_DAY, NEW_DAY]) {
      const { client, sent } = stubClient([{}]);
      expect(await new DynamoAppMediaStore(client, TABLE).reserve("Ada-42", ID, FILE, NOW_ISO, true, charge)).toBe("reserved");
      const usage = itemsOf(sent[0])[1];
      const values = usage?.part["ExpressionAttributeValues"] as Record<string, { N?: string; S?: string }>;
      expect(usage?.part["ConditionExpression"]).toContain("#bytes <= :bytesLimit AND #files <= :filesLimit");
      expect(values[":bytesLimit"]?.N).toBe(String(MAX_APP_MEDIA_BYTES - FILE.bytes));
      expect(values[":filesLimit"]?.N).toBe(String(MAX_APP_MEDIA_FILES - 1));
      if (charge.sameDay) {
        expect(usage?.part["ConditionExpression"]).toContain("#uploadDay = :today AND #uploadedBytes <= :budgetLimit");
        expect(values[":budgetLimit"]?.N).toBe(String(DAILY_UPLOAD_BUDGET_BYTES - charge.cost));
      } else expect(usage?.part["ConditionExpression"]).toContain("(attribute_not_exists(#uploadDay) OR #uploadDay < :today)");
      expectWithinIam(sent[0]);
    }
  });

  it("reserve answers taken when the record exists, conflict on a lost race, and throws anything else", async () => {
    for (const [error, result] of [
      [cancelled(["ConditionalCheckFailed", "None"]), "taken"],
      [cancelled(["ConditionalCheckFailed", "ConditionalCheckFailed"]), "taken"],
      [cancelled(["None", "ConditionalCheckFailed"]), "conflict"],
      [cancelled(["None", "TransactionConflict"]), "conflict"],
    ] as const) {
      const { client } = stubClient([error]);
      expect(await new DynamoAppMediaStore(client, TABLE).reserve("Ada-42", ID, FILE, NOW_ISO, true, SAME_DAY)).toBe(result);
    }
    const { client } = stubClient([Object.assign(new Error("x"), { name: "ProvisionedThroughputExceededException" })]);
    await expect(new DynamoAppMediaStore(client, TABLE).reserve("Ada-42", ID, FILE, NOW_ISO, true, SAME_DAY)).rejects.toThrow();
  });

  it("finish marks the record stored only while uploading and the app is live (ConditionCheck on the live marker), retrying a TransactionConflict", async () => {
    const ok = stubClient([{}]);
    expect(await new DynamoAppMediaStore(ok.client, TABLE).finish("Ada-42", ID)).toBe(true);
    const [update, check] = itemsOf(ok.sent[0]);
    expect(update?.part).toMatchObject({ UpdateExpression: "SET #status = :stored", ConditionExpression: "#status = :uploading" });
    expect(check?.kind).toBe("ConditionCheck");
    expect(check?.part["ConditionExpression"]).toBe("attribute_exists(#liveAt)");
    expectWithinIam(ok.sent[0]);

    const gone = stubClient([cancelled(["None", "ConditionalCheckFailed"])]);
    expect(await new DynamoAppMediaStore(gone.client, TABLE).finish("Ada-42", ID)).toBe(false);

    let pauses = 0;
    const busy = stubClient([cancelled(["None", "TransactionConflict"]), {}]);
    expect(await new DynamoAppMediaStore(busy.client, TABLE, async () => void (pauses += 1)).finish("Ada-42", ID)).toBe(true);
    expect(pauses).toBe(1);
    const stuck = stubClient(Array.from({ length: FINISH_ATTEMPTS }, () => cancelled(["TransactionConflict", "None"])));
    await expect(new DynamoAppMediaStore(stuck.client, TABLE).finish("Ada-42", ID)).rejects.toThrow();
    expect(stuck.sent).toHaveLength(FINISH_ATTEMPTS);
  });

  it("release and remove delete the record only as read and give its room back (not the day's uploads)", async () => {
    const { client, sent } = stubClient([{}, {}, cancelled(["ConditionalCheckFailed", "None"]), cancelled(["ConditionalCheckFailed", "None"])]);
    const store = new DynamoAppMediaStore(client, TABLE);
    await store.release("Ada-42", ID, 300_000, NOW_ISO);
    expect(await store.remove("Ada-42", ID, { bytes: 300_000, status: "stored", createdAt: NOW_ISO }, NOW_ISO)).toBe("deleted");
    await expect(store.release("Ada-42", ID, 300_000, NOW_ISO)).resolves.toBeUndefined();
    expect(await store.remove("Ada-42", ID, { bytes: 300_000, status: "stored", createdAt: NOW_ISO }, NOW_ISO)).toBe("conflict");
    for (const command of sent) {
      const [record, usage] = itemsOf(command);
      expect(record?.kind).toBe("Delete");
      expect(record?.part["ConditionExpression"]).toMatch(/^#status = :(uploading|status) AND #bytes = :size$/);
      expect(usage?.part["UpdateExpression"]).toBe("SET #bytes = #bytes - :size, #files = #files - :one, #updatedAt = :now");
      expect(usage?.part["UpdateExpression"]).not.toContain("uploaded");
      expectWithinIam(command);
    }
  });

  it("every name the store uses is in the IAM lists, and the lists hold pk and sk", () => {
    for (const list of [APP_MEDIA_WRITE_ATTRIBUTES, APP_MEDIA_READ_ATTRIBUTES, APP_LIVE_READ_ATTRIBUTES]) {
      expect(list).toContain("pk");
      expect(list).toContain("sk");
    }
  });
});

describe("S3MediaBucket", () => {
  it("criterion 7: stores a file with its fixed content type and a long cache header, and deletes by key", async () => {
    const sent: (PutObjectCommand | DeleteObjectCommand)[] = [];
    const client = { send: async (command: PutObjectCommand | DeleteObjectCommand) => void sent.push(command) } as unknown as MediaBucketSender;
    const bucket = new S3MediaBucket(client, "ssd-workshop-app-media-x");
    await bucket.put(`app-media/ada-42/${ID}`, Buffer.from("abc"), "audio/webm");
    await bucket.delete(`app-media/ada-42/${ID}`);
    expect(sent[0]).toBeInstanceOf(PutObjectCommand);
    expect(sent[0]?.input).toMatchObject({ Bucket: "ssd-workshop-app-media-x", Key: `app-media/ada-42/${ID}`, ContentType: "audio/webm", CacheControl: MEDIA_CACHE_CONTROL, ContentLength: 3 });
    expect(MEDIA_CACHE_CONTROL).toBe("public, max-age=31536000, s-maxage=86400, immutable");
    expect(sent[1]).toBeInstanceOf(DeleteObjectCommand);
    expect(sent[1]?.input).toEqual({ Bucket: "ssd-workshop-app-media-x", Key: `app-media/ada-42/${ID}` });
  });
});
