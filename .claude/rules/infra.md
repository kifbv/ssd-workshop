---
paths:
  - "infra/**"
---

# Infrastructure rules

- Never deploy from a session: no `cdk deploy`, `cdk destroy`, `cdk bootstrap` or CloudFormation
  writes. Workshop stacks deploy only from `main` (ticket 0.5).
- `infra/access/access-stack.yaml` is applied by Franck only, never by CI or a session.
- Every resource is named `ssd-workshop-*` and tagged `project=ssd-workshop`; every IAM role
  carries the `ssd-workshop-boundary` permissions boundary.
- Region `eu-central-1`; only CloudFront certificates live in `us-east-1`.
- DNS: only the `workshop.rankly.games` record and its certificate validation records may change.
- No account-wide CDK bootstrap: use `CliCredentialsStackSynthesizer` with the
  `ssd-workshop-cdk-assets-*` bucket for stacks with file assets. It also uploads the template
  there, so asset-free stacks in another region (or the one creating the bucket) use
  `LegacyStackSynthesizer` (inline template) and must keep no file assets.
- Never use `crossRegionReferences`: it writes SSM `/cdk/exports/*` through a Lambda the boundary
  forbids. Look resources up by fixed name instead.
- CDK constructs that bring their own Lambda (BucketDeployment, custom resources) need explicit
  `ssd-workshop-*` names on the function, role and layer (escape hatch): CloudFormation names a
  layer after its logical id, outside the deploy policy.
- A new paid AWS service or a cost estimate above $50/month is a Stop-and-ask case.
- `cdk synth` fails with "This app contains no stacks" on an empty app; keep at least one stack.
- aws-cdk-lib types break `exactOptionalPropertyTypes` (e.g. passing a synthesizer): assert to the
  CDK interface at the call site (`as IStackSynthesizer`); never turn the flag off.
- CDK generates names for some resources that take no name by default (e.g. the Origin Access
  Control of `S3BucketOrigin.withOriginAccessControl`): pass an explicitly named construct. The
  names test checks every `*Name` key at any depth.
