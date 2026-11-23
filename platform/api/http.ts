/**
 * The response shape an API Gateway HTTP API (payload format 2.0) expects from
 * a Lambda handler. Declared here instead of adding `@types/aws-lambda` for one
 * interface. `cookies` become `Set-Cookie` headers (ticket 1.5).
 */
export interface HttpResponse {
  statusCode: number;
  headers?: Record<string, string>;
  cookies?: string[];
  body?: string;
}

/**
 * The parts of an API Gateway HTTP API (payload format 2.0) request event the
 * handlers read. The body is base64 when `isBase64Encoded` is true. Header names
 * arrive lower-cased; request cookies arrive in `cookies` (one `name=value` each),
 * not in a `cookie` header.
 */
export interface HttpRequest {
  body?: string;
  isBase64Encoded?: boolean;
  headers?: Record<string, string | undefined>;
  cookies?: string[];
  /** For example `GET /api/me`. */
  routeKey?: string;
  pathParameters?: Record<string, string | undefined>;
  /** The query string's parameters (a repeated name arrives comma-joined). */
  queryStringParameters?: Record<string, string | undefined>;
}

/** Every API answer: JSON, never cached. */
export const JSON_HEADERS = { "content-type": "application/json", "cache-control": "no-store" } as const;

/** A JSON answer with `{"message": ...}` plus any extra fields (a fresh copy each time). */
export function jsonResponse(statusCode: number, body: Record<string, unknown>): HttpResponse {
  return { statusCode, headers: { ...JSON_HEADERS }, body: JSON.stringify(body) };
}

/** Larger bodies are refused before parsing (requests hold a few dozen bytes). */
export const MAX_BODY_BYTES = 2048;
/** The raw body is checked before any decoding (base64 inflates by 4/3, so 4 KB is ample). */
export const MAX_RAW_BODY_BYTES = 4096;

/**
 * The body as a JSON object (possibly base64), or undefined when it is missing, too large, not
 * JSON or not an object. Never throws and never echoes the input. Routes with larger bodies (a
 * conversation message, ticket 1.7) pass their own limits.
 */
export function readJsonObject(
  request: HttpRequest,
  limits: { maxBodyBytes: number; maxRawBodyBytes: number } = { maxBodyBytes: MAX_BODY_BYTES, maxRawBodyBytes: MAX_RAW_BODY_BYTES },
): Record<string, unknown> | undefined {
  if (typeof request.body !== "string") return undefined;
  if (Buffer.byteLength(request.body, "utf8") > limits.maxRawBodyBytes) return undefined;
  const raw = request.isBase64Encoded === true ? Buffer.from(request.body, "base64").toString("utf8") : request.body;
  if (Buffer.byteLength(raw, "utf8") > limits.maxBodyBytes) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  return parsed as Record<string, unknown>;
}

/**
 * True when the request says its body is JSON (`content-type: application/json`, any parameters).
 * Browsers cannot send this type cross-site without a CORS preflight, which the API never grants,
 * so requiring it on writes blocks cross-site form posts (on top of the SameSite=Strict cookie).
 */
export function isJsonContentType(request: HttpRequest): boolean {
  const value = request.headers?.["content-type"];
  if (typeof value !== "string") return false;
  return value.split(";")[0]?.trim().toLowerCase() === "application/json";
}

export const UNSUPPORTED_MEDIA_TYPE_MESSAGE = "Send the request as JSON (content-type: application/json).";

export function unsupportedMediaTypeResponse(): HttpResponse {
  return jsonResponse(415, { message: UNSUPPORTED_MEDIA_TYPE_MESSAGE });
}
