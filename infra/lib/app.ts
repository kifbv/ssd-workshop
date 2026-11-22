import { App, type AppProps, Aspects, Tags } from "aws-cdk-lib";
import { WorkshopIamAspect } from "./aspects.js";
import { AssetsStack } from "./assets-stack.js";
import {
  ACCOUNT,
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
 * Builds the workshop CDK app: the assets bucket, the site bucket with its pages
 * (eu-central-1) and the certificate, CloudFront and DNS record (us-east-1).
 * Every resource is tagged `project=ssd-workshop`; every role has the
 * `/ssd-workshop/` path and the `ssd-workshop-boundary` permissions boundary.
 */
export function buildApp(props?: AppProps): App {
  const app = new App(props);
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

  return app;
}
