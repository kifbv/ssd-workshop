import { NodeHttpHandler } from "@smithy/node-http-handler";
import { REGION } from "./settings.js";

/**
 * Bounded SDK calls for the API functions: 2 attempts, 1 s to connect, 1.5 s per request, so a
 * slow table or SES call fails well inside a fixed answer time (3 s) and the 10-second Lambda
 * timeout is never reached. Lambda needs no proxy, so no httpsAgent (unlike the scripts run from
 * a session).
 */
export const HTTP_TIMEOUTS = { connectionTimeout: 1000, requestTimeout: 1500 } as const;

export function clientSettings(): { region: string; maxAttempts: number; requestHandler: NodeHttpHandler } {
  return { region: REGION, maxAttempts: 2, requestHandler: new NodeHttpHandler({ ...HTTP_TIMEOUTS }) };
}
