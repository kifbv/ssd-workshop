// Ticket 2.13: `npm run participant -- reset <nickname> [--yes]` against the in-memory table the API's tests use, the
// in-memory app data store and the in-memory GitHub. Test names start with the criterion they prove (AC1 to AC5).
import { describe, expect, it } from "vitest";
import { FakeAppDataStore } from "../../api/app-data/fakes.js";
import { handleAppDataRequest } from "../../api/app-data/data.js";
import { FakeAppMediaStore, FakeMediaBucket } from "../../api/app-media/fakes.js";
import { jpegOfSize } from "../../api/app-media/fixtures.js";
import { APP_MEDIA_TIMEOUT_SECONDS, handleAppMediaRequest, mediaKey } from "../../api/app-media/media.js";
import { FakeAppTokenStore } from "../../api/app-token/fakes.js";
import { hashAppToken } from "../../api/app-token/token.js";
import { FakeConversationTable } from "../../api/conversation/fakes.js";
import { parseGitHubSecret, type GitHubDeps } from "../../api/github/app.js";
import { FAKE_TOKEN_PREFIX, FakeGitHub, TEST_SECRET_TEXT } from "../../api/github/fakes.js";
import { openRepositoryAdmin } from "../../api/github/repository.js";
import { STALE_PENDING_SECONDS } from "../../api/conversation/state.js";
import type { BuildStatus, Step } from "../../api/types.js";
import { FakeResetStore } from "../conversation/fakes.js";
import { runConversation, type ConversationDeps } from "../conversation/command.js";
import { MEDIA_SETTLE_MS, runParticipant, SETTLE_MS, USAGE, type AppMediaFiles, type ParticipantDeps } from "./command.js";
import type { ParticipantResetStore } from "./store.js";

const NOW = new Date("2026-11-25T10:00:00.000Z");
const NOW_S = NOW.getTime() / 1000;
const SECRET = "my secret app idea about the quarterly numbers";
const SPEC_TEXT = "# Secret spec text";
const ADA_EMAIL = "ada.lovelace@example.com";
const ADA_ID = "p-ada-0f3c9a7e";
const BOB_ID = "p-bob-71d2c004";
const MESSAGE_ID = "2026-11-25T09:00:00.000Z-0101010101010101";
/** Ticket 3.18: each app's photo and recording ids. */
const PHOTO_ID = "PhotoPhotoPhotoPhoto01";
const VOICE_ID = "VoiceVoiceVoiceVoice01";
const ADA_EDIT_SECRET = Buffer.alloc(32, 61).toString("base64url");
const BOB_EDIT_SECRET = Buffer.alloc(32, 62).toString("base64url");

type Method = keyof ParticipantResetStore;

/** The conversation reset store plus builds (the table's), app data (FakeAppDataStore) and the live marker. */
class FakeParticipantResetStore extends FakeResetStore implements ParticipantResetStore {
  /** The next call of this method throws (a run that stops part way), then it works again. */
  failOnce: Method | undefined;
  failure: Error = Object.assign(new Error(`table down for PARTICIPANT#${ADA_ID} (${ADA_EMAIL})`), { name: "InternalServerError" });

  constructor(
    readonly table: FakeConversationTable,
    readonly apps: FakeAppDataStore,
    readonly media: FakeAppMediaStore,
  ) {
    super(table);
    // Every method of the interface may be made to fail once.
    for (const method of [
      "findParticipantId",
      "getStep",
      "getResetState",
      "listResetItems",
      "restart",
      "deleteItems",
      "getBuildStatus",
      "listAppData",
      "deleteAppData",
      "listAppMedia",
      "deleteAppMedia",
      "hasLiveMarker",
      "deleteLiveMarker",
      "deleteEditLink",
    ] as const) {
      const original = (this[method] as (...args: unknown[]) => Promise<unknown>).bind(this);
      (this as Record<string, unknown>)[method] = async (...args: unknown[]) => {
        if (this.failOnce === method) {
          this.failOnce = undefined;
          throw this.failure;
        }
        return original(...args);
      };
    }
  }

  async listAppData(nickname: string) {
    const lower = nickname.toLowerCase();
    const values = [...this.apps.values.keys()].filter((id) => id.startsWith(`${lower}/`)).map((id) => `DATA#${id.slice(lower.length + 1)}`);
    return [...values, ...(this.apps.usage.has(lower) ? ["DATA_USAGE"] : [])];
  }
  async deleteAppData(nickname: string, sortKeys: readonly string[]) {
    const lower = nickname.toLowerCase();
    for (const sk of sortKeys) {
      if (sk === "DATA_USAGE") this.apps.usage.delete(lower);
      else this.apps.values.delete(`${lower}/${sk.slice("DATA#".length)}`);
    }
  }
  /** Ticket 3.18: the media records (`MEDIA#<id>`) and totals (`MEDIA_USAGE`) of FakeAppMediaStore. */
  async listAppMedia(nickname: string) {
    const lower = nickname.toLowerCase();
    const records = [...this.media.records.keys()].filter((id) => id.startsWith(`${lower}/`)).map((id) => `MEDIA#${id.slice(lower.length + 1)}`);
    return [...records, ...(this.media.usage.has(lower) ? ["MEDIA_USAGE"] : [])];
  }
  async deleteAppMedia(nickname: string, sortKeys: readonly string[]) {
    const lower = nickname.toLowerCase();
    for (const sk of sortKeys) {
      if (sk === "MEDIA_USAGE") this.media.usage.delete(lower);
      else this.media.records.delete(`${lower}/${sk.slice("MEDIA#".length)}`);
    }
  }
  async hasLiveMarker(nickname: string) {
    return this.apps.live.has(nickname.toLowerCase());
  }
  async deleteLiveMarker(nickname: string) {
    // One marker item in the table: the media API's fake keeps its own copy of it.
    this.media.live.delete(nickname.toLowerCase());
    return this.apps.live.delete(nickname.toLowerCase());
  }
  /** Ticket 3.26: the apps' edit links. */
  readonly tokens = new FakeAppTokenStore();
  async deleteEditLink(nickname: string) {
    return this.tokens.deleteEditLink(nickname);
  }
}

