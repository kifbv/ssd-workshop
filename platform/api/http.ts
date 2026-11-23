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
