import {
  App,
  type AppProps,
  CliCredentialsStackSynthesizer,
  type IStackSynthesizer,
  Stack,
  Tags,
} from "aws-cdk-lib";

export const REGION = "eu-central-1";

/**
 * Builds the workshop CDK app. Every resource is tagged `project=ssd-workshop`.
 * Stacks use our own assets bucket instead of the account-wide CDK bootstrap
 * (see docs/decisions.md). The site stack is empty until ticket 0.4 fills it;
 * the CDK CLI refuses to synthesize an app with no stacks.
 */
export function buildApp(props?: AppProps): App {
  const app = new App(props);
  Tags.of(app).add("project", "ssd-workshop");

  new Stack(app, "ssd-workshop-site", {
    env: { region: REGION },
    // aws-cdk-lib's declarations do not satisfy exactOptionalPropertyTypes
    // (bootstrapQualifier), so the synthesizer is asserted to its interface.
    synthesizer: new CliCredentialsStackSynthesizer({
      fileAssetsBucketName: "ssd-workshop-cdk-assets-${AWS::AccountId}",
    }) as IStackSynthesizer,
  });

  return app;
}
