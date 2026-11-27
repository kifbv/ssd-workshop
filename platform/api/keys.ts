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

/** When codes were sent to this email in the last hour (rate limit, ticket 1.4). */
export const codeRequestsKey = (email: string): ItemKey => ({ pk: emailPk(email), sk: "CODE_REQUESTS" });

export const sessionKey = (tokenHash: string): ItemKey => ({
  pk: `SESSION#${checkId("token hash", tokenHash)}`,
  sk: "SESSION",
});

export const participantKey = (participantId: string): ItemKey => ({ pk: participantPk(participantId), sk: "PROFILE" });

export const messageKey = (participantId: string, messageId: string): ItemKey => ({
  pk: participantPk(participantId),
  sk: `${MESSAGE_PREFIX}${checkId("message id", messageId)}`,
});

/**
 * The claim on a nickname (ticket 1.5): keyed by the lower-cased nickname, so `Ada` and `ada`
 * collide. Written together with the profile's nickname, only if absent.
 */
export const nicknameKey = (nickname: string): ItemKey => ({
  pk: `NICK#${checkId("nickname", nickname).toLowerCase()}`,
  sk: "NICK",
});

/**
 * An app's live marker (ticket 2.4): present once the deployer (ticket 2.5) has published the app at
 * `/apps/<nickname>/`. Keyed by the lower-cased nickname, like the claim. The data API answers 404
 * without it. Its partition (`APP#`) is not the data's (`APPDATA#`), so the data API's role, which
 * may write only in `APPDATA#*`, can never make an app live or take it off.
 */
export const appLiveKey = (nickname: string): ItemKey => ({
  pk: `APP#${checkId("nickname", nickname).toLowerCase()}`,
  sk: "LIVE",
});

/**
 * One build of an app (ticket 2.5; ticket 2.7 creates them): its status and the deployer's outcome. Its own
 * partition (`BUILD#`), so the `APP#` partition keeps only the live marker (the data API's role reads all
 * of `APP#*`). The id is chosen by its creator: 1 to 64 letters, digits, dashes or underscores.
 */
export const BUILD_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
/**
 * One launch of a build (ticket 2.9 try 2): a random UUID the launcher's claim stores on the build (`attemptId`) and
 * passes to the task it starts; the runner's writes hold only under it, so a second runner for the build is refused.
 */
export const ATTEMPT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function buildKey(buildId: string): ItemKey {
  if (!BUILD_ID_PATTERN.test(buildId)) throw new Error("build id is not 1 to 64 letters, digits, dashes or underscores");
  return { pk: `BUILD#${buildId}`, sk: "BUILD" };
}

/**
 * The launcher's watch list (ticket 2.9): one item per build it claimed and has not seen finish, at `LAUNCHES` /
 * `BUILD#<build id>`, holding the build's task once started. The stuck-build check reads this one partition (no scan).
 * Its partition key is not `BUILD#...` (IAM's `BUILD#*` never matches `LAUNCHES`), so the builder's task role cannot
 * touch it.
 */
export const LAUNCHES_PK = "LAUNCHES";

export function launchKey(buildId: string): ItemKey {
  return { pk: LAUNCHES_PK, sk: buildKey(buildId).pk };
}

/**
 * Build slots (ticket 3.4): one partition `BUILD_SLOTS` with the counter `COUNT` (`running`, `version`) and one holder
 * item per build holding a slot (`BUILD#<id>`). The launcher's claim adds a holder and counts it up in one transaction
 * (only while `running` is under the cap); every terminal write then removes the holder and counts down in one
 * transaction, so a slot is freed exactly once. Not `BUILD#...` (IAM's `BUILD#*` never matches it).
 */
export const BUILD_SLOTS_PK = "BUILD_SLOTS";
export const slotCountKey = (): ItemKey => ({ pk: BUILD_SLOTS_PK, sk: "COUNT" });
export const slotHolderKey = (buildId: string): ItemKey => ({ pk: BUILD_SLOTS_PK, sk: buildKey(buildId).pk });

/**
 * The waiting line (ticket 3.4): one entry per queued build the launcher has seen, at `BUILD_QUEUE` / its `queueKey`
 * (`<ISO time first seen>#<build id>`, so the sort key orders the line). "Builds ahead" counts the entries before it.
 */
