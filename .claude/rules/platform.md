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
  relative file arguments resolve from the root, not from where the user typed them: take absolute paths only
  and refuse a relative one.
- An answer that must not reveal allow-list membership (sign-in) is the same for every outcome, failures
  included: catch table and SES errors, log only `error.name`, and return the neutral answer, never a 500.
- Such an answer is also sent at one fixed time (sign-in: `ANSWER_AFTER_MS`), racing the work against the
  deadline, with bounded SDK clients (`maxAttempts`, `NodeHttpHandler` timeouts): otherwise the answer time
  or a Lambda timeout (503) tells who is listed. Test with `vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })`
  and an injected `sleep`; real async work (scrypt) is not driven by fake timers, so wait for it with a
  `setImmediate` loop (`settle` in `platform/api/sign-in/fakes.ts`) before advancing the clock.
- IAM cannot condition on a DynamoDB sort key: a role limited to a partition (`dynamodb:LeadingKeys`) can still
  write any item in it. Limit PutItem's attribute names (`dynamodb:Attributes`) and make readers require an
  attribute that role cannot write.
