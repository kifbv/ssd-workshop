import { App, type AppProps, Aspects, Tags } from "aws-cdk-lib";
import { AlertsStack } from "./alerts-stack.js";
import { ApiStack } from "./api-stack.js";
import { WorkshopIamAspect } from "./aspects.js";
import { AppsStack } from "./apps-stack.js";
import { AssetsStack } from "./assets-stack.js";
import { BuildsStack } from "./builds-stack.js";
import {
  ACCOUNT,
  BUILDER_IMAGE_DIGEST_CONTEXT,
  builderImageDigest,
  DOMAIN,
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
 * Builds the workshop CDK app: the assets bucket, the site bucket with its pages,
 * the data table and HTTP API (eu-central-1) and the certificate, CloudFront and
 * DNS record (us-east-1), the build network, cluster and image repository
 * (eu-central-1, ticket 2.1), the apps bucket with its deployer (eu-central-1, ticket 2.5), and the web ACL
 * (edge stack) and cost anomaly alerts (us-east-1, ticket 3.13).
 * Every resource is tagged `project=ssd-workshop`; every role has the
 * `/ssd-workshop/` path and the `ssd-workshop-boundary` permissions boundary.
 */
export function buildApp(props?: AppProps): App {
  const app = new App(props);
  // Checked before any stack is built (bundling every Lambda takes seconds); the builds stack uses the same rule.
  builderImageDigest(app.node.tryGetContext(BUILDER_IMAGE_DIGEST_CONTEXT));
  Tags.of(app).add(TAG_KEY, TAG_VALUE);
  // One mechanism for every role, also those CDK constructs create (see aspects.ts).
  Aspects.of(app).add(new WorkshopIamAspect());

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
    description: `SSD Workshop: certificate, CloudFront and the ${DOMAIN} record`,
  });
  edge.addStackDependency(site);

  // Has a file asset (the bundled Lambda code), so it uses the assets bucket.
  const api = new ApiStack(app, STACK_NAMES.api, {
    env: { account: ACCOUNT, region: REGION },
    synthesizer: assetsBucketSynthesizer(),
    description: "SSD Workshop: data table, HTTP API and its Lambda functions",
  });
  api.addStackDependency(assets);

  // Ticket 2.5: the apps bucket, the deploy queue and the deployer (bundled Lambda code, so the assets
  // bucket). It finds the table by name; the edge stack serves the bucket at /apps/*, so it comes after.
  const apps = new AppsStack(app, STACK_NAMES.apps, {
    env: { account: ACCOUNT, region: REGION },
    synthesizer: assetsBucketSynthesizer(),
    description: "SSD Workshop: apps bucket, deploy queue and the deployer",
  });
  apps.addStackDependency(assets);
  edge.addStackDependency(apps);

  // Ticket 2.9 adds the build launcher (bundled Lambda code), so the assets bucket; it finds the table and the
  // deploy queue by name.
  const builds = new BuildsStack(app, STACK_NAMES.builds, {
    env: { account: ACCOUNT, region: REGION },
    synthesizer: assetsBucketSynthesizer(),
    description: "SSD Workshop: build network, ECS cluster, builder image, task and launcher",
  });
  builds.addStackDependency(assets);

  // Ticket 3.13: Cost Anomaly Detection (us-east-1, Cost Explorer's home; no file assets, so an inline template). It
  // takes nothing from the other stacks; declared last, so `cdk deploy --all` reaches it after the others (a missing
  // alert address parameter then fails this stack alone).
  new AlertsStack(app, STACK_NAMES.alerts, {
    env: { account: ACCOUNT, region: EDGE_REGION },
    synthesizer: inlineTemplateSynthesizer(),
    description: "SSD Workshop: cost anomaly monitor on project=ssd-workshop and its daily email",
  });

  return app;
}
