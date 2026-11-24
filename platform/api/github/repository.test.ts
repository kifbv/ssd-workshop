// Ticket 2.6: the participant's repository and the builder's token, against an in-memory GitHub (./fakes.ts).
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { BUILDER_COMMIT_EMAIL } from "../settings.js";
import { parseGitHubSecret, type GitHubDeps, type GitHubLogEntry } from "./app.js";
import { FAKE_TOKEN_PREFIX, FakeGitHub, TEST_PRIVATE_KEY_PEM, TEST_SECRET_TEXT } from "./fakes.js";
import {
  BOOTSTRAP_MESSAGE,
  COMMIT_IDENTITY,
  FIRST_COMMIT_MESSAGE,
  REBUILD_COMMIT_MESSAGE,
  builderToken,
  commitRequest,
  prepareRepository,
  repositoryNameFor,
  withSpec,
  type RepositoryFile,
} from "./repository.js";
import { TEMPLATE_DIR, loadTemplateFiles } from "./template.js";

const NOW = new Date("2026-11-24T10:00:00Z");
const credentials = parseGitHubSecret(TEST_SECRET_TEXT);
const SPEC = "# Plant diary\n\nAda (ada.lovelace@example.com) wants to note when each plant was watered.\n";

/** Every log line any test here wrote, through the module's log or the console (criterion 5). */
const logged: string[] = [];
const consoleMethods = ["log", "info", "warn", "error", "debug"] as const;
const everyBearer = new Set<string>();

beforeAll(() => {
  for (const method of consoleMethods) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    });
  }
});

afterAll(() => {
  vi.restoreAllMocks();
});

function setup(): { github: FakeGitHub; deps: GitHubDeps; logs: GitHubLogEntry[] } {
  let at = NOW.getTime();
  const now = (): Date => new Date((at += 5));
  const github = new FakeGitHub(() => new Date(at));
  const logs: GitHubLogEntry[] = [];
  const deps: GitHubDeps = {
    fetch: github.fetch,
    now,
    log: (entry) => {
      logs.push(entry);
      logged.push(JSON.stringify(entry));
    },
  };
  return { github, deps, logs };
}

const forget = (github: FakeGitHub): void => {
  for (const bearer of github.bearers) everyBearer.add(bearer);
};

