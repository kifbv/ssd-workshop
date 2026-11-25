// Ticket 2.13: `npm run participant -- reset <nickname> [--yes]` against the in-memory table the API's tests use, the
// in-memory app data store and the in-memory GitHub. Test names start with the criterion they prove (AC1 to AC5).
import { describe, expect, it } from "vitest";
import { FakeAppDataStore } from "../../api/app-data/fakes.js";
import { FakeConversationTable } from "../../api/conversation/fakes.js";
import { parseGitHubSecret, type GitHubDeps } from "../../api/github/app.js";
import { FAKE_TOKEN_PREFIX, FakeGitHub, TEST_SECRET_TEXT } from "../../api/github/fakes.js";
import { openRepositoryAdmin } from "../../api/github/repository.js";
import { STALE_PENDING_SECONDS } from "../../api/conversation/state.js";
import type { BuildStatus, Step } from "../../api/types.js";
import { FakeResetStore } from "../conversation/fakes.js";
import { runParticipant, USAGE, type ParticipantDeps } from "./command.js";
import type { ParticipantResetStore } from "./store.js";

const NOW = new Date("2026-11-25T10:00:00.000Z");
const NOW_S = NOW.getTime() / 1000;
const SECRET = "my secret app idea about the quarterly numbers";
const SPEC_TEXT = "# Secret spec text";
const ADA_EMAIL = "ada.lovelace@example.com";
const ADA_ID = "p-ada-0f3c9a7e";
const BOB_ID = "p-bob-71d2c004";
const MESSAGE_ID = "2026-11-25T09:00:00.000Z-0101010101010101";

type Method = keyof ParticipantResetStore;

/** The conversation reset store plus builds (the table's), app data (FakeAppDataStore) and the live marker. */
class FakeParticipantResetStore extends FakeResetStore implements ParticipantResetStore {
  /** The next call of this method throws (a run that stops part way), then it works again. */
  failOnce: Method | undefined;
  failure: Error = Object.assign(new Error(`table down for PARTICIPANT#${ADA_ID} (${ADA_EMAIL})`), { name: "InternalServerError" });

  constructor(
    readonly table: FakeConversationTable,
    readonly apps: FakeAppDataStore,
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
      "hasLiveMarker",
      "deleteLiveMarker",
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

  async getBuildStatus(buildId: string) {
    return this.table.builds.get(buildId)?.status;
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
  async hasLiveMarker(nickname: string) {
    return this.apps.live.has(nickname.toLowerCase());
  }
  async deleteLiveMarker(nickname: string) {
    this.apps.live.delete(nickname.toLowerCase());
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
    apps.values.set(`${lower}/scores`, { json: "[1,2]", bytes: 5 });
    apps.values.set(`${lower}/name`, { json: `"${SECRET}"`, bytes: 10 });
    apps.usage.set(lower, { bytes: 15, keys: 2 });
    github.addRepository(`ssd-${lower}`);
  }
  const store = new FakeParticipantResetStore(table, apps);
  const out: string[] = [];
  const err: string[] = [];
  let githubOpened = 0;
  const githubDeps: GitHubDeps = { fetch: github.fetch, now: () => NOW, log: () => undefined };
  const deps: ParticipantDeps = {
    createStore: () => store,
    openGitHub: async () => {
      githubOpened++;
      return openRepositoryAdmin(parseGitHubSecret(TEST_SECRET_TEXT), githubDeps);
    },
    now: () => NOW,
    out: (l) => out.push(l),
    err: (l) => err.push(l),
  };
  const run = (...args: string[]) => runParticipant(args, deps);
  const printed = () => [...out, ...err].join("\n");
  return { table, apps, github, store, deps, out, err, run, printed, githubOpened: () => githubOpened };
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
  });
}

/** Ada's whole reset is done: conversation gone, Clarify, no app data, marker or repository; the rest unchanged. */
function expectAdaReset(s: Setup, kept: { allow: string; nicknames: string; sessions: string; usage: string; builds: string }) {
  expect(s.table.messages.get(ADA_ID)?.size ?? 0).toBe(0);
  expect(s.table.replies.get(ADA_ID)?.size ?? 0).toBe(0);
  expect(s.table.specs.get(ADA_ID) ?? []).toEqual([]);
  expect(s.table.conversations.has(ADA_ID)).toBe(false);
  expect(s.table.profiles.get(ADA_ID)?.step).toBe("clarify");
  expect(s.table.profiles.get(ADA_ID)?.nickname).toBe("Ada");
  expect([...s.apps.values.keys()].filter((k) => k.startsWith("ada/"))).toEqual([]);
  expect(s.apps.usage.has("ada")).toBe(false);
  expect(s.apps.live.has("ada")).toBe(false);
  expect(s.github.repositories.has("ssd-ada")).toBe(false);
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
      "App: 2 stored values and the app's data totals, live marker present, repository ssd-workshop-apps/ssd-ada exists.",
      "Nothing changed. Run again with --yes to delete all of this and send Ada back to step 1 (Clarify).",
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
      "App: no app data, live marker absent, repository ssd-workshop-apps/ssd-ada already gone.",
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
        "Deleted 2 stored values and the app's data totals and the live marker.",
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
    expect(s.out[0]).toBe("Deleted 2 stored values and the app's data totals and the live marker.");
    expectBobUntouched(s);
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
    s.store.restart = async (id, seen) => {
      s.table.conversations.set(ADA_ID, { state: "open", pendingId: "new", pendingSince: NOW_S });
      return original(id, seen);
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
    expect(s.out.slice(0, 3)).toEqual([
      "Reset Ada: deleted 0 messages and replies and 0 spec versions; back at step 1 (Clarify).",
      "Deleted no app data and the live marker (there was none).",
      "Repository ssd-workshop-apps/ssd-ada was already gone.",
    ]);
  });

  for (const stop of ["restart", "deleteItems", "deleteLiveMarker", "listAppData", "deleteAppData"] as const) {
    it(`AC4 WHEN a first run stopped at ${stop} THEN a second run finishes without error`, async () => {
      const s = setup();
      const kept = keptOf(s);
      // listAppData is read twice (plan, then before deleting): fail the second read.
      if (stop === "listAppData") {
        const original = s.store.listAppData.bind(s.store);
        let reads = 0;
        s.store.listAppData = async (nickname) => {
          if (++reads === 2) throw s.store.failure;
          return original(nickname);
        };
      } else s.store.failOnce = stop;
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
