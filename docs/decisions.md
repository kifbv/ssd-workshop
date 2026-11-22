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
- **Engines:** `package.json` requires Node 22 or newer and npm 10 or newer, the versions CI and the cloud sessions use.
- **Limits of the deny rules:** `Read(...)` denies cover Claude's file tools; a shell `cat .env` or an `aws --profile x iam ...` form is not guaranteed to be caught. The real controls are that no secrets live in the repository and that the AWS user's least-privilege policy refuses what it must not do.
- **CI:** one GitHub Actions job `ci` on every pull request (npm ci, lint, type check, tests, `cdk synth`, `cfn-lint` on the access stack), so branch protection needs one required check. `permissions: contents: read` only, no AWS credentials, checkout without persisted credentials; cfn-lint pinned (`cfn-lint==1.61.0`) and installed with pip; actions pinned to major versions.
- **CDK runner:** `tsx` runs `infra/bin/app.ts` (`cdk.json` `app`), because it runs our ESM + `NodeNext` TypeScript with no extra config, where ts-node needs an ESM loader setup.
- **First stack:** the CDK CLI refuses to synthesize an app with no stacks, so the app holds one empty `ssd-workshop-site` stack (eu-central-1, `CliCredentialsStackSynthesizer` with the `ssd-workshop-cdk-assets-<account>` bucket, `project=ssd-workshop` tag on the whole app) that ticket 0.4 fills.
- **CDK and strict types:** aws-cdk-lib's declarations break `exactOptionalPropertyTypes`, so a synthesizer is asserted to `IStackSynthesizer` at the call site instead of turning the flag off. `@types/node` 22 is a root dev dependency for Node built-ins in tests.
