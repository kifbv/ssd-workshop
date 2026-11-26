// Ticket 3.10: the one-off backfill of the dashboard index's key on items created before the index existed.
import type { ScanCommandInput, UpdateItemCommandInput } from "@aws-sdk/client-dynamodb";
import { describe, expect, it } from "vitest";
import { backfillListType, formatBackfill, type BackfillSender } from "./backfill.js";

const S = (value: string) => ({ S: value });

function stub(pages: Record<string, { S: string }>[][], fail: (key: string) => Error | undefined = () => undefined) {
  const scans: ScanCommandInput[] = [];
  const updates: UpdateItemCommandInput[] = [];
  const client = {
    send: async (command: { input: Record<string, unknown>; constructor: { name: string } }) => {
      if (command.constructor.name === "ScanCommand") {
        scans.push(command.input as unknown as ScanCommandInput);
        const index = scans.length - 1;
        return { Items: pages[index] ?? [], ...(index < pages.length - 1 ? { LastEvaluatedKey: { pk: S(`page-${String(index)}`) } } : {}) };
      }
      const input = command.input as unknown as UpdateItemCommandInput;
      updates.push(input);
      const error = fail(String(input.Key?.["pk"]?.S));
      if (error !== undefined) throw error;
      return {};
    },
  } as unknown as BackfillSender;
  return { client, scans, updates };
}

describe("backfillListType (ticket 3.10)", () => {
  it("WHEN items of the four kinds lack listType THEN each gets it under a condition; allow-list, codes and sessions never do", async () => {
    const { client, scans, updates } = stub([
      [
        { pk: S("PARTICIPANT#p-1"), sk: S("PROFILE"), type: S("participant") },
        { pk: S("PARTICIPANT#p-1"), sk: S("CONVERSATION"), type: S("conversation") },
        // A wrong shape for its type (no writer makes it) is left alone, as is anything under EMAIL#.
        { pk: S("EMAIL#x"), sk: S("ALLOW"), type: S("participant") },
        { pk: S("PARTICIPANT#p-1"), sk: S("MSG#m"), type: S("usage") },
      ],
      [
        { pk: S("PARTICIPANT#p-1"), sk: S("USAGE"), type: S("usage") },
        { pk: S("BUILD#b-1"), sk: S("BUILD"), type: S("build") },
      ],
    ]);
    expect(await backfillListType(client, "ssd-workshop-data")).toEqual({ updated: 4, skipped: 0 });
    expect(scans).toHaveLength(2);
    expect(scans[0]).toMatchObject({
      FilterExpression: "#type IN (:k0, :k1, :k2, :k3) AND attribute_not_exists(#listType)",
      ProjectionExpression: "pk, sk, #type",
      ExpressionAttributeValues: { ":k0": S("participant"), ":k1": S("conversation"), ":k2": S("usage"), ":k3": S("build") },
    });
    expect(scans[1]?.ExclusiveStartKey).toEqual({ pk: S("page-0") });
    expect(updates.map((u) => [u.Key?.["pk"]?.S, u.Key?.["sk"]?.S, u.ExpressionAttributeValues?.[":type"]?.S])).toEqual([
      ["PARTICIPANT#p-1", "PROFILE", "participant"],
      ["PARTICIPANT#p-1", "CONVERSATION", "conversation"],
      ["PARTICIPANT#p-1", "USAGE", "usage"],
      ["BUILD#b-1", "BUILD", "build"],
    ]);
    for (const u of updates) {
      expect(u).toMatchObject({
        UpdateExpression: "SET #listType = :type",
        ConditionExpression: "#type = :type AND attribute_not_exists(#listType)",
        ExpressionAttributeNames: { "#type": "type", "#listType": "listType" },
        ReturnValues: "NONE",
      });
    }
  });

  it("WHEN an item changed meanwhile THEN it is counted as skipped; other errors stop the run", async () => {
    const conditional = Object.assign(new Error("x"), { name: "ConditionalCheckFailedException" });
    const first = stub([[{ pk: S("BUILD#b-1"), sk: S("BUILD"), type: S("build") }]], () => conditional);
    expect(await backfillListType(first.client, "t")).toEqual({ updated: 0, skipped: 1 });
    const denied = Object.assign(new Error("x"), { name: "AccessDeniedException" });
    const second = stub([[{ pk: S("BUILD#b-1"), sk: S("BUILD"), type: S("build") }]], () => denied);
    await expect(backfillListType(second.client, "t")).rejects.toThrow("x");
  });

  it("prints counts only", () => {
    expect(formatBackfill({ updated: 3, skipped: 1 })).toBe("Dashboard index: 3 item(s) given their listType, 1 changed meanwhile and left as they are.");
  });
});
