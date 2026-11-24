// Ticket 2.6: the participant's repository and the builder's token, against an in-memory GitHub (./fakes.ts).
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { BUILDER_COMMIT_EMAIL } from "../settings.js";
import { parseGitHubSecret, type GitHubDeps, type GitHubLogEntry } from "./app.js";
import { FAKE_TOKEN_PREFIX, FakeGitHub, TEST_PRIVATE_KEY_PEM, TEST_SECRET_TEXT } from "./fakes.js";
import {
  BOOTSTRAP_FILE,
  BOOTSTRAP_MESSAGE,
  BOOTSTRAP_TEXT,
  RETRY_WAITS_MS,
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

interface Setup {
  github: FakeGitHub;
  deps: GitHubDeps;
  logs: GitHubLogEntry[];
  /** Every wait the retry asked for (ms); nothing really waits. */
  waits: number[];
}

function setup(): Setup {
  let at = NOW.getTime();
  const now = (): Date => new Date((at += 5));
  const github = new FakeGitHub(() => new Date(at));
  const logs: GitHubLogEntry[] = [];
  const waits: number[] = [];
  const deps: GitHubDeps = {
    fetch: github.fetch,
    now,
    log: (entry) => logs.push(entry),
    sleep: (ms) => {
      waits.push(ms);
      return Promise.resolve();
    },
  };
  return { github, deps, logs, waits };
}

/** deps.fetch rewritten: `answer` may return a replacement Response for a call, or undefined to let GitHub answer. */
function intercept(s: Setup, answer: (url: string, init: RequestInit) => Response | undefined): void {
  const fetch = s.github.fetch;
  s.deps.fetch = async (url, init) => answer(url, init) ?? fetch(url, init);
}

const jsonAnswer = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let template: RepositoryFile[];
beforeAll(async () => {
  template = await loadTemplateFiles();
});

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
const EARLIER_FILES = { "SPEC.md": "# Earlier app\n" };
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
  });

  it("refuses an installation on another account", async () => {
    const { github, deps } = setup();
    github.installationAccount = "someone-else";
    await expect(prepareRepository({ credentials, nickname: "Carol", spec: SPEC, templateFiles: template }, deps)).rejects.toThrow(/installation on ssd-workshop-apps/);
    expect(github.repositories.size).toBe(0);
  });
});

describe("prepareRepository: the repository exists (criterion 2)", () => {
  it("reuses it on a rebuild and adds a new commit on top of main holding the template and the new spec", async () => {
    const { github, deps } = setup();
    const first = await prepareRepository({ credentials, nickname: "Dora", spec: SPEC, templateFiles: template }, deps);
    const newSpec = "# Plant diary v2\n\nAlso show the next watering day.\n";
    const second = await prepareRepository({ credentials, nickname: "DORA", spec: newSpec, templateFiles: template }, deps);
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
    expect(github.history("ssd-finn").map((c) => c.sha)).toEqual([result.commit]);
    expect(github.history("ssd-finn")[0]?.message).toBe(FIRST_COMMIT_MESSAGE);
  });

  it("refuses to reuse a repository that is not public", async () => {
    const { github, deps } = setup();
    github.addRepository("ssd-gail", { private: true });
    await expect(prepareRepository({ credentials, nickname: "gail", spec: SPEC, templateFiles: template }, deps)).rejects.toThrow(/not public/);
  });
});

