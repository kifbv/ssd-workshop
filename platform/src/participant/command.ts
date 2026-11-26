// `npm run participant -- reset <nickname> [--yes]` (ticket 2.13): start a test participant's workshop over with the
// same sign-in. Without --yes it only says what it would delete. Run from your own machine with your own AWS
// credentials (AWS_PROFILE). The flow lives here with its outside world passed in, so it is tested against in-memory
// fakes; ./main.ts wires in the real ones. It composes the conversation reset (../conversation): same arguments, same
// "AI is answering" refusal, same conditional restart.
//
// Nothing it prints holds a message text, a participant id, an email address or a token; an error shows only its
// name, or a GitHubProblem's plain reason (written never to hold a token, a key or GitHub's answer). It prints the
// nickname and the repository's name: the operator asked for that participant (decision "(2.13) Names printed").
import { GitHubProblem } from "../../api/github/app.js";
import type { RepositoryAdmin } from "../../api/github/repository.js";
import { APPS_GITHUB_OWNER, appRepositoryName } from "../../api/settings.js";
import {
  aiAnswering,
  buildRunningMessage,
  errorName,
  parseConversationArgs,
  plural,
  runningBuild,
  STEP_NAMES,
  type ResetCommand,
} from "../conversation/command.js";
import type { ParticipantResetStore } from "./store.js";

export const USAGE = `Usage: npm run participant -- reset <nickname> [--yes]

  reset <nickname>         show what a reset would delete; changes nothing
  reset <nickname> --yes   start the participant's workshop over: delete their messages, the AI's replies and
                           every spec version, send them back to step 1 (Clarify), end their sign-ins to save
                           in apps (app write tokens), and delete their app's data, its live marker and its
                           GitHub repository

Kept: the allow-list entry, the nickname, sessions, AI usage totals and build records. The app's published
files stay online until the next build's deploy replaces them. It refuses while a build is queued, building
or deploying, or while the AI is answering. A run that stopped part way finishes on the next run.

Runs with your own AWS credentials (AWS_PROFILE); reads the GitHub App's key from the secret ssd-workshop-github.`;

export interface ParticipantDeps {
  /** Called only once the arguments are accepted, so a usage error makes no AWS call. */
  createStore: () => ParticipantResetStore;
  /** Reads the GitHub App's secret and mints the administration token; called before anything changes. */
  openGitHub: () => Promise<RepositoryAdmin>;
  now: () => Date;
  /** Waits between the two passes over the app's data (see SETTLE_MS); injected so tests do not wait. */
  sleep: (ms: number) => Promise<void>;
  out: (line: string) => void;
  err: (line: string) => void;
}

/**
 * How long the reset waits after deleting the app's data before listing it again. The data API (ticket 2.4) reads the
 * live marker apart from its write transaction, so a write that read the marker just before the reset deleted it can
 * still commit afterwards; such a write normally lands within this pause and the second pass deletes it.
 */
export const SETTLE_MS = 2000;

const KEPT = "Kept: allow-list entry, nickname, sessions, AI usage totals and build records.";

export function parseParticipantArgs(args: readonly string[]): ResetCommand | { error: string } {
  return parseConversationArgs(args);
}

/** "4 stored values and their totals", "no app data". */
function describeAppData(keys: readonly string[]): string {
  const values = keys.filter((k) => k.startsWith("DATA#")).length;
  const totals = keys.includes("DATA_USAGE");
  if (values === 0 && !totals) return "no app data";
  return `${plural(values, "stored value", "stored values")}${totals ? " and the app's data totals" : ""}`;
}

