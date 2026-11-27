// Ticket 3.26: the builder's edit link in `GET /api/build`, and "New edit link" (`POST /api/build/edit-link`), written
// before the code. Criteria 3, 4 and 6 (the build routes' part).
import { describe, expect, it } from "vitest";
import { handleAppDataRequest } from "../app-data/data.js";
import { FakeAppDataStore } from "../app-data/fakes.js";
import { APP_TOKEN_PATTERN, hashAppToken } from "../app-token/token.js";
import type { HttpRequest, HttpResponse } from "../http.js";
import { SESSION_COOKIE } from "../session/session.js";
import { APP_EDIT_LINK_TEXTS } from "../workshop/texts.js";
import { BUILD_ROUTE, EDIT_LINK_ROUTE, handleConversationRequest, type ConversationDeps, type ConversationLogEntry } from "./conversation.js";
import { FakeConversationTable, FakeQueue } from "./fakes.js";

const NOW = new Date("2026-11-27T10:00:00.000Z");
const NOW_S = NOW.getTime() / 1000;
const session = (n: number): string => Buffer.alloc(32, n).toString("base64url");
const ADA = session(1);
const BOB = session(2);
const NEWBIE = session(3);
const ADA_ID = "p-ada-1";
const BOB_ID = "p-bob-2";

function setup(adaStatus: "live" | "building" | "queued" = "live") {
  const table = new FakeConversationTable();
  table.addParticipant(ADA_ID, "Ada", ADA, NOW_S + 3600, "building");
  table.addParticipant(BOB_ID, "Bob", BOB, NOW_S + 3600, "building");
  table.addParticipant("p-new-3", undefined, NEWBIE, NOW_S + 3600, "nickname");
  for (const [id, nickname, status] of [
    [ADA_ID, "Ada", adaStatus],
    [BOB_ID, "Bob", "building"],
  ] as const) {
    const buildId = `build-${nickname.toLowerCase()}`;
    table.conversations.set(id, { state: "open", latestSpecVersion: 1, approvedSpecVersion: 1, buildId });
    table.builds.set(buildId, { buildId, nickname, participantId: id, status, createdAt: "x", updatedAt: "x" });
  }
  const logs: ConversationLogEntry[] = [];
  let counter = 100;
  const deps: ConversationDeps = {
    sessions: table,
    store: table,
    editLinks: table.appTokens,
    queue: new FakeQueue(),
    now: () => NOW,
    randomBytes: (n) => Buffer.alloc(n, ++counter),
    log: (e) => logs.push(e),
  };
  const call = (request: HttpRequest): Promise<HttpResponse> => handleConversationRequest(request, deps);
  return { table, logs, call };
}

const getBuild = (token: string | null): HttpRequest => ({ routeKey: BUILD_ROUTE, ...(token === null ? {} : { cookies: [`${SESSION_COOKIE}=${token}`] }) });
const renew = (token: string | null, contentType = "application/json", body = "{}"): HttpRequest => ({
  routeKey: EDIT_LINK_ROUTE,
  headers: { "content-type": contentType },
  body,
  ...(token === null ? {} : { cookies: [`${SESSION_COOKIE}=${token}`] }),
});
const json = (response: HttpResponse): Record<string, unknown> => JSON.parse(response.body ?? "{}") as Record<string, unknown>;
const secretOf = (editUrl: unknown): string => String(editUrl).split("#edit=")[1] ?? "";

/** A write through the data API with this secret, against the same edit links. */
async function putWith(table: FakeConversationTable, secret: string): Promise<number> {
  const apps = new FakeAppDataStore();
  apps.live.add("ada");
  const answer = await handleAppDataRequest(
    {
      routeKey: "PUT /api/apps/{nickname}/data/{key}",
      pathParameters: { nickname: "ada", key: "board" },
      headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
      body: '"hi"',
    },
    { store: apps, tokens: table.appTokens, now: () => NOW, log: () => undefined, pause: async () => {} },
  );
  return answer.statusCode;
}

