import { fileURLToPath } from "node:url";
import { Duration, RemovalPolicy, Stack, type StackProps, Tags } from "aws-cdk-lib";
import { IpAddresses, type IVpc, Peer, Port, SecurityGroup, SubnetType, Vpc } from "aws-cdk-lib/aws-ec2";
import { Repository, TagStatus } from "aws-cdk-lib/aws-ecr";
import { Table } from "aws-cdk-lib/aws-dynamodb";
import {
  Cluster,
  ContainerImage,
  ContainerInsights,
  CpuArchitecture,
  FargateTaskDefinition,
  LogDrivers,
  OperatingSystemFamily,
} from "aws-cdk-lib/aws-ecs";
import { Effect, PolicyStatement, Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { SqsEventSource } from "aws-cdk-lib/aws-lambda-event-sources";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import { CfnSchedule } from "aws-cdk-lib/aws-scheduler";
import { Secret } from "aws-cdk-lib/aws-secretsmanager";
import { Queue, QueueEncryption } from "aws-cdk-lib/aws-sqs";
import type { Construct } from "constructs";
import { BEDROCK_INVOKE_RESOURCES, workshopFunction } from "./api-stack.js";
import {
  ACCOUNT,
  ATTRIBUTE_LIMITED_RETURN_VALUES,
  BUILD_CHECK_QUEUE_NAME,
  BUILD_CHECK_SCHEDULE_NAME,
  BUILD_CHECK_SCHEDULER_ROLE_NAME,
  BUILD_LAUNCHER_FUNCTION_NAME,
  BUILDER_BUILD_READ_ATTRIBUTES,
  BUILDER_BUILD_UPDATE_ATTRIBUTES,
  BUILDER_CONTAINER_NAME,
  BUILDER_CPU,
  BUILDER_EXECUTION_ROLE_NAME,
  BUILDER_IMAGE_DIGEST_CONTEXT,
  builderImageDigest,
  BUILDER_LOG_GROUP_NAME,
  BUILDER_MEMORY_MB,
  BUILDER_TASK_FAMILY,
  BUILDER_TASK_ROLE_NAME,
  BUILDER_USAGE_UPDATE_ATTRIBUTES,
  BUILDER_IMAGES_KEPT,
  BUILDER_REPOSITORY_NAME,
  BUILD_DLQ_NAME,
  BUILD_QUEUE_NAME,
  BUILDS_AVAILABILITY_ZONES,
  BUILDS_CLUSTER_NAME,
  BUILDS_SECURITY_GROUP_NAME,
  BUILDS_VPC_CIDR,
  BUILDS_VPC_NAME,
  DEPLOY_DLQ_NAME,
  DEPLOY_QUEUE_NAME,
  GITHUB_SECRET_NAME,
  LAUNCHER_BUILD_UPDATE_ATTRIBUTES,
  LAUNCHER_LAUNCH_ATTRIBUTES,
  LAUNCHER_READ_ATTRIBUTES,
  LAUNCHES_PARTITION,
  REGION,
  TABLE_NAME,
} from "./config.js";

/**
 * The build launcher's timeout (ticket 2.9): preparing the repository (a dozen GitHub calls, each at most 10 s, with
 * brief retries) and RunTask fit with room; GitHub calls stop LAUNCH_RESERVE_MS (20 s) before it, so a failure is
 * always written.
 */
export const LAUNCHER_TIMEOUT_SECONDS = 120;
export const LAUNCHER_MEMORY_MB = 512;
/** Visibility timeout of the launch queue (ticket 2.7): just above the launcher's timeout (ticket 2.9). */
export const BUILD_QUEUE_VISIBILITY_SECONDS = LAUNCHER_TIMEOUT_SECONDS + 30;
/** At most this many launches at once (one participant's launches run one at a time: a FIFO message group each). */
export const LAUNCHER_MAX_CONCURRENCY = 5;
/** EventBridge Scheduler runs the stuck-build check this often (criterion 3: a stopped task's build fails within 2 minutes). */
export const BUILD_CHECK_SCHEDULE = "rate(1 minute)";
/** Check messages are only triggers: one left unread for 5 minutes is dropped (a later one runs the check). */
export const BUILD_CHECK_RETENTION_SECONDS = 300;
/** The template the launcher commits (ticket 2.6), copied next to its bundled code as `template/`. */
export const TEMPLATE_DIR = fileURLToPath(new URL("../../templates/basic", import.meta.url));
/** Deliveries of one launch message before it goes to the dead-letter queue. */
export const BUILD_QUEUE_MAX_RECEIVES = 3;

/**
 * Where build tasks run (ticket 2.1): a VPC with two public subnets and no NAT gateway
 * (tasks get a public IP), a security group that only lets HTTPS out, the ECS cluster
 * and the builder's image repository. No Lambda and no custom resource. Since ticket 2.6 also the GitHub App's
 * secret, which build launches need, and since ticket 2.7 the launch queue (the AI worker sends to it by name).
 */
export class BuildsStack extends Stack {
  readonly vpc: Vpc;
  readonly securityGroup: SecurityGroup;
  readonly cluster: Cluster;
  readonly repository: Repository;
  readonly githubSecret: Secret;
  readonly buildQueue: Queue;
  readonly builderTask: FargateTaskDefinition;

  /**
   * The zones are fixed (config.ts). Without this override, `Vpc` checks its zones against
   * `Stack.availabilityZones`, which with an account in `env` asks AWS at synth time: CI has
   * no credentials, and the lookup would also write `cdk.context.json`.
   */
  override get availabilityZones(): string[] {
    return [...BUILDS_AVAILABILITY_ZONES];
  }

  constructor(scope: Construct, id: string, props: StackProps) {
    super(scope, id, props);

    this.vpc = new Vpc(this, "Vpc", {
      vpcName: BUILDS_VPC_NAME,
      ipAddresses: IpAddresses.cidr(BUILDS_VPC_CIDR),
      // Fixed zones (see the availabilityZones override above).
      availabilityZones: [...BUILDS_AVAILABILITY_ZONES],
      natGateways: 0,
      subnetConfiguration: [
        // Tasks ask for a public IP in RunTask (assignPublicIp); nothing else gets one by default.
        { name: "public", subnetType: SubnetType.PUBLIC, cidrMask: 24, mapPublicIpOnLaunch: false },
      ],
      // The VPC's default security group is created untagged, so the deploy rights cannot change
      // it, and restricting it needs a custom-resource Lambda. Build tasks never use it.
      restrictDefaultSecurityGroup: false,
    });
    // Each subnet and its route table are named `ssd-workshop-builds-public-<n>` (the tag reaches
    // the route table too); the internet gateway takes the VPC's name.
    this.vpc.publicSubnets.forEach((subnet, i) => {
      Tags.of(subnet).add("Name", `${BUILDS_VPC_NAME}-public-${String(i + 1)}`);
    });

    // aws-cdk-lib's Vpc does not satisfy exactOptionalPropertyTypes (vpnGatewayId): assert to IVpc.
    const vpc = this.vpc as IVpc;

    this.securityGroup = new SecurityGroup(this, "TaskSecurityGroup", {
      vpc,
      securityGroupName: BUILDS_SECURITY_GROUP_NAME,
      description: "SSD Workshop build tasks: outgoing HTTPS only",
      allowAllOutbound: false,
    });
    this.securityGroup.addEgressRule(Peer.anyIpv4(), Port.tcp(443), "HTTPS to GitHub and AWS");

    this.cluster = new Cluster(this, "Cluster", {
      clusterName: BUILDS_CLUSTER_NAME,
      vpc,
      containerInsightsV2: ContainerInsights.DISABLED,
    });

    this.repository = new Repository(this, "BuilderRepository", {
      repositoryName: BUILDER_REPOSITORY_NAME,
      imageScanOnPush: true,
      lifecycleRules: [
        {
          description: `Keep the newest ${String(BUILDER_IMAGES_KEPT)} images`,
          tagStatus: TagStatus.ANY,
          maxImageCount: BUILDER_IMAGES_KEPT,
        },
      ],
      // Default removal policy: RETAIN. No emptyOnDelete (it adds a custom-resource Lambda).
    });

    // Ticket 2.6. No value given: CloudFormation stores a random placeholder (secretsmanager:GetRandomPassword,
    // decision "(2.2)") until Franck loads the app's id and key. Retained, so a stack change never loses the key;
    // no resource policy (denied by the access stack) and no rotation (GitHub keys are rotated by hand).
    this.githubSecret = new Secret(this, "GitHubSecret", {
      secretName: GITHUB_SECRET_NAME,
      description: "SSD Workshop GitHub App credentials {appId, privateKey}; Franck loads the value (infra/README.md)",
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // Ticket 2.7: the launch queue. The AI worker (api stack) sends `{"buildId"}` here once a readiness check passed,
    // by the queue's fixed name (no cross-stack reference); the build launcher (ticket 2.9) consumes it. FIFO, with
    // the build id as deduplication id: a re-send after a failed send is dropped within 5 minutes.
    const buildDeadLetters = new Queue(this, "BuildsDlq", {
      queueName: BUILD_DLQ_NAME,
      fifo: true,
      encryption: QueueEncryption.SQS_MANAGED,
      retentionPeriod: Duration.days(14),
    });
    this.buildQueue = new Queue(this, "Builds", {
      queueName: BUILD_QUEUE_NAME,
      fifo: true,
      contentBasedDeduplication: false,
      encryption: QueueEncryption.SQS_MANAGED,
      visibilityTimeout: Duration.seconds(BUILD_QUEUE_VISIBILITY_SECONDS),
      retentionPeriod: Duration.days(1),
      deadLetterQueue: { queue: buildDeadLetters, maxReceiveCount: BUILD_QUEUE_MAX_RECEIVES },
    });

    // Ticket 2.9: the builder's task. Its image is the deploy workflow's push, named by digest.
    const digest = builderImageDigest(this.node.tryGetContext(BUILDER_IMAGE_DIGEST_CONTEXT));
    // Only tasks on the builds cluster may assume the builder's task role (ticket 2.9 try 2). Unverified until the first
    // live build: that ECS names the task's ARN as aws:SourceArn there; if a task fails with "ECS was unable to assume the
    // role", widen it to `arn:aws:ecs:<region>:<account>:*` (infra/README.md). The execution role keeps the account-wide
    // form AWS documents for it (ticket 2.9 try 3, checker 6): ECS may name another ARN when it pulls the image.
    const taskPrincipal = (sourceArn: string) =>
      new ServicePrincipal("ecs-tasks.amazonaws.com", {
        conditions: { StringEquals: { "aws:SourceAccount": ACCOUNT }, ArnLike: { "aws:SourceArn": sourceArn } },
      });
    const builderLogs = new LogGroup(this, "BuilderLogs", {
      logGroupName: BUILDER_LOG_GROUP_NAME,
      retention: RetentionDays.TWO_WEEKS,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    // The runner's rights (decision "Spec delta ... Builder"): the build model, its build record, the usage counters and
    // the deploy queue. Nothing else: no secret, no other table partition, no other queue.
    const taskRole = new Role(this, "BuilderTaskRole", {
      roleName: BUILDER_TASK_ROLE_NAME,
      assumedBy: taskPrincipal(`arn:aws:ecs:${REGION}:${ACCOUNT}:task/${BUILDS_CLUSTER_NAME}/*`),
      description: "The builder task's runner: the build model, its build record, usage counters, the deploy queue",
    });
    const executionRole = new Role(this, "BuilderExecutionRole", {
      roleName: BUILDER_EXECUTION_ROLE_NAME,
      assumedBy: taskPrincipal(`arn:aws:ecs:${REGION}:${ACCOUNT}:*`),
      description: "Starts the builder task: pulls its image and writes its logs",
    });
    const tableArn = Table.fromTableName(this, "Data", TABLE_NAME).tableArn;
    taskRole.addToPolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
        resources: [...BEDROCK_INVOKE_RESOURCES],
      }),
    );
    taskRole.addToPolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["dynamodb:GetItem"],
        resources: [tableArn],
        conditions: {
          "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["BUILD#*"] },
          "ForAllValues:StringEquals": { "dynamodb:Attributes": [...BUILDER_BUILD_READ_ATTRIBUTES] },
          StringEquals: { "dynamodb:Select": "SPECIFIC_ATTRIBUTES" },
        },
      }),
    );
    taskRole.addToPolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["dynamodb:UpdateItem"],
        resources: [tableArn],
        conditions: {
          "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["BUILD#*"] },
          "ForAllValues:StringEquals": { "dynamodb:Attributes": [...BUILDER_BUILD_UPDATE_ATTRIBUTES] },
          StringEqualsIfExists: { "dynamodb:ReturnValues": ["NONE"] },
        },
      }),
    );
    taskRole.addToPolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["dynamodb:UpdateItem"],
        resources: [tableArn],
        conditions: {
          "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["PARTICIPANT#*"] },
          "ForAllValues:StringEquals": { "dynamodb:Attributes": [...BUILDER_USAGE_UPDATE_ATTRIBUTES] },
          StringEqualsIfExists: { "dynamodb:ReturnValues": ["NONE"] },
        },
      }),
    );
    taskRole.addToPolicy(
      new PolicyStatement({ effect: Effect.ALLOW, actions: ["sqs:SendMessage"], resources: [`arn:aws:sqs:${REGION}:${ACCOUNT}:${DEPLOY_QUEUE_NAME}`] }),
    );
    this.builderTask = new FargateTaskDefinition(this, "BuilderTask", {
      family: BUILDER_TASK_FAMILY,
      cpu: BUILDER_CPU,
      memoryLimitMiB: BUILDER_MEMORY_MB,
      taskRole,
      executionRole,
      runtimePlatform: { cpuArchitecture: CpuArchitecture.X86_64, operatingSystemFamily: OperatingSystemFamily.LINUX },
    });
    // No environment and no secrets: the launcher passes the build id and its one-repository token at start.
    this.builderTask.addContainer("Builder", {
      containerName: BUILDER_CONTAINER_NAME,
      image: ContainerImage.fromEcrRepository(this.repository, digest),
      essential: true,
      logging: LogDrivers.awsLogs({ streamPrefix: "builder", logGroup: builderLogs }),
    });

    // Ticket 2.9: the build launcher, fed by the launch queue and, every minute, by the check queue.
    const checkQueue = new Queue(this, "BuildsCheck", {
      queueName: BUILD_CHECK_QUEUE_NAME,
      encryption: QueueEncryption.SQS_MANAGED,
      visibilityTimeout: Duration.seconds(BUILD_QUEUE_VISIBILITY_SECONDS),
      retentionPeriod: Duration.seconds(BUILD_CHECK_RETENTION_SECONDS),
    });
    const launcher = workshopFunction(this, "Launcher", BUILD_LAUNCHER_FUNCTION_NAME, "builds-launcher.ts", LAUNCHER_MEMORY_MB, LAUNCHER_TIMEOUT_SECONDS, {
      beforeBundling: () => [],
      beforeInstall: () => [],
      // The template the launcher commits travels with its code (decision "(2.6) Template files are an input").
      afterBundling: (_inputDir: string, outputDir: string) => [`cp -R "${TEMPLATE_DIR}" "${outputDir}/template"`],
    });
    launcher.addEnvironment("BUILDER_TASK_DEFINITION_ARN", this.builderTask.taskDefinitionArn);
    launcher.addEnvironment("BUILDS_SECURITY_GROUP_ID", this.securityGroup.securityGroupId);
    // The one reader of the GitHub App's key (the boundary denies every other role, decision "(2.6)").
    launcher.addToRolePolicy(new PolicyStatement({ effect: Effect.ALLOW, actions: ["secretsmanager:GetSecretValue"], resources: [this.githubSecret.secretArn] }));
    launcher.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["dynamodb:GetItem"],
        resources: [tableArn],
        conditions: {
          "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["BUILD#*", "PARTICIPANT#*"] },
          "ForAllValues:StringEquals": { "dynamodb:Attributes": [...LAUNCHER_READ_ATTRIBUTES] },
          StringEquals: { "dynamodb:Select": "SPECIFIC_ATTRIBUTES" },
        },
      }),
    );
    launcher.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["dynamodb:UpdateItem"],
        resources: [tableArn],
        conditions: {
          "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["BUILD#*"] },
          "ForAllValues:StringEquals": { "dynamodb:Attributes": [...LAUNCHER_BUILD_UPDATE_ATTRIBUTES] },
          StringEqualsIfExists: { "dynamodb:ReturnValues": [...ATTRIBUTE_LIMITED_RETURN_VALUES] },
        },
      }),
    );
    launcher.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:Query"],
        resources: [tableArn],
        conditions: {
          "ForAllValues:StringEquals": { "dynamodb:LeadingKeys": [LAUNCHES_PARTITION], "dynamodb:Attributes": [...LAUNCHER_LAUNCH_ATTRIBUTES] },
          StringEqualsIfExists: { "dynamodb:ReturnValues": [...ATTRIBUTE_LIMITED_RETURN_VALUES] },
        },
      }),
    );
    launcher.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["ecs:RunTask"],
        resources: [this.builderTask.taskDefinitionArn],
        conditions: { ArnEquals: { "ecs:cluster": this.cluster.clusterArn } },
      }),
    );
    const buildTasks = `arn:aws:ecs:${REGION}:${ACCOUNT}:task/${BUILDS_CLUSTER_NAME}/*`;
    launcher.addToRolePolicy(
      new PolicyStatement({ effect: Effect.ALLOW, actions: ["ecs:TagResource"], resources: [buildTasks], conditions: { StringEquals: { "ecs:CreateAction": "RunTask" } } }),
    );
    launcher.addToRolePolicy(new PolicyStatement({ effect: Effect.ALLOW, actions: ["ecs:DescribeTasks", "ecs:StopTask"], resources: [buildTasks] }));
    launcher.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["iam:PassRole"],
        resources: [taskRole.roleArn, executionRole.roleArn],
        conditions: { StringEquals: { "iam:PassedToService": "ecs-tasks.amazonaws.com" } },
      }),
    );
    // The stuck-build check reads the two dead-letter queues (and removes what it handled).
    launcher.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["sqs:ReceiveMessage", "sqs:DeleteMessage"],
        resources: [buildDeadLetters.queueArn, `arn:aws:sqs:${REGION}:${ACCOUNT}:${DEPLOY_DLQ_NAME}`],
      }),
    );
    // One message per invocation; the sources grant the consume rights on these two queues only.
    launcher.addEventSource(new SqsEventSource(this.buildQueue, { batchSize: 1, maxConcurrency: LAUNCHER_MAX_CONCURRENCY }));
    launcher.addEventSource(new SqsEventSource(checkQueue, { batchSize: 1, maxConcurrency: 2 }));

    // Every minute, EventBridge Scheduler drops a trigger on the check queue (a Lambda cannot be invoked by a workload
    // role: the boundary has no lambda:InvokeFunction). Its role may only send to that queue.
    const schedulerRole = new Role(this, "BuildsCheckSchedulerRole", {
      roleName: BUILD_CHECK_SCHEDULER_ROLE_NAME,
      // Only its own schedule (in the default group) may use it (ticket 2.9 try 2).
      assumedBy: new ServicePrincipal("scheduler.amazonaws.com", {
        conditions: {
          StringEquals: { "aws:SourceAccount": ACCOUNT, "aws:SourceArn": `arn:aws:scheduler:${REGION}:${ACCOUNT}:schedule/default/${BUILD_CHECK_SCHEDULE_NAME}` },
        },
      }),
      description: "Sends the stuck-build check's trigger to its queue every minute",
    });
    schedulerRole.addToPolicy(new PolicyStatement({ effect: Effect.ALLOW, actions: ["sqs:SendMessage"], resources: [checkQueue.queueArn] }));
    new CfnSchedule(this, "BuildsCheckSchedule", {
      name: BUILD_CHECK_SCHEDULE_NAME,
      description: "SSD Workshop: run the build launcher's stuck-build check",
      scheduleExpression: BUILD_CHECK_SCHEDULE,
      flexibleTimeWindow: { mode: "OFF" },
      state: "ENABLED",
      target: { arn: checkQueue.queueArn, roleArn: schedulerRole.roleArn, input: "{}" },
    });
  }
}
