// Step 3, Build (ticket 2.10): what `GET /api/build` means for the page, as pure functions so every rule is unit
// tested without a browser. The DOM wiring is in ./main.ts.
//
// File paths, hosts, commit messages and failure reasons are anyone's text (the coding agent's, a participant's
// files): the page shows them with `textContent` only, and puts into a link only what passes the checks below.
// Ticket 3.4: the queue's place text is shared with the API (phase 3 texts, ticket 3.2): plain functions, no Node.js.
import { queuePositionText } from "../../api/workshop/texts.js";
import { MESSAGES, type ApiAnswer, type Show, type Tone } from "./flow.js";

/** The step 3 page asks for news of the build this often while it runs. */
export const BUILD_POLL_INTERVAL_MS = 2000;

export type BuildStatus = "queued" | "building" | "deploying" | "live" | "failed";
const STATUSES: readonly BuildStatus[] = ["queued", "building", "deploying", "live", "failed"];

/** The builder's steps (ticket 2.8), in order. */
export type FeedStep = "preparing" | "writing" | "checking" | "committing" | "deploying";
const STEPS: readonly FeedStep[] = ["preparing", "writing", "checking", "committing", "deploying"];

export type FeedEvent =
  | { kind: "step"; step: FeedStep; at: string }
  | { kind: "file"; path: string; at: string }
  | { kind: "fetch"; host: string; at: string }
  | { kind: "commit"; sha: string; message: string; at: string };

/** `GET /api/build`. */
export interface Build {
  buildId: string;
  status: BuildStatus;
  /** Oldest first. */
  feed: FeedEvent[];
  repositoryUrl?: string;
  appUrl?: string;
  failureReasons?: string[];
  /** Ticket 3.4: while queued, how many builds wait ahead of it (once the launcher has placed it). */
  ahead?: number;
  /** Ticket 3.5: the workshop is paused (the admin's global Stop). */
  paused?: true;
  /** Ticket 3.5: the server could not read whether it is paused (keep the line as it shows). */
  pausedUnknown?: true;
  /** Ticket 3.10: a facilitator paused this person (not the whole workshop). */
  pausedBy?: "facilitator";
  /** Ticket 3.8 (from 3.6): a change build, with its number (1 for the participant's first change). */
  kind?: "change";
  changeNumber?: number;
}

/** The row of stages on the page: the builder's steps, then live. */
export type Stage = FeedStep | "live";
export const STAGES: readonly Stage[] = [...STEPS, "live"];

export const BUILD_TEXTS = {
  failed: "Something went wrong with your build. Your facilitator can restart it.",
  /** One line under the stages: what is happening now. */
  now: {
    queued: "Your build is in the queue and starts in a moment.",
    preparing: "Getting your repository and the app template ready.",
    writing: "The AI is writing your app's files.",
    checking: "Checking the files against the workshop's rules.",
    committing: "Saving the files to your GitHub repository.",
    deploying: "Checking your app once more and publishing it.",
    live: "Your app is live.",
  },
  /** Before each kind of feed line. */
  wrote: "Wrote",
  read: "Read",
  saved: "Saved",
} as const;

const show = (message: string, tone: Tone = "error"): Show => ({ kind: "show", message, tone });

const record = (v: unknown): Record<string, unknown> | undefined =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
const text = (v: unknown): v is string => typeof v === "string";

/** A commit id GitHub gave: 40 lower-case hex characters, the only form that goes into a link. */
export const COMMIT_SHA = /^[0-9a-f]{40}$/;
/** A participant's repository: `https://github.com/<owner>/ssd-<lower-cased nickname>` (ticket 2.6). */
const REPOSITORY_URL = /^https:\/\/github\.com\/ssd-workshop-apps\/ssd-[a-z0-9-]{3,20}$/;
/** A live app's address on the workshop's own site (ticket 2.5). */
const APP_URL = /^https:\/\/workshop\.rankly\.games\/apps\/[a-z0-9-]{3,20}\/$/;

function parseEvent(value: unknown): FeedEvent | undefined {
  const e = record(value);
  if (e === undefined || !text(e["at"])) return undefined;
  const at = e["at"];
  if (e["kind"] === "step" && (STEPS as readonly unknown[]).includes(e["step"])) return { kind: "step", step: e["step"] as FeedStep, at };
  if (e["kind"] === "file" && text(e["path"])) return { kind: "file", path: e["path"], at };
  if (e["kind"] === "fetch" && text(e["host"])) return { kind: "fetch", host: e["host"], at };
  if (e["kind"] === "commit" && text(e["sha"]) && COMMIT_SHA.test(e["sha"]) && text(e["message"])) return { kind: "commit", sha: e["sha"], message: e["message"], at };
  return undefined;
}