describe("criterion 3: GET /api/build gives the builder their app's edit link", () => {
  it("WHEN the signed-in builder asks GET /api/build for a live app THEN editUrl = <appUrl>#edit=<secret>, the same on every ask, and it saves as the builder", async () => {
    const { call, table } = setup();
    const first = json(await call(getBuild(ADA)));
    expect(first["appUrl"]).toBe("https://workshop.rankly.games/apps/ada/");
    expect(first["editUrl"]).toMatch(/^https:\/\/workshop\.rankly\.games\/apps\/ada\/#edit=[A-Za-z0-9_-]{43}$/);
    expect(first["editUrl"]).toBe(`${String(first["appUrl"])}#edit=${secretOf(first["editUrl"])}`);
    expect(secretOf(first["editUrl"])).toMatch(APP_TOKEN_PATTERN);
    expect(json(await call(getBuild(ADA)))["editUrl"]).toBe(first["editUrl"]);
    expect(table.appTokens.links.size).toBe(1);
    expect(await putWith(table, secretOf(first["editUrl"]))).toBe(204);
    expect(await table.appTokens.getAppToken(hashAppToken(secretOf(first["editUrl"])))).toEqual({ app: "ada", nickname: "Ada", kind: "edit" });
  });

  it("WHEN another participant asks GET /api/build THEN their answer never holds Ada's edit link (their own build only, no link before it is live)", async () => {
    const { call } = setup();
    const ada = json(await call(getBuild(ADA)));
    const secret = secretOf(ada["editUrl"]);
    for (const token of [BOB, NEWBIE]) {
      const answer = await call(getBuild(token));
      expect(answer.body ?? "").not.toContain(secret);
      expect(json(answer)["editUrl"]).toBeUndefined();
    }
    // Signed out: 401, nothing else.
    const out = await call(getBuild(null));
    expect(out.statusCode).toBe(401);
    expect(out.body ?? "").not.toContain(secret);
  });

  it("WHEN the build is not live yet THEN no edit link is made; WHEN a change build runs after the app went live THEN the existing link is still given", async () => {
    const building = setup("building");
    expect(json(await building.call(getBuild(ADA)))["editUrl"]).toBeUndefined();
    expect(building.table.appTokens.links.size).toBe(0);
    const { call, table } = setup();
    const live = json(await call(getBuild(ADA)))["editUrl"];
    const build = table.builds.get("build-ada");
    if (build) build.status = "building";
    expect(json(await call(getBuild(ADA)))["editUrl"]).toBe(live);
  });

  it("WHEN the builder's profile is marked removed from the allow-list THEN no edit link is made", async () => {
    const { call, table } = setup();
    const profile = table.profiles.get(ADA_ID);
    if (profile) profile.role = "removed" as never;
    // The session check reads the role from the allow-list entry, so the request passes it; the link's own check stops it.
    const answer = await call(getBuild(ADA));
    expect(json(answer)["editUrl"]).toBeUndefined();
    expect(table.appTokens.links.size).toBe(0);
  });

  it("WHEN the edit links cannot be read THEN GET /api/build still answers, without editUrl, logging the error's name only", async () => {
    const { call, table, logs } = setup();
    table.appTokens.failure = Object.assign(new Error("down"), { name: "ProvisionedThroughputExceededException" });
    const answer = await call(getBuild(ADA));
    expect(answer.statusCode).toBe(200);
    expect(json(answer)["editUrl"]).toBeUndefined();
    expect(logs.at(-1)).toEqual({ event: "conversation", route: "build", outcome: "ok", error: "ProvisionedThroughputExceededException" });
  });
});

describe("criterion 4: New edit link", () => {
  it("WHEN the builder asks for a new edit link THEN a new secret is made, the old one answers 401 at once, and GET /api/build gives the new editUrl", async () => {
    const { call, table } = setup();
    const oldUrl = json(await call(getBuild(ADA)))["editUrl"];
    const old = secretOf(oldUrl);
    expect(await putWith(table, old)).toBe(204);
    const answer = await call(renew(ADA));
    expect(answer.statusCode).toBe(200);
    const newUrl = json(answer)["editUrl"];
    expect(newUrl).toMatch(/^https:\/\/workshop\.rankly\.games\/apps\/ada\/#edit=[A-Za-z0-9_-]{43}$/);
    expect(newUrl).not.toBe(oldUrl);
    expect(await putWith(table, old)).toBe(401);
    expect(await putWith(table, secretOf(newUrl))).toBe(204);
    expect(json(await call(getBuild(ADA)))["editUrl"]).toBe(newUrl);
    expect(table.appTokens.tokens.size).toBe(1);
  });

  it("WHEN the caller is signed out THEN 401; WHEN another participant presses it THEN only their own app (none yet: 404) and Ada's link is unchanged", async () => {
    const { call, table } = setup();
    const adaUrl = json(await call(getBuild(ADA)))["editUrl"];
    expect((await call(renew(null))).statusCode).toBe(401);
    for (const token of [BOB, NEWBIE]) {
      const answer = await call(renew(token));
      expect([answer.statusCode, json(answer)]).toEqual([404, { message: APP_EDIT_LINK_TEXTS.notLive, reason: "not-live" }]);
      expect(answer.body ?? "").not.toContain(secretOf(adaUrl));
    }
    // A body naming another app changes nothing: the app is the session's own.
    expect((await call(renew(BOB, "application/json", JSON.stringify({ app: "ada" })))).statusCode).toBe(404);
    expect(json(await call(getBuild(ADA)))["editUrl"]).toBe(adaUrl);
    expect(await putWith(table, secretOf(adaUrl))).toBe(204);
  });

  it("refuses a body that is not JSON (415, so a plain form on another site cannot press it) or not an object (400), changing nothing", async () => {
    const { call } = setup();
    const url = json(await call(getBuild(ADA)))["editUrl"];
    expect((await call(renew(ADA, "text/plain"))).statusCode).toBe(415);
    expect((await call(renew(ADA, "application/x-www-form-urlencoded"))).statusCode).toBe(415);
    expect((await call(renew(ADA, "application/json", "[1]"))).statusCode).toBe(400);
    expect(json(await call(getBuild(ADA)))["editUrl"]).toBe(url);
  });

  it("WHEN the app has no edit link yet (not live, or reset) THEN 404 and nothing is made", async () => {
    const { call, table } = setup("building");
    expect((await call(renew(ADA))).statusCode).toBe(404);
    expect(table.appTokens.links.size).toBe(0);
  });
});

describe("criterion 6 (build routes' part): no log line holds a secret or its hash", () => {
  it("WHEN a secret is made, read or renewed THEN the log holds route, outcome and error name only", async () => {
    const { call, logs } = setup();
    const first = secretOf(json(await call(getBuild(ADA)))["editUrl"]);
    const second = secretOf(json(await call(renew(ADA)))["editUrl"]);
    await call(getBuild(ADA));
    await call(renew(BOB));
    const text = JSON.stringify(logs);
    for (const secret of [first, hashAppToken(first), second, hashAppToken(second)]) expect(text).not.toContain(secret);
    for (const entry of logs) expect(Object.keys(entry).every((k) => ["event", "route", "outcome", "error"].includes(k))).toBe(true);
    expect(logs.map((l) => [l.route, l.outcome])).toEqual([
      ["build", "ok"],
      ["edit-link", "renewed"],
      ["build", "ok"],
      ["edit-link", "not-live"],
    ]);
  });
});
