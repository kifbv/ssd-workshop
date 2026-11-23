import { fileURLToPath } from "node:url";
import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import { HttpApi, HttpMethod } from "aws-cdk-lib/aws-apigatewayv2";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import { AttributeType, BillingMode, Table, TableEncryption } from "aws-cdk-lib/aws-dynamodb";
import { Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { Architecture, type IFunction, Runtime } from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import type { Construct } from "constructs";
import { API_NAME, HEALTH_FUNCTION_NAME, TABLE_NAME } from "./config.js";

/** Lambda handlers live with the rest of the API code. */
export const API_HANDLERS_DIR = fileURLToPath(new URL("../../platform/api/handlers", import.meta.url));

/** Default-stage throttle: a cheap guard against runaway clients (the workshop needs ~15 requests/s). */
export const API_THROTTLE = { rateLimit: 50, burstLimit: 100 } as const;

/** The TTL attribute (epoch seconds) of sign-in codes and sessions. */
export const TTL_ATTRIBUTE = "expiresAt";

/**
 * The workshop's data and API (ticket 1.1): the single DynamoDB table, the HTTP
 * API and its Lambda functions. Pages and API share the workshop origin from
 * ticket 1.2 (CloudFront sends /api/* here), so the API has no CORS.
 */
export class ApiStack extends Stack {
  readonly table: Table;
  readonly api: HttpApi;

  constructor(scope: Construct, id: string, props: StackProps) {
    super(scope, id, props);

    // Single-table design, key scheme in platform/api/types.ts.
    this.table = new Table(this, "Data", {
      tableName: TABLE_NAME,
      partitionKey: { name: "pk", type: AttributeType.STRING },
      sortKey: { name: "sk", type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      encryption: TableEncryption.DEFAULT,
      timeToLiveAttribute: TTL_ATTRIBUTE,
      // Participants' work lives here: kept when the stack is deleted, and the
      // table cannot be deleted by a direct API call either.
      removalPolicy: RemovalPolicy.RETAIN,
      deletionProtection: true,
    });

    this.api = new HttpApi(this, "Api", {
      apiName: API_NAME,
      description: "SSD Workshop API (routes under /api/)",
      // The stage is added below, with throttling.
      createDefaultStage: false,
    });
    this.api.addStage("DefaultStage", {
      stageName: "$default",
      autoDeploy: true,
      throttle: API_THROTTLE,
    });

    const health = workshopFunction(this, "Health", HEALTH_FUNCTION_NAME, "health.ts");
    this.api.addRoutes({
      path: "/api/health",
      methods: [HttpMethod.GET],
      // Adds the invoke permission with the API's execute-api ARN as source.
      integration: new HttpLambdaIntegration("HealthIntegration", health),
    });

    new CfnOutput(this, "ApiEndpoint", {
      description: "The API's own endpoint (https://<api id>.execute-api.<region>.amazonaws.com)",
      value: this.api.apiEndpoint,
    });
  }
}

/**
 * A Node.js 22 arm64 function bundled by esbuild from platform/api/handlers, with
 * its own named role (no rights beyond writing its logs; the app's aspect adds the
 * path and boundary) and its own named log group with two weeks of retention.
 */
function workshopFunction(scope: Construct, id: string, name: string, entry: string): IFunction {
  const logGroup = new LogGroup(scope, `${id}Logs`, {
    logGroupName: name,
    retention: RetentionDays.TWO_WEEKS,
    removalPolicy: RemovalPolicy.DESTROY,
  });

  const role = new Role(scope, `${id}Role`, {
    roleName: name,
    assumedBy: new ServicePrincipal("lambda.amazonaws.com"),
    description: `Runs the ${name} Lambda function`,
  });
  logGroup.grantWrite(role);

  return new NodejsFunction(scope, id, {
    functionName: name,
    entry: `${API_HANDLERS_DIR}/${entry}`,
    handler: "handler",
    runtime: Runtime.NODEJS_22_X,
    architecture: Architecture.ARM_64,
    memorySize: 256,
    timeout: Duration.seconds(10),
    role,
    logGroup,
    bundling: { minify: true, sourceMap: false },
  }) as IFunction;
}
