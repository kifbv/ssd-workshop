// `npm run backfill-list-type` (ticket 3.10): gives the items created before the dashboard index existed their
// `listType`, the index's key (platform/api/settings.ts BY_TYPE_INDEX_KEY). The index is sparse: only profiles,
// conversations, usage totals and builds carry `listType`, written by their own writers from 3.10 on; an item created
// earlier is missing from the dashboard until this runs once (or until its writer touches it again: a profile at the next
// sign-in, a usage total at the next AI call). Run by Franck after the deploy, with his own credentials
// (`AWS_PROFILE=franck`): a Scan reads keys of every partition, the allow-list's included, which no workshop role and no
// Claude session may do. Nothing it reads is printed: only counts.
import {
  ScanCommand,
  UpdateItemCommand,
  type AttributeValue,
  type ScanCommandOutput,
  type UpdateItemCommandOutput,
} from "@aws-sdk/client-dynamodb";
import { BY_TYPE_INDEX_KEY } from "../../api/settings.js";

/** The kinds of item the index lists, each with the key shape its writer uses. */
export const LISTED_KINDS: Readonly<Record<string, (pk: string, sk: string) => boolean>> = {
  participant: (pk, sk) => pk.startsWith("PARTICIPANT#") && sk === "PROFILE",
  conversation: (pk, sk) => pk.startsWith("PARTICIPANT#") && sk === "CONVERSATION",
  usage: (pk, sk) => pk.startsWith("PARTICIPANT#") && sk === "USAGE",
  build: (pk, sk) => pk.startsWith("BUILD#") && sk === "BUILD",
};

export interface BackfillSender {
  send(command: ScanCommand): Promise<ScanCommandOutput>;
  send(command: UpdateItemCommand): Promise<UpdateItemCommandOutput>;
}

export interface BackfillCounts {
  /** Items that got their `listType` now. */
  updated: number;
  /** Items that changed meanwhile (their writer set it first, or the item went): left as they are. */
  skipped: number;
}

const str = (value: string): AttributeValue => ({ S: value });

/** Scans for the four kinds without `listType` (keys and `type` only) and sets it, each under a condition. */
export async function backfillListType(client: BackfillSender, table: string): Promise<BackfillCounts> {
  const counts: BackfillCounts = { updated: 0, skipped: 0 };
  const kinds = Object.keys(LISTED_KINDS);
  let start: Record<string, AttributeValue> | undefined;
  do {
    const page = await client.send(
      new ScanCommand({
        TableName: table,
        FilterExpression: `#type IN (${kinds.map((_, i) => `:k${String(i)}`).join(", ")}) AND attribute_not_exists(#listType)`,
        ProjectionExpression: "pk, sk, #type",
        ExpressionAttributeNames: { "#type": "type", "#listType": BY_TYPE_INDEX_KEY },
        ExpressionAttributeValues: Object.fromEntries(kinds.map((kind, i) => [`:k${String(i)}`, str(kind)])),
        ConsistentRead: true,
        ...(start === undefined ? {} : { ExclusiveStartKey: start }),
      }),
    );
    for (const item of page.Items ?? []) {
      const pk = item["pk"]?.S;
      const sk = item["sk"]?.S;
      const type = item["type"]?.S;
      // Only the shape each kind's writer uses: an allow-list entry, a code or a session never gets one.
      if (pk === undefined || sk === undefined || type === undefined || LISTED_KINDS[type]?.(pk, sk) !== true) continue;
      try {
        await client.send(
          new UpdateItemCommand({
            TableName: table,
            Key: { pk: str(pk), sk: str(sk) },
            UpdateExpression: "SET #listType = :type",
            ConditionExpression: "#type = :type AND attribute_not_exists(#listType)",
            ExpressionAttributeNames: { "#type": "type", "#listType": BY_TYPE_INDEX_KEY },
            ExpressionAttributeValues: { ":type": str(type) },
            ReturnValues: "NONE",
          }),
        );
        counts.updated += 1;
      } catch (error) {
        if ((error as { name?: unknown } | null)?.name !== "ConditionalCheckFailedException") throw error;
        counts.skipped += 1;
      }
    }
    start = page.LastEvaluatedKey;
  } while (start !== undefined);
  return counts;
}

/** The one line the command prints. */
export const formatBackfill = (counts: BackfillCounts): string =>
  `Dashboard index: ${String(counts.updated)} item(s) given their listType, ${String(counts.skipped)} changed meanwhile and left as they are.`;
