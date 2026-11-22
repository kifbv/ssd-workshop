# Decisions

Choices made while building that the specification left open. Newest phase first.

## How changes are made

- **Spec signed off (2026-11-22):** [AI Workshop Platform: Spec](https://claude.ai/artifact/6mNkKPKQysWNoj7eL6Gyus), signed off by Franck, all 23 confirm-or-correct points confirmed.
- **Workflow:** each phase starts with a brief in `docs/phases/` and one round of questions.
  During a ticket, choices that can be undone are decided, recorded here and listed for veto in
  the pull request; only the cases under "Stop and ask" in `CLAUDE.md` wait for Franck. Each
  ticket is built in fresh-session tries and judged by the `checker` agent, at most 3 tries.
- **Spec deltas:** a change to signed-off behaviour is recorded here as ADDED, CHANGED or REMOVED,
  with the date and the pull request.

## Phase 0: foundations

- **AWS access:** least-privilege CloudFormation stack `ssd-workshop-access` (`infra/access/access-stack.yaml`): permissions boundary, GitHub OIDC deploy role limited to `main`, IAM user for Claude's sessions, $100/month budget. Rights are limited to `ssd-workshop-*` names, the `project=ssd-workshop` tag and DNS under `workshop.rankly.games`; the stack protects itself from the deploy role.
- **No CDK bootstrap roles:** CDK uses `CliCredentialsStackSynthesizer` with our own `ssd-workshop-cdk-assets-*` bucket, so deploys run with the least-privilege role instead of the account-wide `cdk-hnb659fds-*` roles.
- **Licence:** MIT, since the repository is public for the pitch.
- **Platform language:** TypeScript for infrastructure, API and web pages, so the platform is one language end to end; advanced participant apps use Python. (Franck, 2026-11-22)
- **SES:** already in production mode for rankly.games, so codes can go to any allow-listed address; sender `ssd-workshop@rankly.games`. (Franck, 2026-11-22)
- **Access stack split:** the deploy rights are two managed policies (`ssd-workshop-deploy` and `ssd-workshop-deploy-edge`), because IAM caps one managed policy at 6,144 characters.
- **Workspaces:** npm workspaces `infra` and `platform`; `templates/` holds only a README and becomes a workspace when it gets code.
- **Checks at the root:** one ESLint flat config (`@eslint/js` recommended + typescript-eslint strict), one strict `tsconfig.base.json` with a root `tsconfig.json` covering `infra/` and `platform/`, and vitest run from the root with `--passWithNoTests`. A workspace gets its own `tsconfig.json` when it gets code.
- **Tool versions:** ESLint 10, TypeScript 5.9 (typescript-eslint supports TypeScript below 6.1), vitest 5 (vitest 3 pulls a critical `tinypool` advisory).
- **Deny rules:** `.claude/settings.json` denies `cdk deploy/destroy/bootstrap`, `aws iam`, every CloudFormation stack write (not only `ssd-workshop-access`, since workshop stacks deploy from `main`), Route53 record changes, pushes to `main`, force pushes, and reading `.env*`, `secrets/`, keys and `~/.aws/credentials`.
- **Plugin for every session:** `.claude/settings.json` enables `spec-driven@cadenceworks` from the `cadenceworks-dev/claude-workflow` marketplace for local sessions; cloud sessions take it from the claude.ai account.
- **Path rules:** `.claude/rules/infra.md`, `platform.md` and `templates.md`.
- **Allowed without asking:** `.claude/settings.json` lets Claude sessions run `npm ci`, `npm run lint`, `npm run typecheck` and `npm test` without a permission prompt, since they touch only the working tree and the npm cache.
- **Engines:** `package.json` requires Node 22.21 or newer (built-in `proxyEnv`, used by the smoke script behind a proxy) and npm 10 or newer, the versions CI and the cloud sessions use.
- **Limits of the deny rules:** `Read(...)` denies cover Claude's file tools; a shell `cat .env` or an `aws --profile x iam ...` form is not guaranteed to be caught. The real controls are that no secrets live in the repository and that the AWS user's least-privilege policy refuses what it must not do.
- **CI:** one GitHub Actions job `ci` on every pull request (npm ci, lint, type check, tests, `cdk synth`, `cfn-lint` on the access stack), so branch protection needs one required check. `permissions: contents: read` only, no AWS credentials, checkout without persisted credentials; cfn-lint pinned (`cfn-lint==1.61.0`) and installed with pip; actions pinned to major versions.
- **CDK runner:** `tsx` runs `infra/bin/app.ts` (`cdk.json` `app`), because it runs our ESM + `NodeNext` TypeScript with no extra config, where ts-node needs an ESM loader setup.
- **First stack:** the CDK CLI refuses to synthesize an app with no stacks, so the app holds one empty `ssd-workshop-site` stack (eu-central-1, `CliCredentialsStackSynthesizer` with the `ssd-workshop-cdk-assets-<account>` bucket, `project=ssd-workshop` tag on the whole app) that ticket 0.4 fills.
- **CDK and strict types:** aws-cdk-lib's declarations break `exactOptionalPropertyTypes`, so a synthesizer is asserted to `IStackSynthesizer` at the call site instead of turning the flag off. `@types/node` 22 is a root dev dependency for Node built-ins in tests.
- **Smoke checks (0.6):** `npm run -s smoke -- bedrock | quota | ses <address>` at the root runs `platform/src/smoke/main.ts` with `tsx`; the rules (arguments, quota matching, masking, latency) are pure functions in `logic.ts` with vitest tests, the AWS calls stay thin. Unknown command or missing address prints usage and exits 1, before any AWS call.
- **Smoke run silently:** npm echoes every script's command line (`> tsx src/smoke/main.ts ses jane@...`), which would print the recipient address. The root script calls the workspace with `npm run -s`, which silences the inner echo; the outer echo can only be silenced by the caller, so the command is documented (usage text, `main.ts` header, here) as `npm run -s smoke -- ses <address>`.
- **Smoke model:** defaults to `eu.anthropic.claude-sonnet-5-5` (latest Sonnet, EU inference profile, as the spec says Sonnet), overridable with `SMOKE_MODEL_ID`. Its applied cross-region tokens-per-minute quota in eu-central-1 is 0 (AWS default 6,000,000), so until a quota increase is granted `bedrock` needs `SMOKE_MODEL_ID=eu.anthropic.claude-sonnet-4-6`; an id that does not start with `eu.anthropic.` is refused. Converse API, one-word prompt, `maxTokens` 16.
- **Smoke quotas:** matched by name on Service Quotas code `bedrock`: `Cross-region model inference tokens|requests per minute for Anthropic Claude <Family> <x.y>`, optional ` V1`; the `Global cross-region` and `1M Context Length` variants are left out, since `eu.*` profiles are geographic cross-region. Prints the applied value next to the AWS default. Sonnet 5.5 has no requests-per-minute quota in the list, so the script says so.
- **Smoke email:** SESv2 `SendEmail` from `ssd-workshop@rankly.games`, subject "SSD Workshop smoke test", a random sample 6-digit code. The recipient is printed masked (`f***@e***.com`); error messages are printed with credentials in URLs replaced (`scheme://***@`) and addresses masked; the MessageId is printed. Limit: the script masks only its own output; npm's command echo shows the full address unless the command is run with `npm run -s` (see "Smoke run silently").
- **Smoke proof without a real inbox:** the SES mailbox simulator (`success@simulator.amazonses.com`) only proves that SES accepted the send from `ssd-workshop@rankly.games`. The two `ses` acceptance criteria (arrival at a verified and at an unverified real address) need Franck to run the command and check the inboxes.
- **Smoke dependencies:** `@aws-sdk/client-bedrock-runtime`, `@aws-sdk/client-service-quotas`, `@aws-sdk/client-sesv2` (official AWS SDK v3 clients) as platform dependencies; `tsx` as a platform dev dependency, as in `infra`.
- **AWS SDK behind a proxy:** the SDK ignores `HTTPS_PROXY`; when it (or lowercase `https_proxy`) is set, the clients get an `https.Agent` with Node's built-in `proxyEnv` (Node 22.21+), so no proxy-agent dependency is needed.
