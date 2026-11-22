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
  `ssd-workshop-cdk-assets-*` bucket.
- A new paid AWS service or a cost estimate above $50/month is a Stop-and-ask case.
- `cdk synth` fails with "This app contains no stacks" on an empty app; keep at least one stack.
- aws-cdk-lib types break `exactOptionalPropertyTypes` (e.g. passing a synthesizer): assert to the
  CDK interface at the call site (`as IStackSynthesizer`); never turn the flag off.
- Give every named resource an explicit name starting `ssd-workshop-` (CloudFront functions, ECS
  clusters and task definition families, schedule groups, ...): CDK's generated names drop the
  dashes (`ssdworkshopsite...`), which the access policy refuses.
- CDK `crossRegionReferences` writes SSM parameters under `/cdk/exports/...`, outside the allowed
  `/ssd-workshop/*`: pass the us-east-1 certificate another way (e.g. a fixed parameter under
  `/ssd-workshop/`).
- API Gateway: CDK's `RestApi` creates an account-wide CloudWatch role (`PATCH /account`) unless
  `cloudWatchRole: false`; the access policy refuses it. The deploy job uses no GitHub environment
  (the role trusts only `refs/heads/main`).
