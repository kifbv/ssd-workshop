import { fileURLToPath } from "node:url";
import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import { type CfnStage, HttpApi, HttpMethod } from "aws-cdk-lib/aws-apigatewayv2";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import { AttributeType, BillingMode, Table, TableEncryption } from "aws-cdk-lib/aws-dynamodb";
import { Effect, PolicyStatement, Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { Architecture, Runtime } from "aws-cdk-lib/aws-lambda";
import { SqsEventSource } from "aws-cdk-lib/aws-lambda-event-sources";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import { Queue, QueueEncryption } from "aws-cdk-lib/aws-sqs";
import type { Construct } from "constructs";
import {
  ACCOUNT,
  AI_DLQ_NAME,
  AI_QUEUE_NAME,
  AI_WORKER_FUNCTION_NAME,
  AI_WORKER_UPDATE_ATTRIBUTES,
  API_NAME,
  CONVERSATION_FUNCTION_NAME,
  CONVERSATION_UPDATE_ATTRIBUTES,
  FOUNDATION_MODEL_ID,
  MODEL_ID,
  REGION,
  HEALTH_FUNCTION_NAME,
  PARTICIPANT_FUNCTION_NAME,
  PARTICIPANT_NICK_PUT_ATTRIBUTES,
  PARTICIPANT_PROFILE_UPDATE_ATTRIBUTES,
  SENDER_ADDRESS,
  SES_SEND_RESOURCES,
  SIGN_IN_CODE_PUT_ATTRIBUTES,
  SIGN_IN_CODE_FUNCTION_NAME,
  SIGN_IN_VERIFY_EMAIL_UPDATE_ATTRIBUTES,
  SIGN_IN_VERIFY_FUNCTION_NAME,
  SIGN_IN_VERIFY_PROFILE_UPDATE_ATTRIBUTES,
  SIGN_IN_VERIFY_SESSION_PUT_ATTRIBUTES,
  TABLE_NAME,
} from "./config.js";

/** Lambda handlers live with the rest of the API code. */
export const API_HANDLERS_DIR = fileURLToPath(new URL("../../platform/api/handlers", import.meta.url));

/** Default-stage throttle: a cheap guard against runaway clients (the workshop needs ~15 requests/s). */
export const API_THROTTLE = { rateLimit: 50, burstLimit: 100 } as const;

/**
 * Route throttle for `POST /api/sign-in/code` (ticket 1.4): reachable without sign-in and every
 * well-formed request holds a Lambda for 3 s, so a flood at the stage limit would keep ~150
 * executions busy in an account whose Lambda concurrency is shared. ~15 people need far less.
 */
export const SIGN_IN_CODE_ROUTE_KEY = "POST /api/sign-in/code";
export const SIGN_IN_CODE_THROTTLE = { rateLimit: 5, burstLimit: 10 } as const;

/**
 * Route throttle for `POST /api/sign-in/verify` (ticket 1.5): like the code route, reachable
 * without sign-in and every well-formed request holds a Lambda for 3 s. Guessing is already
 * capped by the 5 wrong tries per address.
 */
export const SIGN_IN_VERIFY_ROUTE_KEY = "POST /api/sign-in/verify";
export const SIGN_IN_VERIFY_THROTTLE = { rateLimit: 5, burstLimit: 10 } as const;

/** The protected participant routes (ticket 1.5), all served by one function behind one session check. */
export const PARTICIPANT_ROUTES = [
  { path: "/api/me", method: HttpMethod.GET },
  { path: "/api/me/nickname", method: HttpMethod.POST },
  { path: "/api/participants/{id}", method: HttpMethod.GET },
] as const;

/** The protected conversation routes (ticket 1.7), served by one function. */
export const CONVERSATION_ROUTES = [
  { path: "/api/conversation/messages", method: HttpMethod.POST },
  { path: "/api/conversation/messages/{id}", method: HttpMethod.GET },
] as const;

/**
 * The AI worker's timeout (ticket 1.7): a guardrail call and an answer of up to 2000 tokens fit with
 * room; the AI calls are cut off 30 s before it, so the outcome is always stored.
 */
export const AI_WORKER_TIMEOUT_SECONDS = 300;
/** Six times the worker's timeout, as AWS recommends for a queue that feeds a Lambda function. */
export const AI_QUEUE_VISIBILITY_SECONDS = 6 * AI_WORKER_TIMEOUT_SECONDS;
/** A job whose worker crashed this many times goes to the dead-letter queue. */
export const AI_QUEUE_MAX_RECEIVES = 3;

/** The model the AI worker may call: the EU inference profile and the foundation model it routes to in each EU region. */
export const BEDROCK_INVOKE_RESOURCES = [
  `arn:aws:bedrock:${REGION}:${ACCOUNT}:inference-profile/${MODEL_ID}`,
  `arn:aws:bedrock:eu-*::foundation-model/${FOUNDATION_MODEL_ID}`,
] as const;

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
    const stage = this.api.addStage("DefaultStage", {
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

    // Ticket 1.4: emails a sign-in code. Reachable without sign-in, so its table rights stay in
    // the `EMAIL#*` partitions: GetItem (allow-list, codes, counter) and PutItem of the CODE and
    // CODE_REQUESTS attribute names only. It sends from the workshop address only, through the
    // workshop's identities and configuration set. 512 MB keeps scrypt fast and predictable; the
    // answer goes out at 3 s, well inside the 10 s timeout.
    const signInCode = workshopFunction(this, "SignInCode", SIGN_IN_CODE_FUNCTION_NAME, "sign-in-code.ts", 512);
    const emailPartitions = { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["EMAIL#*"] } };
    signInCode.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["dynamodb:GetItem"],
        resources: [this.table.tableArn],
        conditions: emailPartitions,
      }),
    );
    signInCode.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["dynamodb:PutItem"],
        resources: [this.table.tableArn],
        conditions: {
          ...emailPartitions,
          "ForAllValues:StringEquals": { "dynamodb:Attributes": [...SIGN_IN_CODE_PUT_ATTRIBUTES] },
        },
      }),
    );
    signInCode.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["ses:SendEmail"],
        resources: [...SES_SEND_RESOURCES],
        conditions: { StringEquals: { "ses:FromAddress": SENDER_ADDRESS } },
      }),
    );
    const signInCodeRoutes = this.api.addRoutes({
      path: "/api/sign-in/code",
      methods: [HttpMethod.POST],
      integration: new HttpLambdaIntegration("SignInCodeIntegration", signInCode),
    });

    // Ticket 1.5: checks a code and starts a session. Reachable without sign-in. In `EMAIL#*` it
    // reads (allow-list, codes), updates only `attempts`, `version` and `participantId`, and deletes
    // (the used or burned codes item); in `PARTICIPANT#*` it updates only the profile's attributes
    // (never `nickname`); in `SESSION#*` it puts only the session's. 512 MB for scrypt, as 1.4.
    const signInVerify = workshopFunction(this, "SignInVerify", SIGN_IN_VERIFY_FUNCTION_NAME, "sign-in-verify.ts", 512);
    signInVerify.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["dynamodb:GetItem"],
        resources: [this.table.tableArn],
        conditions: emailPartitions,
      }),
    );
    signInVerify.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["dynamodb:UpdateItem"],
        resources: [this.table.tableArn],
        conditions: {
          ...emailPartitions,
          "ForAllValues:StringEquals": { "dynamodb:Attributes": [...SIGN_IN_VERIFY_EMAIL_UPDATE_ATTRIBUTES] },
        },
      }),
    );
    signInVerify.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["dynamodb:DeleteItem"],
        resources: [this.table.tableArn],
        conditions: emailPartitions,
      }),
    );
    signInVerify.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["dynamodb:UpdateItem"],
        resources: [this.table.tableArn],
        conditions: {
          "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["PARTICIPANT#*"] },
          "ForAllValues:StringEquals": { "dynamodb:Attributes": [...SIGN_IN_VERIFY_PROFILE_UPDATE_ATTRIBUTES] },
        },
      }),
    );
    signInVerify.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["dynamodb:PutItem"],
        resources: [this.table.tableArn],
        conditions: {
          "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["SESSION#*"] },
          "ForAllValues:StringEquals": { "dynamodb:Attributes": [...SIGN_IN_VERIFY_SESSION_PUT_ATTRIBUTES] },
        },
      }),
    );
    const signInVerifyRoutes = this.api.addRoutes({
      path: "/api/sign-in/verify",
      methods: [HttpMethod.POST],
      integration: new HttpLambdaIntegration("SignInVerifyIntegration", signInVerify),
    });

    // Ticket 1.5: the protected participant routes. It reads sessions and profiles, puts nickname
    // claims (only their attributes) and updates only a profile's `nickname` and `step`; the claim
    // and the profile update go in one transaction, authorized item by item.
    const participant = workshopFunction(this, "Participant", PARTICIPANT_FUNCTION_NAME, "participant.ts");
    participant.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["dynamodb:GetItem"],
        resources: [this.table.tableArn],
        conditions: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["SESSION#*", "PARTICIPANT#*"] } },
      }),
    );
    participant.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["dynamodb:PutItem"],
        resources: [this.table.tableArn],
        conditions: {
          "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["NICK#*"] },
          "ForAllValues:StringEquals": { "dynamodb:Attributes": [...PARTICIPANT_NICK_PUT_ATTRIBUTES] },
        },
      }),
    );
    participant.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["dynamodb:UpdateItem"],
        resources: [this.table.tableArn],
        conditions: {
          "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["PARTICIPANT#*"] },
          "ForAllValues:StringEquals": { "dynamodb:Attributes": [...PARTICIPANT_PROFILE_UPDATE_ATTRIBUTES] },
        },
      }),
    );
    // One invoke permission for the function, scoped to this API (`<api id>/*/*/*`) instead of one
    // per route: CDK's per-route source ARN would hold `{id}` literally for the path parameter route.
    const participantIntegration = new HttpLambdaIntegration("ParticipantIntegration", participant, {
      scopePermissionToRoute: false,
    });
    for (const route of PARTICIPANT_ROUTES) {
      this.api.addRoutes({ path: route.path, methods: [route.method], integration: participantIntegration });
    }

    // Ticket 1.7: the conversation. The routes' function stores a message and hands its ids to the
    // AI worker through a queue (a function may not invoke another: the boundary has no
    // lambda:InvokeFunction). Both update only listed attribute names in `PARTICIPANT#*`, never put.
    const aiDeadLetters = new Queue(this, "AiMessagesDlq", {
      queueName: AI_DLQ_NAME,
      encryption: QueueEncryption.SQS_MANAGED,
      retentionPeriod: Duration.days(14),
    });
    const aiQueue = new Queue(this, "AiMessages", {
      queueName: AI_QUEUE_NAME,
      encryption: QueueEncryption.SQS_MANAGED,
      visibilityTimeout: Duration.seconds(AI_QUEUE_VISIBILITY_SECONDS),
      retentionPeriod: Duration.days(1),
      deadLetterQueue: { queue: aiDeadLetters, maxReceiveCount: AI_QUEUE_MAX_RECEIVES },
    });

    const participantPartitions = { "dynamodb:LeadingKeys": ["PARTICIPANT#*"] };
    const conversation = workshopFunction(this, "Conversation", CONVERSATION_FUNCTION_NAME, "conversation.ts");
    conversation.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["dynamodb:GetItem"],
        resources: [this.table.tableArn],
        conditions: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["SESSION#*", "PARTICIPANT#*"] } },
      }),
    );
    conversation.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["dynamodb:UpdateItem"],
        resources: [this.table.tableArn],
        conditions: {
          "ForAllValues:StringLike": participantPartitions,
          "ForAllValues:StringEquals": { "dynamodb:Attributes": [...CONVERSATION_UPDATE_ATTRIBUTES] },
        },
      }),
    );
    conversation.addToRolePolicy(
      new PolicyStatement({ effect: Effect.ALLOW, actions: ["sqs:SendMessage"], resources: [aiQueue.queueArn] }),
    );
    // One invoke permission scoped to this API, as for the participant routes (path parameter route).
    const conversationIntegration = new HttpLambdaIntegration("ConversationIntegration", conversation, {
      scopePermissionToRoute: false,
    });
    for (const route of CONVERSATION_ROUTES) {
      this.api.addRoutes({ path: route.path, methods: [route.method], integration: conversationIntegration });
    }

    const worker = workshopFunction(this, "AiWorker", AI_WORKER_FUNCTION_NAME, "ai-worker.ts", 256, AI_WORKER_TIMEOUT_SECONDS);
    worker.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["dynamodb:GetItem", "dynamodb:Query"],
        resources: [this.table.tableArn],
        conditions: { "ForAllValues:StringLike": participantPartitions },
      }),
    );
    worker.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["dynamodb:UpdateItem"],
        resources: [this.table.tableArn],
        conditions: {
          "ForAllValues:StringLike": participantPartitions,
          "ForAllValues:StringEquals": { "dynamodb:Attributes": [...AI_WORKER_UPDATE_ATTRIBUTES] },
        },
      }),
    );
    worker.addToRolePolicy(
      new PolicyStatement({ effect: Effect.ALLOW, actions: ["bedrock:InvokeModel"], resources: [...BEDROCK_INVOKE_RESOURCES] }),
    );
    // One job per invocation; the source grants the role the consume rights on this queue only.
    worker.addEventSource(new SqsEventSource(aiQueue, { batchSize: 1 }));

    // Route-level throttles (L1 RouteSettings; the L2 stage has no per-route option). A route must
    // exist before the stage names it. No reserved concurrency: it takes from the account-wide pool.
    const cfnStage = stage.node.defaultChild as CfnStage;
    cfnStage.addPropertyOverride(`RouteSettings.${SIGN_IN_CODE_ROUTE_KEY}`, {
      ThrottlingRateLimit: SIGN_IN_CODE_THROTTLE.rateLimit,
      ThrottlingBurstLimit: SIGN_IN_CODE_THROTTLE.burstLimit,
    });
    cfnStage.addPropertyOverride(`RouteSettings.${SIGN_IN_VERIFY_ROUTE_KEY}`, {
      ThrottlingRateLimit: SIGN_IN_VERIFY_THROTTLE.rateLimit,
      ThrottlingBurstLimit: SIGN_IN_VERIFY_THROTTLE.burstLimit,
    });
    for (const route of [...signInCodeRoutes, ...signInVerifyRoutes]) cfnStage.node.addDependency(route);

    new CfnOutput(this, "ApiEndpoint", {
      description: "The API's own endpoint (https://<api id>.execute-api.<region>.amazonaws.com)",
      value: this.api.apiEndpoint,
    });
  }
}

/**
 * A Node.js 22 arm64 function bundled by esbuild from platform/api/handlers, with
 * its own named role (only the right to write its logs; the caller adds what the
 * function needs; the app's aspect adds the path and boundary) and its own named log group with two weeks of retention.
 */
function workshopFunction(
  scope: Construct,
  id: string,
  name: string,
  entry: string,
  memorySize = 256,
  timeoutSeconds = 10,
): NodejsFunction {
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
    memorySize,
    timeout: Duration.seconds(timeoutSeconds),
    role,
    logGroup,
    // NodejsFunction leaves @aws-sdk/* out of the bundle by default on Node 18+ runtimes (the
    // runtime has its own copy). Bundling it pins the version the tests ran with and keeps the
    // bundle self-contained (the synth test loads it).
    bundling: { minify: true, sourceMap: false, externalModules: [] },
  });
}
