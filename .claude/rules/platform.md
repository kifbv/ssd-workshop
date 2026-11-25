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
  A page that polls at once on load (step 3's `GET /api/build`, ticket 2.10) sets its timer before the test could
  pause: install with a fixed `time` and `pauseAt` it before `page.goto` (`openPaused` in `pages.test.ts`).
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
  files in parallel with Chromium). Try 1's `[a-z][a-z0-9+-]*://` took 72 s on 400 KB of letters. Time-limit
  tests must also use many DISTINCT matches, not one unit repeated: a per-match `line.includes(...)` is quadratic but
  stops at once on a repeated unit (ticket 2.14 try 5: 1.8 s on 256 KB of distinct hosts; use a `Set` built in one scan).
- An API that sandboxed apps call (opaque origin `null`, ticket 2.4) puts `Access-Control-Allow-Origin: *` on every
  answer, errors, 404 and the preflight included (else the page cannot read the reason), never with credentials, and
  never reads or sets a cookie. Prove it in Chromium with the real handler behind a local server serving the page
  under the apps' CSP (`platform/api/app-data/browser.test.ts`); Chromium logs every 4xx answer as a console error.
- A Playwright test that needs a local HTTPS origin (ticket 2.14, `template.test.ts`) makes its certificate in memory
  with `selfSignedCertificate()` (`platform/api/build/test-certificate.ts`: node:crypto and a few DER structures, no
  openssl, nothing written to disk) and opens the context with `ignoreHTTPSErrors: true`. Chromium launched by
  Playwright ignores `HTTPS_PROXY`: a harness that must reach the real network from a session passes
  `proxy: { server }` and, since the session proxy re-signs TLS, `ignoreHTTPSErrors` (only then; `src/eval/build.ts`).
- JSON from strangers: cap nesting depth by scanning the text (`nestingDepth` in `app-data/data.ts`); `JSON.stringify`
  of a few thousand nested lists overflows the stack, while `JSON.parse` accepts it.
- Archives from strangers (the deployer's GitHub tarballs, ticket 2.5): cap the download while streaming (and the
  announced length first), unpack with `gunzipSync(..., { maxOutputLength })` (a zip bomb stops there), reject an
  absolute or `..` path before anything else, and never write to disk. In tests, a `ReadableStream` pulls its first
  chunk when constructed, so "nothing was read" cannot be asserted on it.
- A queue message that makes a worker act on a record (the deployer's `{ buildId, nickname, commit }`, ticket 2.5) is
  tied to that record by the write's condition: the build must exist, belong to the message's app (`nickname` equal
  exactly, as 2.7 stores it) and be in a state that expects the work; a failed condition drops the message, and a
  failure is recorded on the record only after that condition passed. The commit in a deploy message must come only
  from the platform's own push result, never from participant input. MANDATORY for 2.8/2.9: the builder stores the
  commit it pushed on the build (`pushedCommit`) and the deployer's start condition then requires
  `#pushedCommit = :commit` (added in that ticket, with the name in the IAM attribute list): a commit SHA alone does
  not prove it came from the participant's repository (GitHub serves fork-network commits through the parent's URL).
  Builds left `deploying` after a dead-letter are moved to `failed` by the launcher's stuck-build check (2.9).
- A worker phase cut off by a deadline is aborted, not just abandoned: one `AbortController` per phase, its signal
  passed to every call (`client.send(command, { abortSignal })`, `fetch`). The record's terminal writes are
  conditional on the working state (`#status = :deploying`), so a late write can never flip a finished record
  (ticket 2.5). When two items must both change, write first the one whose failure a retry repairs.
- Text that quotes participants' files (the deployer's `failureReasons`) is stored with control and other
  non-printable characters replaced by `?` (`storedReason`), and pages (2.7, 2.10) render it with `textContent` only.
- The API never answers 403: the distribution turns every 403 into the plain 404 page (ticket 2.5). Use 401 or 404;
  `platform/api/statuses.test.ts` fails on a `403` or `Forbidden` in any API source.
- An SQS-fed worker whose last delivery must record a failure (the deployer) takes its deadline from the Lambda
  context (`getRemainingTimeInMillis()`), starts no phase with less than a reserve left (15 s) and cuts each phase off
  at the reserve (race plus a network time limit bounded by the time left), so the failure write still fits.
