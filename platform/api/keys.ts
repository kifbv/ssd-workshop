/**
 * Key builders for the single table `ssd-workshop-data` (see types.ts for the
 * scheme). Every key goes through here, so ids and emails are checked once.
 * Errors never include the email address (personal data).
 */

export interface ItemKey {
  pk: string;
  sk: string;
}

const SEPARATOR = "#";

/** Prefix of every conversation message's sort key: `begins_with(sk, MESSAGE_PREFIX)`. */
export const MESSAGE_PREFIX = "MSG#";

/** The form an email is stored and looked up in: trimmed and lower-cased. */
export function normalizeEmail(email: string): string {
  const normalized = email.trim().toLowerCase();
  if (normalized === "") throw new Error("email is empty");
  if (normalized.includes(SEPARATOR)) throw new Error("email holds the key separator #");
  return normalized;
}

function checkId(kind: string, id: string): string {
  if (id === "") throw new Error(`${kind} is empty`);
  if (id.includes(SEPARATOR)) throw new Error(`${kind} holds the key separator #`);
  return id;
}

const emailPk = (email: string): string => `EMAIL#${normalizeEmail(email)}`;
const participantPk = (participantId: string): string => `PARTICIPANT#${checkId("participant id", participantId)}`;

export const allowListKey = (email: string): ItemKey => ({ pk: emailPk(email), sk: "ALLOW" });

export const codeKey = (email: string): ItemKey => ({ pk: emailPk(email), sk: "CODE" });

export const sessionKey = (tokenHash: string): ItemKey => ({
  pk: `SESSION#${checkId("token hash", tokenHash)}`,
  sk: "SESSION",
});

export const participantKey = (participantId: string): ItemKey => ({ pk: participantPk(participantId), sk: "PROFILE" });

export const messageKey = (participantId: string, messageId: string): ItemKey => ({
  pk: participantPk(participantId),
  sk: `${MESSAGE_PREFIX}${checkId("message id", messageId)}`,
});

export const usageKey = (participantId: string): ItemKey => ({ pk: participantPk(participantId), sk: "USAGE" });
