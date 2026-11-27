import { execFileSync } from "node:child_process";
import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeAppTokenStore } from "../../api/app-token/fakes.js";
import { hashAppToken } from "../../api/app-token/token.js";
import { findRepoRoot, runAllowlist, type CommandDeps } from "./command.js";
import type { GroupRole } from "./logic.js";
import type { AllowListInput, AllowListStore, RemoveResult } from "./store.js";

/** In-memory allow-list with the same contract as the DynamoDB store. */
class FakeStore implements AllowListStore {
  readonly items = new Map<string, AllowListInput & { createdAt: string; participantId?: string }>();
  private clock = 0;

  async upsert(entry: AllowListInput): Promise<"added" | "updated"> {
    const existing = this.items.get(entry.email);
    if (existing) {
      this.items.set(entry.email, { ...existing, group: entry.group, role: entry.role });
      return "updated";
    }
    this.items.set(entry.email, { ...entry, createdAt: `t${this.clock++}` });
    return "added";
  }

  async listAll(): Promise<GroupRole[]> {
    return [...this.items.values()].map(({ group, role }) => ({ group, role }));
  }

  async exists(email: string): Promise<boolean> {
    return this.items.has(email);
  }

  /** Ticket 3.26: the apps' edit links (the same in-memory store the API's tests use), and the profiles' nicknames. */
  readonly tokens = new FakeAppTokenStore();
  readonly nicknames = new Map<string, string>();

  async remove(email: string): Promise<RemoveResult> {
    const participantId = this.items.get(email)?.participantId;
    const nickname = participantId === undefined ? undefined : this.nicknames.get(participantId);
    const editLinkDeleted = nickname === undefined ? false : await this.tokens.deleteEditLink(nickname);
    return { removed: this.items.delete(email), editLinkDeleted };
  }
}

const repoRoot = findRepoRoot(dirname(fileURLToPath(import.meta.url)));

let dir: string;
let store: FakeStore;
let stdout: string[];
let stderr: string[];
let storesCreated: number;

function deps(overrides: Partial<CommandDeps> = {}): CommandDeps {
  return {
    repoRoot,
    createStore: () => {
      storesCreated++;
      return store;
    },
    out: (line) => stdout.push(line),
    err: (line) => stderr.push(line),
    ...overrides,
  };
}

const output = (): string => [...stdout, ...stderr].join("\n");

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ssd-workshop-allowlist-"));
  store = new FakeStore();
  stdout = [];
  stderr = [];
  storesCreated = 0;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const PEOPLE = [
  "email,group,role",
  "  Jane.Doe@Example.COM ,alpha,participant",
  "bob@example.org,alpha,facilitator",
  "not-an-email,alpha,participant",
  "carol@example.com,beta,boss",
  "dave@example.com,,admin",
  "erin@example.com,beta,admin",
  "jane.doe@example.com,beta,admin",
  "",
].join("\n");
const ADDRESSES = ["jane.doe@example.com", "Jane.Doe@Example.COM", "bob@example.org", "not-an-email", "carol@example.com", "dave@example.com", "erin@example.com"];

describe("findRepoRoot", () => {
  it("finds the monorepo root (the package.json with workspaces)", () => {
    expect(relative(repoRoot, fileURLToPath(import.meta.url))).toBe(join("platform", "src", "allowlist", "command.test.ts"));
  });
});