- GitHub's Git Data API (blobs, trees, commits, refs) answers 409 "Git Repository is empty" for a repository without a
  commit: open it with one Contents API `PUT /repos/<o>/<r>/contents/<path>` (author and committer set), then write the
  real first commit with no parent and force `main` to it (ticket 2.6, `platform/api/github/repository.ts`). GitHub App
  tokens: check the answer of `access_tokens` (selection `selected`, the one repository, only the asked rights plus
  `metadata: read`, `expires_at` within an hour) before using it, and never log a token, the JWT or a repository name
  (an operator command run from the owner's own machine may print the repository it acts on to that operator,
  ticket 2.13).
  Every id from GitHub that goes into a URL path (commit, tree, blob) must match `^[0-9a-f]{40}$` first. Right after
  creating or opening a repository GitHub briefly answers 404 or 409: retry those Git Data steps a bounded number of
  times (3 tries, 1 s and 2 s, injected `sleep`), never on 401, 403 or 422, and never the first read of the branch
  (`get-branch`), whose 404/409 means "empty" (the re-read after a 422 is retried). Recognise the platform's own leftover commit by its content (tree and blob id), not its
  message alone, before forcing a branch over it. That "empty" 404 can be GitHub's brief one on a repository with
  history, where the Contents `PUT` lands on top of `main` (or answers 422 when the file exists): force a branch only
  to replace a commit whose answer has an empty `parents` list (missing list = has parents), else commit on top.
