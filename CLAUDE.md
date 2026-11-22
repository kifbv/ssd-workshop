# SSD Workshop

Platform for an interactive AI workshop: participants take a small app idea from a sentence to a
live web app, guided by AI, with every step explained; fast finishers continue into an advanced
track on Kubernetes. npm workspaces monorepo:

- `infra/`: AWS CDK app (TypeScript); `infra/access/` holds the least-privilege access stack, applied by Franck only.
- `platform/`: API and web pages (TypeScript).
- `templates/`: participant app starters (later phases).

Spec and decisions: `docs/` (start at `docs/README.md`).

## Key facts

- AWS account `rankly.games`, region `eu-central-1` (CloudFront certificates in `us-east-1`).
- Domain `workshop.rankly.games` in Route53.
- Every resource is tagged `project=ssd-workshop` and named `ssd-workshop-*`; every IAM role carries
  the `ssd-workshop-boundary` permissions boundary.
- AI: Claude on Amazon Bedrock through EU inference profiles (`eu.anthropic.*`).
- Email: SES, sender `ssd-workshop@rankly.games`.
- The platform is TypeScript; advanced participant apps are Python.
- Participant-facing explanations lead with diagrams; text supports them (Franck's standing preference).

## Validation

Run before pushing:

- `npm ci`
- `npm run lint` (ESLint with typescript-eslint)
- `npm run typecheck` (TypeScript strict)
- `npm test` (vitest)

## How we work

- **Before a phase:** `/brief` writes `docs/phases/<phase>.md`: the tickets, each with two or three
  sentences, dependencies and acceptance criteria, plus every open question in one numbered list
  with a suggested answer. Franck answers once; the answers go to `docs/decisions.md`. No coding
  until the brief is approved.
- **During a ticket, decide and record, don't ask.** A choice the spec, the brief and
  `docs/decisions.md` leave open, and that can be undone, gets a sensible default, a line in
  `docs/decisions.md` and a place in the pull request's "Please veto" list. Examples: sort order,
  button wording, a default value, the layout of a table that holds no real data yet, a small
  library (with its reason).
- **Stop and ask Franck only for:**
  1. Anything in the rankly.games AWS account outside the workshop's tagged resources
     (`project=ssd-workshop`, names `ssd-workshop-*`).
  2. Any DNS change other than the `workshop.rankly.games` record (and its certificate validation
     records).
  3. Any new paid AWS service, or a monthly cost estimate above $50. This includes switching the
     Kubernetes cluster on for the first time.
  4. Any change to signed-off behaviour in the spec (needs a spec delta and Franck's yes).
  5. Anything that would publish participants' email addresses.
  6. Any unresolved security finding before a release.
- **Acceptance criteria** are `WHEN <situation> THEN <result>` sentences, each tied to a test or a
  command. Every criterion starts as FAIL and turns to PASS only with proof that was run.
- **One ticket, one pull request**, small enough to review on a phone. `/ticket` builds it in
  tries: a fresh builder session, the checks, then the `checker` agent (fresh context, no edit
  rights). Findings start the next try on the same branch. After 3 failed tries, stop and report.
- **Never merge.** Franck signs off the spec and merges every platform pull request; Claude never
  merges. A merge to `main` deploys (deploy workflow, from ticket 0.5); nothing is deployed from a
  session.
- **Participant app commits** are automatic and never reviewed; this review flow is for the
  platform only.
- **Spec changes** to signed-off behaviour are written as ADDED / CHANGED / REMOVED in the pull
  request and in `docs/decisions.md`, and need Franck's yes (see "Stop and ask").
- Write the test first when the change has logic (rules, access, dates, quotas, authorization).
- Prefer the simplest solution that meets the spec. No new dependency without a reason in the
  pull request.
- A lesson that will matter again (a gotcha, a pattern) goes into the matching `.claude/rules/`
  file in the same pull request.

## Rules

- `main` is protected: every change goes through a pull request.
- Never read or commit secrets (`.env*`, keys, files under `secrets/`); `.claude/settings.json`
  denies them, and denies deploys, `aws iam` and writes to the access stack.
- Participants' email addresses are personal data: never log, display or publish them.