async function reset(command: ResetCommand, deps: ParticipantDeps, store: ParticipantResetStore): Promise<number> {
  const { nickname } = command;
  const participantId = await store.findParticipantId(nickname);
  if (participantId === undefined) {
    deps.err(`No participant has the nickname ${nickname}.`);
    return 1;
  }
  const step = await store.getStep(participantId);
  // A participant without a step 1 yet has no conversation to reset; their app's data and repository (keyed by the
  // nickname they claimed) are still cleaned.
  const stepName = step === undefined ? undefined : STEP_NAMES[step];
  const state = await store.getResetState(participantId);
  if (aiAnswering(state, deps.now())) {
    deps.err(`The AI is still answering ${nickname}'s last message; try again in a minute (after a crash, up to 20 minutes). Nothing changed.`);
    return 1;
  }
  const running = await runningBuild(store, state);
  if (running !== undefined) {
    deps.err(buildRunningMessage(nickname, running));
    return 1;
  }
  const items = stepName === undefined ? { messages: [], specs: [] } : await store.listResetItems(participantId);
  const appData = await store.listAppData(nickname);
  const live = await store.hasLiveMarker(nickname);
  // GitHub before any change: a missing secret or an unreachable GitHub stops the reset with nothing changed.
  const github = await deps.openGitHub();
  const repository = `${APPS_GITHUB_OWNER}/${appRepositoryName(nickname)}`;
  const repositoryExists = await github.exists(nickname);

  const conversation =
    stepName === undefined
      ? `${nickname} has not reached step 1 yet (no conversation)`
      : `${nickname} is at ${stepName}, with ${plural(items.messages.length, "message or reply", "messages and replies")} and ${plural(items.specs.length, "spec version", "spec versions")}`;
  if (!command.confirmed) {
    deps.out(`${conversation}.`);
    deps.out(`App: ${describeAppData(appData)}, live marker ${live ? "present" : "absent"}, repository ${repository} ${repositoryExists ? "exists" : "already gone"}.`);
    deps.out(`Nothing changed. Run again with --yes to delete all of this${stepName === undefined ? "" : ` and send ${nickname} back to step 1 (Clarify)`}, and to end ${nickname}'s sign-ins to save in apps.`);
    deps.out(KEPT);
    return 0;
  }

  // Order (decision "(2.13) Reset order"): the step change comes first, so no new build can start (it needs an
  // approved spec) while the live marker, the data and the repository go; a retry finds no conversation, restarts
  // again harmlessly and repeats each delete, all of which accept "already gone".
  if (stepName !== undefined) {
    if (!(await store.restart(participantId, state, deps.now().toISOString()))) {
      deps.err(`${nickname} sent a message meanwhile; nothing changed. Try again in a minute.`);
      return 1;
    }
    await store.deleteItems(participantId, [...items.messages, ...items.specs]);
    deps.out(
      `Reset ${nickname}: deleted ${plural(items.messages.length, "message or reply", "messages and replies")} and ${plural(items.specs.length, "spec version", "spec versions")}; back at step 1 (Clarify).`,
    );
  }
  // Ticket 3.24: the participant's app write tokens (for any app) stop working at once; their sessions are kept.
  const revoked = await store.revokeAppTokens(participantId);
  deps.out(`Ended ${plural(revoked, "sign-in to save in apps", "sign-ins to save in apps")} (app write tokens).`);
  // The live marker before the data: without it the data API answers 404 to every new request. A request that read the
  // marker just before it went can still commit its write after the first listing (the API does not re-check the
  // marker inside its transaction), so after a pause the data is listed and deleted once more; a write held up longer
  // than SETTLE_MS could still land afterwards (decision "(2.13) Reset order").
  const markerDeleted = await store.deleteLiveMarker(nickname);
  const firstPass = await store.listAppData(nickname);
  await store.deleteAppData(nickname, firstPass);
  await deps.sleep(SETTLE_MS);
  const secondPass = await store.listAppData(nickname);
  await store.deleteAppData(nickname, secondPass);
  const deletedData = [...new Set([...firstPass, ...secondPass])];
  deps.out(`Deleted ${describeAppData(deletedData)}; ${markerDeleted ? "deleted the live marker" : "the live marker was already gone"}.`);
  const removed = await github.remove(nickname);
  deps.out(removed ? `Repository ${repository} deleted.` : `Repository ${repository} was already gone.`);
  deps.out(KEPT);
  deps.out("The app's published files stay online until the next build's deploy replaces them.");
  deps.out(`${nickname} sees step 1 after reloading the page; the next approved spec builds into a new repository.`);
  return 0;
}

export async function runParticipant(args: readonly string[], deps: ParticipantDeps): Promise<number> {
  const parsed = parseParticipantArgs(args);
  if ("error" in parsed) {
    deps.err(`${parsed.error}\n\n${USAGE}`);
    return 1;
  }
  try {
    return await reset(parsed, deps, deps.createStore());
  } catch (error) {
    // A GitHubProblem's message is written to be shown (step and status, or what to load in the secret).
    const reason = error instanceof GitHubProblem ? `${errorName(error)}: ${error.message.replace(/\.$/, "")}` : errorName(error);
    deps.err(`Participant reset failed: ${reason}. Check your AWS credentials (AWS_PROFILE), the region and the GitHub secret.`);
    deps.err("Run the same command again: a reset that stopped part way finishes on the next run.");
    return 1;
  }
}
