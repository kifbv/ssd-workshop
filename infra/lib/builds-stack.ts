import { Duration, RemovalPolicy, Stack, type StackProps, Tags } from "aws-cdk-lib";
import { IpAddresses, type IVpc, Peer, Port, SecurityGroup, SubnetType, Vpc } from "aws-cdk-lib/aws-ec2";
import { Repository, TagStatus } from "aws-cdk-lib/aws-ecr";
import { Cluster, ContainerInsights } from "aws-cdk-lib/aws-ecs";
import { Secret } from "aws-cdk-lib/aws-secretsmanager";
import { Queue, QueueEncryption } from "aws-cdk-lib/aws-sqs";
import type { Construct } from "constructs";
import {
  BUILDER_IMAGES_KEPT,
  BUILDER_REPOSITORY_NAME,
  BUILD_DLQ_NAME,
  BUILD_QUEUE_NAME,
  BUILDS_AVAILABILITY_ZONES,
  BUILDS_CLUSTER_NAME,
  BUILDS_SECURITY_GROUP_NAME,
  BUILDS_VPC_CIDR,
  BUILDS_VPC_NAME,
  GITHUB_SECRET_NAME,
} from "./config.js";

/**
 * Visibility timeout of the launch queue (ticket 2.7). Its consumer, the build launcher, comes with ticket 2.9, which
 * sets this just above the launcher's timeout (rule in .claude/rules/infra.md); until then nothing consumes it.
 */
export const BUILD_QUEUE_VISIBILITY_SECONDS = 330;
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
  }
}
