import type { IAspect } from "aws-cdk-lib";
import { CfnInstanceProfile, CfnRole } from "aws-cdk-lib/aws-iam";
import type { IConstruct } from "constructs";
import { BOUNDARY_ARN, IAM_PATH } from "./config.js";

/**
 * Puts every IAM role, including the raw `AWS::IAM::Role` that CDK constructs
 * such as `BucketDeployment` create, under the `/ssd-workshop/` path with the
 * `ssd-workshop-boundary` permissions boundary, and every instance profile under
 * the same path. The deploy rights only reach `role/ssd-workshop/*` and only
 * create roles that carry the boundary. Applied once, to the whole app.
 */
export class WorkshopIamAspect implements IAspect {
  visit(node: IConstruct): void {
    if (node instanceof CfnRole) {
      node.addPropertyOverride("Path", IAM_PATH);
      node.addPropertyOverride("PermissionsBoundary", BOUNDARY_ARN);
    } else if (node instanceof CfnInstanceProfile) {
      node.addPropertyOverride("Path", IAM_PATH);
    }
  }
}
