---
paths:
  - "platform/**"
---

# Platform rules

- TypeScript, strict (`tsconfig.base.json`); tests are `*.test.ts` next to the code, run by vitest.
- AI calls go to Claude on Amazon Bedrock through EU inference profiles (`eu.anthropic.*`) in
  `eu-central-1`.
- Email goes through SES from `ssd-workshop@rankly.games`.
- Participants' email addresses are never logged, shown to other participants or published.
- Participant-facing explanations lead with a diagram; text supports it.
- AWS SDK v3 ignores `HTTPS_PROXY` (and `AWS_REGION` is not set in sessions): set `region: "eu-central-1"` on
  every client and, when `HTTPS_PROXY` is set, pass `requestHandler: { httpsAgent: new Agent({ proxyEnv: process.env }) }`,
  or calls skip the session proxy and fail with "security token ... invalid".