describe("builderToken (criterion 3)", () => {
  it("is limited to that one repository with contents write, and expires within an hour", async () => {
    const { github, deps } = setup();
    const token = await builderToken(credentials, "Hana", deps);
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

describe("the organization-wide token (administration write)", () => {
  it("is used only when GitHub's answer grants exactly administration write and metadata read", async () => {
    const answers = [
      { permissions: { administration: "write", metadata: "read", contents: "write" } },
      { permissions: { administration: "read", metadata: "read" } },
      { permissions: { administration: "write", members: "write" } },
      { permissions: { metadata: "read" } },
    ];
    for (const answer of answers) {
      const { github, deps } = setup();
      github.overrideTokenAnswer = answer;
      await expect(prepareRepository({ credentials, nickname: "Jack", spec: SPEC, templateFiles: template }, deps), JSON.stringify(answer)).rejects.toThrow(
        /more than administration write/,
      );
      expect(github.repositories.size).toBe(0);
      expect(github.calls.some((c) => c.path === "/orgs/ssd-workshop-apps/repos")).toBe(false);
    }
  });
});

describe("ids from GitHub that go into a URL path", () => {
  const malformed = ["../../../orgs/ssd-workshop-apps/repos", "ABCDEF0123456789ABCDEF0123456789ABCDEF01", "abc123", `${"a".repeat(40)}/x`];

  it("a malformed commit id from the branch fails plainly, and is never put into a path", async () => {
    for (const bad of malformed) {
      const s = setup();
      await prepareRepository({ credentials, nickname: "Kira", spec: SPEC, templateFiles: template }, s.deps);
      const before = s.github.calls.length;
      intercept(s, (url, init) => (url.endsWith("/git/ref/heads/main") && init.method === "GET" ? jsonAnswer(200, { object: { sha: bad } }) : undefined));
      await expect(prepareRepository({ credentials, nickname: "Kira", spec: SPEC, templateFiles: template }, s.deps), bad).rejects.toThrow(
        'GitHub\'s answer to the step "get-branch" holds no valid id.',
      );
      const later = s.github.calls.slice(before);
      expect(later.some((c) => c.path.includes("/git/commits/"))).toBe(false);
    }
  });

  it("malformed blob, tree, commit and commit-tree ids fail plainly", async () => {
    const cases: { step: string; match: (url: string, method: string) => boolean; body: (bad: string) => unknown; status: number }[] = [
      { step: "blob", match: (url, m) => m === "POST" && url.endsWith("/git/blobs"), body: (bad) => ({ sha: bad }), status: 201 },
      { step: "tree", match: (url, m) => m === "POST" && url.endsWith("/git/trees"), body: (bad) => ({ sha: bad }), status: 201 },
      { step: "commit", match: (url, m) => m === "POST" && url.endsWith("/git/commits"), body: (bad) => ({ sha: bad }), status: 201 },
    ];
    for (const one of cases) {
      const s = setup();
      intercept(s, (url, init) => (one.match(url, init.method ?? "GET") ? jsonAnswer(one.status, one.body(malformed[0] ?? "")) : undefined));
      await expect(prepareRepository({ credentials, nickname: "Kira", spec: SPEC, templateFiles: template }, s.deps), one.step).rejects.toThrow(
        `GitHub's answer to the step "${one.step}" holds no valid id.`,
      );
      expect(s.github.calls.some((c) => c.path.includes(".."))).toBe(false);
    }
    // The tree id of `main`'s commit (read to recognise a leftover opening commit) goes into a path too.
    const s = setup();
    await prepareRepository({ credentials, nickname: "Kira", spec: SPEC, templateFiles: template }, s.deps);
    intercept(s, (url, init) =>
      init.method === "GET" && url.includes("/git/commits/")
        ? jsonAnswer(200, { message: BOOTSTRAP_MESSAGE, parents: [], tree: { sha: malformed[0] } })
        : undefined,
    );
    await expect(prepareRepository({ credentials, nickname: "Kira", spec: SPEC, templateFiles: template }, s.deps)).rejects.toThrow(
      'GitHub\'s answer to the step "get-commit" holds no valid id.',
    );
    expect(s.github.calls.some((c) => c.path.includes(".."))).toBe(false);
  });
});

describe("a parentless commit with the opening message is replaced only when it is exactly the opening commit", () => {
  it("a lone opening commit (README.md holding the opening line only) is replaced by the template's first commit", async () => {
    const { github, deps } = setup();
    github.addRepository("ssd-lena");
    github.seedCommit("ssd-lena", { [BOOTSTRAP_FILE]: BOOTSTRAP_TEXT }, BOOTSTRAP_MESSAGE);
    const result = await prepareRepository({ credentials, nickname: "lena", spec: SPEC, templateFiles: template }, deps);
    expect(github.history("ssd-lena").map((c) => c.sha)).toEqual([result.commit]);
    expect(github.history("ssd-lena")[0]?.message).toBe(FIRST_COMMIT_MESSAGE);
  });

  it("with other files, or another README text, it is kept: a rebuild commit goes on top, not forced", async () => {
    const trees = [
      { [BOOTSTRAP_FILE]: BOOTSTRAP_TEXT, "app.js": "console.log('mine');\n" },
      { [BOOTSTRAP_FILE]: "Someone's own notes.\n" },
      { "notes.md": BOOTSTRAP_TEXT },
    ];
    for (const files of trees) {
      const { github, deps } = setup();
      github.addRepository("ssd-milo");
      const kept = github.seedCommit("ssd-milo", files, BOOTSTRAP_MESSAGE);
      const result = await prepareRepository({ credentials, nickname: "milo", spec: SPEC, templateFiles: template }, deps);
      const history = github.history("ssd-milo");
      expect(history.map((c) => c.sha), JSON.stringify(files)).toEqual([result.commit, kept]);
      expect(history[0]?.message).toBe(REBUILD_COMMIT_MESSAGE);
      const update = github.calls.find((c) => c.method === "PATCH");
      expect(update?.body?.force).toBe(false);
    }
  });
});

describe("a rebuild whose get-branch answers GitHub's brief 404 is never forced over the earlier history", () => {
  const getBranch = (url: string, init: RequestInit): boolean => (init.method ?? "GET") === "GET" && url.endsWith("/git/ref/heads/main");
  /** Answers 404 to the first get-branch, then lets GitHub answer. */
  const branch404Once = (s: Setup): void => {
    let first = true;
    intercept(s, (url, init) => {
      if (!first || !getBranch(url, init)) return undefined;
      first = false;
      return jsonAnswer(404, { message: "Not Found" });
    });
  };
  const EARLIER_APP = { "SPEC.md": "# Earlier app\n", "app.js": "console.log('earlier');\n" };

  it("without README.md: the opening commit lands on top of main, and the rebuild goes on top of it, not forced", async () => {
    const s = setup();
    s.github.addRepository("ssd-olga");
    const root = s.github.seedCommit("ssd-olga", EARLIER_APP, FIRST_COMMIT_MESSAGE);
    const earlier = s.github.seedCommit("ssd-olga", EARLIER_APP, REBUILD_COMMIT_MESSAGE, [root]);
    branch404Once(s);
    const result = await prepareRepository({ credentials, nickname: "olga", spec: SPEC, templateFiles: template }, s.deps);
    const history = s.github.history("ssd-olga");
    expect(history.map((c) => c.sha)).toContain(earlier);
    expect(history.map((c) => c.sha)).toContain(root);
    expect(history[0]?.sha).toBe(result.commit);
    expect(history[0]?.message).toBe(REBUILD_COMMIT_MESSAGE);
    expect(history[1]?.message).toBe(BOOTSTRAP_MESSAGE);
    expect(history[2]?.sha).toBe(earlier);
    const update = s.github.calls.find((c) => c.method === "PATCH");
    expect(update?.body?.force).toBe(false);
  });

  it("with README.md: GitHub's 422 to the opening commit makes it read main again, and the rebuild goes on top, not forced", async () => {
    const s = setup();
    s.github.addRepository("ssd-otto");
    const earlier = s.github.seedCommit("ssd-otto", { ...EARLIER_APP, "README.md": "# Earlier app\n" }, FIRST_COMMIT_MESSAGE);
    branch404Once(s);
    const result = await prepareRepository({ credentials, nickname: "otto", spec: SPEC, templateFiles: template }, s.deps);
    expect(s.github.history("ssd-otto").map((c) => c.sha)).toEqual([result.commit, earlier]);
    expect(s.github.calls.filter((c) => c.method === "PUT")).toHaveLength(1);
    // The second read of main (the first, answered 404 by the interception, never reached the fake).
    expect(s.github.calls.filter((c) => c.method === "GET" && c.path.endsWith("/git/ref/heads/main"))).toHaveLength(1);
    const update = s.github.calls.find((c) => c.method === "PATCH");
    expect(update?.body?.force).toBe(false);
  });

  it("an opening commit that was made but answered 409 (so tried again, then 422) is still replaced, as a lone opening commit", async () => {
    const s = setup();
    let first = true;
    const fetch = s.github.fetch;
    s.deps.fetch = async (url, init) => {
      const answer = await fetch(url, init);
      if (first && init.method === "PUT") {
        first = false;
        return jsonAnswer(409, { message: "Conflict" });
      }
      return answer;
    };
    const result = await prepareRepository({ credentials, nickname: "Pia", spec: SPEC, templateFiles: template }, s.deps);
    expect(s.github.history("ssd-pia").map((c) => c.sha)).toEqual([result.commit]);
    expect(s.github.history("ssd-pia")[0]?.message).toBe(FIRST_COMMIT_MESSAGE);
  });

  it("an opening commit's answer without a valid id or a parents list fails plainly, and main is not moved", async () => {
    const answers: { body: unknown; error: string }[] = [
      { body: { commit: { sha: "abc123", parents: [] } }, error: 'GitHub\'s answer to the step "bootstrap" holds no valid id.' },
      { body: { commit: { sha: "a".repeat(40) } }, error: 'GitHub\'s answer to the step "bootstrap" holds no list of parents.' },
      { body: { commit: { sha: "a".repeat(40), parents: "none" } }, error: 'GitHub\'s answer to the step "bootstrap" holds no list of parents.' },
    ];
    for (const one of answers) {
      const s = setup();
      intercept(s, (url, init) => (init.method === "PUT" ? jsonAnswer(201, one.body) : undefined));
      await expect(prepareRepository({ credentials, nickname: "Quinn", spec: SPEC, templateFiles: template }, s.deps), JSON.stringify(one.body)).rejects.toThrow(
        one.error,
      );
      expect(s.github.calls.some((c) => c.method === "PATCH")).toBe(false);
    }
  });
});

describe("a leftover opening commit whose answer lists no parents", () => {
  it("is not taken for a lone opening commit: the rebuild goes on top, not forced", async () => {
    const s = setup();
    s.github.addRepository("ssd-rosa");
    const root = s.github.seedCommit("ssd-rosa", EARLIER_FILES, FIRST_COMMIT_MESSAGE);
    const leftover = s.github.seedCommit("ssd-rosa", { [BOOTSTRAP_FILE]: BOOTSTRAP_TEXT }, BOOTSTRAP_MESSAGE, [root]);
    const tree = s.github.repo("ssd-rosa").commits.get(leftover)?.tree;
    intercept(s, (url, init) =>
      (init.method ?? "GET") === "GET" && url.endsWith(`/git/commits/${leftover}`)
        ? jsonAnswer(200, { sha: leftover, message: BOOTSTRAP_MESSAGE, tree: { sha: tree } })
        : undefined,
    );
    const result = await prepareRepository({ credentials, nickname: "rosa", spec: SPEC, templateFiles: template }, s.deps);
    expect(s.github.history("ssd-rosa").map((c) => c.sha)).toEqual([result.commit, leftover, root]);
    expect(s.github.calls.find((c) => c.method === "PATCH")?.body?.force).toBe(false);
  });
});

describe("GitHub's brief 404 or 409 right after creating or opening the repository", () => {
  /** Answers `status` to the first `times` calls that match, then lets GitHub answer. */
  const failFirst = (s: Setup, match: (url: string, method: string) => boolean, status: number, times: number): (() => number) => {
    let seen = 0;
    intercept(s, (url, init) => {
      if (!match(url, init.method ?? "GET")) return undefined;
      seen += 1;
      return seen <= times ? jsonAnswer(status, { message: "Git Repository is empty." }) : undefined;
    });
    return () => seen;
  };
  const firstBlob = (url: string, method: string): boolean => method === "POST" && url.endsWith("/git/blobs");

  it("is tried again, at most 3 tries, after waiting 1 s then 2 s", async () => {
    expect(RETRY_WAITS_MS).toEqual([1000, 2000]);
    for (const status of [404, 409]) {
      const s = setup();
      const seen = failFirst(s, firstBlob, status, 2);
      const result = await prepareRepository({ credentials, nickname: "Nora", spec: SPEC, templateFiles: template }, s.deps);
      expect(s.github.history("ssd-nora").map((c) => c.sha)).toEqual([result.commit]);
      expect(s.waits).toEqual([1000, 2000]);
      expect(seen()).toBe(template.length + 2);
    }
  });

  it("applies to the opening commit and every Git Data step", async () => {
    const steps: ((url: string, method: string) => boolean)[] = [
      (url, m) => m === "PUT" && url.includes("/contents/"),
      (url, m) => m === "POST" && url.endsWith("/git/trees"),
      (url, m) => m === "POST" && url.endsWith("/git/commits"),
      (url, m) => m === "PATCH" && url.endsWith("/git/refs/heads/main"),
    ];
    for (const match of steps) {
      const s = setup();
      failFirst(s, match, 409, 1);
      await prepareRepository({ credentials, nickname: "Nora", spec: SPEC, templateFiles: template }, s.deps);
      expect(s.waits).toEqual([1000]);
    }
    const s = setup();
    await prepareRepository({ credentials, nickname: "Nora", spec: SPEC, templateFiles: template }, s.deps);
    failFirst(s, (url, m) => m === "GET" && url.includes("/git/commits/"), 404, 1);
    await prepareRepository({ credentials, nickname: "Nora", spec: "v2", templateFiles: template }, s.deps);
    expect(s.waits).toEqual([1000]);
    // The opening commit's tree is read only for a lone opening commit.
    const t = setup();
    t.github.addRepository("ssd-nora");
    t.github.seedCommit("ssd-nora", { [BOOTSTRAP_FILE]: BOOTSTRAP_TEXT }, BOOTSTRAP_MESSAGE);
    const trees = failFirst(t, (url, m) => m === "GET" && url.includes("/git/trees/"), 404, 1);
    const result = await prepareRepository({ credentials, nickname: "Nora", spec: SPEC, templateFiles: template }, t.deps);
    expect(trees()).toBe(2);
    expect(t.waits).toEqual([1000]);
    expect(t.github.history("ssd-nora").map((c) => c.sha)).toEqual([result.commit]);
  });

  it("fails plainly after the third 404 or 409", async () => {
    const s = setup();
    const seen = failFirst(s, firstBlob, 409, 3);
    await expect(prepareRepository({ credentials, nickname: "Nora", spec: SPEC, templateFiles: template }, s.deps)).rejects.toThrow(
      'GitHub answered 409 to the step "blob".',
    );
    expect(seen()).toBe(3);
    expect(s.waits).toEqual([1000, 2000]);
  });

  it("never tries again after 401, 403 or 422", async () => {
    for (const status of [401, 403, 422]) {
      const s = setup();
      const seen = failFirst(s, firstBlob, status, 1);
      await expect(prepareRepository({ credentials, nickname: "Nora", spec: SPEC, templateFiles: template }, s.deps), String(status)).rejects.toThrow(
        `GitHub answered ${status} to the step "blob".`,
      );
      expect(seen()).toBe(1);
      expect(s.waits).toEqual([]);
    }
  });

  it("stops waiting when the caller's deadline aborts", async () => {
    const s = setup();
    const controller = new AbortController();
    s.deps.signal = controller.signal;
    s.deps.sleep = (ms) => {
      s.waits.push(ms);
      controller.abort();
      return Promise.resolve();
    };
    failFirst(s, firstBlob, 409, 3);
    await expect(prepareRepository({ credentials, nickname: "Nora", spec: SPEC, templateFiles: template }, s.deps)).rejects.toThrow(
      'GitHub answered 409 to the step "blob".',
    );
    expect(s.waits).toEqual([1000]);
  });
});

describe("logs (criterion 5)", () => {
  // These checks run their own flows here, so they hold whatever order the tests run in.
  const lines: string[] = [];
  const bearers = new Set<string>();

  beforeAll(async () => {
    for (const method of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        lines.push(args.map(String).join(" "));
      });
    }
    const run = async (flow: (s: Setup) => Promise<unknown>, tamper?: (s: Setup) => void): Promise<void> => {
      const s = setup();
      s.deps.log = (entry) => {
        s.logs.push(entry);
        lines.push(JSON.stringify(entry));
      };
      tamper?.(s);
      await flow(s).catch(() => undefined);
      for (const bearer of s.github.bearers) bearers.add(bearer);
    };
    const prepare = (nickname: string, spec: string) => (s: Setup) => prepareRepository({ credentials, nickname, spec, templateFiles: template }, s.deps);
    // A new repository, then a rebuild of it, in one GitHub.
    await run(async (s) => {
      await prepare("Ada-Lovelace", SPEC)(s);
      await prepare("Ada-Lovelace", `${SPEC}\nv2\n`)(s);
    });
    await run((s) => builderToken(credentials, "Hana", s.deps));
    // Failures: a refused token, an unreachable GitHub, a retried step.
    await run(
      (s) => builderToken(credentials, "Hana", s.deps),
      (s) => {
        s.github.overrideTokenAnswer = { repository_selection: "all" };
      },
    );
    await run(prepare("Ada-Lovelace", SPEC), (s) => {
      intercept(s, (url) => {
        if (url.endsWith("/git/trees")) throw new TypeError("fetch failed");
        return undefined;
      });
    });
    await run(prepare("Ada-Lovelace", SPEC), (s) => {
      let once = true;
      intercept(s, (url) => {
        if (once && url.endsWith("/git/blobs")) {
          once = false;
          return jsonAnswer(409, { message: "Git Repository is empty." });
        }
        return undefined;
      });
    });
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });

  it("one JSON line per GitHub call: step, status and duration only", () => {
    const entries = lines.filter((line) => line.startsWith("{")).map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(entries.length).toBeGreaterThan(30);
    expect(entries.some((entry) => entry.status === "unreachable")).toBe(true);
    expect(entries.some((entry) => entry.status === 409)).toBe(true);
    for (const entry of entries) {
      expect(Object.keys(entry).every((key) => ["event", "step", "status", "error", "durationMs"].includes(key))).toBe(true);
    }
  });

  it("no token, JWT, key, nickname, repository name or spec appears in the logs", () => {
    const all = lines.join("\n");
    expect(bearers.size).toBeGreaterThan(8);
    expect([...bearers].some((bearer) => bearer.startsWith(FAKE_TOKEN_PREFIX))).toBe(true);
    expect([...bearers].some((bearer) => bearer.startsWith("eyJ"))).toBe(true);
    for (const bearer of bearers) expect(all.includes(bearer)).toBe(false);
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
