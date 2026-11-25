# Final AWS infrastructure

The whole platform once every phase is built (spec sections 5 and 5A, phase briefs 0 to 2).
State on 24 November 2026: green is live, orange dashed is phase 2 (approved, being built),
grey dotted is phases 3 to 6 (in the spec, not yet briefed).

![SSD Workshop final AWS infrastructure](aws-final.png)

[aws-final.svg](aws-final.svg) is the source (hand-laid SVG, sharp at any zoom); `aws-final.png`
is the same picture at twice the size, for phones.

## How to read it

- **One address.** Everything is served from `workshop.rankly.games` through one CloudFront
  distribution: pages from the site bucket, `/api/*` from the HTTP API, `/apps/*` from the apps
  bucket (sandbox CSP), and `/globe/` and `/x/<nickname>/<app>/` from the k3s cluster. No other
  DNS record is needed.
- **Talk (live).** API Lambdas write to the one DynamoDB table; sign-in codes go out through SES;
  messages to the AI go through SQS to the AI worker, which calls Claude on Bedrock (EU inference
  profiles).
- **Build (phase 2).** After the readiness check, the launcher creates the participant's repository
  in the `ssd-workshop-apps` organization and starts a Fargate builder task. The coding agent has
  file tools and reads public https pages (WebFetch, ticket 2.15), with no shell and no credentials; the runner commits to GitHub, writes feed events and hands the commit to the
  deployer, which checks it and publishes it to the apps bucket. Only the deployer writes there.
- **Advanced (phase 4 and 6).** A k3s cluster on one EC2 instance, switched on by Franck. Each
  participant's repository CI builds an image to the GitHub container registry, and Flux deploys
  the repository's `deploy/` folder into that participant's namespace.
- **Guard rails.** The access stack (boundary on every role, OIDC deploy role for `main` only,
  Claude's IAM user, $100 budget) is applied by Franck alone.

Not drawn: the CDK assets bucket, dead-letter queues other than the AI one, and log groups per
function. Phases 3 and 5 add functions and pages but no new kind of AWS resource; the k3s
cluster's network placement is decided in the phase 4 brief.

## Mermaid version

The same structure as text, for quick edits (GitHub draws it).

```mermaid
flowchart TB
  people["Participants, facilitators, admin"] --> cf["CloudFront<br/>workshop.rankly.games"]
  dns["Route53 record"] -.-> cf
  cert["ACM certificate (us-east-1)"] -.-> cf

  subgraph euc1["AWS eu-central-1"]
    site["S3 site bucket"]
    apps["S3 apps bucket<br/>sandbox CSP"]:::p2
    api["API Gateway HTTP API"] --> fn["Lambdas: sign-in, participant,<br/>conversation, health"]
    api --> fn2["Lambdas: app data API, build feed"]:::p2
    api --> fn3["Lambdas: dashboard, flags,<br/>change requests, global stop"]:::later
    fn & fn2 & fn3 --> ddb[("DynamoDB ssd-workshop-data")]
    fn --> ses["SES sign-in code email"]
    fn --> aiq["SQS ai-messages"] --> worker["Lambda AI worker"]
    worker --> bedrock["Bedrock Claude<br/>EU inference profiles"]
    worker --> ddb
    worker -->|readiness passed| bq["SQS builds"]:::p2
    bq --> launcher["Lambda build launcher"]:::p2
    secret["Secrets Manager<br/>GitHub App key"]:::p2 --> launcher
    subgraph vpc["VPC, HTTPS out only, no NAT"]
      builder["ECS Fargate builder<br/>runner + coding agent"]:::p2
    end
    ecr["ECR builder image"]:::p2 --> builder
    launcher -->|RunTask| builder
    builder --> bedrock
    builder -->|feed events| ddb
    builder --> dq["SQS deploys"]:::p2 --> deployer["Lambda deployer"]:::p2
    deployer --> apps
    k3s["EC2 k3s: Flux, policy checks,<br/>globe, sample-data API"]:::later
  end

  cf -->|default| site
  cf -->|/api/*| api
  cf -->|/apps/*| apps
  cf -->|/globe/, /x/...| k3s

  subgraph gh["GitHub"]
    repo["kifbv/ssd-workshop<br/>CI + deploy"]
    org["ssd-workshop-apps<br/>repo per participant"]:::p2
    ghcr["Container registry"]:::later
    removal["Removal workflow"]:::later
  end
  launcher & builder & deployer -->|GitHub App token| org
  org --> ghcr --> k3s
  org -->|Flux watches deploy/| k3s
  repo -->|OIDC deploy role| euc1

  classDef p2 stroke:#b86e00,stroke-width:2px,stroke-dasharray:6 3,fill:#fff1d6
  classDef later stroke:#5b6472,stroke-width:2px,stroke-dasharray:2 3,fill:#eef0f4
```
