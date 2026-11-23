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
  every client and, when `HTTPS_PROXY` or `https_proxy` is set, pass `requestHandler: new NodeHttpHandler({ httpsAgent: new Agent({ proxyEnv: process.env }) })`,
  or calls skip the session proxy and fail with "security token ... invalid".
- npm echoes a script's command line, arguments included: a script that takes personal data (an email
  address) is run as `npm run -s ...`, and a root script that forwards to a workspace uses `npm run -s ... -w <ws>`.
- AWS SDK v3 clients that default to HTTP/2 (Bedrock runtime) ignore `requestHandler: { httpsAgent }` options: pass `new NodeHttpHandler({ httpsAgent })` explicitly.
- A root script that forwards to a workspace (`npm run -s x -w platform --`) starts the inner npm from the
  repository root, so the script sees `INIT_CWD` = repository root, not the folder where the command was typed:
  relative file arguments resolve from the root (document it, or advise absolute paths).
