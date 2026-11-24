// Ticket 2.6: the GitHub App's credentials, its JWT and the REST calls' shape.
import { createPublicKey, createVerify } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  GitHubProblem,
  SECRET_KEY_UNREADABLE,
  SECRET_NOT_LOADED,
  appJwt,
  findInstallation,
  getApp,
  githubCall,
  mintInstallationToken,
  parseGitHubSecret,
  type GitHubDeps,
  type GitHubLogEntry,
} from "./app.js";
import { FAKE_TOKEN_PREFIX, FakeGitHub, TEST_APP_ID, TEST_INSTALLATION_ID, TEST_PRIVATE_KEY_PEM, TEST_SECRET_TEXT } from "./fakes.js";

const NOW = new Date("2026-11-24T10:00:00Z");

function setup(): { github: FakeGitHub; deps: GitHubDeps; logs: GitHubLogEntry[] } {
  const github = new FakeGitHub(() => NOW);
  const logs: GitHubLogEntry[] = [];
  return { github, logs, deps: { fetch: github.fetch, now: () => NOW, log: (entry) => logs.push(entry) } };
}

const problemOf = (work: () => unknown): GitHubProblem => {
  try {
    work();
  } catch (error) {
    if (error instanceof GitHubProblem) return error;
    throw error;
  }
  throw new Error("no problem raised");
};

describe("parseGitHubSecret", () => {
  it("reads {appId, privateKey} (the id as text or a number)", () => {
    expect(parseGitHubSecret(TEST_SECRET_TEXT).appId).toBe(TEST_APP_ID);
    expect(parseGitHubSecret(JSON.stringify({ appId: 424242, privateKey: TEST_PRIVATE_KEY_PEM })).appId).toBe("424242");
  });

  it("says plainly that the secret is not loaded for CDK's random placeholder or any other shape, never echoing it", () => {
    const placeholder = "Xq8$k2!pLm9#rT4vWz7&nB3cYd6^fG1h";
    for (const value of [undefined, "", placeholder, "{}", "[]", "null", JSON.stringify({ appId: "x1", privateKey: TEST_PRIVATE_KEY_PEM }), JSON.stringify({ appId: "1", privateKey: "abc" }), JSON.stringify({ appId: "1" })]) {
      const problem = problemOf(() => parseGitHubSecret(value));
      expect(problem.message).toBe(SECRET_NOT_LOADED);
    }
    expect(problemOf(() => parseGitHubSecret(placeholder)).message).not.toContain(placeholder.slice(0, 6));
    const withKey = problemOf(() => parseGitHubSecret(JSON.stringify({ appId: "x1", privateKey: TEST_PRIVATE_KEY_PEM })));
    expect(withKey.message).not.toContain("BEGIN");
  });

  it("says the key cannot be read when it is not a PEM RSA private key, without quoting it", () => {
    const broken = "-----BEGIN RSA PRIVATE KEY-----\nnot-a-key-SECRETBITS\n-----END RSA PRIVATE KEY-----\n";
    const problem = problemOf(() => parseGitHubSecret(JSON.stringify({ appId: "7", privateKey: broken })));
    expect(problem.message).toBe(SECRET_KEY_UNREADABLE);
    expect(problem.message).not.toContain("SECRETBITS");
  });
});

