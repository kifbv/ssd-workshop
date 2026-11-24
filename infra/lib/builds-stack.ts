import { Stack, type StackProps, Tags } from "aws-cdk-lib";
import { IpAddresses, type IVpc, Peer, Port, SecurityGroup, SubnetType, Vpc } from "aws-cdk-lib/aws-ec2";
import { Repository, TagStatus } from "aws-cdk-lib/aws-ecr";
import { Cluster, ContainerInsights } from "aws-cdk-lib/aws-ecs";
import type { Construct } from "constructs";
import {
  BUILDER_IMAGES_KEPT,
  BUILDER_REPOSITORY_NAME,
  BUILDS_AVAILABILITY_ZONES,
  BUILDS_CLUSTER_NAME,
  BUILDS_SECURITY_GROUP_NAME,
  BUILDS_VPC_CIDR,
  BUILDS_VPC_NAME,
} from "./config.js";

/**
 * Where build tasks run (ticket 2.1): a VPC with two public subnets and no NAT gateway
 * (tasks get a public IP), a security group that only lets HTTPS out, the ECS cluster
 * and the builder's image repository. No Lambda and no custom resource.
 */
export class BuildsStack extends Stack {
  readonly vpc: Vpc;
  readonly securityGroup: SecurityGroup;
  readonly cluster: Cluster;
  readonly repository: Repository;

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
  }
}
