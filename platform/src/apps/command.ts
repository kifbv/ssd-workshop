// `npm run apps -- refresh` (ticket 3.25, question 10): asks the deployer to put the platform's current
// workshop-data.js into every live app, so apps built before saving needed the workshop's sign-in (3.24) save with it.
// Run once by Franck right after deploying 3.25, from his machine with his own AWS credentials (`AWS_PROFILE=franck`):
// Claude sessions may neither read table items nor send to the deploy queue (access stack). Only the deployer may write
// app files (bucket policy `OnlyTheDeployerWritesApps`), so this command sends one `{"refresh": "<nickname>"}` message
// per live app to the deploy queue, in the app's message group (after any deploy of that app already queued); the
// deployer does the rest (platform/api/deploy/deploy.ts). The flow lives here with its outside world passed in, so it
// is tested against in-memory fakes; ./main.ts wires in the real ones. It prints nicknames and counts only: never an
// email address.

export const USAGE = `Usage: npm run apps -- refresh

  refresh   republish the platform's current workshop-data.js in every live app (the deployer puts the file and
            clears CloudFront's copy within a minute); safe to run again

Runs with your own AWS credentials (AWS_PROFILE=franck).`;

export type AppsCommand = { command: "refresh" };

export function parseAppsArgs(args: readonly string[]): AppsCommand | { error: string } {
  const [command, ...rest] = args;
  if (command === undefined) return { error: "no command given" };
  if (command !== "refresh") return { error: "unknown command" };
  return rest.length === 0 ? { command } : { error: "refresh takes no arguments" };
}

/** Nicknames are 3 to 20 letters, digits or dashes (the API's rule); anything else in the table is skipped. */
const NICKNAME = /^[A-Za-z0-9-]{3,20}$/;

export interface LiveApps {
  /** The nickname on every app's live marker (`APP#<nickname>` / `LIVE`, written by the deployer). */
  listLiveApps(): Promise<string[]>;
}

export interface RefreshQueue {
  /** `{"refresh": nickname}` to the deploy queue, in the app's message group (lower-cased nickname). */
  send(nickname: string, deduplicationId: string): Promise<void>;
}

export interface AppsDeps {
  /** Called only once the arguments are accepted, so a usage error makes no AWS call. */
  connect: () => { apps: LiveApps; queue: RefreshQueue };
  now: () => Date;
  out: (line: string) => void;
  err: (line: string) => void;
}

const nameOf = (error: unknown): string => (error instanceof Error ? error.name : "Error");

async function refresh(deps: AppsDeps, world: ReturnType<AppsDeps["connect"]>): Promise<number> {
  // One message per app, whatever letter case its marker holds.
  const byKey = new Map<string, string>();
  for (const nickname of await world.apps.listLiveApps()) {
    if (NICKNAME.test(nickname) && !byKey.has(nickname.toLowerCase())) byKey.set(nickname.toLowerCase(), nickname);
  }
  const apps = [...byKey.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  if (apps.length === 0) {
    deps.out("No live apps: nothing to refresh.");
    return 0;
  }
  const stamp = String(deps.now().getTime());
  const failed: string[] = [];
  for (const [key, nickname] of apps) {
    try {
      // Its own deduplication id: SQS drops a second message with the same id within 5 minutes.
      await world.queue.send(nickname, `refresh-${key}-${stamp}`);
      deps.out(`${nickname}: refresh queued`);
    } catch (error) {
      failed.push(nickname);
      deps.err(`${nickname}: the refresh message could not be sent (${nameOf(error)})`);
    }
  }
  const sent = apps.length - failed.length;
  deps.out(`Asked the deployer to refresh ${sent} of ${apps.length} live ${apps.length === 1 ? "app" : "apps"}; each gets the platform's workshop-data.js within a minute.`);
  if (failed.length > 0) {
    deps.err(`Run the command again for the ${failed.length === 1 ? "app" : "apps"} that failed (it is safe to repeat).`);
    return 1;
  }
  return 0;
}

export async function runApps(args: readonly string[], deps: AppsDeps): Promise<number> {
  const parsed = parseAppsArgs(args);
  if ("error" in parsed) {
    deps.err(`${parsed.error}\n\n${USAGE}`);
    return 2;
  }
  try {
    return await refresh(deps, deps.connect());
  } catch (error) {
    deps.err(`The command failed (${nameOf(error)}). Check your AWS credentials (AWS_PROFILE=franck).`);
    return 1;
  }
}
