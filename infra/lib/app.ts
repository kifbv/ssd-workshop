import { App, type AppProps, Stack, Tags } from "aws-cdk-lib";
import { ManagedPolicy, PermissionsBoundary } from "aws-cdk-lib/aws-iam";
import { AssetsStack } from "./assets-stack.js";
import {
  ACCOUNT,
  BOUNDARY_ARN,
  EDGE_REGION,
  REGION,
  STACK_NAMES,
  TAG_KEY,
  TAG_VALUE,
} from "./config.js";
import { EdgeStack } from "./edge-stack.js";
import { SiteStack } from "./site-stack.js";
import { assetsBucketSynthesizer, inlineTemplateSynthesizer } from "./synthesizer.js";

export { REGION, EDGE_REGION } from "./config.js";

/**
 * Builds the workshop CDK app: the assets bucket, the site bucket with its pages
 * (eu-central-1) and the certificate, CloudFront and DNS record (us-east-1).
 * Every resource is tagged `project=ssd-workshop` and every role carries the
 * `ssd-workshop-boundary` permissions boundary.
 */
export function buildApp(props?: AppProps): App {
  const app = new App(props);
  Tags.of(app).add(TAG_KEY, TAG_VALUE);

  const assets = new AssetsStack(app, STACK_NAMES.assets, {
    env: { account: ACCOUNT, region: REGION },
    synthesizer: inlineTemplateSynthesizer(),
    description: "SSD Workshop: bucket for CDK file assets",
  });

  const site = new SiteStack(app, STACK_NAMES.site, {
    env: { account: ACCOUNT, region: REGION },
    synthesizer: assetsBucketSynthesizer(),
    description: "SSD Workshop: private site bucket and its pages",
  });
  site.addStackDependency(assets);

  const edge = new EdgeStack(app, STACK_NAMES.edge, {
    env: { account: ACCOUNT, region: EDGE_REGION },
    synthesizer: inlineTemplateSynthesizer(),
    description: "SSD Workshop: certificate, CloudFront and the workshop.rankly.games record",
  });
  edge.addStackDependency(site);

  // An imported policy must live in a stack, so the boundary is applied per stack;
  // it reaches every role in it, including those CDK constructs create.
  for (const stack of app.node.children.filter(Stack.isStack)) {
    PermissionsBoundary.of(stack).apply(
      ManagedPolicy.fromManagedPolicyArn(stack, "Boundary", BOUNDARY_ARN),
    );
  }

  return app;
}