let template: RepositoryFile[];
beforeAll(async () => {
  template = await loadTemplateFiles();
});

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
const EMAIL = /[^\s<>"'()]+@[^\s<>"'()]+\.[a-z]{2,}/gi;

describe("loadTemplateFiles and withSpec", () => {
  it("reads every file of templates/basic, and the spec replaces SPEC.md whole", async () => {
    const paths = template.map((file) => file.path);
    expect(paths).toEqual(["AGENTS.md", "README.md", "SPEC.md", "app.js", "index.html", "style.css", "workshop-data.js"]);
    expect(TEMPLATE_DIR.endsWith("/templates/basic/")).toBe(true);
    const files = withSpec(template, SPEC);
    expect(files.map((file) => file.path)).toEqual(paths);
    expect(decode(files.find((file) => file.path === "SPEC.md")?.bytes ?? new Uint8Array())).toBe(SPEC);
  });
});

describe("repositoryNameFor", () => {
  it("is ssd-<nickname> in lower case, for every nickname the 1.5 rules allow, and a valid GitHub name", () => {
    expect(repositoryNameFor("Ada-Lovelace")).toBe("ssd-ada-lovelace");
    expect(repositoryNameFor("ABC")).toBe("ssd-abc");
    expect(repositoryNameFor("-x-")).toBe("ssd--x-");
    for (const name of ["ssd-ada-lovelace", "ssd-abc", "ssd--x-", repositoryNameFor("A".repeat(20))]) {
      expect(name).toMatch(/^[a-z0-9-]{7,24}$/);
    }
  });

  it("refuses a nickname outside the rules (it would make another path or name)", () => {
    for (const bad of ["ab", "a/b/c", "../x", "a b c", "A".repeat(21), "ad.a"]) expect(() => repositoryNameFor(bad), bad).toThrow(/rules/);
  });
});

describe("prepareRepository: a new repository (criterion 1)", () => {
  it("creates ssd-<nickname> public in lower case in ssd-workshop-apps, and the history's first commit holds the template and the spec", async () => {
    const { github, deps } = setup();
    const result = await prepareRepository({ credentials, nickname: "Ada-Lovelace", spec: SPEC, templateFiles: template }, deps);
    forget(github);
    expect(result.repository).toBe("ssd-workshop-apps/ssd-ada-lovelace");
    expect(result.created).toBe(true);
    const repo = github.repo("ssd-ada-lovelace");
    expect(repo.private).toBe(false);
    expect(repo.createdWith).toMatchObject({ name: "ssd-ada-lovelace", visibility: "public", private: false, auto_init: false });
    const history = github.history("ssd-ada-lovelace");
    expect(history).toHaveLength(1);
    const [first] = history;
    expect(first?.sha).toBe(result.commit);
    expect(first?.parents).toEqual([]);
    expect(first?.message).toBe(FIRST_COMMIT_MESSAGE);
    const files = github.filesAt("ssd-ada-lovelace", result.commit);
    const expected = Object.fromEntries(withSpec(template, SPEC).map((file) => [file.path, decode(file.bytes)]));
    expect(files).toEqual(expected);
    expect(files["SPEC.md"]).toBe(SPEC);
    expect(files["index.html"]).toBe(decode(template.find((f) => f.path === "index.html")?.bytes ?? new Uint8Array()));
    // The opening commit (Git Data API refuses an empty repository) is no longer reachable from main.
    expect([...repo.commits.values()].some((c) => c.message === BOOTSTRAP_MESSAGE)).toBe(true);
    expect(history.some((c) => c.message === BOOTSTRAP_MESSAGE)).toBe(false);
  });

  it("creates the repository with a token for administration only, and writes files with a token for that one repository", async () => {
    const { github, deps } = setup();
    await prepareRepository({ credentials, nickname: "Bob", spec: SPEC, templateFiles: template }, deps);
    forget(github);
    const create = github.calls.find((c) => c.path === "/orgs/ssd-workshop-apps/repos");
    const createGrant = github.grants.get(create?.authorization?.replace("Bearer ", "") ?? "");
    expect(createGrant).toEqual({ permissions: { administration: "write", metadata: "read" }, repositories: undefined });
    const writes = github.calls.filter((c) => c.path.startsWith("/repos/ssd-workshop-apps/ssd-bob/"));
    expect(writes.length).toBeGreaterThan(5);
    for (const call of writes) {
      expect(github.grants.get(call.authorization?.replace("Bearer ", "") ?? "")).toEqual({
        permissions: { contents: "write", metadata: "read" },
        repositories: ["ssd-bob"],
      });
    }
  });

  it("refuses when the organization's default branch is not main", async () => {
    const { github, deps } = setup();
    github.defaultBranch = "master";
    await expect(prepareRepository({ credentials, nickname: "Carol", spec: SPEC, templateFiles: template }, deps)).rejects.toThrow(/default branch is not main/);
    forget(github);
  });

  it("refuses an installation on another account", async () => {
    const { github, deps } = setup();
    github.installationAccount = "someone-else";
    await expect(prepareRepository({ credentials, nickname: "Carol", spec: SPEC, templateFiles: template }, deps)).rejects.toThrow(/installation on ssd-workshop-apps/);
    expect(github.repositories.size).toBe(0);
    forget(github);
  });
});

describe("prepareRepository: the repository exists (criterion 2)", () => {
  it("reuses it on a rebuild and adds a new commit on top of main holding the template and the new spec", async () => {
    const { github, deps } = setup();
    const first = await prepareRepository({ credentials, nickname: "Dora", spec: SPEC, templateFiles: template }, deps);
    const newSpec = "# Plant diary v2\n\nAlso show the next watering day.\n";
    const second = await prepareRepository({ credentials, nickname: "DORA", spec: newSpec, templateFiles: template }, deps);
    forget(github);
    expect(second.created).toBe(false);
    expect(second.repository).toBe("ssd-workshop-apps/ssd-dora");
    expect(github.repositories.size).toBe(1);
    const history = github.history("ssd-dora");
    expect(history.map((c) => c.sha)).toEqual([second.commit, first.commit]);
    expect(history[0]?.message).toBe(REBUILD_COMMIT_MESSAGE);
    expect(history[0]?.parents).toEqual([first.commit]);
    expect(github.filesAt("ssd-dora", second.commit)["SPEC.md"]).toBe(newSpec);
    expect(github.filesAt("ssd-dora", first.commit)["SPEC.md"]).toBe(SPEC);
  });

  it("starts the history in an existing empty repository (409 from the Git Data API), as for a new one", async () => {
    const { github, deps } = setup();
    github.addRepository("ssd-erin");
    const result = await prepareRepository({ credentials, nickname: "erin", spec: SPEC, templateFiles: template }, deps);
    forget(github);
    expect(result.created).toBe(false);
    const history = github.history("ssd-erin");
    expect(history).toHaveLength(1);
    expect(history[0]?.message).toBe(FIRST_COMMIT_MESSAGE);
    expect(github.calls.some((c) => c.path.endsWith("/git/ref/heads/main"))).toBe(true);
  });

  it("replaces a lone opening commit left by a try that stopped half-way, so the history still starts with the template", async () => {
    const { github, deps } = setup();
    let failTree = true;
    const fetch = github.fetch;
    deps.fetch = async (url, init) => {
      if (failTree && url.endsWith("/git/trees")) {
        failTree = false;
        throw new TypeError("fetch failed");
      }
      return fetch(url, init);
    };
    await expect(prepareRepository({ credentials, nickname: "Finn", spec: SPEC, templateFiles: template }, deps)).rejects.toThrow(/could not be reached \(tree\)/);
    expect(github.history("ssd-finn").map((c) => c.message)).toEqual([BOOTSTRAP_MESSAGE]);
    const result = await prepareRepository({ credentials, nickname: "Finn", spec: SPEC, templateFiles: template }, deps);
    forget(github);
    expect(github.history("ssd-finn").map((c) => c.sha)).toEqual([result.commit]);
    expect(github.history("ssd-finn")[0]?.message).toBe(FIRST_COMMIT_MESSAGE);
  });

  it("refuses to reuse a repository that is not public", async () => {
    const { github, deps } = setup();
    github.addRepository("ssd-gail", { private: true });
    await expect(prepareRepository({ credentials, nickname: "gail", spec: SPEC, templateFiles: template }, deps)).rejects.toThrow(/not public/);
    forget(github);
  });
});

describe("builderToken (criterion 3)", () => {
  it("is limited to that one repository with contents write, and expires within an hour", async () => {
    const { github, deps } = setup();
    const token = await builderToken(credentials, "Hana", deps);
    forget(github);
    expect(token.token.startsWith(FAKE_TOKEN_PREFIX)).toBe(true);
    expect(token.repository).toBe("ssd-workshop-apps/ssd-hana");
    const ask = github.calls.find((c) => c.path.endsWith("/access_tokens"));
    expect(ask?.body).toEqual({ repositories: ["ssd-hana"], permissions: { contents: "write" } });
    expect(github.grants.get(token.token)).toEqual({ permissions: { contents: "write", metadata: "read" }, repositories: ["ssd-hana"] });
    const lifetime = Date.parse(token.expiresAt) - NOW.getTime();
    expect(lifetime).toBeGreaterThan(0);
    expect(lifetime).toBeLessThanOrEqual(60 * 60 * 1000 + 60 * 1000);
  });

  it("refuses a token that lives longer than an hour, or has already expired", async () => {
    for (const lifetime of [2 * 60 * 60 * 1000, -1000]) {
      const { github, deps } = setup();
      github.tokenLifetimeMs = lifetime;
      await expect(builderToken(credentials, "Hana", deps)).rejects.toThrow(/within an hour/);
      forget(github);
    }
  });

  it("refuses an answer that reaches all repositories, another repository or more rights", async () => {
    const answers = [
      { repository_selection: "all" },
      { repositories: [{ full_name: "ssd-workshop-apps/ssd-other" }] },
      { repositories: [{ full_name: "ssd-workshop-apps/ssd-hana" }, { full_name: "ssd-workshop-apps/ssd-other" }] },
      { repositories: [{ full_name: "someone-else/ssd-hana" }] },
      { permissions: { contents: "write", metadata: "read", administration: "write" } },
      { permissions: { contents: "read", metadata: "read" } },
      { permissions: { contents: "write", workflows: "write" } },
    ];
    for (const answer of answers) {
      const { github, deps } = setup();
      github.overrideTokenAnswer = answer;
      await expect(builderToken(credentials, "Hana", deps), JSON.stringify(answer)).rejects.toThrow(/more than the one repository/);
      forget(github);
    }
  });
});

describe("commit identity (criterion 4)", () => {
  const onlyNoreply = (value: unknown): void => {
    const found = JSON.stringify(value).match(EMAIL) ?? [];
    expect(found.filter((address) => address !== BUILDER_COMMIT_EMAIL)).toEqual([]);
  };

  it("every commit's author, committer and message hold no email address but the noreply one, even when the spec holds one", async () => {
    expect(COMMIT_IDENTITY).toEqual({ name: "SSD Workshop builder", email: "noreply@workshop.rankly.games" });
    const { github, deps } = setup();
    await prepareRepository({ credentials, nickname: "Ivy", spec: SPEC, templateFiles: template }, deps);
    await prepareRepository({ credentials, nickname: "Ivy", spec: `${SPEC}\nContact: someone@example.org\n`, templateFiles: template }, deps);
    forget(github);
    const commits = [...github.repo("ssd-ivy").commits.values()];
    expect(commits.length).toBe(3);
    for (const commit of commits) {
      expect(commit.author).toMatchObject(COMMIT_IDENTITY);
      expect(commit.committer).toMatchObject(COMMIT_IDENTITY);
      onlyNoreply([commit.author, commit.committer, commit.message]);
      expect(commit.message).not.toContain("@");
    }
    // The spec's addresses only reach the SPEC.md file, as the participant wrote it.
    expect(github.filesAt("ssd-ivy", github.history("ssd-ivy")[0]?.sha ?? "")["SPEC.md"]).toContain("someone@example.org");
    // And every request body that is commit metadata (not file content).
    for (const call of github.calls.filter((c) => c.path.endsWith("/git/commits") || c.path.includes("/contents/"))) {
      onlyNoreply([call.body?.author, call.body?.committer, call.body?.message]);
    }
  });

  it("commitRequest always uses the fixed identity, whatever the message and parents", () => {
    const body = commitRequest(FIRST_COMMIT_MESSAGE, "t", ["p"], NOW);
    expect(body).toEqual({
      message: FIRST_COMMIT_MESSAGE,
      tree: "t",
      parents: ["p"],
      author: { ...COMMIT_IDENTITY, date: NOW.toISOString() },
      committer: { ...COMMIT_IDENTITY, date: NOW.toISOString() },
    });
    onlyNoreply(body);
  });
});

describe("logs (criterion 5)", () => {
  it("one JSON line per GitHub call: step, status and duration only", () => {
    const { logs } = setup();
    expect(logs).toEqual([]);
    const lines = logged.filter((line) => line.startsWith("{")).map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines.length).toBeGreaterThan(50);
    for (const line of lines) {
      expect(Object.keys(line).every((key) => ["event", "step", "status", "error", "durationMs"].includes(key))).toBe(true);
    }
  });

  it("after all these tests, no token, JWT, key, nickname, repository name or spec appears in the logs", () => {
    const all = logged.join("\n");
    expect(everyBearer.size).toBeGreaterThan(20);
    expect([...everyBearer].some((bearer) => bearer.startsWith(FAKE_TOKEN_PREFIX))).toBe(true);
    expect([...everyBearer].some((bearer) => bearer.startsWith("eyJ"))).toBe(true);
    for (const bearer of everyBearer) expect(all.includes(bearer)).toBe(false);
    expect(all).not.toContain(FAKE_TOKEN_PREFIX);
    expect(all).not.toContain("ghs_");
    expect(all).not.toContain("eyJ");
    expect(all).not.toContain("PRIVATE KEY");
    expect(all).not.toContain(TEST_PRIVATE_KEY_PEM.split("\n")[1] ?? "?");
    for (const secretish of ["ada-lovelace", "ssd-hana", "Plant diary", "example.com", "ssd-workshop-apps/"]) {
      expect(all.toLowerCase()).not.toContain(secretish.toLowerCase());
    }
  });
});