/** Ada and Bob, each with a message, a reply, two specs, usage, a build, app data, a live marker and a repository. */
function setup(options: { step?: Step; buildStatus?: BuildStatus } = {}) {
  const step = options.step ?? "building";
  const table = new FakeConversationTable();
  table.addParticipant(ADA_ID, "Ada", "hash-ada", NOW_S + 3600, step);
  table.addParticipant(BOB_ID, "Bob", "hash-bob", NOW_S + 3600, "building");
  table.allow.set(ADA_EMAIL, { email: ADA_EMAIL, group: "blue", role: "participant", participantId: ADA_ID } as never);
  const apps = new FakeAppDataStore();
  // Ticket 3.18: the media API's records and bucket; the reset deletes its live marker with the data API's (one item).
  const media = new FakeAppMediaStore();
  const bucket = new FakeMediaBucket();
  const github = new FakeGitHub(() => NOW);
  for (const [id, nickname] of [
    [ADA_ID, "Ada"],
    [BOB_ID, "Bob"],
  ] as const) {
    table.messages.set(id, new Map([[MESSAGE_ID, { id: MESSAGE_ID, step: "clarify", text: SECRET, status: "done", pendingSince: NOW_S - 3600, createdAt: "x" }]]));
    table.replies.set(id, new Map([[MESSAGE_ID, { text: "Who is it for?", kind: "answer", createdAt: "x" }]]));
    table.specs.set(id, [
      { version: 1, text: SPEC_TEXT, messageId: MESSAGE_ID, createdAt: "x" },
      { version: 2, text: SPEC_TEXT, messageId: MESSAGE_ID, createdAt: "x", approvedAt: "x" },
    ]);
    const buildId = `build-${nickname.toLowerCase()}`;
    table.conversations.set(id, { state: "open", latestSpecVersion: 2, approvedSpecVersion: 2, buildId });
    table.builds.set(buildId, {
      buildId,
      nickname,
      participantId: id,
      status: nickname === "Ada" ? (options.buildStatus ?? "live") : "live",
      createdAt: "x",
      updatedAt: "x",
    });
    table.usage.set(id, { inputTokens: 100, outputTokens: 10, costUsd: 0.01 });
    const lower = nickname.toLowerCase();
    apps.live.add(lower);
    media.live.add(lower);
    apps.values.set(`${lower}/scores`, { json: "[1,2]", bytes: 5 });
    apps.values.set(`${lower}/name`, { json: `"${SECRET}"`, bytes: 10 });
    apps.usage.set(lower, { bytes: 15, keys: 2 });
    for (const [id, contentType] of [
      [PHOTO_ID, "image/jpeg"],
      [VOICE_ID, "audio/webm"],
    ] as const) {
      bucket.objects.set(mediaKey(lower, id), { body: Buffer.from(`${lower} ${id}`), contentType });
      media.records.set(`${lower}/${id}`, { bytes: 1000, status: "stored", createdAt: "2026-11-25T09:59:00.000Z", contentType, uploadedBy: nickname });
    }
    media.usage.set(lower, { bytes: 2000, files: 2, uploadDay: "2026-11-25", uploadedBytes: 2000 });
    github.addRepository(`ssd-${lower}`);
  }
  const store = new FakeParticipantResetStore(table, apps, media);
  // Ticket 3.26: each app has its edit link.
  store.tokens.addEditLink("ada", "Ada", ADA_EDIT_SECRET);
  store.tokens.addEditLink("bob", "Bob", BOB_EDIT_SECRET);
  const out: string[] = [];
  const err: string[] = [];
  let githubOpened = 0;
  const waits: number[] = [];
  const githubDeps: GitHubDeps = { fetch: github.fetch, now: () => NOW, log: () => undefined };
  // Ticket 3.18: the media bucket's files and CloudFront's invalidations; `failMedia` makes the next such call throw once.
  const forgotten: string[] = [];
  const mediaControl: { failMedia: keyof AppMediaFiles | undefined } = { failMedia: undefined };
  const failing = (call: keyof AppMediaFiles) => {
    if (mediaControl.failMedia === call) {
      mediaControl.failMedia = undefined;
      throw store.failure;
    }
  };
  const mediaFiles: AppMediaFiles = {
    list: async (nickname) => {
      failing("list");
      return [...bucket.objects.keys()].filter((key) => key.startsWith(`app-media/${nickname.toLowerCase()}/`));
    },
    remove: async (keys) => {
      failing("remove");
      for (const key of keys) await bucket.delete(key);
    },
    forget: async (nickname) => {
      failing("forget");
      forgotten.push(`/app-media/${nickname.toLowerCase()}/*`);
    },
  };
  const deps: ParticipantDeps = {
    createStore: () => store,
    createMediaFiles: () => mediaFiles,
    openGitHub: async () => {
      githubOpened++;
      return openRepositoryAdmin(parseGitHubSecret(TEST_SECRET_TEXT), githubDeps);
    },
    now: () => NOW,
    sleep: async (ms) => void waits.push(ms),
    out: (l) => out.push(l),
    err: (l) => err.push(l),
  };
  const run = (...args: string[]) => runParticipant(args, deps);
  const printed = () => [...out, ...err].join("\n");
  return { table, apps, media, bucket, forgotten, mediaControl, github, store, deps, out, err, run, printed, waits, githubOpened: () => githubOpened };
}

