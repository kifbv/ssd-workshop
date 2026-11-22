import {
  CliCredentialsStackSynthesizer,
  type IStackSynthesizer,
  LegacyStackSynthesizer,
} from "aws-cdk-lib";
import { ASSETS_BUCKET_NAME } from "./config.js";

// aws-cdk-lib's declarations do not satisfy exactOptionalPropertyTypes
// (bootstrapQualifier), so synthesizers are asserted to their interface.

/**
 * For stacks with file assets (site): deploys with the caller's own credentials and
 * uploads assets, and the template, to our assets bucket in eu-central-1 instead of
 * the account-wide CDK bootstrap (see docs/decisions.md). The bucket name comes
 * from config.ts, the one place that names the account.
 */
export function assetsBucketSynthesizer(): IStackSynthesizer {
  return new CliCredentialsStackSynthesizer({
    fileAssetsBucketName: ASSETS_BUCKET_NAME,
  }) as IStackSynthesizer;
}

/**
 * For stacks without file assets (cdk-assets, edge): the CLI sends the template
 * inline with the caller's credentials. The CliCredentials synthesizer would
 * upload the template to the assets bucket, which does not exist before the
 * cdk-assets stack and is in the wrong region for the us-east-1 edge stack.
 * Adding a file asset to such a stack would need the CDK bootstrap; a test
 * guards against it.
 */
export function inlineTemplateSynthesizer(): IStackSynthesizer {
  return new LegacyStackSynthesizer() as IStackSynthesizer;
}
