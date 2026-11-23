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
- API Gateway HTTP API (payload 2.0) delivers request cookies in `event.cookies` (one `name=value` each), not
  in a `cookie` header, and sets cookies from the response's `cookies` list; header names arrive lower-cased.
  Every protected route calls `requireSession` (`platform/api/session/session.ts`) and acts only on the
  caller's own participant id.
- A limit on tries (sign-in codes: 5 wrong tries) is counted with one atomic DynamoDB `ADD` (`ReturnValues: UPDATED_NEW`,
  condition `attribute_exists(pk)`), never a read-then-conditional-write that gives up after lost races: parallel
  requests would otherwise escape the limit. Test it with a burst of parallel requests against the fake.
- Pages (`platform/web`): no inline `<script>`, `<style>`, `style=` or `on*=` attributes (the CSP has `script-src 'self'`
  and `style-src 'self'`); set text with `textContent`. Browser code gets DOM types from `platform/web/tsconfig.json`
  only. In Playwright, a `hidden` element is not in the accessibility tree: `getByRole` waits forever for it, so read
  hidden fields by id.
- SQS delivers a job at least once: the worker skips a message that is no longer `pending` and stores the outcome in
  one transaction conditional on it still being pending (ticket 1.7). DynamoDB refuses an expression with an undefined
  `:value`/`#name` (or an unused one): `store.test.ts` checks every transaction item's placeholders both ways.
- An approval that lets something skip a check is tied to the content, not the record: store a hash of the approved
  content (`approvedTextHash`, SHA-256 of the text) in an attribute no Lambda role may write, and skip only while the
  current content has that hash (ticket 1.7).
- The Lambda runtime writes an uncaught error's message and stack to CloudWatch: a handler whose errors may carry
  personal data logs only `errorName(error)` and throws a bare `new Error(...)` (no `cause`), as `ai-worker.ts` does.
- Playwright's `page.clock.install()` keeps the page clock following real time: to test timers (polling every 2 s),
  pause it after the page loads (`page.clock.pauseAt(Date.now() in the page + 1)`), then move time only with
  `runFor`. `runFor` fires only timers already set: after each poll, wait for its response (`waitForResponse`) and
  let the page handle it before moving time again, or the next timer is missed (ticket 1.8, `pauseClock` and
  `pollAfter` in `pages.test.ts`).
- A model's machine-readable signal (clarify's `[READY_FOR_SPEC]`) is a marker line the worker strips before storing
  the text, so it never shows on the page or goes back to the model as history (ticket 1.8).
