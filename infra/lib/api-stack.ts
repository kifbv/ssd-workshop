import { fileURLToPath } from "node:url";
import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import { type CfnStage, HttpApi, HttpMethod } from "aws-cdk-lib/aws-apigatewayv2";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import { AttributeType, BillingMode, ProjectionType, Table, TableEncryption } from "aws-cdk-lib/aws-dynamodb";
import { Effect, PolicyStatement, Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { Architecture, Runtime } from "aws-cdk-lib/aws-lambda";
import { SqsEventSource } from "aws-cdk-lib/aws-lambda-event-sources";
import { type ICommandHooks, NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import { Queue, QueueEncryption } from "aws-cdk-lib/aws-sqs";
import type { Construct } from "constructs";
import {
  ACCOUNT,
  ADMIN_FUNCTION_NAME,
  AI_DLQ_NAME,
  AI_QUEUE_NAME,
  AI_WORKER_FUNCTION_NAME,
  AI_WORKER_BUILD_CHECK_ATTRIBUTES,
  AI_WORKER_BUILD_UPDATE_ATTRIBUTES,
  AI_WORKER_UPDATE_ATTRIBUTES,
  API_NAME,
  APP_DATA_FUNCTION_NAME,
  APP_DATA_WRITE_ATTRIBUTES,
  APP_LIVE_READ_ATTRIBUTES,
  APP_TOKEN_LIST_READ_ATTRIBUTES,
  APP_TOKEN_LIST_UPDATE_ATTRIBUTES,
  APP_TOKEN_PUT_ATTRIBUTES,
  APP_TOKEN_READ_ATTRIBUTES,
  ATTRIBUTE_LIMITED_RETURN_VALUES,
  BUILD_QUEUE_NAME,
  BUILD_QUEUE_PARTITION,
  BUILD_RETRIES_PARTITION,
  BUILD_SLOTS_PARTITION,
  BY_TYPE_INDEX_ATTRIBUTES,
  BY_TYPE_INDEX_KEY,
  BY_TYPE_INDEX_NAME,
  FACILITATOR_BUILD_READ_ATTRIBUTES,
  FACILITATOR_FUNCTION_NAME,
  FACILITATOR_INDEX_READ_ATTRIBUTES,
  FACILITATOR_INDEX_TYPES,
  FACILITATOR_NICK_READ_ATTRIBUTES,
  FACILITATOR_PARTICIPANT_UPDATE_ATTRIBUTES,
  RETRY_REQUEST_ATTRIBUTES,
  CONVERSATION_FUNCTION_NAME,
  CONVERSATION_UPDATE_ATTRIBUTES,
  FOUNDATION_MODEL_ID,
  MODEL_ID,
  REGION,
  HEALTH_FUNCTION_NAME,
  PARTICIPANT_FUNCTION_NAME,
  PARTICIPANT_NICK_PUT_ATTRIBUTES,
  PARTICIPANT_PROFILE_UPDATE_ATTRIBUTES,
  QUEUE_COUNT_ATTRIBUTES,
  SENDER_ADDRESS,
  SESSION_ALLOW_READ_ATTRIBUTES,
  SES_SEND_RESOURCES,
  SETTINGS_PARTITION,
  SETTINGS_READ_ATTRIBUTES,
  SETTINGS_UPDATE_ATTRIBUTES,
  SIGN_IN_CODE_PUT_ATTRIBUTES,
  SIGN_IN_CODE_FUNCTION_NAME,
  SIGN_IN_VERIFY_EMAIL_UPDATE_ATTRIBUTES,
  SIGN_IN_VERIFY_FUNCTION_NAME,
  SIGN_IN_VERIFY_PROFILE_UPDATE_ATTRIBUTES,
  SIGN_IN_VERIFY_SESSION_PUT_ATTRIBUTES,
  SLOT_RELEASE_ATTRIBUTES,
  SLOT_RELEASE_CHECK_ATTRIBUTES,
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

/**
 * Route throttles for the data API (ticket 2.4), for all apps together: reachable by anyone with an
 * app's address. Each app's daily write budget caps what writes cost; the throttles cap the requests
 * (and their reads of the small totals item). PUT and DELETE get 30 requests/s (burst 60), enough for a
 * workshop room pressing shared counters (a throttled request answers 429), GET 20/s (burst 40).
 * OPTIONS 20/s (burst 40) too: every preflight invokes the function.
 */
export const APP_DATA_WRITE_THROTTLE = { rateLimit: 30, burstLimit: 60 } as const;
export const APP_DATA_READ_THROTTLE = { rateLimit: 20, burstLimit: 40 } as const;
/** The data API's CORS preflight: browsers keep its answer 600 s, so few are sent; each still invokes the function. */
export const APP_DATA_PREFLIGHT_THROTTLE = { rateLimit: 20, burstLimit: 40 } as const;

/** The protected participant routes (ticket 1.5), all served by one function behind one session check. */
export const PARTICIPANT_ROUTES = [
  { path: "/api/me", method: HttpMethod.GET },
  { path: "/api/me/nickname", method: HttpMethod.POST },
  { path: "/api/participants/{id}", method: HttpMethod.GET },
  // Ticket 3.1: deletes the caller's own session and clears its cookie (ticket 3.24: and revokes their app write tokens).
  { path: "/api/sign-out", method: HttpMethod.POST },
  // Ticket 3.24: an app write token for one live app, for the hand-off page /app-sign-in.
  { path: "/api/app-tokens", method: HttpMethod.POST },
] as const;

/** The admin routes (ticket 3.2; Stop and Resume from 3.5), served by their own function: the only role that may write `SETTINGS`. */
export const ADMIN_ROUTES = [
  { path: "/api/admin/settings", method: HttpMethod.GET },
  { path: "/api/admin/settings", method: HttpMethod.PUT },
  { path: "/api/admin/stop", method: HttpMethod.POST },
  { path: "/api/admin/resume", method: HttpMethod.POST },
] as const;

/**
 * The facilitator routes (ticket 3.10), served by their own function: the dashboard's list, a participant's conversation
 * log and the actions, a participant named by nickname (platform/api/facilitator/facilitator.ts).
 */
export const FACILITATOR_ROUTES = [
  { path: "/api/facilitator/participants", method: HttpMethod.GET },
  { path: "/api/facilitator/participants/{nickname}/conversation", method: HttpMethod.GET },
  { path: "/api/facilitator/participants/{nickname}/retry", method: HttpMethod.POST },
  { path: "/api/facilitator/participants/{nickname}/pause", method: HttpMethod.POST },
  { path: "/api/facilitator/participants/{nickname}/resume", method: HttpMethod.POST },
  { path: "/api/facilitator/participants/{nickname}/budget", method: HttpMethod.POST },
  { path: "/api/facilitator/participants/{nickname}/flag/approve", method: HttpMethod.POST },
  { path: "/api/facilitator/participants/{nickname}/flag/reject", method: HttpMethod.POST },
] as const;

/** The protected conversation routes (ticket 1.7; history and step from 1.8; spec and approve from 1.9), served by one function. */
export const CONVERSATION_ROUTES = [
  { path: "/api/conversation/messages", method: HttpMethod.POST },
  { path: "/api/conversation/messages/{id}", method: HttpMethod.GET },
  { path: "/api/conversation", method: HttpMethod.GET },
  { path: "/api/conversation/step", method: HttpMethod.POST },
  { path: "/api/conversation/spec", method: HttpMethod.GET },
  { path: "/api/conversation/spec/approve", method: HttpMethod.POST },
  // Ticket 2.7: the caller's own build (the step 3 page polls it from ticket 2.10).
  { path: "/api/build", method: HttpMethod.GET },
  // Ticket 3.5: the workshop's state (paused or not), asked every 30 s by every signed-in screen (one SETTINGS read).
  { path: "/api/status", method: HttpMethod.GET },
  // Ticket 3.6: Build this change and Not this one, on the caller's proposed version.
  { path: "/api/conversation/change/build", method: HttpMethod.POST },
  { path: "/api/conversation/change/discard", method: HttpMethod.POST },
  // Ticket 3.9: Rebuild from my repository.
  { path: "/api/conversation/change/rebuild", method: HttpMethod.POST },
  // Ticket 3.15: Rebuild with my edits.
  { path: "/api/conversation/change/edit", method: HttpMethod.POST },
] as const;

/**
 * The data API for participants' apps (ticket 2.4), one function. `OPTIONS` is a route of its own:
 * the HTTP API has no CORS configuration, so the function answers the preflight itself (with
 * `Access-Control-Allow-Origin: *`), like every other answer of this path.
 */
export const APP_DATA_PATH = "/api/apps/{nickname}/data/{key}";
export const APP_DATA_METHODS = [HttpMethod.GET, HttpMethod.PUT, HttpMethod.DELETE, HttpMethod.OPTIONS] as const;

/**
 * The AI worker's timeout (ticket 1.7): a guardrail call and an answer of up to 2000 tokens fit with
 * room; the AI calls are cut off 30 s before it, so the outcome is always stored.
 */
export const AI_WORKER_TIMEOUT_SECONDS = 300;
/**
 * Just above the worker's timeout, so SQS delivers a crashed job again while its message is still
 * pending: the last of AI_QUEUE_MAX_RECEIVES runs starts by about 2 x 330 s and ends by about 960 s,
 * within the platform's STALE_PENDING_SECONDS (1200 s; tested). AWS's advice of six times the timeout
 * is for batches with partial retries; with batch size 1 and maxConcurrency there is no such case.
 */
export const AI_QUEUE_VISIBILITY_SECONDS = AI_WORKER_TIMEOUT_SECONDS + 30;
/** A job whose worker crashed this many times goes to the dead-letter queue. */
export const AI_QUEUE_MAX_RECEIVES = 3;
/** At most this many workers at once (AWS's minimum is 2), so a burst of messages queues instead of hitting Bedrock throttling. */
export const AI_WORKER_MAX_CONCURRENCY = 5;

/** The model the AI worker may call: the EU inference profile and the foundation model it routes to in each EU region. */
export const BEDROCK_INVOKE_RESOURCES = [
  `arn:aws:bedrock:${REGION}:${ACCOUNT}:inference-profile/${MODEL_ID}`,
  `arn:aws:bedrock:eu-*::foundation-model/${FOUNDATION_MODEL_ID}`,
] as const;

/** The launch queue (builds stack, ticket 2.7), named by its fixed ARN: the AI worker is its one sender. */
export const BUILD_QUEUE_ARN = `arn:aws:sqs:${REGION}:${ACCOUNT}:${BUILD_QUEUE_NAME}`;

/** The TTL attribute (epoch seconds) of sign-in codes and sessions. */
export const TTL_ATTRIBUTE = "expiresAt";

/**
 * The workshop's data and API (ticket 1.1): the single DynamoDB table, the HTTP
 * API and its Lambda functions. Pages and API share the workshop origin from
 * ticket 1.2 (CloudFront sends /api/* here), so the API has no CORS configuration; only the data API
 * for apps (ticket 2.4) answers CORS, from its own function.
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
    // Ticket 3.10: the one secondary index, sparse: keyed by `listType`, which only profiles, conversations, usage totals and
    // builds carry, for the facilitators' list (a Query per kind, never a Scan; the allow-list is never in it).
    // INCLUDE only what a dashboard row needs (never `email`, a message's text or a spec); only the facilitator role may
    // query it, and only the types FACILITATOR_INDEX_TYPES.
    this.table.addGlobalSecondaryIndex({
      indexName: BY_TYPE_INDEX_NAME,
      partitionKey: { name: BY_TYPE_INDEX_KEY, type: AttributeType.STRING },
      projectionType: ProjectionType.INCLUDE,
      nonKeyAttributes: [...BY_TYPE_INDEX_ATTRIBUTES],
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
    addSessionCheckRights(participant, this.table);
    // Ticket 3.24: app write tokens. It reads an app's live marker (`liveAt` only) and the caller's token list
    // (`tokens` only), puts token items (`APPTOKEN#*`, their names only), updates token lists (`TOKENS#*`, their names
    // only) and deletes both (sign-out). It never reads a token item back, and no call returns an item.
    participant.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["dynamodb:GetItem"],
        resources: [this.table.tableArn],
        conditions: {
          "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["APP#*"] },
          "ForAllValues:StringEquals": { "dynamodb:Attributes": [...APP_LIVE_READ_ATTRIBUTES] },
          StringEquals: { "dynamodb:Select": "SPECIFIC_ATTRIBUTES" },
        },
      }),
    );
    participant.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["dynamodb:GetItem"],
        resources: [this.table.tableArn],
        conditions: {
          "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["TOKENS#*"] },
          "ForAllValues:StringEquals": { "dynamodb:Attributes": [...APP_TOKEN_LIST_READ_ATTRIBUTES] },
          StringEquals: { "dynamodb:Select": "SPECIFIC_ATTRIBUTES" },
        },
      }),
    );
    participant.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["dynamodb:PutItem"],
        resources: [this.table.tableArn],
        conditions: {
          "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["APPTOKEN#*"] },
          "ForAllValues:StringEquals": { "dynamodb:Attributes": [...APP_TOKEN_PUT_ATTRIBUTES] },
          StringEqualsIfExists: { "dynamodb:ReturnValues": ["NONE"] },
        },
      }),
    );
    participant.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["dynamodb:UpdateItem"],
        resources: [this.table.tableArn],
        conditions: {
          "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["TOKENS#*"] },
          "ForAllValues:StringEquals": { "dynamodb:Attributes": [...APP_TOKEN_LIST_UPDATE_ATTRIBUTES] },
          StringEqualsIfExists: { "dynamodb:ReturnValues": ["NONE"] },
        },
      }),
    );
    participant.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["dynamodb:DeleteItem"],
        resources: [this.table.tableArn],
        conditions: {
          "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["APPTOKEN#*", "TOKENS#*"] },
          StringEqualsIfExists: { "dynamodb:ReturnValues": ["NONE"] },
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

    // Ticket 3.2: the admin routes. Reads sessions and profiles (the session check) and the `SETTINGS` item, and
    // updates only the settings' listed attribute names there (no PutItem, so the item is never replaced or emptied).
    // The admin check is in the code (the role comes from the allow-list); no other role may write `SETTINGS`.
    const admin = workshopFunction(this, "Admin", ADMIN_FUNCTION_NAME, "admin.ts");
    admin.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["dynamodb:GetItem"],
        resources: [this.table.tableArn],
        conditions: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["SESSION#*", "PARTICIPANT#*", SETTINGS_PARTITION] } },
      }),
    );
    admin.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["dynamodb:UpdateItem"],
        resources: [this.table.tableArn],
        conditions: {
          "ForAllValues:StringEquals": {
            "dynamodb:LeadingKeys": [SETTINGS_PARTITION],
            "dynamodb:Attributes": [...SETTINGS_UPDATE_ATTRIBUTES],
          },
          StringEqualsIfExists: { "dynamodb:ReturnValues": ["NONE"] },
        },
      }),
    );
    addSessionCheckRights(admin, this.table);
    const adminIntegration = new HttpLambdaIntegration("AdminIntegration", admin, { scopePermissionToRoute: false });
    for (const route of ADMIN_ROUTES) {
      this.api.addRoutes({ path: route.path, methods: [route.method], integration: adminIntegration });
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
    // Ticket 2.7: also reads builds (`GET /api/build` answers only a build whose participantId is the caller).
    conversation.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["dynamodb:GetItem"],
        resources: [this.table.tableArn],
        conditions: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["SESSION#*", "PARTICIPANT#*", "BUILD#*"] } },
      }),
    );
    // The page's history (ticket 1.8): a Query of the caller's own partition (requireSession picks it).
    conversation.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["dynamodb:Query"],
        resources: [this.table.tableArn],
        conditions: { "ForAllValues:StringLike": participantPartitions },
      }),
    );
    // Ticket 3.4: `GET /api/build` counts the queued builds ahead of the caller's: a count only (`Select` COUNT).
    conversation.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["dynamodb:Query"],
        resources: [this.table.tableArn],
        conditions: {
          "ForAllValues:StringEquals": { "dynamodb:LeadingKeys": [BUILD_QUEUE_PARTITION], "dynamodb:Attributes": [...QUEUE_COUNT_ATTRIBUTES] },
          StringEquals: { "dynamodb:Select": "COUNT" },
        },
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
    // Ticket 3.3: `GET /api/conversation` answers the budget left, so it reads the settings' caps (projected).
    addSettingsReadRights(conversation, this.table);
    addSessionCheckRights(conversation, this.table);
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
    // Ticket 2.7: a passed readiness check creates the build record (UpdateItem only, its listed attribute names, only
    // if absent by the code's condition) and sends its id to the launch queue.
    worker.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["dynamodb:UpdateItem"],
        resources: [this.table.tableArn],
        conditions: {
          "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["BUILD#*"] },
          "ForAllValues:StringEquals": { "dynamodb:Attributes": [...AI_WORKER_BUILD_UPDATE_ATTRIBUTES] },
          StringEqualsIfExists: { "dynamodb:ReturnValues": [...ATTRIBUTE_LIMITED_RETURN_VALUES] },
        },
      }),
    );
    // Ticket 3.6: the change build's transaction checks that the build it follows is live or failed (nothing running).
    worker.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["dynamodb:ConditionCheckItem"],
        resources: [this.table.tableArn],
        conditions: {
          "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["BUILD#*"] },
          "ForAllValues:StringEquals": { "dynamodb:Attributes": [...AI_WORKER_BUILD_CHECK_ATTRIBUTES] },
        },
      }),
    );
    // Ticket 3.3: the AI budget check before each AI call reads the settings' caps (projected; its spend and extra
    // budget come from the participant's own partition above).
    addSettingsReadRights(worker, this.table);
    worker.addToRolePolicy(
      new PolicyStatement({ effect: Effect.ALLOW, actions: ["bedrock:InvokeModel"], resources: [...BEDROCK_INVOKE_RESOURCES] }),
    );
    worker.addToRolePolicy(new PolicyStatement({ effect: Effect.ALLOW, actions: ["sqs:SendMessage"], resources: [BUILD_QUEUE_ARN] }));
    // Ticket 3.5: a job held by the global Stop goes back on the worker's own queue (with a delay), so the message stays
    // answerable after Resume without growing the queue's receive count.
    worker.addToRolePolicy(new PolicyStatement({ effect: Effect.ALLOW, actions: ["sqs:SendMessage"], resources: [aiQueue.queueArn] }));
    // One job per invocation, at most AI_WORKER_MAX_CONCURRENCY at once; the source grants the role the
    // consume rights on this queue only.
    worker.addEventSource(new SqsEventSource(aiQueue, { batchSize: 1, maxConcurrency: AI_WORKER_MAX_CONCURRENCY }));

    // Ticket 3.10: the facilitator routes. Reads sessions, profiles, conversations and messages (`PARTICIPANT#*`), a
    // nickname's participant id and a build's status (projected), lists by type through the index (projected, four
    // types only), puts Retry requests (`BUILD_RETRIES`), and updates in `PARTICIPANT#*` only the names Pause, Add budget,
    // Retry's note and a flag's decision need. The facilitator check is in the code (the role comes from the allow-list).
    const facilitator = workshopFunction(this, "Facilitator", FACILITATOR_FUNCTION_NAME, "facilitator.ts");
    facilitator.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["dynamodb:GetItem", "dynamodb:Query"],
        resources: [this.table.tableArn],
        conditions: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["PARTICIPANT#*"] } },
      }),
    );
    facilitator.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["dynamodb:GetItem"],
        resources: [this.table.tableArn],
        conditions: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["SESSION#*"] } },
      }),
    );
    for (const [prefix, names] of [
      ["NICK#*", FACILITATOR_NICK_READ_ATTRIBUTES],
      ["BUILD#*", FACILITATOR_BUILD_READ_ATTRIBUTES],
    ] as const) {
      facilitator.addToRolePolicy(
        new PolicyStatement({
          effect: Effect.ALLOW,
          actions: ["dynamodb:GetItem"],
          resources: [this.table.tableArn],
          conditions: {
            "ForAllValues:StringLike": { "dynamodb:LeadingKeys": [prefix] },
            "ForAllValues:StringEquals": { "dynamodb:Attributes": [...names] },
            StringEquals: { "dynamodb:Select": "SPECIFIC_ATTRIBUTES" },
          },
        }),
      );
    }
    // The index: a Query only, for the four types only (the index's partition key, `listType`, is the LeadingKeys value; the
    // Null guard refuses a request without one), projected.
    facilitator.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["dynamodb:Query"],
        resources: [`${this.table.tableArn}/index/${BY_TYPE_INDEX_NAME}`],
        conditions: {
          "ForAllValues:StringEquals": { "dynamodb:LeadingKeys": [...FACILITATOR_INDEX_TYPES], "dynamodb:Attributes": [...FACILITATOR_INDEX_READ_ATTRIBUTES] },
          Null: { "dynamodb:LeadingKeys": "false" },
          StringEquals: { "dynamodb:Select": "SPECIFIC_ATTRIBUTES" },
        },
      }),
    );
    facilitator.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["dynamodb:Query"],
        resources: [this.table.tableArn],
        conditions: {
          "ForAllValues:StringEquals": { "dynamodb:LeadingKeys": [BUILD_RETRIES_PARTITION], "dynamodb:Attributes": [...RETRY_REQUEST_ATTRIBUTES] },
          StringEquals: { "dynamodb:Select": "SPECIFIC_ATTRIBUTES" },
        },
      }),
    );
    facilitator.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["dynamodb:PutItem"],
        resources: [this.table.tableArn],
        conditions: {
          "ForAllValues:StringEquals": { "dynamodb:LeadingKeys": [BUILD_RETRIES_PARTITION], "dynamodb:Attributes": [...RETRY_REQUEST_ATTRIBUTES] },
          StringEqualsIfExists: { "dynamodb:ReturnValues": ["NONE"] },
        },
      }),
    );
    facilitator.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["dynamodb:UpdateItem"],
        resources: [this.table.tableArn],
        conditions: {
          "ForAllValues:StringLike": participantPartitions,
          "ForAllValues:StringEquals": { "dynamodb:Attributes": [...FACILITATOR_PARTICIPANT_UPDATE_ATTRIBUTES] },
          StringEqualsIfExists: { "dynamodb:ReturnValues": [...ATTRIBUTE_LIMITED_RETURN_VALUES] },
        },
      }),
    );
    // An approved flag goes to the AI worker, exactly as `npm run flags -- approve` sends it.
    facilitator.addToRolePolicy(new PolicyStatement({ effect: Effect.ALLOW, actions: ["sqs:SendMessage"], resources: [aiQueue.queueArn] }));
    addSettingsReadRights(facilitator, this.table);
    addSessionCheckRights(facilitator, this.table);
    const facilitatorIntegration = new HttpLambdaIntegration("FacilitatorIntegration", facilitator, { scopePermissionToRoute: false });
    for (const route of FACILITATOR_ROUTES) {
      this.api.addRoutes({ path: route.path, methods: [route.method], integration: facilitatorIntegration });
    }

    // Ticket 2.4: the data API for apps, reachable without sign-in by anyone with an app's address.
    // It reads the live marker (`APP#*`, written only by the deployer) and the app's data
    // (`APPDATA#*`), and puts, updates and deletes only in `APPDATA#*`, naming only the data items'
    // attribute names: it can neither make an app live nor take one off, nor touch other items.
    const appData = workshopFunction(this, "AppData", APP_DATA_FUNCTION_NAME, "app-data.ts");
    appData.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["dynamodb:GetItem"],
        resources: [this.table.tableArn],
        conditions: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["APP#*", "APPDATA#*"] } },
      }),
    );
    appData.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem"],
        resources: [this.table.tableArn],
        conditions: {
          "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["APPDATA#*"] },
          "ForAllValues:StringEquals": { "dynamodb:Attributes": [...APP_DATA_WRITE_ATTRIBUTES] },
        },
      }),
    );
    // Ticket 3.24: the write check reads an app write token by its hash (`app`, `nickname` and `expiresAt` only, with a
    // projection); nothing else in `APPTOKEN#*`, and nothing at all in `TOKENS#*`.
    appData.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["dynamodb:GetItem"],
        resources: [this.table.tableArn],
        conditions: {
          "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["APPTOKEN#*"] },
          "ForAllValues:StringEquals": { "dynamodb:Attributes": [...APP_TOKEN_READ_ATTRIBUTES] },
          StringEquals: { "dynamodb:Select": "SPECIFIC_ATTRIBUTES" },
        },
      }),
    );
    // One invoke permission scoped to this API (path parameter route, as for the participant routes).
    const appDataRoutes = this.api.addRoutes({
      path: APP_DATA_PATH,
      methods: [...APP_DATA_METHODS],
      integration: new HttpLambdaIntegration("AppDataIntegration", appData, { scopePermissionToRoute: false }),
    });

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
    const appDataThrottles = [
      [HttpMethod.PUT, APP_DATA_WRITE_THROTTLE],
      [HttpMethod.DELETE, APP_DATA_WRITE_THROTTLE],
      [HttpMethod.GET, APP_DATA_READ_THROTTLE],
      [HttpMethod.OPTIONS, APP_DATA_PREFLIGHT_THROTTLE],
    ] as const;
    for (const [method, throttle] of appDataThrottles) {
      cfnStage.addPropertyOverride(`RouteSettings.${method} ${APP_DATA_PATH}`, {
        ThrottlingRateLimit: throttle.rateLimit,
        ThrottlingBurstLimit: throttle.burstLimit,
      });
    }
    for (const route of [...signInCodeRoutes, ...signInVerifyRoutes, ...appDataRoutes]) cfnStage.node.addDependency(route);

    new CfnOutput(this, "ApiEndpoint", {
      description: "The API's own endpoint (https://<api id>.execute-api.<region>.amazonaws.com)",
      value: this.api.apiEndpoint,
    });
  }
}

/**
 * A read of the `SETTINGS` item (ticket 3.3): GetItem in the `SETTINGS` partition of `SETTINGS_READ_ATTRIBUTES` only,
 * with a projection (`dynamodb:Select` `SPECIFIC_ATTRIBUTES`), never a write.
 */
export function addSettingsReadRights(fn: NodejsFunction, table: Table): void {
  fn.addToRolePolicy(
    new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ["dynamodb:GetItem"],
      resources: [table.tableArn],
      conditions: {
        "ForAllValues:StringEquals": { "dynamodb:LeadingKeys": [SETTINGS_PARTITION], "dynamodb:Attributes": [...SETTINGS_READ_ATTRIBUTES] },
        StringEquals: { "dynamodb:Select": "SPECIFIC_ATTRIBUTES" },
      },
    }),
  );
}

/**
 * What the one session check needs beyond reading `SESSION#*` and `PARTICIPANT#*` (ticket 3.1): the caller's
 * allow-list entry, re-read at every call (GetItem in `EMAIL#*` of `role`, `group` and `participantId` only, with a
 * projection, so never `email`), and deleting a session (sign-out, or a person no longer on the list).
 */
export function addSessionCheckRights(fn: NodejsFunction, table: Table): void {
  fn.addToRolePolicy(
    new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ["dynamodb:GetItem"],
      resources: [table.tableArn],
      conditions: {
        "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["EMAIL#*"] },
        "ForAllValues:StringEquals": { "dynamodb:Attributes": [...SESSION_ALLOW_READ_ATTRIBUTES] },
        StringEquals: { "dynamodb:Select": "SPECIFIC_ATTRIBUTES" },
      },
    }),
  );
  fn.addToRolePolicy(
    new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ["dynamodb:DeleteItem"],
      resources: [table.tableArn],
      // The store's delete returns nothing (ticket 3.1 try 2): never the old session item (`ALL_OLD`).
      conditions: {
        "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["SESSION#*"] },
        StringEqualsIfExists: { "dynamodb:ReturnValues": ["NONE"] },
      },
    }),
  );
}

