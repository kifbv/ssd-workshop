// `npm run conversation -- reset <nickname> [--yes]`: start a participant's conversation over, for
// tests and dry runs. Without --yes it only says what it would delete. Run from your own machine with
// your own AWS credentials (AWS_PROFILE). The flow lives here with its outside world passed in, so it
// is tested against in-memory fakes; ./main.ts wires in the real ones. Nothing it prints holds a
// message text, an id or an email address (an error shows only its name).
import { STALE_PENDING_SECONDS } from "../../api/conversation/state.js";
import type { ResetStore } from "./store.js";

export const USAGE = `Usage: npm run conversation -- reset <nickname> [--yes]

  reset <nickname>         show what a reset would delete; changes nothing
  reset <nickname> --yes   delete the participant's messages, the AI's replies and every spec version,
                           and send them back to step 1 (Clarify); their AI usage totals and any build
                           record are kept

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

const STEP_NAMES: Record<string, string> = {
  clarify: "step 1 (Clarify)",
  spec: "step 2 (Spec)",
  approved: "step 2 (Spec, approved)",
  building: "step 3 (Build)",
};
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

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
  const nowSeconds = Math.floor(deps.now().getTime() / 1000);
  const answering =
    state.pendingId !== undefined && state.state !== "waiting" && nowSeconds - (state.pendingSince ?? 0) <= STALE_PENDING_SECONDS;
  if (answering) {
    deps.err(`The AI is still answering ${nickname}'s last message; try again in a minute (after a crash, up to 20 minutes). Nothing changed.`);
    return 1;
  }
  const items = await store.listResetItems(participantId);
  const found = `${plural(items.messages.length, "message or reply", "messages and replies")} and ${plural(items.specs.length, "spec version", "spec versions")}`;
  if (!command.confirmed) {
    deps.out(`${nickname} is at ${stepName}, with ${found}.`);
    deps.out(`Nothing changed. Run again with --yes to delete them and send ${nickname} back to step 1 (Clarify); their AI usage totals are kept.`);
    return 0;
  }
  if (!(await store.restart(participantId, state))) {
    deps.err(`${nickname} sent a message meanwhile; nothing changed. Try again in a minute.`);
    return 1;
  }
  await store.deleteItems(participantId, [...items.messages, ...items.specs]);
  deps.out(`Reset ${nickname}: deleted ${found}; back at step 1 (Clarify). AI usage totals kept.`);
  // Ticket 2.7: the build record is not the conversation's; it stays (the launcher acts on it only while it is
  // queued). The next approved spec makes a new build, and the repository is reused (ticket 2.6).
  if (step === "building") deps.out(`${nickname}'s earlier build stays on record; a new approved spec starts a new build.`);
  deps.out(`${nickname} sees an empty conversation after reloading the page.`);
  return 0;
}

/** Only the error's name: an AWS error message can quote a key (a participant id) or an item. */
function errorName(error: unknown): string {
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
