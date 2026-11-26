// Ticket 3.10: every request DynamoFacilitatorStore sends names only what the facilitator role's IAM statements allow
// (infra/lib/config.ts), reads by type through the index (a Query, never a Scan), and projects what it reads.
import type { QueryCommandInput, TransactWriteItemsCommandInput, UpdateItemCommandInput } from "@aws-sdk/client-dynamodb";
import { describe, expect, it } from "vitest";
import {
  BY_TYPE_INDEX_ATTRIBUTES,
  BY_TYPE_INDEX_NAME as CONFIG_INDEX_NAME,
  FACILITATOR_INDEX_READ_ATTRIBUTES,
  FACILITATOR_INDEX_TYPES,
  FACILITATOR_PARTICIPANT_UPDATE_ATTRIBUTES,
  RETRY_REQUEST_ATTRIBUTES,
  BUILD_RETRIES_PARTITION,
} from "../../../infra/lib/config.js";
import { declineReply } from "../conversation/guardrail.js";
import { BUILD_RETRIES_PK } from "../keys.js";
import { BY_TYPE_INDEX_NAME } from "../settings.js";
import { DynamoFacilitatorStore, ROSTER_PROJECTIONS, type FacilitatorSender } from "./store.js";

const TABLE = "ssd-workshop-data";
const BUILD = "b".repeat(32);

function stub(answer: (input: Record<string, unknown>) => unknown = () => ({})) {
  const sent: { name: string; input: Record<string, unknown> }[] = [];
  const client = {
    send: async (command: { input: Record<string, unknown>; constructor: { name: string } }) => {
      sent.push({ name: command.constructor.name, input: command.input });
      const out = answer(command.input);
      if (out instanceof Error) throw out;
      return out;
    },
  } as unknown as FacilitatorSender;
  return { client, sent };
}

type Named = {
  UpdateExpression?: string;
  ConditionExpression?: string;
  ProjectionExpression?: string;
  KeyConditionExpression?: string;
  ExpressionAttributeNames?: Record<string, string>;
  ExpressionAttributeValues?: Record<string, unknown>;
  Key?: Record<string, unknown>;
  Item?: Record<string, unknown>;
};

