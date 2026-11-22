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
