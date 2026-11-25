// `npm run conversation -- reset <nickname> [--yes]`: start a participant's conversation over, for
// tests and dry runs. Without --yes it only says what it would delete. Run from your own machine with
// your own AWS credentials (AWS_PROFILE). The flow lives here with its outside world passed in, so it
// is tested against in-memory fakes; ./main.ts wires in the real ones. Nothing it prints holds a
// message text, an id or an email address (an error shows only its name).
import { STALE_PENDING_SECONDS } from "../../api/conversation/state.js";
import type { ResetState, ResetStore } from "./store.js";

export const USAGE = `Usage: npm run conversation -- reset <nickname> [--yes]

  reset <nickname>         show what a reset would delete; changes nothing
  reset <nickname> --yes   delete the participant's messages, the AI's replies and every spec version,
                           and send them back to step 1 (Clarify); their AI usage totals and any build
                           record are kept

It refuses while the AI is answering or while the participant's build is queued, building or deploying.
To also delete the app's data, its live marker and its GitHub repository: npm run participant -- reset <nickname>

Runs with your own AWS credentials (AWS_PROFILE).`;

export interface ResetCommand {
  command: "reset";
  nickname: string;
  confirmed: boolean;
}

/** Nicknames are 3 to 20 letters, digits or dashes (the API's rule); anything else is refused unread. */
const NICKNAME = /^[A-Za-z0-9-]{3,20}$/;

export function parseConversationArgs(args: readonly string[]): ResetCommand | { error: string } {
  const [command, ...rest] = args;
  if (command === undefined) return { error: "no command given" };
  if (command !== "reset") return { error: "unknown command" };
  const confirmed = rest.includes("--yes");
  const others = rest.filter((a) => a !== "--yes");
  const [nickname, ...extra] = others;
  if (nickname === undefined) return { error: "reset needs a nickname" };
  if (extra.length > 0 || rest.length - others.length > 1) return { error: "reset takes one nickname and, to confirm, --yes" };
  if (!NICKNAME.test(nickname.trim())) return { error: "that is not a nickname (3 to 20 letters, digits or dashes)" };
  return { command, nickname: nickname.trim(), confirmed };
}

export interface ConversationDeps {
  /** Called only once the arguments are accepted, so a usage error makes no AWS call. */
  createStore: () => ResetStore;
  now: () => Date;
  out: (line: string) => void;
  err: (line: string) => void;
}

export const STEP_NAMES: Record<string, string> = {
  clarify: "step 1 (Clarify)",
  spec: "step 2 (Spec)",
  approved: "step 2 (Spec, approved)",
  building: "step 3 (Build)",
};
export const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * True while the AI is answering (a message pending for at most STALE_PENDING_SECONDS; a flagged message waiting for
 * a facilitator is not being answered): a reset then refuses, as the worker would write into the reset conversation.
 */
export function aiAnswering(state: ResetState, now: Date): boolean {
  const nowSeconds = Math.floor(now.getTime() / 1000);
  return state.pendingId !== undefined && state.state !== "waiting" && nowSeconds - (state.pendingSince ?? 0) <= STALE_PENDING_SECONDS;
}

/** Build statuses during which a reset would pull the conversation, the repository or the data from under a running build. */
export const RUNNING_BUILD: ReadonlySet<string> = new Set(["queued", "building", "deploying"]);

/**
 * The status of the build the conversation links to (`buildId`, ticket 2.7) when that build is still running, else
 * undefined. Both resets refuse then (decision "(2.13) Running build found through the build link"): deleting the
 * conversation item would drop the link while the build goes on to recreate the repository and the live marker, so a
 * later full reset would no longer see it. A link to a missing build record does not block.
 */
export async function runningBuild(store: ResetStore, state: ResetState): Promise<string | undefined> {
  if (state.buildId === undefined) return undefined;
  const status = await store.getBuildStatus(state.buildId);
  return status !== undefined && RUNNING_BUILD.has(status) ? status : undefined;
}

export const buildRunningMessage = (nickname: string, status: string) => `${nickname}'s build is ${status}; try again once it is live or failed. Nothing changed.`;

async function reset(command: ResetCommand, deps: ConversationDeps, store: ResetStore): Promise<number> {
  const { nickname } = command;
  const participantId = await store.findParticipantId(nickname);
  if (participantId === undefined) {
    deps.err(`No participant has the nickname ${nickname}.`);
    return 1;
  }
  const step = await store.getStep(participantId);
  const stepName = step === undefined ? undefined : STEP_NAMES[step];
  if (stepName === undefined) {
    deps.err(`${nickname} has not reached step 1 yet; there is nothing to reset.`);
    return 1;
  }
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
  const items = await store.listResetItems(participantId);
  const found = `${plural(items.messages.length, "message or reply", "messages and replies")} and ${plural(items.specs.length, "spec version", "spec versions")}`;
  if (!command.confirmed) {
    deps.out(`${nickname} is at ${stepName}, with ${found}.`);
    deps.out(`Nothing changed. Run again with --yes to delete them and send ${nickname} back to step 1 (Clarify); their AI usage totals are kept.`);
    return 0;
  }
  if (!(await store.restart(participantId, state, deps.now().toISOString()))) {
    deps.err(`${nickname} sent a message meanwhile; nothing changed. Try again in a minute.`);
    return 1;
  }
  await store.deleteItems(participantId, [...items.messages, ...items.specs]);
  deps.out(`Reset ${nickname}: deleted ${found}; back at step 1 (Clarify). AI usage totals kept.`);
  // Ticket 2.7: the build record is not the conversation's; it stays (it is live or failed: a running build refused the
  // reset above). The next approved spec makes a new build, and the repository is reused (ticket 2.6).
  if (step === "building") deps.out(`${nickname}'s earlier build stays on record; a new approved spec starts a new build.`);
  deps.out(`${nickname} sees an empty conversation after reloading the page.`);
  return 0;
}

/** Only the error's name: an AWS error message can quote a key (a participant id) or an item. */
export function errorName(error: unknown): string {
  return error instanceof Error && /^[A-Za-z][A-Za-z0-9]*$/.test(error.name) ? error.name : "Error";
}

export async function runConversation(args: readonly string[], deps: ConversationDeps): Promise<number> {
  const parsed = parseConversationArgs(args);
  if ("error" in parsed) {
    deps.err(`${parsed.error}\n\n${USAGE}`);
    return 1;
  }
  try {
    return await reset(parsed, deps, deps.createStore());
  } catch (error) {
    deps.err(`Conversation command failed: ${errorName(error)}. Check your AWS credentials (AWS_PROFILE) and the region.`);
    deps.err("Run the same command again: a reset that stopped part way finishes on the next run.");
    return 1;
  }
}