describe("appJwt", () => {
  it("is RS256, issued 60 s back, valid 9 minutes, issued by the app id, and verifies with the app's public key", () => {
    const credentials = parseGitHubSecret(TEST_SECRET_TEXT);
    const jwt = appJwt(credentials, NOW);
    const [header, payload, signature] = jwt.split(".");
    expect(JSON.parse(Buffer.from(header ?? "", "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" });
    const seconds = NOW.getTime() / 1000;
    expect(JSON.parse(Buffer.from(payload ?? "", "base64url").toString())).toEqual({ iat: seconds - 60, exp: seconds + 540, iss: TEST_APP_ID });
    const verify = createVerify("RSA-SHA256");
    verify.update(`${header}.${payload}`);
    expect(verify.verify(createPublicKey(TEST_PRIVATE_KEY_PEM), Buffer.from(signature ?? "", "base64url"))).toBe(true);
  });
});

describe("githubCall", () => {
  it("sends the API version, a User-Agent, JSON accept and the bearer; logs step, status and duration only", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const logs: GitHubLogEntry[] = [];
    const answer = await githubCall(
      {
        fetch: async (url, init) => {
          seen.push({ url, init });
          return new Response(JSON.stringify({ ok: 1 }), { status: 200 });
        },
        now: () => NOW,
        log: (entry) => logs.push(entry),
      },
      "app",
      "POST",
      "/app",
      "SECRET-BEARER",
      { a: 1 },
    );
    expect(answer).toEqual({ status: 200, json: { ok: 1 } });
    expect(seen[0]?.url).toBe("https://api.github.com/app");
    const headers = new Headers(seen[0]?.init.headers);
    expect(headers.get("x-github-api-version")).toBe("2022-11-28");
    expect(headers.get("user-agent")).toBe("ssd-workshop-platform");
    expect(headers.get("accept")).toBe("application/vnd.github+json");
    expect(headers.get("authorization")).toBe("Bearer SECRET-BEARER");
    expect(seen[0]?.init.signal).toBeInstanceOf(AbortSignal);
    expect(seen[0]?.init.redirect).toBe("error");
    expect(logs).toEqual([{ event: "github", step: "app", status: 200, durationMs: 0 }]);
  });

  it("turns no answer into a plain problem and logs only the error's name", async () => {
    const logs: GitHubLogEntry[] = [];
    await expect(
      githubCall(
        {
          fetch: async () => {
            throw new TypeError("fetch failed for https://x-access-token:SECRET@github.com");
          },
          now: () => NOW,
          log: (entry) => logs.push(entry),
        },
        "tree",
        "GET",
        "/x",
        "SECRET-BEARER",
      ),
    ).rejects.toThrow("GitHub could not be reached (tree).");
    expect(logs).toEqual([{ event: "github", step: "tree", status: "unreachable", error: "TypeError", durationMs: 0 }]);
  });
});

describe("installation and tokens", () => {
  it("finds the installation on ssd-workshop-apps and the app itself with the JWT", async () => {
    const { deps } = setup();
    const jwt = appJwt(parseGitHubSecret(TEST_SECRET_TEXT), NOW);
    expect(await findInstallation(deps, jwt)).toEqual({
      id: TEST_INSTALLATION_ID,
      account: "ssd-workshop-apps",
      accountType: "Organization",
      repositorySelection: "all",
      permissions: { administration: "write", contents: "write", metadata: "read" },
    });
    expect(await getApp(deps, jwt)).toEqual({ slug: "ssd-workshop-gh-app", name: "SSD Workshop GH App", owner: "ssd-workshop-apps" });
  });

  it("a JWT signed by another key is refused by GitHub (the fake checks the signature)", async () => {
    const { deps } = setup();
    const { generateKeyPairSync } = await import("node:crypto");
    const other = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs1", format: "pem" }).toString();
    const jwt = appJwt(parseGitHubSecret(JSON.stringify({ appId: TEST_APP_ID, privateKey: other })), NOW);
    await expect(findInstallation(deps, jwt)).rejects.toThrow('GitHub answered 401 to the step "installation".');
  });

  it("mints a token with exactly the rights asked for and returns its expiry", async () => {
    const { deps } = setup();
    const jwt = appJwt(parseGitHubSecret(TEST_SECRET_TEXT), NOW);
    const token = await mintInstallationToken(deps, jwt, TEST_INSTALLATION_ID, { permissions: { contents: "write" }, repositories: ["ssd-x"] });
    expect(token.token.startsWith(FAKE_TOKEN_PREFIX)).toBe(true);
    expect(token.expiresAt).toBe("2026-11-24T11:00:00.000Z");
    expect(token.repositories).toEqual(["ssd-workshop-apps/ssd-x"]);
    expect(token.repositorySelection).toBe("selected");
  });
});
