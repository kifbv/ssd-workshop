import { App, Aspects, Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { CfnRole, InstanceProfile, Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { describe, expect, it } from "vitest";
import { WorkshopIamAspect } from "./aspects.js";
import { BOUNDARY_ARN, IAM_PATH } from "./config.js";

describe("WorkshopIamAspect", () => {
  const app = new App();
  const stack = new Stack(app, "ssd-workshop-aspect-test");
  const role = new Role(stack, "L2Role", {
    roleName: "ssd-workshop-l2",
    path: "/",
    assumedBy: new ServicePrincipal("lambda.amazonaws.com"),
  });
  new CfnRole(stack, "RawRole", {
    roleName: "ssd-workshop-raw",
    assumeRolePolicyDocument: { Statement: [] },
  });
  new InstanceProfile(stack, "Profile", { instanceProfileName: "ssd-workshop-profile", role });
  Aspects.of(app).add(new WorkshopIamAspect());
  const template = Template.fromStack(stack);

  it("sets the /ssd-workshop/ path and the boundary on every role, L2 or raw", () => {
    const roles = Object.values(template.findResources("AWS::IAM::Role"));
    expect(roles).toHaveLength(2);
    for (const r of roles) {
      expect(r.Properties).toMatchObject({ Path: IAM_PATH, PermissionsBoundary: BOUNDARY_ARN });
    }
  });

  it("sets the /ssd-workshop/ path on every instance profile", () => {
    const profiles = Object.values(template.findResources("AWS::IAM::InstanceProfile"));
    expect(profiles).toHaveLength(1);
    expect(profiles[0]?.Properties).toMatchObject({ Path: IAM_PATH });
  });
});