- A worker that sends to a queue after its transaction (the readiness check's launch message, ticket 2.7) throws on a
  failed send and makes the redelivery re-send: derive the new record's id from the job's own id (`buildIdFor`), so a
  redelivery finds the stored outcome and sends the same id again instead of acting twice; the consumer acts only on a
  record still in the state that expects it. A platform request that gets a different worker path (`READINESS_REQUEST`)
  is recognised by its exact text at a step where participants cannot send (`approved`), never by its text alone.
- Claude Agent SDK (the builder's coding agent, ticket 2.8): `options.env` REPLACES the child's whole environment,
  so build it from an allow-list (never spread `process.env`: a GitHub token would reach the agent) and give it a
  fresh temporary `HOME`/`CLAUDE_CONFIG_DIR` plus `CLAUDE_CODE_USE_BEDROCK=1`, `AWS_REGION` and every model alias
  set to the one EU profile. Restrict with `tools` + `disallowedTools`, `permissionMode: "dontAsk"`,
  `settingSources: []`, `strictMcpConfig`, and a deny-by-default PreToolUse hook (`onFailure: "block"`) that
  resolves real paths (symlinks, dangling links) against the workspace's real path; test the check on real temp
  folders with symlinks (`platform/builder/permissions.test.ts`).
- The coding agent never holds AWS credentials: Claude Code reaches Bedrock only through the runner's 127.0.0.1 signing proxy (`platform/builder/bedrock-proxy.ts`, `ANTHROPIC_BEDROCK_BASE_URL` + `CLAUDE_CODE_SKIP_BEDROCK_AUTH=1`), which forwards only `POST /<run's random prefix>/model/<build model>/invoke[-with-response-stream]` with `Host` exactly `127.0.0.1:<port>`, no `Origin`, `content-type` exactly `application/json` (a browser page can POST `text/plain` to localhost without a preflight) and replaces non-2xx bodies (they name ARNs); Claude Code keeps the base URL's path and also sends `GET /inference-profiles` at start (a 403 is fine); Node's `fetch` sends `accept: */*` unless told. Glob patterns with `{}`/`[]` (`.{.,}/*`) or a segment of only dots and wildcards (`.?`) can climb out: refuse them outright.
- `npm install <pkg> -w platform` can leave root dev dependencies (vitest) missing from `node_modules`: run `npm ci`
  after changing dependencies, before the checks.
- The in-memory GitHub (`platform/api/github/fakes.ts`) accepts a non-forced ref update when the new commit descends
  from the branch's commit through any number of parents, like GitHub; a test pushing several commits at once relies on it.
- Never trust a commit id to say which repository it came from (GitHub serves a fork's commit through the parent's
  address): the deployer downloads `codeload.github.com/<o>/<r>/tar.gz/refs/heads/main` (full ref: `tar.gz/main` picks a
  tag `main` first) with `redirect: "error"` and reads the commit from the first entry only (pax global header, one
  `comment=<40 hex>`), then publishes those same bytes when it equals the pushed one (ticket 2.8, `readTarGzArchive`).
- A worker that starts something costly or hard to undo (the launcher's RunTask, ticket 2.9) claims the record first
  (one conditional transaction, `queued` → `building`, plus a watch entry), then acts; any failure after the claim marks
  the record failed and consumes the message, so a redelivery can never start a second task. Anything that can leave a
  record stuck (a stopped task, a dead-lettered message) is swept by a scheduled check that writes only under the
  condition that the record is still in the state the check saw (`#status = :building AND #taskArn = :taskArn ...`).
- A worker started for a record (the builder task, ticket 2.9 try 2) is bound to the launch that started it: the
  launcher's claim stores a random `attemptId` on the record and passes it to the worker, and every worker write is
  conditional on `#status = :working AND #attemptId = :attemptId`, so a stale or foreign worker cannot write. It also
  gets the exact input the launcher prepared (`BUILDER_BASE_COMMIT`) and fails unless what it reads still equals it:
  someone holding the worker's token could otherwise change the input between launch and start.
- ECS: RunTask's `startedBy` takes up to 128 letters, digits, `-`, `_` and `/` (StartTask's only 36); ListTasks with
  `startedBy` must use no other filter (the desired status defaults to `RUNNING`). Give RunTask the deadline's
  `abortSignal`; a cut-off RunTask may still have started a task, which the attempt id makes harmless.
- Claude Code on Bedrock puts the model id in the path unencoded (`/model/<id with :>/invoke`), while the AWS SDK
  encodes it (`%3A`): anything matching Bedrock paths must accept both. Its default extended thinking roughly
  triples a coding agent's time and doubles its cost on Sonnet 4.6; the builder turns it off (`thinking: disabled`).
- A stub interface for an SDK client (`ResetSender`) lists `send` once per command; an interface that extends it to add a
  command must restate every overload, or its own `send` replaces them and typecheck fails (ticket 2.13,
  `ParticipantResetSender`).
- Fake keys in tests are built at run time (`["FAKE", "test", ...].join("")`, `FAKE_KEY` in `build/check.test.ts`), never
  written as one literal: GitHub push protection refuses a push whose commits hold a 32-hex "OpenWeather key", and the
  GitGuardian check fails the PR on any high-entropy or `AIza...` literal, also in comments and docs (ticket 2.14).
- Claude Code's WebFetch (ticket 2.15): the hook gets `{ url, prompt, offset? }`; check the raw text before `new URL()`
  (which repairs `127.1`, `0x7f000001`, trailing dots, `%6c`, backslashes) and require the parsed host to equal the raw
  one. It summarises with `ANTHROPIC_SMALL_FAST_MODEL` (set it, with every other model name, to the build model or the
  local Bedrock proxy refuses it), first asks `api.anthropic.com/api/web/domain_info` unless the flag setting
  `skipWebFetchPreflight` is passed (SDK `settings`, loaded even with `settingSources: []`), and is deferrable: set
  `ENABLE_TOOL_SEARCH=false` when the agent has no ToolSearch tool. WebSearch is off on Bedrock (`isEnabled()` false for
  `bedrock`). `options.env` holds no proxy, so a local run behind a session proxy must pass `HTTPS_PROXY`, `NO_PROXY`
  (127.0.0.1) and `NODE_EXTRA_CA_CERTS` itself (`webProxyEnvironment`, eval only).
  A cloud session's network policy may refuse the services' hosts ("proxy refused the connection" in the tool result, 0
  fetches in the eval): the session environment must allow them (now allowed: en.wikipedia.org, upload.wikimedia.org,
  openlibrary.org, covers.openlibrary.org, api.open-meteo.com, api.frankfurter.app, api.tvmaze.com, restcountries.com).
- A CommonJS package whose types say `export default` (`jsqr`) type-checks under `NodeNext` only as `import m from "x"; const f = m.default;`
  (the default import is the module itself); `m.default` is the function at run time in Node.js and in vitest alike (ticket 2.11).
- Proving a picture the page draws (step 4's QR code, ticket 2.11): screenshot the element, turn the PNG back into pixels in
  the page (`createImageBitmap` of a `Blob`, `OffscreenCanvas.getImageData`: no file, no network, CSP-safe) and decode them
  in Node.js (`decodeQrOnScreen` in `pages.test.ts`).