export const BUILD_QUEUE_PK = "BUILD_QUEUE";
export const queueEntryKey = (queueKey: string): ItemKey => ({ pk: BUILD_QUEUE_PK, sk: queueKey });
export const newQueueKey = (nowIso: string, buildId: string): string => `${nowIso}#${buildId}`;

/**
 * Retry requests (ticket 3.10): one item per build a facilitator asked to retry, at `BUILD_RETRIES` / `BUILD#<id>`. Only
 * the facilitator function puts them; the launcher's minute check (the one role that may stop a build task and launch
 * a build) acts on them and deletes them. Not `BUILD#...` (IAM's `BUILD#*` never matches it).
 */
export const BUILD_RETRIES_PK = "BUILD_RETRIES";
export const retryRequestKey = (buildId: string): ItemKey => ({ pk: BUILD_RETRIES_PK, sk: buildKey(buildId).pk });

/** Prefix of every stored value's sort key in an app's data partition (ticket 2.4). */
export const APP_DATA_PREFIX = "DATA#";

const appDataPk = (nickname: string): string => `APPDATA#${checkId("nickname", nickname).toLowerCase()}`;

/** One JSON value an app keeps (ticket 2.4), at `APPDATA#<nickname>` / `DATA#<key>`. */
export const appDataKey = (nickname: string, key: string): ItemKey => ({
  pk: appDataPk(nickname),
  sk: `${APP_DATA_PREFIX}${checkId("data key", key)}`,
});

/** The running totals of an app's data (ticket 2.4): bytes and keys, written with every value. */
export const appDataUsageKey = (nickname: string): ItemKey => ({ pk: appDataPk(nickname), sk: "DATA_USAGE" });

/** Prefix of every photo's or recording's sort key in an app's media partition (ticket 3.18). */
export const APP_MEDIA_PREFIX = "MEDIA#";

/**
 * An app's media records (ticket 3.18): `APPMEDIA#<lower-cased nickname>`. Its own prefix: IAM's `APP#*` never matches
 * `APPMEDIA#...` (the character after `APP` is `M`), nor `APPDATA#*` or `APPTOKEN#*`, so the media function's role
 * cannot touch the live marker, the data or the tokens, and the data function's cannot touch the media.
 */
const appMediaPk = (nickname: string): string => `APPMEDIA#${checkId("nickname", nickname).toLowerCase()}`;

/** One stored photo or recording (ticket 3.18), at `APPMEDIA#<nickname>` / `MEDIA#<id>`: its size, type and state. */
export const appMediaKey = (nickname: string, id: string): ItemKey => ({ pk: appMediaPk(nickname), sk: `${APP_MEDIA_PREFIX}${checkId("media id", id)}` });

/** The running totals of an app's media (ticket 3.18): bytes, files and the day's uploads. */
export const appMediaUsageKey = (nickname: string): ItemKey => ({ pk: appMediaPk(nickname), sk: "MEDIA_USAGE" });

/**
 * An app's AI spend for the UTC day (ticket 3.21): `APPAI#<lower-cased nickname>` / `AI_USAGE` (day, costUsd). Its own
 * prefix: IAM's `APP#*`, `APPDATA#*`, `APPMEDIA#*` and `APPTOKEN#*` never match `APPAI#...`, so only the AI function's
 * role may move it.
 */
export const appAiUsageKey = (nickname: string): ItemKey => ({ pk: `APPAI#${checkId("nickname", nickname).toLowerCase()}`, sk: "AI_USAGE" });

/**
 * A signed-in writer's AI spend for the UTC day across all apps (ticket 3.21 try 2): `APPAI_WRITER#<lower-cased writer
 * nickname>` / `AI_USAGE` (day, costUsd). `APPAI#*` never matches it (the character after `APPAI` is `_`), nor does
 * `APPAI_TOTAL`.
 */
export const appAiWriterKey = (writer: string): ItemKey => ({ pk: `APPAI_WRITER#${checkId("writer nickname", writer).toLowerCase()}`, sk: "AI_USAGE" });