describe("allowlist import", () => {
  it("criterion 1: stores each row once, lower-cased and trimmed, and prints only counts", async () => {
    writeFileSync(join(dir, "people.csv"), PEOPLE);
    expect(await runAllowlist(["import", join(dir, "people.csv")], deps())).toBe(0);

    expect([...store.items.keys()].sort()).toEqual(["bob@example.org", "erin@example.com", "jane.doe@example.com"]);
    expect(store.items.get("jane.doe@example.com")).toMatchObject({ group: "alpha", role: "participant" });
    expect(stdout.join("\n")).toBe(
      [
        "Added: 3",
        "Updated: 0",
        "Rejected: 4",
        "Line 4: invalid email",
        "Line 5: unknown role",
        "Line 6: empty group",
        "Line 8: duplicate of line 2",
      ].join("\n"),
    );
    expect(stderr).toEqual([]);
  });

  it("criterion 1: a second import updates group and role and keeps createdAt", async () => {
    const file = join(dir, "people.csv");
    writeFileSync(file, "email,group,role\na@example.com,alpha,participant\n");
    await runAllowlist(["import", file], deps());
    const createdAt = store.items.get("a@example.com")?.createdAt;

    writeFileSync(file, "email,group,role\nA@example.com,beta,facilitator\nb@example.com,beta,participant\n");
    stdout = [];
    expect(await runAllowlist(["import", file], deps())).toBe(0);
    expect(stdout.join("\n")).toBe("Added: 1\nUpdated: 1\nRejected: 0");
    expect(store.items.get("a@example.com")).toEqual({ email: "a@example.com", group: "beta", role: "facilitator", createdAt });
    expect(store.items.size).toBe(2);
  });

  it("criterion 2: bad rows are rejected with their line numbers while the others are imported", async () => {
    writeFileSync(join(dir, "people.csv"), "email,group,role\nbad,g,participant\nok@example.com,g,admin\nok2@example.com,g,root\nok3@example.com, ,admin\n");
    expect(await runAllowlist(["import", join(dir, "people.csv")], deps())).toBe(0);
    expect([...store.items.keys()]).toEqual(["ok@example.com"]);
    expect(stdout.join("\n")).toBe("Added: 1\nUpdated: 0\nRejected: 3\nLine 2: invalid email\nLine 4: unknown role\nLine 5: empty group");
  });

  it("criteria 1 and 3: import then list print no email address from the file", async () => {
    writeFileSync(join(dir, "people.csv"), PEOPLE);
    await runAllowlist(["import", join(dir, "people.csv")], deps());
    await runAllowlist(["import", join(dir, "people.csv")], deps());
    expect(await runAllowlist(["list"], deps())).toBe(0);

    const text = output();
    for (const address of ADDRESSES) expect(text).not.toContain(address);
    expect(text).not.toMatch(/@/);
    expect(stdout.at(-1)).toBe(
      ["Group  Role         Count", "alpha  participant      1", "alpha  facilitator      1", "beta   admin            1", "Total                   3"].join("\n"),
    );
  });

  it("criterion 2: rejects an address pasted in the group column and never prints it", async () => {
    writeFileSync(join(dir, "people.csv"), "email,group,role\nalpha,jane.doe@example.com,participant\nok@example.com,g,admin\n");
    expect(await runAllowlist(["import", join(dir, "people.csv")], deps())).toBe(0);
    expect([...store.items.values()].map((i) => i.group)).toEqual(["g"]);
    expect(stdout.join("\n")).toBe("Added: 1\nUpdated: 0\nRejected: 1\nLine 2: invalid email, group looks like an email address");
    expect(await runAllowlist(["list"], deps())).toBe(0);
    expect(output()).not.toMatch(/@/);
  });

  it("refuses a file without the header and imports nothing", async () => {
    writeFileSync(join(dir, "people.csv"), "a@example.com,g,participant\n");
    expect(await runAllowlist(["import", join(dir, "people.csv")], deps())).toBe(1);
    expect(stderr).toEqual(["Nothing imported: the first line must be the header email,group,role."]);
    expect(storesCreated).toBe(0);
  });

  it("refuses a missing file before any AWS call", async () => {
    expect(await runAllowlist(["import", join(dir, "missing.csv")], deps())).toBe(1);
    expect(stderr).toEqual(["CSV file not found."]);
    expect(storesCreated).toBe(0);
  });

  it("prints a store error redacted, after the counts so far, and exits 1", async () => {
    writeFileSync(join(dir, "people.csv"), "email,group,role\na@example.com,g,participant\nb@example.com,g,participant\n");
    const failing: AllowListStore = {
      upsert: async (entry) => {
        if (entry.email === "b@example.com") throw new Error(`AccessDenied on EMAIL#${entry.email}`);
        return "added";
      },
      listAll: async () => [],
      exists: async () => false,
      remove: async () => ({ removed: false, editLinkDeleted: false }),
    };
    expect(await runAllowlist(["import", join(dir, "people.csv")], deps({ createStore: () => failing }))).toBe(1);
    expect(stdout.join("\n")).toBe("Added: 1\nUpdated: 0\nRejected: 0");
    expect(stderr).toHaveLength(1);
    expect(stderr[0]).toBe("Allow-list import failed: Error: AccessDenied on E***@e***.com");
    expect(output()).not.toContain("b@example.com");
  });
});