type Setup = ReturnType<typeof setup>;

/** Everything the reset could touch, as plain JSON, to compare before and after. */
function snapshot(s: Setup): string {
  const plain = (value: unknown): unknown =>
    value instanceof Map ? [...value.entries()].map(([k, v]) => [k, plain(v)]) : value instanceof Set ? [...value] : value;
  const t = s.table;
  return JSON.stringify({
    allow: plain(t.allow),
    profiles: plain(t.profiles),
    nicknames: plain(t.nicknames),
    sessions: plain(t.sessions),
    messages: plain(t.messages),
    replies: plain(t.replies),
    conversations: plain(t.conversations),
    usage: plain(t.usage),
    specs: plain(t.specs),
    builds: plain(t.builds),
    live: plain(s.apps.live),
    values: plain(s.apps.values),
    appUsage: plain(s.apps.usage),
    repositories: [...s.github.repositories.keys()],
    appTokens: plain(s.store.tokens.tokens),
    editLinks: plain(s.store.tokens.links),
    mediaFiles: [...s.bucket.objects.keys()],
    mediaRecords: plain(s.media.records),
    mediaUsage: plain(s.media.usage),
  });
}

/** Ada's whole reset is done: conversation gone, Clarify, no app data, marker or repository; the rest unchanged. */
function expectAdaReset(s: Setup, kept: { allow: string; nicknames: string; sessions: string; usage: string; builds: string }) {
  expect(s.table.messages.get(ADA_ID)?.size ?? 0).toBe(0);
  expect(s.table.replies.get(ADA_ID)?.size ?? 0).toBe(0);
  expect(s.table.specs.get(ADA_ID) ?? []).toEqual([]);
  expect(s.table.conversations.has(ADA_ID)).toBe(false);
  expect(s.table.profiles.get(ADA_ID)).toMatchObject({ step: "clarify", stepSince: NOW.toISOString() });
  expect(s.table.profiles.get(ADA_ID)?.nickname).toBe("Ada");
  expect([...s.apps.values.keys()].filter((k) => k.startsWith("ada/"))).toEqual([]);
  expect(s.apps.usage.has("ada")).toBe(false);
  expect(s.apps.live.has("ada")).toBe(false);
  expect(s.github.repositories.has("ssd-ada")).toBe(false);
  // Ticket 3.18 criterion 8: Ada's photos, recordings, their records and totals are gone, and CloudFront was told.
  expect([...s.bucket.objects.keys()].filter((k) => k.startsWith("app-media/ada/"))).toEqual([]);
  expect([...s.media.records.keys()].filter((k) => k.startsWith("ada/"))).toEqual([]);
  expect(s.media.usage.has("ada")).toBe(false);
  expect(s.forgotten).toContain("/app-media/ada/*");
  // Ticket 3.26 criterion 5: Ada's app's edit link and its lookup item are gone.
  expect(s.store.tokens.links.has("ada")).toBe(false);
  expect([...s.store.tokens.tokens.values()].filter((t) => t.app === "ada")).toEqual([]);
  expect(JSON.stringify([...s.table.allow])).toBe(kept.allow);
  expect(JSON.stringify([...s.table.nicknames])).toBe(kept.nicknames);
  expect(JSON.stringify([...s.table.sessions])).toBe(kept.sessions);
  expect(JSON.stringify([...s.table.usage])).toBe(kept.usage);
  expect(JSON.stringify([...s.table.builds])).toBe(kept.builds);
}

const keptOf = (s: Setup) => ({
  allow: JSON.stringify([...s.table.allow]),
  nicknames: JSON.stringify([...s.table.nicknames]),
  sessions: JSON.stringify([...s.table.sessions]),
  usage: JSON.stringify([...s.table.usage]),
  builds: JSON.stringify([...s.table.builds]),
});

/** Bob's conversation, data, marker and repository, untouched by Ada's reset. */
function expectBobUntouched(s: Setup) {
  expect(s.table.messages.get(BOB_ID)?.size).toBe(1);
  expect(s.table.specs.get(BOB_ID)).toHaveLength(2);
  expect(s.table.conversations.get(BOB_ID)?.buildId).toBe("build-bob");
  expect(s.table.profiles.get(BOB_ID)?.step).toBe("building");
  expect(s.apps.live.has("bob")).toBe(true);
  expect(s.apps.values.has("bob/scores")).toBe(true);
  expect(s.github.repositories.has("ssd-bob")).toBe(true);
  expect([...s.bucket.objects.keys()].filter((k) => k.startsWith("app-media/bob/"))).toHaveLength(2);
  expect([...s.media.records.keys()].filter((k) => k.startsWith("bob/"))).toHaveLength(2);
  expect(s.media.usage.has("bob")).toBe(true);
  expect(s.forgotten).not.toContain("/app-media/bob/*");
  expect(s.store.tokens.links.get("bob")?.secret).toBe(BOB_EDIT_SECRET);
  expect(s.store.tokens.tokens.has(hashAppToken(BOB_EDIT_SECRET))).toBe(true);
}

/** AC5: nothing printed holds an email address, a participant id, a token or a message or spec text. */
function expectNothingPrivate(s: Setup) {
  const text = s.printed();
  for (const forbidden of [ADA_EMAIL, "@", ADA_ID, BOB_ID, FAKE_TOKEN_PREFIX, SECRET, SPEC_TEXT, "Who is it for?", "PARTICIPANT#"]) {
    expect(text).not.toContain(forbidden);
  }
  for (const bearer of s.github.bearers) expect(text).not.toContain(bearer);
}

