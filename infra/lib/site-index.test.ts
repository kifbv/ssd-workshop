import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SITE_INDEX_FUNCTION_FILE } from "./edge-stack.js";

interface Request {
  uri: string;
  querystring: Record<string, { value: string; multiValue?: { value: string }[] }>;
}
type Answer = Request | { statusCode: number; statusDescription: string; headers: { location: { value: string } } };

// The function as CloudFront runs it: the file's code, its `handler` called with a viewer request event.
const code = readFileSync(SITE_INDEX_FUNCTION_FILE, "utf8");
const handler = new Function(`${code}\nreturn handler;`)() as (event: { request: Request }) => Answer;
const run = (uri: string, querystring: Request["querystring"] = {}): Answer => handler({ request: { uri, querystring } });

describe("CloudFront Function ssd-workshop-site-index (ticket 3.11)", () => {
  it("asks for the dashboard's index.html at /facilitator/", () => {
    expect(run("/facilitator/")).toMatchObject({ uri: "/facilitator/index.html" });
  });

  it("passes the dashboard's script and any other file unchanged", () => {
    expect(run("/facilitator/dashboard.js")).toMatchObject({ uri: "/facilitator/dashboard.js" });
    expect(run("/facilitator/index.html")).toMatchObject({ uri: "/facilitator/index.html" });
    expect(run("/facilitators")).toMatchObject({ uri: "/facilitators" });
  });

  it("redirects /facilitator without a slash to /facilitator/ (301), keeping the query", () => {
    expect(run("/facilitator")).toEqual({ statusCode: 301, statusDescription: "Moved Permanently", headers: { location: { value: "/facilitator/" } } });
    expect(run("/facilitator", { group: { value: "g1" }, flag: { value: "" } })).toMatchObject({
      statusCode: 301,
      headers: { location: { value: "/facilitator/?group=g1&flag" } },
    });
  });

  it("stays small (CloudFront Functions take at most 10 KB of code)", () => {
    expect(Buffer.byteLength(code)).toBeLessThan(10 * 1024);
  });
});