function attributeNames(input: Named): string[] {
  const text = [input.UpdateExpression, input.ConditionExpression, input.ProjectionExpression, input.KeyConditionExpression].join(" ");
  const placeholders = (text.match(/#[A-Za-z]+/g) ?? []).map((p) => input.ExpressionAttributeNames?.[p] ?? p);
  const keywords = new Set(["SET", "REMOVE", "ADD", "DELETE", "AND", "OR", "NOT", "IN", "attribute_exists", "attribute_not_exists", "undefined"]);
  const bare = (text.replace(/[#:][A-Za-z_]+/g, " ").match(/[A-Za-z_]+/g) ?? []).filter((w) => !keywords.has(w));
  return [...new Set([...placeholders, ...bare, ...Object.keys(input.Key ?? {}), ...Object.keys(input.Item ?? {})])].sort();
}

function placeholdersMatch(input: Named): void {
  const text = [input.UpdateExpression, input.ConditionExpression, input.ProjectionExpression, input.KeyConditionExpression].join(" ");
  expect(new Set(Object.keys(input.ExpressionAttributeNames ?? {}))).toEqual(new Set(text.match(/#[A-Za-z]+/g) ?? []));
  expect(new Set(Object.keys(input.ExpressionAttributeValues ?? {}))).toEqual(new Set(text.match(/:[A-Za-z_]+/g) ?? []));
}

const conditionFailed = () => Object.assign(new Error("x"), { name: "ConditionalCheckFailedException" });

describe("DynamoFacilitatorStore (ticket 3.10)", () => {
  it("names the same index as the infrastructure, and projects only attributes the index holds", () => {
    expect(BY_TYPE_INDEX_NAME).toBe(CONFIG_INDEX_NAME);
    expect(Object.keys(ROSTER_PROJECTIONS).sort()).toEqual([...FACILITATOR_INDEX_TYPES].sort());
    for (const names of Object.values(ROSTER_PROJECTIONS)) {
      for (const name of names) expect(FACILITATOR_INDEX_READ_ATTRIBUTES as readonly string[], name).toContain(name);
    }
    for (const name of ["email", "text", "allowRef"]) expect(BY_TYPE_INDEX_ATTRIBUTES as readonly string[]).not.toContain(name);
  });

  it("reads the roster with one paged, projected Query per type on the index (never a Scan), plus the Retry requests", async () => {
    let pages = 0;
    const { client, sent } = stub((input) => {
      const values = input["ExpressionAttributeValues"] as Record<string, { S: string }>;
      if (values[":pk"]?.S === BUILD_RETRIES_PK) return { Items: [{ buildId: { S: BUILD } }, {}] };
      switch (values[":type"]?.S) {
        case "participant":
          pages += 1;
          return pages === 1
            ? { Items: [{ id: { S: "p-1" }, nickname: { S: "Ada" }, role: { S: "participant" }, group: { S: "blue" }, step: { S: "clarify" }, paused: { BOOL: true }, extraBudget: { N: "4" } }], LastEvaluatedKey: { pk: { S: "x" } } }
            : { Items: [{ id: { S: "p-2" }, role: { S: "participant" } }, {}] };
        case "conversation":
          return { Items: [{ pk: { S: "PARTICIPANT#p-1" }, buildId: { S: BUILD }, state: { S: "waiting" }, pendingId: { S: "m-1" } }, { pk: { S: "EMAIL#x" } }] };
        case "usage":
          return { Items: [{ participantId: { S: "p-1" }, costUsd: { N: "0.5" } }, { participantId: { S: "p-2" }, costUsd: { N: "oops" } }] };
        case "build":
          return { Items: [{ buildId: { S: BUILD }, participantId: { S: "p-1" }, status: { S: "building" }, launchedAt: { S: "t" }, kind: { S: "change" }, changeNumber: { N: "2" } }, { buildId: { S: "c" }, participantId: { S: "p-1" }, status: { S: "weird" } }] };
        default:
          return {};
      }
    });
    const roster = await new DynamoFacilitatorStore(client, TABLE).roster();
    expect(roster.profiles).toEqual([
      { participantId: "p-1", nickname: "Ada", role: "participant", group: "blue", step: "clarify", paused: true, extraBudget: 4, changeRequestsUsed: 0 },
      { participantId: "p-2", role: "participant", paused: false, extraBudget: 0, changeRequestsUsed: 0 },
    ]);
    expect([...roster.conversations]).toEqual([["p-1", { buildId: BUILD, state: "waiting", pendingId: "m-1" }]]);
    expect([...roster.spend]).toEqual([["p-1", 0.5], ["p-2", 0]]);
    expect([...roster.builds]).toEqual([[BUILD, { participantId: "p-1", status: "building", launchedAt: "t", kind: "change", changeNumber: 2 }]]);
    expect([...roster.retries]).toEqual([BUILD]);
    expect(sent.every((c) => c.name === "QueryCommand")).toBe(true);
    for (const { input } of sent) {
      const query = input as unknown as QueryCommandInput & Named;
      placeholdersMatch(query);
      expect(query.Select).toBe("SPECIFIC_ATTRIBUTES");
      if (query.IndexName === undefined) {
        expect(query.ExpressionAttributeValues).toEqual({ ":pk": { S: BUILD_RETRIES_PARTITION } });
        for (const name of attributeNames(query)) expect(RETRY_REQUEST_ATTRIBUTES as readonly string[], name).toContain(name);
      } else {
        expect(query.IndexName).toBe(BY_TYPE_INDEX_NAME);
        expect(query.KeyConditionExpression).toBe("#type = :type");
        expect(FACILITATOR_INDEX_TYPES as readonly string[]).toContain((query.ExpressionAttributeValues?.[":type"] as { S: string }).S);
        for (const name of attributeNames(query)) expect(FACILITATOR_INDEX_READ_ATTRIBUTES as readonly string[], name).toContain(name);
      }
    }
    // Four types (the profiles over two pages) and the Retry requests.
    expect(sent).toHaveLength(6);
  });

  it("writes Pause, Add budget, Retry and both flag decisions with only the role's attribute names and limited return values", async () => {
    const message = { status: { S: "flagged" }, text: { S: "hi" }, author: { S: "participant" }, step: { S: "clarify" }, suggestion: { S: "" } };
    const { client, sent } = stub((input) => {
      const key = input["Key"] as Record<string, { S: string }> | undefined;
      if (key?.["sk"]?.S === "CONVERSATION") return { Item: { state: { S: "waiting" }, pendingId: { S: "m-1" } } };
      if (key?.["sk"]?.S === "MSG#m-1") return { Item: message };
      if ((input["UpdateExpression"] as string | undefined)?.startsWith("ADD")) return { Attributes: { extraBudget: { N: "6" } } };
      return {};
    });
    const store = new DynamoFacilitatorStore(client, TABLE);
    expect(await store.setPaused("p-1", true)).toBe(true);
    expect(await store.addBudget("p-1", 2)).toBe(6);
    await store.requestRetry(BUILD, "p-1", "2026-11-26T10:00:00.000Z");
    expect(await store.approve("p-1", "m-1", "hi", 1, "2026-11-26T10:00:00.000Z")).toBe(true);
    expect(await store.finish("p-1", "m-1", { kind: "declined", reply: declineReply("") }, "flagged", "2026-11-26T10:00:00.000Z")).toBe(true);
    const writes: Named[] = [];
    for (const { name, input } of sent) {
      if (name === "TransactWriteItemsCommand") {
        for (const item of (input as unknown as TransactWriteItemsCommandInput).TransactItems ?? []) {
          const write = (item.Update ?? item.Put ?? item.Delete ?? item.ConditionCheck) as Named & { ReturnValues?: string };
          writes.push(write);
        }
      } else if (name === "UpdateItemCommand" || name === "PutItemCommand") writes.push(input as Named);
    }
    expect(writes.length).toBeGreaterThanOrEqual(7);
    for (const write of writes) {
      placeholdersMatch(write);
      const pk = (write.Key ?? write.Item)?.["pk"] as { S: string };
      const allowed: readonly string[] = pk.S === BUILD_RETRIES_PK ? RETRY_REQUEST_ATTRIBUTES : FACILITATOR_PARTICIPANT_UPDATE_ATTRIBUTES;
      if (pk.S !== BUILD_RETRIES_PK) expect(pk.S).toMatch(/^PARTICIPANT#/);
      for (const name of attributeNames(write)) expect(allowed, `${pk.S} ${name}`).toContain(name);
      expect(["NONE", "UPDATED_NEW", undefined]).toContain((write as { ReturnValues?: string }).ReturnValues);
    }
    // Only the retry request is a PutItem; the amount added is the caller's (the route passes the server's $2).
    expect(sent.filter((c) => c.name === "PutItemCommand").map((c) => (c.input["Item"] as Record<string, { S: string }>)["pk"]?.S)).toEqual([BUILD_RETRIES_PK]);
    const add = sent.find((c) => (c.input["UpdateExpression"] as string | undefined)?.startsWith("ADD"))?.input as unknown as UpdateItemCommandInput;
    expect(add.ExpressionAttributeValues).toEqual({ ":step": { N: "2" } });
  });

  it("answers false or undefined when the profile is missing, and ignores a missing conversation on Retry", async () => {
    const { client } = stub(() => conditionFailed());
    const store = new DynamoFacilitatorStore(client, TABLE);
    expect(await store.setPaused("p-1", false)).toBe(false);
    expect(await store.addBudget("p-1", 2)).toBeUndefined();
    let calls = 0;
    const second = stub(() => (++calls === 2 ? conditionFailed() : {}));
    await expect(new DynamoFacilitatorStore(second.client, TABLE).requestRetry(BUILD, "p-1", "t")).resolves.toBeUndefined();
  });

  it("reads a nickname's participant id and a build for Retry with projections only, refusing a malformed build id", async () => {
    const { client, sent } = stub((input) =>
      (input["Key"] as Record<string, { S: string }>)["pk"]?.S.startsWith("NICK#")
        ? { Item: { participantId: { S: "p-1" } } }
        : { Item: { participantId: { S: "p-1" }, status: { S: "failed" } } },
    );
    const store = new DynamoFacilitatorStore(client, TABLE);
    expect(await store.findParticipantId("Ada")).toBe("p-1");
    expect(await store.getRetryBuild(BUILD)).toEqual({ participantId: "p-1", status: "failed" });
    expect(await store.getRetryBuild("../x")).toBeUndefined();
    expect(sent).toHaveLength(2);
    for (const { input } of sent) {
      placeholdersMatch(input as Named);
      expect(input["ProjectionExpression"]).toBeDefined();
    }
  });
});