describe("npm run participant -- reset: arguments", () => {
  it("takes reset with one nickname and an optional --yes; anything else prints the usage and makes no call", async () => {
    for (const args of [[], ["delete", "Ada"], ["reset"], ["reset", "Ada", "Bob"], ["reset", "Ada", "--yes", "--yes"], ["reset", ADA_EMAIL]]) {
      const s = setup();
      let created = 0;
      s.deps.createStore = () => {
        created++;
        return s.store;
      };
      await expect(s.run(...args)).resolves.toBe(1);
      expect(created).toBe(0);
      expect(s.githubOpened()).toBe(0);
      expect(s.err.join("\n")).toContain(USAGE);
      expect(s.out.join("\n")).not.toContain(ADA_EMAIL);
    }
  });

  it("WHEN the nickname is unknown THEN it says so, exits 1 and changes nothing", async () => {
    const s = setup();
    const before = snapshot(s);
    await expect(s.run("reset", "Zed", "--yes")).resolves.toBe(1);
    expect(s.err).toEqual(["No participant has the nickname Zed."]);
    expect(snapshot(s)).toBe(before);
  });
});

describe("AC1: reset without --yes", () => {
  it("AC1 WHEN reset runs without --yes THEN it prints what it would delete and changes nothing", async () => {
    const s = setup();
    const before = snapshot(s);
    await expect(s.run("reset", "Ada")).resolves.toBe(0);
    expect(snapshot(s)).toBe(before);
    expect(s.github.calls.filter((c) => c.method === "DELETE")).toEqual([]);
    expect(s.out).toEqual([
      "Ada is at step 3 (Build), with 2 messages and replies and 2 spec versions.",
      "App: 2 stored values and the app's data totals, 2 photos and recordings, live marker present, repository ssd-workshop-apps/ssd-ada exists.",
      "Nothing changed. Run again with --yes to delete all of this and send Ada back to step 1 (Clarify), including the app's edit link.",
      "Kept: allow-list entry, nickname, sessions, AI usage totals and build records.",
    ]);
    expect(s.err).toEqual([]);
    expectNothingPrivate(s);
  });

  it("AC1 WHEN there is nothing left THEN the dry run says so and still changes nothing", async () => {
    const s = setup({ step: "clarify" });
    await s.run("reset", "Ada", "--yes");
    s.out.length = 0;
    const before = snapshot(s);
    await expect(s.run("reset", "Ada")).resolves.toBe(0);
    expect(snapshot(s)).toBe(before);
    expect(s.out.slice(0, 2)).toEqual([
      "Ada is at step 1 (Clarify), with 0 messages and replies and 0 spec versions.",
      "App: no app data, no photos or recordings, live marker absent, repository ssd-workshop-apps/ssd-ada already gone.",
    ]);
  });
});

describe("AC2: reset --yes at any step", () => {
  for (const step of ["clarify", "spec", "approved", "building"] as const) {
    it(`AC2 WHEN reset --yes runs for a participant at ${step} THEN conversation, specs, app data, live marker and repository are gone, the step is Clarify with no approved version or build link, and allow-list, nickname, usage and builds are unchanged`, async () => {
      const s = setup({ step });
      const kept = keptOf(s);
      await expect(s.run("reset", "Ada", "--yes")).resolves.toBe(0);
      expectAdaReset(s, kept);
      // The conversation item held the approved and latest versions and the build link: it is gone, so none is left.
      expect(s.table.conversations.get(ADA_ID)?.approvedSpecVersion).toBeUndefined();
      expect(s.table.conversations.get(ADA_ID)?.buildId).toBeUndefined();
      expectBobUntouched(s);
      expect(s.err).toEqual([]);
      expect(s.out).toEqual([
        "Reset Ada: deleted 2 messages and replies and 2 spec versions; back at step 1 (Clarify).",
        "Waiting 30 s for uploads already under way, then deleting the app's photos and recordings once more.",
        "Deleted the app's edit link: saving through it answers \"This link is view only.\".",
        "Deleted 2 stored values and the app's data totals; deleted the live marker.",
        "Deleted 2 photos and recordings; CloudFront stops serving the app's media within minutes.",
        "Repository ssd-workshop-apps/ssd-ada deleted.",
        "Kept: allow-list entry, nickname, sessions, AI usage totals and build records.",
        "The app's published files stay online until the next build's deploy replaces them.",
        "Ada sees step 1 after reloading the page; the next approved spec builds into a new repository.",
      ]);
      expectNothingPrivate(s);
    });
  }

  it("AC2 WHEN the nickname is typed in another letter case THEN the same participant, data, marker and repository are reset", async () => {
    const s = setup();
    const kept = keptOf(s);
    await expect(s.run("reset", "ADA", "--yes")).resolves.toBe(0);
    expectAdaReset(s, kept);
    expectBobUntouched(s);
  });

  it("AC2 WHEN the participant has not reached step 1 THEN the app's data, marker and repository are still deleted and the profile is left alone", async () => {
    const s = setup();
    const profile = s.table.profiles.get(ADA_ID);
    if (profile) profile.step = "nickname";
    await expect(s.run("reset", "Ada", "--yes")).resolves.toBe(0);
    expect(s.table.profiles.get(ADA_ID)?.step).toBe("nickname");
    expect(s.apps.live.has("ada")).toBe(false);
    expect(s.apps.usage.has("ada")).toBe(false);
    expect(s.github.repositories.has("ssd-ada")).toBe(false);
    expect(s.out[0]).toBe("Waiting 30 s for uploads already under way, then deleting the app's photos and recordings once more.");
    expect(s.out[1]).toBe("Deleted the app's edit link: saving through it answers \"This link is view only.\".");
    expect(s.out[2]).toBe("Deleted 2 stored values and the app's data totals; deleted the live marker.");
    expectBobUntouched(s);
  });
});

