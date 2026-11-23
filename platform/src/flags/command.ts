// `npm run flags -- list | approve <nickname> | reject <nickname>` (ticket 1.7): the stand-in for the
// phase 3 facilitator dashboard. The flow with its outside world passed in (store, queue, clock,
// output), so it is tested against in-memory fakes; ./main.ts wires in the real ones. `list` prints,
// on the owner's own terminal only, each waiting nickname with the flagged message's text and the
// guardrail's reason, so a decision is never blind; nothing prints an email address or an id.
import { declineReply } from "../../api/conversation/guardrail.js";
import type { MessageQueue } from "../../api/conversation/state.js";
import { redactError } from "../smoke/logic.js";
import type { FlagsStore } from "./store.js";

export const USAGE = `Usage: npm run flags -- <command>

Commands:
  list                 the nicknames whose last message waits for a decision, with that message
                       and the guardrail's reason
  approve <nickname>   let the waiting message through: the AI answers it (no new guardrail check)
  reject <nickname>    decline the waiting message with a polite sentence; the participant can write again

Runs with your own AWS credentials (AWS_PROFILE).`;

export type FlagsCommand = { command: "list" } | { command: "approve" | "reject"; nickname: string };

/** Nicknames are 3 to 20 letters, digits or dashes (the API's rule); anything else is refused unread. */
const NICKNAME = /^[A-Za-z0-9-]{3,20}$/;

export function parseFlagsArgs(args: readonly string[]): FlagsCommand | { error: string } {
  const [command, ...rest] = args;
  switch (command) {
    case "list":
      return rest.length === 0 ? { command } : { error: "list takes no arguments" };
    case "approve":
    case "reject": {
      const [nickname, ...extra] = rest;
      if (nickname === undefined) return { error: `${command} needs a nickname` };
      if (extra.length > 0) return { error: `${command} takes exactly one nickname` };
      if (!NICKNAME.test(nickname.trim())) return { error: "that is not a nickname (3 to 20 letters, digits or dashes)" };
      return { command, nickname: nickname.trim() };
    }
    case undefined:
      return { error: "no command given" };
    default:
      return { error: "unknown command" };
  }
}

export interface FlagsDeps {
  /** Called only once the arguments are accepted, so a usage error makes no AWS call. */
  createStore: () => FlagsStore;
  createQueue: () => MessageQueue;
  now: () => Date;
  out: (line: string) => void;
  err: (line: string) => void;
}

/** Text typed by a participant, made safe for a terminal: control and format characters (escape sequences, line breaks, direction overrides) become spaces. */
export function terminalSafe(text: string): string {
  return text.replace(/[\p{Cc}\p{Cf}]/gu, " ");
}

async function list(store: FlagsStore, out: (line: string) => void): Promise<number> {
  const ids = await store.listWaiting();
  const waiting = await Promise.all(
    ids.map(async (id) => {
      const nickname = (await store.getNickname(id)) ?? "(no nickname)";
      const pendingId = (await store.getConversation(id))?.pendingId;
      const message = pendingId === undefined ? undefined : await store.getMessage(id, pendingId);
      return { nickname, text: message?.text ?? "(message not found)", reason: message?.verdictReason ?? "(no reason given)" };
    }),
  );
  out(`Waiting for a decision: ${waiting.length}`);
  for (const w of waiting.sort((a, b) => a.nickname.localeCompare(b.nickname))) {
    out("");
    out(w.nickname);
    out(`  Message: ${terminalSafe(w.text)}`);
    out(`  Flagged because: ${terminalSafe(w.reason)}`);
  }
  return 0;
}

async function decide(command: "approve" | "reject", nickname: string, deps: FlagsDeps, store: FlagsStore): Promise<number> {
  const participantId = await store.findParticipantId(nickname);
  if (participantId === undefined) {
    deps.err(`No participant has the nickname ${nickname}.`);
    return 1;
  }
  const conversation = await store.getConversation(participantId);
  const messageId = conversation?.pendingId;
  const message = conversation?.state === "waiting" && messageId !== undefined ? await store.getMessage(participantId, messageId) : undefined;
  if (messageId === undefined || message?.status !== "flagged") {
    deps.err(`${nickname} has no message waiting for a decision.`);
    return 1;
  }
  const now = deps.now();
  if (command === "reject") {
    const done = await store.finish(participantId, messageId, { kind: "declined", reply: declineReply(message.suggestion) }, "flagged", now.toISOString());
    if (!done) {
      deps.err(`${nickname}'s message was decided meanwhile; nothing changed.`);
      return 1;
    }
    deps.out(`Rejected: ${nickname}'s message got a polite decline, and ${nickname} can write again.`);
    return 0;
  }
  const approved = await store.approve(participantId, messageId, message.text, Math.floor(now.getTime() / 1000), now.toISOString());
  if (!approved) {
    deps.err(`${nickname}'s message was decided meanwhile; nothing changed.`);
    return 1;
  }
  try {
    await deps.createQueue().send({ participantId, messageId });
  } catch (error) {
    deps.err(`Approved, but the queue refused the message (${redactError(errorText(error))}).`);
    deps.err(`${nickname} sees it fail within 20 minutes and can send it again.`);
    return 1;
  }
  deps.out(`Approved: ${nickname}'s message goes to the AI now; the answer appears on their page.`);
  return 0;
}

function errorText(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

export async function runFlags(args: readonly string[], deps: FlagsDeps): Promise<number> {
  const parsed = parseFlagsArgs(args);
  if ("error" in parsed) {
    deps.err(`${parsed.error}\n\n${USAGE}`);
    return 1;
  }
  try {
    const store = deps.createStore();
    return parsed.command === "list" ? await list(store, deps.out) : await decide(parsed.command, parsed.nickname, deps, store);
  } catch (error) {
    deps.err(`Flags command failed: ${redactError(errorText(error))}`);
    return 1;
  }
}