describe("allowlist path refusal", () => {
  it("criterion 4: refuses a CSV path inside the repository, even one that does not exist", async () => {
    for (const file of [join(repoRoot, "people.csv"), join(repoRoot, "docs", "people.csv"), join(repoRoot, "package.json")]) {
      stderr = [];
      expect(await runAllowlist(["import", file], deps())).toBe(1);
      expect(stderr[0]).toMatch(/^Refused: the CSV file is inside the repository/);
    }
    expect(storesCreated).toBe(0);
  });

  it("criterion 4: refuses a relative path, wherever it leads, before reading it", async () => {
    writeFileSync(join(dir, "people.csv"), "email,group,role\na@example.com,g,participant\n");
    for (const file of ["platform/package.json", "people.csv", "../people.csv", "./people.csv"]) {
      stderr = [];
      expect(await runAllowlist(["import", file], deps())).toBe(1);
      expect(stderr).toEqual(["Refused: give an absolute path to the CSV file."]);
    }
    expect(storesCreated).toBe(0);
  });

  it("criterion 4: refuses a path into the repository written in another letter case", async () => {
    for (const file of [join(repoRoot.toUpperCase(), "people.csv"), join(repoRoot.toLowerCase(), "Docs", "People.CSV")]) {
      stderr = [];
      expect(await runAllowlist(["import", file], deps())).toBe(1);
      expect(stderr[0]).toMatch(/^Refused: the CSV file is inside the repository/);
    }
    expect(storesCreated).toBe(0);
  });

  it("criterion 4: refuses a CSV inside any other git work tree, also through a symlink", async () => {
    const other = join(dir, "other-repo");
    mkdirSync(join(other, "sub"), { recursive: true });
    execFileSync("git", ["init", "-q", other], { stdio: "ignore" });
    const csv = "email,group,role\na@example.com,g,participant\n";
    writeFileSync(join(other, "people.csv"), csv);
    writeFileSync(join(other, "sub", "people.csv"), csv);
    const link = join(dir, "link.csv");
    symlinkSync(join(other, "sub", "people.csv"), link);
    for (const file of [join(other, "people.csv"), join(other, "sub", "people.csv"), link]) {
      stderr = [];
      expect(await runAllowlist(["import", file], deps())).toBe(1);
      expect(stderr).toEqual(["Refused: the CSV file is inside a git repository. Keep it outside, so personal data never reaches git."]);
    }
    expect(storesCreated).toBe(0);
  });

  it("criterion 4: refuses a CSV below a folder whose .git is a plain file (worktree or submodule form)", async () => {
    const other = join(dir, "worktree");
    mkdirSync(join(other, "sub"), { recursive: true });
    writeFileSync(join(other, ".git"), "gitdir: /somewhere/else/.git/worktrees/x\n");
    const csv = "email,group,role\na@example.com,g,participant\n";
    writeFileSync(join(other, "people.csv"), csv);
    writeFileSync(join(other, "sub", "people.csv"), csv);
    for (const file of [join(other, "people.csv"), join(other, "sub", "people.csv")]) {
      stderr = [];
      expect(await runAllowlist(["import", file], deps())).toBe(1);
      expect(stderr).toEqual(["Refused: the CSV file is inside a git repository. Keep it outside, so personal data never reaches git."]);
    }
    expect(storesCreated).toBe(0);
  });

  it("criterion 4: refuses a CSV inside a git work tree whatever the git environment says", async () => {
    const other = join(dir, "other-repo");
    mkdirSync(other);
    execFileSync("git", ["init", "-q", other], { stdio: "ignore" });
    writeFileSync(join(other, "people.csv"), "email,group,role\na@example.com,g,participant\n");
    const saved = { ceiling: process.env["GIT_CEILING_DIRECTORIES"], path: process.env["PATH"] };
    process.env["GIT_CEILING_DIRECTORIES"] = dir;
    process.env["PATH"] = "";
    try {
      expect(await runAllowlist(["import", join(other, "people.csv")], deps())).toBe(1);
    } finally {
      if (saved.ceiling === undefined) delete process.env["GIT_CEILING_DIRECTORIES"];
      else process.env["GIT_CEILING_DIRECTORIES"] = saved.ceiling;
      process.env["PATH"] = saved.path;
    }
    expect(stderr).toEqual(["Refused: the CSV file is inside a git repository. Keep it outside, so personal data never reaches git."]);
    expect(storesCreated).toBe(0);
  });

  it("refuses a CSV path that is a directory", async () => {
    mkdirSync(join(dir, "people.csv"));
    expect(await runAllowlist(["import", join(dir, "people.csv")], deps())).toBe(1);
    expect(stderr).toEqual(["Refused: the CSV path is not a file."]);
    expect(storesCreated).toBe(0);
  });

  it("criterion 4: refuses a file with more than one hard link (realpath cannot follow them)", async () => {
    const elsewhere = mkdtempSync(join(tmpdir(), "ssd-workshop-allowlist-"));
    try {
      const original = join(elsewhere, "people.csv");
      writeFileSync(original, "email,group,role\na@example.com,g,participant\n");
      linkSync(original, join(dir, "people.csv"));
      for (const file of [join(dir, "people.csv"), original]) {
        stderr = [];
        expect(await runAllowlist(["import", file], deps())).toBe(1);
        expect(stderr).toEqual(["Refused: the CSV file has more than one hard link. Use a plain copy outside any git repository."]);
      }
      expect(storesCreated).toBe(0);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it("criterion 4: refuses a symlink outside the repository that points into it", async () => {
    const link = join(dir, "people.csv");
    symlinkSync(join(repoRoot, "package.json"), link);
    expect(await runAllowlist(["import", link], deps())).toBe(1);
    expect(stderr[0]).toMatch(/^Refused/);
    expect(storesCreated).toBe(0);
  });

  it("accepts a file in a temporary directory outside the repository", async () => {
    writeFileSync(join(dir, "people.csv"), "email,group,role\na@example.com,g,participant\n");
    expect(await runAllowlist(["import", join(dir, "people.csv")], deps())).toBe(0);
    expect(storesCreated).toBe(1);
  });
});

describe("allowlist remove (ticket 3.1)", () => {
  const JANE = "jane.doe@example.com";
  const BOB = "bob@example.org";
  function listed(): void {
    for (const email of [JANE, BOB]) store.items.set(email, { email, group: "alpha", role: "participant", createdAt: "t", participantId: "p" });
  }

  it("without --yes only says whether the address has an entry, changes nothing and prints no address", async () => {
    listed();
    expect(await runAllowlist(["remove", "  Jane.Doe@Example.COM "], deps())).toBe(0);
    expect(stdout).toEqual(["This address has an allow-list entry. Nothing was changed: run again with --yes to remove it."]);
    expect(await runAllowlist(["remove", "carol@example.com"], deps())).toBe(0);
    expect(stdout[1]).toBe("This address has no allow-list entry. Nothing was changed.");
    expect([...store.items.keys()].sort()).toEqual([BOB, JANE]);
    expect(output()).not.toContain("@");
  });

  it("criterion 1: with --yes deletes that one entry (normalized address), before or after the address, and prints no address", async () => {
    listed();
    expect(await runAllowlist(["remove", "Jane.Doe@Example.COM", "--yes"], deps())).toBe(0);
    expect(stdout).toEqual([
      "Removed the allow-list entry for this address. Their sessions end at their next call; their profile and app are kept.",
    ]);
    expect([...store.items.keys()]).toEqual([BOB]);
    // Again: there is nothing left to remove.
    expect(await runAllowlist(["remove", "--yes", JANE], deps())).toBe(0);
    expect(stdout[1]).toBe("This address has no allow-list entry. Nothing was changed.");
    expect([...store.items.keys()]).toEqual([BOB]);
    expect(output()).not.toContain("@");
  });

  it("ticket 3.26: WHEN a linked person is removed with --yes THEN their app's edit link stops at once (others' stay), and no secret, id or address is printed", async () => {
    store.items.set(JANE, { email: JANE, group: "alpha", role: "participant", createdAt: "t", participantId: "p-jane-1" });
    store.items.set(BOB, { email: BOB, group: "alpha", role: "participant", createdAt: "t", participantId: "p-bob-2" });
    store.nicknames.set("p-jane-1", "Jane-1");
    store.nicknames.set("p-bob-2", "Bob-2");
    const secrets = { jane: Buffer.alloc(32, 1).toString("base64url"), bob: Buffer.alloc(32, 3).toString("base64url") };
    store.tokens.addEditLink("jane-1", "Jane-1", secrets.jane);
    store.tokens.addEditLink("bob-2", "Bob-2", secrets.bob);
    expect(await runAllowlist(["remove", JANE, "--yes"], deps())).toBe(0);
    expect(stdout).toEqual([
      "Removed the allow-list entry for this address and deleted their app's edit link. Their sessions end at their next call; their profile and app are kept.",
    ]);
    expect(await store.tokens.getAppToken(hashAppToken(secrets.jane))).toBeUndefined();
    expect(await store.tokens.getAppToken(hashAppToken(secrets.bob))).toMatchObject({ nickname: "Bob-2" });
    // Without --yes nothing is deleted.
    expect(await runAllowlist(["remove", BOB], deps())).toBe(0);
    expect(await store.tokens.getAppToken(hashAppToken(secrets.bob))).toMatchObject({ nickname: "Bob-2" });
    const text = output();
    for (const secret of ["@", "p-jane-1", "p-bob-2", secrets.jane, hashAppToken(secrets.jane)]) expect(text, secret).not.toContain(secret);
  });

  it("refuses a missing, invalid or extra argument before any AWS call, without repeating what was typed", async () => {
    for (const args of [
      ["remove"],
      ["remove", "--yes"],
      ["remove", "not-an-address"],
      ["remove", "ja#ne@example.com"],
      ["remove", JANE, BOB],
      ["remove", JANE, "--yes", "--yes"],
      ["remove", JANE, "--force"],
    ]) {
      expect(await runAllowlist(args, deps()), args.join(" ")).toBe(1);
    }
    expect(storesCreated).toBe(0);
    expect(stdout).toEqual([]);
    const text = output();
    for (const typed of ["@", "not-an-address", "ja#ne", "--force"]) expect(text, typed).not.toContain(typed);
  });

  it("prints a store error redacted and exits 1", async () => {
    const failing: AllowListStore = {
      upsert: async () => "added",
      listAll: async () => [],
      exists: async (email) => {
        throw new Error(`AccessDenied on EMAIL#${email}`);
      },
      remove: async (email) => {
        throw new Error(`AccessDenied on EMAIL#${email}`);
      },
    };
    expect(await runAllowlist(["remove", JANE], deps({ createStore: () => failing }))).toBe(1);
    expect(await runAllowlist(["remove", JANE, "--yes"], deps({ createStore: () => failing }))).toBe(1);
    expect(stderr).toEqual([
      "Allow-list remove failed: Error: AccessDenied on E***@e***.com",
      "Allow-list remove failed: Error: AccessDenied on E***@e***.com",
    ]);
    expect(output()).not.toContain(JANE);
  });
});

describe("allowlist usage", () => {
  it("prints usage and exits 1 on an unknown command, before any AWS call", async () => {
    expect(await runAllowlist(["delete"], deps())).toBe(1);
    expect(stderr[0]).toMatch(/^unknown command\n\nUsage: npm run -s allowlist -- <command>/);
    expect(storesCreated).toBe(0);
  });
});
