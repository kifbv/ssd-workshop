import type { HttpResponse } from "../http.js";

/**
 * `GET /api/health`: proves that CloudFront (from ticket 1.2), API Gateway and
 * Lambda are wired together. Touches no data and logs nothing.
 */
export async function handler(): Promise<HttpResponse> {
  return {
    statusCode: 200,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
    body: JSON.stringify({ ok: true }),
  };
}
