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
- When a limit spans two items (data API totals, ticket 2.4), enforce it with conditions inside one TransactWriteItems;
  retrying with a short random pause and then answering 409 is fine because a lost race can never pass the limit.
  Writes that all update one item (an app's `DATA_USAGE`) cancel each other with `TransactionConflict` on DynamoDB,
  which the in-memory fakes do not reproduce: pause 20 to 80 ms at random before another try.
- A public write path whose limits a loop can stay under (replacing one value) needs a cost cap of its own: a daily
  byte budget per app in the same transaction (ticket 2.4: 5 MB per UTC day, 429) and route throttles. Count what
  DynamoDB bills: every item the transaction writes, in whole KB, at the larger of its old and new size (replacing
  100 KB with 1 byte still costs 100 KB), and the totals item too (it grows with the keys).
- DynamoDB bills a `GetItem` on the whole item's size, whatever the `ProjectionExpression`: a request path that may
  be refused (429, 413) reads only small items. Keep what a write needs (each key's size) in the small totals item
  (a map attribute, `sizes.#k` through `ExpressionAttributeNames`; IAM's `dynamodb:Attributes` sees only the
  top-level `sizes`; create the map with the item, as a nested `SET` on a missing map fails) and never read the
  value item on a write (ticket 2.4).
- A date condition on a day counter only moves forward: `attribute_not_exists(#day) OR #day < :today` (ISO dates
  compare as text), never `<>`, or an instance whose clock is behind resets the count.
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
  pause it after the page loads (`page.clock.pauseAt(Date.now() in the page + 1000)`), then move time only with
  `runFor`. `runFor` fires only timers already set: after each poll, wait for its response (`waitForResponse`) and
  let the page handle it before moving time again, or the next timer is missed (ticket 1.8, `pauseClock` and
  `pollAfter` in `pages.test.ts`).
  Pause at the page's time plus 1 s, not plus 1 ms: real time passes between reading the page's clock and
  pausing, and a loaded full run fails with "Cannot fast-forward to the past".
- A model's machine-readable signal (clarify's `[READY_FOR_SPEC]`) is a marker line the worker strips before storing
  the text, so it never shows on the page or goes back to the model as history (ticket 1.8).
- Mermaid under the pages' CSP (`style-src 'self'`): draw off-screen with `setAttribute("style")` turned into CSSOM
  writes and `<style>` elements into SVG `<desc>` placeholders, `securityLevel: "loose"` (DOMPurify's final parse
  reports every style attribute), then show the finished SVG only as an `<img>` from a `data:` URL (ticket 1.9,
  `platform/web/src/diagram.ts`). Mermaid cannot parse flowcharts in Node.js (no DOM, "DOMPurify.addHook is not a
  function"): check diagrams with the page's own `diagram.js` in Playwright's Chromium (`platform/src/eval/diagram.ts`).
  Draw one diagram at a time (`render` queues): two overlapping draws each save the other's swapped DOM methods
  as the originals, and the first to finish leaves the second unpatched (CSP violations in CI, PR #24).
- A large browser-only library goes into its own esbuild entry (`platform/web/build.ts` `SCRIPTS`), loaded only when
  needed, so the other pages stay small (ticket 1.9, `diagram.js`).
- A scanner regex that runs on untrusted text (the deploy check, `platform/api/build/check.ts`) must be linear:
  start a variable run only where it begins (a lookbehind such as `(?<![a-z0-9+.-])` before a scheme), never put
  two optional runs of the same characters side by side (`=\s*["']?\s*` is quadratic on spaces), and test it with
  long lines against a time limit with a margin over 10x (256 KB lines, 1 s: CI runners are slower and run test
  files in parallel with Chromium). Try 1's `[a-z][a-z0-9+-]*://` took 72 s on 400 KB of letters.
- An API that sandboxed apps call (opaque origin `null`, ticket 2.4) puts `Access-Control-Allow-Origin: *` on every
  answer, errors, 404 and the preflight included (else the page cannot read the reason), never with credentials, and
  never reads or sets a cookie. Prove it in Chromium with the real handler behind a local server serving the page
  under the apps' CSP (`platform/api/app-data/browser.test.ts`); Chromium logs every 4xx answer as a console error.
- JSON from strangers: cap nesting depth by scanning the text (`nestingDepth` in `app-data/data.ts`); `JSON.stringify`
  of a few thousand nested lists overflows the stack, while `JSON.parse` accepts it.
- Archives from strangers (the deployer's GitHub tarballs, ticket 2.5): cap the download while streaming (and the
  announced length first), unpack with `gunzipSync(..., { maxOutputLength })` (a zip bomb stops there), reject an
  absolute or `..` path before anything else, and never write to disk. In tests, a `ReadableStream` pulls its first
  chunk when constructed, so "nothing was read" cannot be asserted on it.