/** A build from `GET /api/build`, or undefined when the body is not one. Unknown feed events are left out. */
export function parseBuild(body: unknown): Build | undefined {
  const b = record(body);
  if (b === undefined || !text(b["buildId"]) || !(STATUSES as readonly unknown[]).includes(b["status"])) return undefined;
  const feed = Array.isArray(b["feed"]) ? b["feed"].flatMap((e) => parseEvent(e) ?? []) : [];
  const reasons = Array.isArray(b["failureReasons"]) ? b["failureReasons"].filter(text) : undefined;
  return {
    buildId: b["buildId"],
    status: b["status"] as BuildStatus,
    feed,
    ...(text(b["repositoryUrl"]) && REPOSITORY_URL.test(b["repositoryUrl"]) ? { repositoryUrl: b["repositoryUrl"] } : {}),
    ...(text(b["appUrl"]) && APP_URL.test(b["appUrl"]) ? { appUrl: b["appUrl"] } : {}),
    ...(reasons === undefined ? {} : { failureReasons: reasons }),
    ...(typeof b["ahead"] === "number" && Number.isInteger(b["ahead"]) && b["ahead"] >= 0 ? { ahead: b["ahead"] } : {}),
    ...(b["paused"] === true ? { paused: true as const } : {}),
    ...(b["pausedUnknown"] === true ? { pausedUnknown: true as const } : {}),
    ...(b["paused"] === true && b["pausedBy"] === "facilitator" ? { pausedBy: "facilitator" as const } : {}),
    ...(b["kind"] === "change" ? { kind: "change" as const } : {}),
    ...(b["kind"] === "change" && typeof b["changeNumber"] === "number" && Number.isInteger(b["changeNumber"]) && b["changeNumber"] >= 1
      ? { changeNumber: b["changeNumber"] }
      : {}),
  };
}

/**
 * Ticket 3.8: where the page shows a build that is no longer running: step 4 once it is live, and also after a failed
 * change build (the app before it is still live, decision 3.6); a failed first build stays on step 3 with its reasons.
 */
export const showsStepFour = (build: Build): boolean => build.status === "live" || (build.status === "failed" && build.kind === "change");

/**
 * `GET /api/build`: a build; `missing` (404, no build yet: the page keeps asking); signed out; or a message for
 * anything else (the page keeps asking too).
 */
export function buildResult(answer: ApiAnswer): { kind: "build"; build: Build } | { kind: "missing" } | { kind: "signed-out" } | Show {
  if (answer.status === 200) {
    const build = parseBuild(answer.body);
    return build ? { kind: "build", build } : show(MESSAGES.failed);
  }
  if (answer.status === 404) return { kind: "missing" };
  if (answer.status === 401) return { kind: "signed-out" };
  if (answer.status === 429) return show(MESSAGES.retry, "info");
  if (answer.status === 0) return show(MESSAGES.offline);
  return show(MESSAGES.failed);
}

/** True while the build still runs: the page keeps polling (it stops on live and on failed). */
export const isRunning = (status: BuildStatus): boolean => status === "queued" || status === "building" || status === "deploying";

/**
 * The stage the build is at: the last step in its feed, `deploying` once the deployer took it, `live` once live.
 * Undefined while queued (no step yet). A failed build stays at the stage it reached.
 */
export function currentStage(build: Build): Stage | undefined {
  if (build.status === "live") return "live";
  if (build.status === "deploying") return "deploying";
  let last: FeedStep | undefined;
  for (const event of build.feed) if (event.kind === "step") last = event.step;
  return last;
}

/** Each stage of the row as done, current (the one highlighted) or still to come. */
export function stageStates(build: Build): Record<Stage, "done" | "current" | "todo"> {
  const current = currentStage(build);
  const at = current === undefined ? -1 : STAGES.indexOf(current);
  const states = {} as Record<Stage, "done" | "current" | "todo">;
  STAGES.forEach((stage, i) => {
    states[stage] = i < at ? "done" : i === at ? "current" : "todo";
  });
  return states;
}

/** The line under the stages. */
export function nowText(build: Build): string {
  if (build.status === "failed") return BUILD_TEXTS.failed;
  // Ticket 3.4: a queued build says how many builds are ahead of it, once the launcher placed it in the line.
  if (build.status === "queued" && build.ahead !== undefined) return queuePositionText(build.ahead);
  return BUILD_TEXTS.now[currentStage(build) ?? "queued"];
}

/** The link to one commit on GitHub, or undefined when the repository or the id is not one the page trusts. */
export function commitUrl(repositoryUrl: string | undefined, sha: string): string | undefined {
  if (repositoryUrl === undefined || !REPOSITORY_URL.test(repositoryUrl) || !COMMIT_SHA.test(sha)) return undefined;
  return `${repositoryUrl}/commit/${sha}`;
}

/** One line of the feed as the page shows it: a word, the text, and for a commit its short id and link. */
export interface FeedLine {
  kind: "file" | "fetch" | "commit";
  label: string;
  text: string;
  link?: { href: string; text: string };
}

/** The files written, pages read and commits made, oldest first (steps show in the row of stages instead). */
export function feedLines(build: Build): FeedLine[] {
  return build.feed.flatMap((event): FeedLine[] => {
    if (event.kind === "file") return [{ kind: "file", label: BUILD_TEXTS.wrote, text: event.path }];
    if (event.kind === "fetch") return [{ kind: "fetch", label: BUILD_TEXTS.read, text: event.host }];
    if (event.kind === "commit") {
      const href = commitUrl(build.repositoryUrl, event.sha);
      return [{ kind: "commit", label: BUILD_TEXTS.saved, text: event.message, ...(href === undefined ? {} : { link: { href, text: event.sha.slice(0, 7) } }) }];
    }
    return [];
  });
}

/** The part of the behind-the-scenes flow that is working now (the same flow as the phase 2 brief's diagram). */
export type BehindPart = "launcher" | "builder" | "agent" | "github" | "deployer" | "app";
export function behindPart(build: Build): BehindPart | undefined {
  if (build.status === "failed") return undefined;
  const stage = currentStage(build);
  if (stage === undefined) return "launcher";
  const parts: Record<Stage, BehindPart> = { preparing: "builder", writing: "agent", checking: "builder", committing: "github", deploying: "deployer", live: "app" };
  return parts[stage];
}