describe("ticket 3.26: reset deletes the app's edit secret", () => {
  it("criterion 5: WHEN `participant reset Ada --yes` ran THEN Ada's edit secret is deleted (a PUT with it answers 401), while Bob's still saves", async () => {
    const s = setup();
    const put = (nickname: string, secret: string) =>
      handleAppDataRequest(
        {
          routeKey: "PUT /api/apps/{nickname}/data/{key}",
          pathParameters: { nickname, key: "board" },
          headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
          body: '"hello"',
        },
        { store: s.apps, tokens: s.store.tokens, now: () => NOW, log: () => undefined, pause: async () => {} },
      );
    expect((await put("ada", ADA_EDIT_SECRET)).statusCode).toBe(204);
    await expect(s.run("reset", "Ada", "--yes")).resolves.toBe(0);
    expect(s.store.tokens.links.has("ada")).toBe(false);
    expect(s.store.tokens.tokens.has(hashAppToken(ADA_EDIT_SECRET))).toBe(false);
    // The app is not live any more either (404 comes first); the secret is unknown to the write check.
    await expect(s.store.tokens.getAppToken(hashAppToken(ADA_EDIT_SECRET))).resolves.toBeUndefined();
    expect((await put("bob", BOB_EDIT_SECRET)).statusCode).toBe(204);
    expect(s.printed()).not.toContain(ADA_EDIT_SECRET);
    expect(s.printed()).not.toContain(hashAppToken(ADA_EDIT_SECRET));
  });

  it("WHEN the builder's page made a new edit link while the reset ran THEN the last pass deletes it too", async () => {
    const s = setup();
    const original = s.store.deleteLiveMarker.bind(s.store);
    s.store.deleteLiveMarker = async (nickname: string) => {
      s.store.tokens.addEditLink("ada", "Ada", Buffer.alloc(32, 77).toString("base64url"));
      return original(nickname);
    };
    await expect(s.run("reset", "Ada", "--yes")).resolves.toBe(0);
    expect(s.store.tokens.links.has("ada")).toBe(false);
    expect([...s.store.tokens.tokens.values()].filter((t) => t.app === "ada")).toEqual([]);
  });
});