/** All apps' AI spend for the UTC day (ticket 3.21): `APPAI_TOTAL` / `AI_USAGE`, which `APPAI#*` does not match. */
export const appAiTotalKey = (): ItemKey => ({ pk: "APPAI_TOTAL", sk: "AI_USAGE" });

/**
 * An edit link's lookup item (ticket 3.26; 3.24's app write tokens used the same key), by the SHA-256 (hex) of the
 * secret: `APPTOKEN#<hash>` / `TOKEN`. Its own partition prefix: IAM's `APP#*` and `APPDATA#*` never match
 * `APPTOKEN#...` (the character after `APP` is `T`), nor `APPEDIT#*`.
 */
export const appTokenKey = (tokenHash: string): ItemKey => {
  if (!/^[0-9a-f]{64}$/.test(tokenHash)) throw new Error("token hash is not 64 hex digits");
  return { pk: `APPTOKEN#${tokenHash}`, sk: "TOKEN" };
};

/**
 * An app's edit link (ticket 3.26): `APPEDIT#<lower-cased nickname>` / `EDIT`, holding the secret (so step 4 can show it
 * again), its hash and the builder's nickname. Its own prefix: `APP#*`, `APPDATA#*`, `APPMEDIA#*`, `APPAI#*` and
 * `APPTOKEN#*` never match `APPEDIT#...`, so only a role granted `APPEDIT#*` (the conversation function) reads it.
 */
export const appEditKey = (nickname: string): ItemKey => ({ pk: `APPEDIT#${checkId("nickname", nickname).toLowerCase()}`, sk: "EDIT" });

/**
 * The workshop's settings (ticket 3.2): one item, `SETTINGS` / `SETTINGS`, holding the admin's caps and the global
 * Stop. Its own partition, so only a role granted `SETTINGS` (the admin function's) may write it.
 */
export const SETTINGS_PK = "SETTINGS";
export const settingsKey = (): ItemKey => ({ pk: SETTINGS_PK, sk: "SETTINGS" });

/** A new participant id: a random UUID (never holds the key separator). */
export function newParticipantId(randomUUID: () => string): string {
  return checkId("participant id", randomUUID());
}

export const usageKey = (participantId: string): ItemKey => ({ pk: participantPk(participantId), sk: "USAGE" });

/** The state of a participant's conversation (ticket 1.7): open or waiting, and the message in flight. */
export const conversationKey = (participantId: string): ItemKey => ({ pk: participantPk(participantId), sk: "CONVERSATION" });

/** The id of the assistant's reply to a participant message: sorts right after it, before the next one. */
export const replyId = (messageId: string): string => `${checkId("message id", messageId)}${REPLY_SUFFIX}`;
export const REPLY_SUFFIX = "-r";

/** Prefix of every spec version's sort key (ticket 1.9): `SPEC#0001`, `SPEC#0002`, ... */
export const SPEC_PREFIX = "SPEC#";
/** Spec versions are numbered 1 to MAX_SPEC_VERSION (4 digits, so the keys sort by version). */
export const MAX_SPEC_VERSION = 9999;

/** One version of a participant's spec (ticket 1.9): every version is kept, the newest sorts last. */
export function specKey(participantId: string, version: number): ItemKey {
  if (!Number.isInteger(version) || version < 1 || version > MAX_SPEC_VERSION) throw new Error("spec version out of range");
  return { pk: participantPk(participantId), sk: `${SPEC_PREFIX}${String(version).padStart(4, "0")}` };
}

/** A participant message id: an ISO time (UTC, milliseconds), a dash and 16 lower-case hex digits. */
export const MESSAGE_ID_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z-[0-9a-f]{16}$/;

/**
 * A new message id that sorts by time: the ISO creation time, a dash and 16 random hex digits
 * (from a cryptographic source such as `crypto.randomBytes`), so ids made in the same millisecond
 * still differ.
 */
export function newMessageId(now: Date, randomBytes: (size: number) => Buffer): string {
  const random = randomBytes(8);
  if (random.length !== 8) throw new Error("random source gave the wrong length");
  return `${now.toISOString()}-${random.toString("hex")}`;
}
