/**
 * The response shape an API Gateway HTTP API (payload format 2.0) expects from
 * a Lambda handler. Declared here instead of adding `@types/aws-lambda` for one
 * interface.
 */
export interface HttpResponse {
  statusCode: number;
  headers?: Record<string, string>;
  body?: string;
}

/**
 * The parts of an API Gateway HTTP API (payload format 2.0) request event the
 * handlers read. The body is base64 when `isBase64Encoded` is true.
 */
export interface HttpRequest {
  body?: string;
  isBase64Encoded?: boolean;
}