describe("ticket 3.18 criterion 8: reset and the app's photos and recordings", () => {
  const tokenFor = async (s: Setup, app: string): Promise<string> => {
    const token = Buffer.alloc(32, 7).toString("base64url");
    s.media.tokens.addEditLink(app, app === "ada" ? "Ada" : "Bob", token);
    return token;
  };
  const call = (s: Setup, method: "PUT" | "DELETE", token: string, id: string, body?: Buffer) =>
    handleAppMediaRequest(
      {
        routeKey: `${method} /api/apps/{nickname}/media/{id}`,
        pathParameters: { nickname: "Ada", id },
        headers: { authorization: `Bearer ${token}` },
        ...(body === undefined ? {} : { body: body.toString("base64"), isBase64Encoded: true }),
      },
      { store: s.media, bucket: s.bucket, tokens: s.media.tokens, now: () => NOW, log: () => undefined, pause: async () => {} },
    );

  it("WHEN reset runs without --yes THEN it counts the app's photos and recordings and deletes none, and CloudFront is not asked", async () => {
    const s = setup();
    const files = [...s.bucket.objects.keys()];
    await expect(s.run("reset", "Ada")).resolves.toBe(0);
    expect(s.out[1]).toContain("2 photos and recordings");
    expect([...s.bucket.objects.keys()]).toEqual(files);
    expect(s.bucket.calls).toEqual([]);
    expect(s.media.records.size).toBe(4);
    expect(s.forgotten).toEqual([]);
  });

  it("WHEN reset --yes runs THEN a photo uploaded through the media API is deleted with its record and totals, CloudFront forgets /app-media/ada/*, and a new upload or delete gets 404 without touching the bucket", async () => {
    const s = setup();
    const token = await tokenFor(s, "ada");
    const uploaded = await call(s, "PUT", token, "UploadUploadUpload0001", jpegOfSize(50_000));
    expect(uploaded.statusCode).toBe(201);
    expect(s.bucket.objects.has(mediaKey("ada", "UploadUploadUpload0001"))).toBe(true);
    const kept = keptOf(s);
    await expect(s.run("reset", "Ada", "--yes")).resolves.toBe(0);
    expect(s.out).toContain("Deleted 3 photos and recordings; CloudFront stops serving the app's media within minutes.");
    expect(s.bucket.objects.has(mediaKey("ada", "UploadUploadUpload0001"))).toBe(false);
    expect(s.forgotten).toEqual(["/app-media/ada/*"]);
    expectAdaReset(s, kept);
    expectBobUntouched(s);
    const calls = s.bucket.calls.length;
    expect((await call(s, "PUT", token, "UploadUploadUpload0002", jpegOfSize(1000))).statusCode).toBe(404);
    expect((await call(s, "DELETE", token, PHOTO_ID)).statusCode).toBe(404);
    expect(s.bucket.calls).toHaveLength(calls);
    expectNothingPrivate(s);
  });

  it("WHEN a file lands after the first pass THEN the second pass after the pause deletes it and its record", async () => {
    const s = setup();
    const original = s.store.deleteAppMedia.bind(s.store);
    let passes = 0;
    s.store.deleteAppMedia = async (nickname, sortKeys) => {
      await original(nickname, sortKeys);
      if (++passes === 1) {
        s.bucket.objects.set(mediaKey("ada", "LateLateLateLateLate01"), { body: Buffer.from("late"), contentType: "image/jpeg" });
        s.media.records.set("ada/LateLateLateLateLate01", { bytes: 4, status: "uploading", createdAt: NOW.toISOString(), contentType: "image/jpeg", uploadedBy: "Bob" });
        s.media.usage.set("ada", { bytes: 4, files: 1, uploadedBytes: 4 });
      }
    };
    await expect(s.run("reset", "Ada", "--yes")).resolves.toBe(0);
    expect(passes).toBe(3);
    expect(s.waits).toEqual([SETTLE_MS, MEDIA_SETTLE_MS]);
    expect(s.bucket.objects.has(mediaKey("ada", "LateLateLateLateLate01"))).toBe(false);
    expect(s.media.records.has("ada/LateLateLateLateLate01")).toBe(false);
    expect(s.media.usage.has("ada")).toBe(false);
    expect(s.out).toContain("Deleted 3 photos and recordings; CloudFront stops serving the app's media within minutes.");
  });

  it("try 2: WHEN an upload cut off mid-flight stores its file after the second pass THEN the last pass, after a wait longer than the media function's timeout, deletes it", async () => {
    const s = setup();
    // The late file lands while the reset waits: after both data passes, before the last media listing.
    s.deps.sleep = async (ms) => {
      s.waits.push(ms);
      if (ms === MEDIA_SETTLE_MS) s.bucket.objects.set(mediaKey("ada", "CutCutCutCutCutCutCut1"), { body: Buffer.from("cut"), contentType: "audio/webm" });
    };
    await expect(s.run("reset", "Ada", "--yes")).resolves.toBe(0);
    expect(s.waits).toEqual([SETTLE_MS, MEDIA_SETTLE_MS]);
    expect(MEDIA_SETTLE_MS).toBeGreaterThan(APP_MEDIA_TIMEOUT_SECONDS * 1000);
    expect(s.bucket.objects.has(mediaKey("ada", "CutCutCutCutCutCutCut1"))).toBe(false);
    // CloudFront is told after the last pass.
    expect(s.forgotten).toEqual(["/app-media/ada/*"]);
    expect(s.out).toContain("Deleted 3 photos and recordings; CloudFront stops serving the app's media within minutes.");
    expect(s.out).toContain("Waiting 30 s for uploads already under way, then deleting the app's photos and recordings once more.");
  });

  it("try 2: WHEN the app has a deleted file's tombstone THEN the dry run does not count it and the reset deletes it", async () => {
    const s = setup();
    s.media.records.set("ada/GoneGoneGoneGoneGone01", { bytes: 1000, status: "deleted", createdAt: "2026-11-25T09:00:00.000Z", contentType: "image/jpeg", uploadedBy: "Bob" });
    await expect(s.run("reset", "Ada")).resolves.toBe(0);
    expect(s.out[1]).toContain("2 photos and recordings");
    await expect(s.run("reset", "Ada", "--yes")).resolves.toBe(0);
    expect(s.media.records.has("ada/GoneGoneGoneGoneGone01")).toBe(false);
  });

  it("WHEN the media bucket cannot be listed THEN the dry run and the reset fail with the error's name only, before any change", async () => {
    const s = setup();
    s.store.failure = Object.assign(new Error(`app-media/ada/${PHOTO_ID} ${ADA_EMAIL}`), { name: "AccessDenied" });
    s.mediaControl.failMedia = "list";
    const before = snapshot(s);
    await expect(s.run("reset", "Ada", "--yes")).resolves.toBe(1);
    expect(snapshot(s)).toBe(before);
    expect(s.err[0]).toBe("Participant reset failed: AccessDenied. Check your AWS credentials (AWS_PROFILE), the region and the GitHub secret.");
    expectNothingPrivate(s);
  });
});

