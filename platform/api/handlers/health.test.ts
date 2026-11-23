import { describe, expect, it } from "vitest";
import { handler } from "./health.js";

describe("GET /api/health", () => {
  it("answers 200 with {\"ok\":true} as uncached JSON", async () => {
    const res = await handler();
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('{"ok":true}');
    expect(res.headers).toEqual({ "content-type": "application/json", "cache-control": "no-store" });
  });
});
