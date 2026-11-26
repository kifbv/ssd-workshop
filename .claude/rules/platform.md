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
  Since ticket 3.1 `requireSession` also re-reads the caller's allow-list entry (through the session's `allowRef`, the
  address sealed under the cookie's token) and takes role and group from it, never from the profile: a new function
  that calls it needs `addSessionCheckRights` (`infra/lib/api-stack.ts`), and tests sign people in with
  `FakeTable.addSession(token, participantId, expiresAt)` (a bare `sessions.set` without `allowRef` is signed out).
- A limit on tries (sign-in codes: 5 wrong tries) is counted with one atomic DynamoDB `ADD` (`ReturnValues: UPDATED_NEW`,
  condition `attribute_exists(pk)`), never a read-then-conditional-write that gives up after lost races: parallel
  requests would otherwise escape the limit. Test it with a burst of parallel requests against the fake.
- When a limit spans two items (data API totals, ticket 2.4), enforce it with conditions inside one TransactWriteItems;
  retrying with a short random pause and then answering 409 is fine because a lost race can never pass the limit.
  Writes that all update one item (an app's `DATA_USAGE`) cancel each other with `TransactionConflict` on DynamoDB,
  which the in-memory fakes do not reproduce: pause 20 to 80 ms at random before another try.
- A public write path whose limits a loop can stay under (replacing one value) needs a cost cap of its own: a daily
  byte budget per app in the same transaction (ticket 2.4: 5 MB per UTC day, 50 MB since 3.17, 429) and route throttles. Count what
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
  content (`approvedTextHash`, SHA-256 of the text) in an attribute only the deciding role may write (since 3.10 the
  facilitator function, beside Franck's `npm run flags`), and skip only while the
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
  Where participants can send at that step (step 4's Build this change, ticket 3.6), the route that alone may store it
  marks it with an attribute participants' messages never carry (`request: "change-build"`), and the worker requires
  the mark and the exact text.
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
- Phase 3 limits (ticket 3.2): read the caps only through `settingsFromItem`/`DynamoSettingsStore.getSettings` and a
  profile's limit fields through `limitsFromItem` (`platform/api/workshop/settings.ts`; absent values are defaults), and
  take participant-facing messages (not button labels, which stay in the web code) from `platform/api/workshop/texts.ts`. Every update that changes a profile's `step` sets
  `stepSince` to the same time in the same update, and the role's attribute list in `infra/lib/config.ts` names it.
  Only the admin function (`ssd-workshop-api-admin`) may write `SETTINGS`; the synth test fails on any other writer.
- AI budget (ticket 3.3): every new AI call (3.6's suggestions included) first reads `ConversationStore.getBudgetFacts` and
  stops on `budgetOf(...).reached`, and a job that makes several calls checks `overBudget(budget, costSoFar)` before
  each later one; at the limit it stores `BUDGET_REPLY` (reply kind `budget`, message `failed`) without calling the model.
  Never add a budget check to the launcher, builder or deployer: a queued or running build always finishes (tested).
- A cap on running work (ticket 3.4, build slots): take the slot in the same transaction that claims the record (a
  counter `ADD` under `attribute_exists(running) AND running >= 0 AND running < :cap`, so a missing or broken counter
  is full, never empty, plus a holder item per record), and free it in one transaction keyed by the holder's existence
  and the record no longer being in a running state, written after its own terminal write by the trusted paths that end
  the record (`releaseSlotQuietly`, `platform/api/build/slots.ts`); a role that runs next to untrusted code (the builder
  task, beside the AI agent) gets no right on the counter, and the scheduled check frees its records' slots. The check
  deletes malformed holder items, frees holders of records no longer running, and repairs the counter from the holders
  under a `version` condition, forced when the counter is missing or negative or after `SLOT_REPAIR_FORCE_AFTER`
  refused repairs in a row (counted on the counter, in an attribute only the check writes), so no writer can block it. A Lambda SQS worker that must wait (no slot) sets the message's
  visibility and returns it in `batchItemFailures` (`reportBatchItemFailures` on the source), never throws, and its
  queue's `maxReceiveCount` and retention must cover the wait. A new DynamoDB item kind in a transaction needs every
  writer's stub answers and IAM statements updated (`ConditionCheckItem` is its own action).
- A pause that can outlast a queue's retries (ticket 3.5, the global Stop): an SQS worker that must hold a job sends it
  again to its own queue with `DelaySeconds` and consumes the delivery (never a thrown error or a visibility change, which
  count towards `maxReceiveCount`), and refreshes whatever a "stale" rule reads (`pendingSince`) in the same step. Check
  who may send to a queue in the access boundary before designing a re-send: only the AI worker and the scheduler may send
  to `ssd-workshop-builds*` (`BuildsFromTheirSendersOnly`), so the launcher's check launches stopped builds itself.
- A count that must only rise when work is really queued (3.6's `changeRequestsUsed`) is a SET to the value read plus
  one, conditional on that exact value and the cap, in the same transaction that creates the work; a missing value is
  `attribute_not_exists` OR the same check, never a bare `ADD` (a redelivery would count twice).
- A worker that runs next to untrusted code (the builder task beside the AI agent) gets the platform's input on its own
  record, copied there by the trusted worker that starts it (3.7: the launcher writes `changeSpec`/`changeList` on the
  build from `SPEC#<specVersion>`, in attributes only it may write), never a read right in another partition: IAM's
  `dynamodb:Attributes` cannot tell a spec's `text` from a message's `text` in `PARTICIPANT#*`.
- Cleaning untrusted text into one line (3.7's `plainLineWithoutEmails`): remove control and format characters (`\p{Cc}`,
  `\p{Cf}`: bidi overrides, zero-width) BEFORE removing email addresses (else `ada@example<U+0001>.org` slips through;
  `removeEmailAddresses` itself drops `\p{Cc}` other than `\t\n\r` first, so multi-line text is covered too),
  and cut with `Array.from` (code points) so an emoji at the cut never leaves a lone surrogate. A read-only GitHub step
  gets a `contents: read` token (`repositoryToken(..., "read")`), never the builder's write one.
- One page, several screens on one conversation (step 4, ticket 3.8): a reply on a screen that can start a build is followed
  by a read of `GET /api/build` before the conversation (`refreshLive`), so the page follows a queued build to step 3;
  `loadConversation` fills step 4 only while step 4 shows (`current === "live"`), else a running build opens step 3. A
  test's mocked API keys handlers by path only: read the query from `call.search` (`?version=3`). A text the page must
  recognise (Build this change's request) lives in `platform/api/workshop/texts.ts`, never in a module that pulls model
  code into the browser bundle (`api/conversation/change.ts` re-exports it).
- Work that needs the GitHub App key (only the launcher may read it, `GitHubKeyForTheLauncherOnly`) for an AI worker job
  (3.9, Rebuild from my repository): the worker sends a marked request through the launch queue (exact body
  `{"readSpec": ...}`, its own deduplication id), the launcher reads with a read-only token, stores the result on the
  request in attributes only it may write (once: `attribute_not_exists`) and sends the job back to the AI queue; the
  worker's second pass acts on the stored result. Never widen the key's readers. A size limit on a file from GitHub is
  checked on the tree entry's `size` before the blob is downloaded, then on the bytes. Store the repository name with
  the text (the worker checks it against the profile's) and read GitHub only for the conversation's request in flight.
- Text from outside that becomes a stored version (3.9's SPEC.md) passes the same `checkSpec` as a model-written one
  before any AI call, or a later change request can never change it. A second writer of an approval (3.9: the AI worker
  for a rebuild) gets its OWN attribute (`rebuildApprovedAt`, never `approvedAt`), and the consumer (the launcher)
  accepts it only with a content tie to input only it wrote (`repositorySpec`); one shared approval attribute would let
  that writer approve anything. A `GetItem` that lists its own `ExpressionAttributeNames` beside a shared projection
  (`getSpec`) must gain every new name too: test placeholders both ways on reads as well as writes.
- Listing items across participants (3.10's dashboard): never a Scan (its keys and `LastEvaluatedKey` hold the
  allow-list's `EMAIL#<address>`); query the sparse `ssd-workshop-by-type` index, keyed by `listType`, which only the
  listed kinds carry (profiles, conversations, usage totals, builds; set by their own writers), so items that must never
  be listed are not in it at all, whatever IAM does on an index Query; project to names in its INCLUDE list, from a
  role limited to those values (`dynamodb:LeadingKeys`, plus a `Null` guard, as a second guard). A new listed kind
  needs its writer to set `listType` (name in that role's list; synth test) and a backfill of older items
  (`npm run backfill-list-type`, Franck). A new attribute a list needs goes into `BY_TYPE_INDEX_ATTRIBUTES` first.
  A facilitator action reads the target profile's `role` first and acts only on `participant`, never on the caller.
  A copy of allow-list data on the profile (`group`, `role`) is kept in step by the allow-list command itself
  (`import` and `remove` update the linked profile), never by a Lambda reading `EMAIL#` items. Work a
  facilitator asks of a build (Retry) is a request item the launcher's minute check acts on, never a StopTask or a
  launch-queue send from another role. A single-item write's failed condition is `ConditionalCheckFailedException`;
  the conversation store's `conditionFailed` only recognises a cancelled transaction.
- A new page in a folder (ticket 3.11's `/facilitator/`) needs its files in `STATIC_FILES`/`SCRIPTS` under that folder
  and a CloudFront behaviour running `ssd-workshop-site-index` (`infra/lib/site-index.js`: slash redirect, `index.html`
  for a folder); S3 has no folder index and the default root object covers `/` only. Reference shared files from the
  root (`/style.css`). A page that polls keeps its cards by a stable key and updates them in place, so an open panel or
  a busy button survives the next read. In Playwright, an aborted request (`route.abort()`) logs
  "Failed to load resource: net::ERR_FAILED", which the console check must expect.
- Confirmations on pages are in-page steps, never `window.confirm`/`alert` (ticket 3.12; `facilitator.test.ts` counts any
  dialog as a violation). A switch whose answer may be lost after it applied (Stop/Resume) re-reads the state on any
  answer but a good 200 before showing it. A form polled beside live data fills its fields once (first read, each
  save), never from the poll, or the poll erases what is being typed.
- A new step in the launcher's minute check that depends on a right not yet applied (3.14's ListTasks, until Franck applies
  the boundary) never throws: it logs one line with the error's name per run and the check goes on (test it with the
  fake throwing `AccessDeniedException`). Log a task by its id (last ARN part) only: overrides can hold a build's token.
  A check that stops tasks on what DescribeTasks shows (3.14's subnets) never acts on a missing detail of a young task
  (a PROVISIONING task may not show it yet): wait a grace from `createdAt`, and bound every ListTasks loop (pages per status).
- A second source for a pipeline (3.15: text typed on the page for 3.9's rebuild) enters it at the point where the first
  source's input is ready (a found read), with its own texts, never a copy of the run. The approval the shared run writes
  stays tied to input another role wrote: the launcher builds an AI-worker-approved version only as the exact text on
  the marked request (`repositorySpec` from the launcher, `editedSpec` from the conversation function). A store reader
  that keeps only known marks (`getMessage`'s `request`) must learn every new mark, or the marked request falls through
  as an ordinary message. A route that edits the live record takes the version it opened and answers 404 when it moved.
- A model's JSON answer with free text inside (readiness reasons, ticket 3.16) breaks when the model quotes a message with
  double quotes (`"Pay cash to the baker"`): the prompt says to use single quotes inside the text. A text the model writes
  in the participant's language (the guardrail's `decline`) is used only when it keeps the fixed text's shape
  (`localDecline`), else the English template; a fixed marker the code reads stays English inside it (`(server)`).
  A one-word prompt change can tip such an answer into "(login), (outside service)" then "Wait, ..." and a second JSON
  object (unreadable): say what to do in the combined case (two reasons, one bracket each), and run the live eval several
  times, not once (ticket 3.17: 4 of 33 before, 0 of 12 and 3 x 17/17 after).
- Removing block tags (`</spec>`, `</message>`) from untrusted text is repeated until nothing changes (`withoutTags`,
  `api/conversation/tags.ts`): one pass lets nested tags rebuild one (`</parti</participant>cipant>`, ticket 3.16 try 2).
- Saving from an app (ticket 3.24): every app route that writes, uploads or calls AI checks `checkAppWrite`
  (`platform/api/app-token/token.ts`): `Authorization: Bearer <app write token>`, never a cookie (the sandboxed app's
  opaque origin never sends the platform's `SameSite=Strict` one). Tokens are stored only as SHA-256 (`APPTOKEN#<hash>`),
  reach the app only in the address's fragment (`/apps/<nick>/#wt=`), and are listed per participant (`TOKENS#<id>`,
  capped) so sign-out and reset can delete them without a Scan. A route that adds a header for apps adds it to the
  function's preflight AND bumps CloudFront's `ssd-workshop-app-data-v<N>` policy (it cannot be updated).
- A tab a sandboxed app opens inherits the app's sandbox (opaque origin, no cookies) unless the apps' CSP has
  `allow-popups-to-escape-sandbox` (ticket 3.24 try 2): a platform page an app opens must be proved in Playwright with the
  REAL apps CSP on the opener (`platform/web/app-sign-in-popup.test.ts`), not only opened directly.
- An optimistic lock on a list item (3.24's `TOKENS#<id>`) uses a `version` that every writer raises by one and every
  write is conditional on, never a size (an add and a remove leave the size unchanged), and the item is emptied, not
  deleted, so the version never goes back. Something that must stop once a session ends (a token create) checks the
  session item inside its own transaction (`ConditionCheck`), and the ending runs its cleanup again after deleting the
  session (retried; a failure there is logged by outcome and the ending still answers done). A cleanup that leaves the
  session in place (allow-list removal) needs its own mark checked in the same transaction (the profile's `role`). Prove such races over every interleaving against a small condition-evaluating stand-in for DynamoDB
  (`MiniDynamo` in `app-token/store.test.ts`), with a control showing the old order fails.