describe("AC3: refusals", () => {
  for (const status of ["queued", "building", "deploying"] as const) {
    it(`AC3 WHEN the build is ${status} THEN nothing changes and the command says why`, async () => {
      const s = setup({ buildStatus: status });
      const before = snapshot(s);
      await expect(s.run("reset", "Ada", "--yes")).resolves.toBe(1);
      expect(snapshot(s)).toBe(before);
      expect(s.err).toEqual([`Ada's build is ${status}; try again once it is live or failed. Nothing changed.`]);
      expect(s.githubOpened()).toBe(0);
      expect(s.forgotten).toEqual([]);
      expectNothingPrivate(s);
    });
  }

  for (const status of ["live", "failed"] as const) {
    it(`AC3 WHEN the build is ${status} THEN the reset goes ahead`, async () => {
      const s = setup({ buildStatus: status });
      await expect(s.run("reset", "Ada", "--yes")).resolves.toBe(0);
      expect(s.github.repositories.has("ssd-ada")).toBe(false);
    });
  }

  it("AC3 WHEN the AI is answering THEN nothing changes and the command says why; a stale or flagged message does not block", async () => {
    const s = setup({ step: "spec" });
    s.table.conversations.set(ADA_ID, { state: "open", pendingId: MESSAGE_ID, pendingSince: NOW_S - 30 });
    const before = snapshot(s);
    await expect(s.run("reset", "Ada", "--yes")).resolves.toBe(1);
    expect(snapshot(s)).toBe(before);
    expect(s.err[0]).toContain("The AI is still answering Ada's last message");
    expect(s.err[0]).toContain("Nothing changed.");
    expect(s.githubOpened()).toBe(0);

    s.table.conversations.set(ADA_ID, { state: "open", pendingId: MESSAGE_ID, pendingSince: NOW_S - STALE_PENDING_SECONDS - 1 });
    await expect(s.run("reset", "Ada", "--yes")).resolves.toBe(0);

    const flagged = setup({ step: "spec" });
    flagged.table.conversations.set(ADA_ID, { state: "waiting", pendingId: MESSAGE_ID, pendingSince: NOW_S - 30 });
    await expect(flagged.run("reset", "Ada", "--yes")).resolves.toBe(0);
    expect(flagged.table.conversations.has(ADA_ID)).toBe(false);
  });

  it("AC3 WHEN a message arrives between the read and the reset THEN nothing is deleted", async () => {
    const s = setup({ step: "spec" });
    const original = s.store.restart.bind(s.store);
    s.store.restart = async (id, seen, nowIso) => {
      s.table.conversations.set(ADA_ID, { state: "open", pendingId: "new", pendingSince: NOW_S });
      return original(id, seen, nowIso);
    };
    const before = snapshot(s);
    await expect(s.run("reset", "Ada", "--yes")).resolves.toBe(1);
    expect(s.err).toEqual(["Ada sent a message meanwhile; nothing changed. Try again in a minute."]);
    // Only the message that arrived differs: no message, spec, data, marker or repository was deleted.
    s.table.conversations.set(ADA_ID, { state: "open", latestSpecVersion: 2, approvedSpecVersion: 2, buildId: "build-ada" });
    expect(snapshot(s)).toBe(before);
  });

  it("AC3 WHEN the GitHub secret is not loaded or GitHub is unreachable THEN nothing changes", async () => {
    const s = setup();
    s.deps.openGitHub = async () => openRepositoryAdmin(parseGitHubSecret("placeholder"), { fetch: s.github.fetch, now: () => NOW, log: () => undefined });
    const before = snapshot(s);
    await expect(s.run("reset", "Ada", "--yes")).resolves.toBe(1);
    expect(snapshot(s)).toBe(before);
    expect(s.err[0]).toContain("GitHubProblem: The GitHub secret is not loaded yet");

    const down = setup();
    down.deps.openGitHub = async () =>
      openRepositoryAdmin(parseGitHubSecret(TEST_SECRET_TEXT), {
        fetch: async () => {
          throw Object.assign(new Error("connect ECONNREFUSED"), { name: "TypeError" });
        },
        now: () => NOW,
        log: () => undefined,
      });
    const downBefore = snapshot(down);
    await expect(down.run("reset", "Ada", "--yes")).resolves.toBe(1);
    expect(snapshot(down)).toBe(downBefore);
    expect(down.err[0]).toBe(
      "Participant reset failed: GitHubProblem: GitHub could not be reached (installation). Check your AWS credentials (AWS_PROFILE), the region and the GitHub secret.",
    );
  });
});

describe("AC4: retries", () => {
  it("AC4 WHEN the repository is already gone THEN the run finishes without error", async () => {
    const s = setup();
    s.github.repositories.delete("ssd-ada");
    const kept = keptOf(s);
    await expect(s.run("reset", "Ada", "--yes")).resolves.toBe(0);
    expect(s.out).toContain("Repository ssd-workshop-apps/ssd-ada was already gone.");
    expectAdaReset(s, kept);
  });

  it("AC4 WHEN a reset already finished THEN running it again finishes without error and changes nothing more", async () => {
    const s = setup();
    await expect(s.run("reset", "Ada", "--yes")).resolves.toBe(0);
    const after = snapshot(s);
    s.out.length = 0;
    await expect(s.run("reset", "Ada", "--yes")).resolves.toBe(0);
    expect(snapshot(s)).toBe(after);
    expect(s.out.slice(0, 6)).toEqual([
      "Reset Ada: deleted 0 messages and replies and 0 spec versions; back at step 1 (Clarify).",
      "Waiting 30 s for uploads already under way, then deleting the app's photos and recordings once more.",
      "The app had no edit link.",
      "Deleted no app data; the live marker was already gone.",
      "Deleted no photos or recordings; CloudFront stops serving the app's media within minutes.",
      "Repository ssd-workshop-apps/ssd-ada was already gone.",
    ]);
  });

  for (const stop of [
    "restart",
    "deleteItems",
    "deleteEditLink",
    "deleteLiveMarker",
    "listAppData",
    "listAppData after the pause",
    "deleteAppData",
    "listAppMedia",
    "deleteAppMedia",
    "media files remove",
    "media files forget",
  ] as const) {
    it(`AC4 WHEN a first run stopped at ${stop} THEN a second run finishes without error`, async () => {
      const s = setup();
      const kept = keptOf(s);
      // listAppData is read three times (plan, first pass, second pass after the pause): fail the second or third read.
      if (stop === "listAppData" || stop === "listAppData after the pause") {
        const original = s.store.listAppData.bind(s.store);
        const failAt = stop === "listAppData" ? 2 : 3;
        let reads = 0;
        s.store.listAppData = async (nickname) => {
          if (++reads === failAt) throw s.store.failure;
          return original(nickname);
        };
      } else if (stop === "media files remove") s.mediaControl.failMedia = "remove";
      else if (stop === "media files forget") s.mediaControl.failMedia = "forget";
      else s.store.failOnce = stop;
      await expect(s.run("reset", "Ada", "--yes")).resolves.toBe(1);
      expect(s.err).toEqual([
        "Participant reset failed: InternalServerError. Check your AWS credentials (AWS_PROFILE), the region and the GitHub secret.",
        "Run the same command again: a reset that stopped part way finishes on the next run.",
      ]);
      s.err.length = 0;
      await expect(s.run("reset", "Ada", "--yes")).resolves.toBe(0);
      expect(s.err).toEqual([]);
      expectAdaReset(s, kept);
      expectBobUntouched(s);
      expectNothingPrivate(s);
    });
  }

  it("AC4 WHEN the first run stopped at the repository's deletion THEN a second run deletes it", async () => {
    const s = setup();
    const kept = keptOf(s);
    s.github.failNextDelete = 502;
    await expect(s.run("reset", "Ada", "--yes")).resolves.toBe(1);
    expect(s.err[0]).toBe(
      'Participant reset failed: GitHubProblem: GitHub answered 502 to the step "delete-repository". Check your AWS credentials (AWS_PROFILE), the region and the GitHub secret.',
    );
    expect(s.github.repositories.has("ssd-ada")).toBe(true);
    s.err.length = 0;
    await expect(s.run("reset", "Ada", "--yes")).resolves.toBe(0);
    expectAdaReset(s, kept);
    expectNothingPrivate(s);
  });
});