/**
 * A Node.js 22 arm64 function bundled by esbuild from platform/api/handlers, with
 * its own named role (only the right to write its logs; the caller adds what the
 * function needs; the app's aspect adds the path and boundary) and its own named log group with two weeks of retention.
 */
export function workshopFunction(
  scope: Construct,
  id: string,
  name: string,
  entry: string,
  memorySize = 256,
  timeoutSeconds = 10,
  commandHooks?: ICommandHooks,
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
    bundling: { minify: true, sourceMap: false, externalModules: [], ...(commandHooks === undefined ? {} : { commandHooks }) },
  });
}

/**
 * Ticket 3.4: the rights to free a build's slot (platform/api/build/slots.ts), for the deployer (the launcher has its own
 * wider statements; the builder task none): check the
 * build ended (ConditionCheckItem in `BUILD#*`, `status` only), delete its holder and count the counter down (in
 * `BUILD_SLOTS`, SLOT_RELEASE_ATTRIBUTES only). Transactions have no IAM action of their own: each item is authorized alone.
 */
export function slotReleaseStatements(tableArn: string): PolicyStatement[] {
  return [
    new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ["dynamodb:ConditionCheckItem"],
      resources: [tableArn],
      conditions: {
        "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["BUILD#*"] },
        "ForAllValues:StringEquals": { "dynamodb:Attributes": [...SLOT_RELEASE_CHECK_ATTRIBUTES] },
      },
    }),
    new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ["dynamodb:UpdateItem", "dynamodb:DeleteItem"],
      resources: [tableArn],
      conditions: {
        "ForAllValues:StringEquals": { "dynamodb:LeadingKeys": [BUILD_SLOTS_PARTITION], "dynamodb:Attributes": [...SLOT_RELEASE_ATTRIBUTES] },
        StringEqualsIfExists: { "dynamodb:ReturnValues": ["NONE"] },
      },
    }),
  ];
}
