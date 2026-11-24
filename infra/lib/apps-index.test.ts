import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { APPS_INDEX_FUNCTION_FILE } from "./edge-stack.js";

interface Request {
  uri: string;
  querystring: Record<string, { value: string; multiValue?: { value: string }[] }>;
}
type Answer = Request | { statusCode: number; statusDescription: string; headers: { location: { value: string } } };

// The function as CloudFront runs it: the file's code, its `handler` called with a viewer request event.
const code = readFileSync(APPS_INDEX_FUNCTION_FILE, "utf8");
const handler = new Function(`${code}\nreturn handler;`)() as (event: { request: Request }) => Answer;
const run = (uri: string, querystring: Request["querystring"] = {}): Answer => handler({ request: { uri, querystring } });

describe("CloudFront Function ssd-workshop-apps-index (ticket 2.5)", () => {
  it("asks for index.html in a folder: /apps/<nickname>/ and any sub-folder", () => {
    expect(run("/apps/ada/")).toMatchObject({ uri: "/apps/ada/index.html" });
    expect(run("/apps/ada/games/")).toMatchObject({ uri: "/apps/ada/games/index.html" });
  });

  it("passes a file's path unchanged, letter case included", () => {
    expect(run("/apps/ada/app.js")).toMatchObject({ uri: "/apps/ada/app.js" });
    expect(run("/apps/ada/img/Logo.PNG")).toMatchObject({ uri: "/apps/ada/img/Logo.PNG" });
  });

  it("redirects /apps/<nickname> without a slash to /apps/<nickname>/ (301), keeping the query", () => {
    expect(run("/apps/ada")).toEqual({ statusCode: 301, statusDescription: "Moved Permanently", headers: { location: { value: "/apps/ada/" } } });
    expect(run("/apps/ada", { x: { value: "1" }, tag: { value: "a", multiValue: [{ value: "a" }, { value: "b" }] }, flag: { value: "" } })).toMatchObject({
      statusCode: 301,
      headers: { location: { value: "/apps/ada/?x=1&tag=a&tag=b&flag" } },
    });
  });

  it("redirects a nickname with upper-case letters to its lower-case address, keeping the rest of the path", () => {
    expect(run("/apps/Ada-42/")).toMatchObject({ statusCode: 301, headers: { location: { value: "/apps/ada-42/" } } });
    expect(run("/apps/ADA/img/Logo.PNG")).toMatchObject({ statusCode: 301, headers: { location: { value: "/apps/ada/img/Logo.PNG" } } });
    expect(run("/apps/Ada")).toMatchObject({ statusCode: 301, headers: { location: { value: "/apps/ada/" } } });
  });

  it("leaves anything else to the bucket (a missing key becomes the 404 page)", () => {
    expect(run("/apps/")).toMatchObject({ uri: "/apps/index.html" });
    expect(run("/apps/a%2Fb/x")).toMatchObject({ uri: "/apps/a%2Fb/x" });
    expect(run("/apps/ada.html")).toMatchObject({ uri: "/apps/ada.html" });
  });

  it("stays small (CloudFront Functions take at most 10 KB of code)", () => {
    expect(Buffer.byteLength(code)).toBeLessThan(10 * 1024);
  });
});