describe("AC2: data written while the reset runs", () => {
  it("AC2 WHEN the data API commits a value during the first delete THEN the second pass after the pause deletes it", async () => {
    const s = setup();
    const kept = keptOf(s);
    const original = s.store.deleteAppData.bind(s.store);
    let passes = 0;
    s.store.deleteAppData = async (nickname, sortKeys) => {
      await original(nickname, sortKeys);
      // A write that read the live marker before the reset deleted it commits now (the API does not re-check it).
      if (++passes === 1) {
        s.apps.values.set("ada/late", { json: "1", bytes: 1 });
        s.apps.usage.set("ada", { bytes: 1, keys: 1 });
      }
    };
    await expect(s.run("reset", "Ada", "--yes")).resolves.toBe(0);
    expect(passes).toBe(2);
    expect(s.waits).toEqual([SETTLE_MS, MEDIA_SETTLE_MS]);
    expect(SETTLE_MS).toBe(2000);
    expect(s.apps.values.has("ada/late")).toBe(false);
    expectAdaReset(s, kept);
    expectBobUntouched(s);
    expect(s.out[3]).toBe("Deleted 3 stored values and the app's data totals; deleted the live marker.");
  });

  it("AC2 WHEN nothing is written meanwhile THEN the second pass finds nothing and deletes nothing more", async () => {
    const s = setup();
    const deleted: string[][] = [];
    const original = s.store.deleteAppData.bind(s.store);
    s.store.deleteAppData = async (nickname, sortKeys) => {
      deleted.push([...sortKeys]);
      await original(nickname, sortKeys);
    };
    await expect(s.run("reset", "Ada", "--yes")).resolves.toBe(0);
    expect(deleted.map((keys) => keys.length)).toEqual([3, 0]);
    expect(s.waits).toEqual([SETTLE_MS, MEDIA_SETTLE_MS]);
  });
});

describe("AC3: the conversation reset and a running build", () => {
  it("AC3 WHEN the conversation reset runs during a running build and the full reset follows THEN both refuse, the build link stays, and no build is orphaned", async () => {
    const s = setup({ buildStatus: "building" });
    const conversationDeps: ConversationDeps = { createStore: () => s.store, now: () => NOW, out: (l) => s.out.push(l), err: (l) => s.err.push(l) };
    const before = snapshot(s);
    // Try 1's hole: the conversation reset deleted the item (and its build link) here, so the full reset saw no build.
    await expect(runConversation(["reset", "Ada", "--yes"], conversationDeps)).resolves.toBe(1);
    expect(s.err).toEqual(["Ada's build is building; try again once it is live or failed. Nothing changed."]);
    expect(s.table.conversations.get(ADA_ID)?.buildId).toBe("build-ada");
    expect(snapshot(s)).toBe(before);
    // The full reset still finds the running build through the link and refuses too.
    await expect(s.run("reset", "Ada", "--yes")).resolves.toBe(1);
    expect(s.err[1]).toBe("Ada's build is building; try again once it is live or failed. Nothing changed.");
    expect(snapshot(s)).toBe(before);
    // Once the build is live, the full reset goes ahead and removes what the build made.
    const build = s.table.builds.get("build-ada");
    if (build !== undefined) build.status = "live";
    const kept = keptOf(s);
    s.err.length = 0;
    await expect(s.run("reset", "Ada", "--yes")).resolves.toBe(0);
    expect(s.err).toEqual([]);
    expectAdaReset(s, kept);
  });
});

describe("AC5: output", () => {
  it("AC5 WHEN the command prints or fails THEN no email address, participant id, token or message text is in its output", async () => {
    // Failures whose AWS message quotes a key, an address and a text: only the error's name is printed.
    for (const stop of ["findParticipantId", "getStep", "getResetState", "getBuildStatus", "listResetItems", "hasLiveMarker", "restart", "deleteItems"] as const) {
      const s = setup();
      s.store.failure = Object.assign(new Error(`PARTICIPANT#${ADA_ID} ${ADA_EMAIL} ${SECRET} ${FAKE_TOKEN_PREFIX}0001`), { name: "ValidationException" });
      s.store.failOnce = stop;
      await expect(s.run("reset", "Ada", "--yes")).resolves.toBe(1);
      expect(s.err[0]).toBe("Participant reset failed: ValidationException. Check your AWS credentials (AWS_PROFILE), the region and the GitHub secret.");
      expectNothingPrivate(s);
    }
    // An error whose name is not a plain word prints "Error".
    const odd = setup();
    odd.store.failure = Object.assign(new Error("x"), { name: `bad ${ADA_EMAIL}` });
    odd.store.failOnce = "getStep";
    await odd.run("reset", "Ada");
    expect(odd.err[0]).toContain("failed: Error.");
    expectNothingPrivate(odd);
    // Successful dry run and reset, GitHub tokens included.
    const s = setup();
    await s.run("reset", "Ada");
    await s.run("reset", "Ada", "--yes");
    expect(s.github.bearers.size).toBeGreaterThan(0);
    expectNothingPrivate(s);
  });
});
