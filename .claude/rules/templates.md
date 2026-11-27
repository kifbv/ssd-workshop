---
paths:
  - "templates/**"
---

# App template rules

- Starters for participant apps; advanced-track apps are Python.
- Participant app commits are automatic and never reviewed, so a starter must be safe to deploy
  as it is.
- Apps are served under the sandbox CSP (`APPS_CONTENT_SECURITY_POLICY` in `infra/lib/config.ts`): the page
  has an opaque origin (`origin` is `"null"`). Use classic `<script defer>` tags (but `workshop-data.js` first and not
  deferred, below), never `type="module"`: a
  module script is fetched with CORS and the same server's answer has no `Access-Control-Allow-Origin`, so it
  is blocked. `localStorage`, `sessionStorage` and cookies throw; data goes through `workshop-data.js`, whose
  requests carry `Origin: null` (ticket 2.3, `platform/api/build/template.test.ts`).
- The deploy check scans every text file, Markdown and comments included, for outside addresses and keys: since
  ticket 2.14 a plain `https://host...` address passes (written as is, no port, user name or escapes), every other
  `scheme://`, `//host` or `http:`/`https:` followed by text fails. Prose must not hold a bare `https://` followed by
  a delimiter (`` `https://` `` fails: describe it in words), nor a key name given a value (`api_key=`, `apiKey:`,
  `Authorization:`, also at the end of a longer name: `weatherApiKey =`), nor a name that is or ends in `key`/`token`/`appid`
  (`OPENWEATHER_KEY`, `myKey`, also `.set("appid", ...)`) given a long quoted value with letters and digits (a value
  with dashes passes unless one part has 8+ characters with a letter and a digit: name storage keys
  `movie-watchlist-v1`, not `movieWatchlist2024`). A template literal's `${` may follow the host (2.14 try 2), but
  nothing up to the path may hold `@` or `:` outside `${...}` and a `${` must close inside the address (try 3);
  AGENTS.md asks for the slash after the host anyway. A scanner that cuts addresses at delimiters must also look
  just past the cut (`'https://a.b"@evil.example/'`), from the end of the cut, not from a trimmed end. Prose
  punctuation (`.,;:!?`) right after an address is dropped when a space, the line's end, `<`, `)` or a quote
  follows (try 4: `Data from https://open-meteo.com.` passes); trim only the end, never inside the host or port. Only the XML namespace names in `NAMESPACE_ADDRESSES` are allowed besides https.
  Comments start with `// ` (a space): `'x'//note` fails the check.
- The apps' CSP (`default-src 'self'`, `connect-src 'self' https:`, `img-src 'self' data: https:`, ticket 2.14) still
  lets the page load its own files and call the data API under the sandbox (`'self'` is the served address, not the
  opaque origin; tested), lets it fetch and show images from any HTTPS address, and blocks outside scripts, styles and
  fonts and every `http:` address. No inline `<script>`, `<style>`, `style=` or `on*=`: the CSP blocks them. An app's
  outside service must answer with CORS (`Access-Control-Allow-Origin: *`): the page's origin is `null`.
- Chromium logs every 404 (and every refused request) as a console error, and the template's test
  fails on any console error: the data API answers a missing key with `200` and `null`, never 404.
- ESLint lints `templates/**/*.js` as browser scripts with the globals declared in `eslint.config.mjs`;
  a new browser global used there must be added to that list.
- Since ticket 3.25 the deployer publishes the platform's `templates/basic/workshop-data.js` (bundled with it) in every
  app, whatever the repository holds: a change to it reaches new deploys at once, and live apps through
  `npm run apps -- refresh` (Franck). Keep it passing the deploy check (`deploy.test.ts` checks it): send the secret as
  `options.headers.authorization = "Bearer " + editSecret` (a property set with `=`; `authorization:` or `"authorization",`
  fails the check), and never write the header with a colon in a comment either. Keep it backward compatible: older
  apps call `get`, `set`, `remove`, `getInfo`, `whoAmI`, `signInLink` (now `null`), media and AI helpers.
- Edit link in apps (3.28, replaces 3.25's sign-in): the secret arrives in the fragment (`#edit=<43 base64url>`, parts
  joined by `&`) and STAYS in the address (Franck's design: reload, bookmark, home-screen icon keep the right to save);
  only an old `wt=` part is removed with `history.replaceState`. Without a secret every write (data, media, AI) is refused
  inside `workshop-data.js` with "This link is view only." before anything is sent (no 401, so no console error); with a
  replaced secret the API's 401 says the same and `canSave()` stays true. Old apps' `data-workshop-sign-in` elements are
  hidden with an inline `display: none !important` set through the CSSOM (the app's CSS can override the `hidden`
  attribute) and a MutationObserver for elements added or changed later. In Playwright, a `goto` that changes only the
  fragment does not reload the page: go to `about:blank` first. App code that sets `location.hash` (or uses `#...`
  links) drops the secret from the address; AGENTS.md rule 2 forbids it.
- An address that carries a capability (3.28's `#edit=` secret) must never be read by app code (3.28 access review M1: a
  "share" or "QR code" spec makes the agent use `location.href`, which puts the secret in a share sheet, the clipboard,
  the page or an outside QR service's address, allowed by `img-src https:`): apps show, copy and share
  `workshopData.viewLink()` (server and path captured at the client's start, no query or fragment), and never change the
  address (`pushState`, `?` links, GET forms to the page). The build eval checks it (`secretLeaks`: outside requests'
  address, body and headers; the page's text, title and `href`/`src`/`value`). A response that CORS refuses reaches
  Playwright only as `requestfailed` with `net::ERR_FAILED`, the same for a 429 and a 200: read its status through the
  DevTools protocol (`Network.responseReceivedExtraInfo`). A `page.route` fulfil skips Chromium's CORS check, so test
  CORS against a real local HTTPS server, launched with Chromium's local-network checks off for a routed public page
  (`edit-link-script.test.ts`).
- View only (3.28): apps hide saving controls with `if (!workshopData.canSave()) document.body.classList.add("view-only")`
  and `.view-only .edit-only { display: none !important; }`; the build eval opens each app with the edit link first
  (generic save: fill visible fields, press Save/Add, `FILL_AND_MARK_SAVE_SCRIPT`) and then without it on the saved data,
  so per-item buttons (Delete, Watched) show to the visitor check too. Screen tabs named in the spec are not saving
  controls (`SAVING_CONTROLS_SCRIPT`); a tab reading exactly a screen's name that saves is caught only by the "This link is
  view only." text appearing after the eval clicks it. Style an element made by `workshop-data.js` through the CSSOM
  (`element.style.x = ...`), never a `style` attribute (the CSP refuses it).
- The build eval is noisy: a change to AGENTS.md or the builder's prompt can tip one example (ticket 3.25: placing new
  prompt lines before the WebFetch lines made the Wikipedia example skip WebFetch 3 times in a row). Run the changed
  example several times (`npm run eval -- build --example <n>`), compare with a baseline on `main` before blaming the
  change, then run the whole suite once. Keep the published files with `EVAL_DUMP_DIR=<absolute folder>` and look at a
  failed app before guessing (3.25 try 3). A field beside a button in a flex row needs `min-width: 0` (AGENTS.md rule 9).
- `whoAmI()` is a promise of the nickname the data API confirms for the secret (`GET .../data/whoami?whoami=1` with it,
  once per page load): since 3.26 always the app builder's, never a name from the address. Who saved is
  `getInfo(key).updatedBy` (also the builder for every edit-link save); an app that wants each person's name asks for it
  in a plain field.
- App code runs in the same page as `workshop-data.js` (3.25 try 2): `workshop-data.js` is the first script of
  `index.html`, not deferred (the deploy check, `runsDataClientFirst` in `platform/api/build/check.ts`, refuses anything
  else), captures `fetch`, `history.replaceState` and `location.replace` with `.bind` at its top, and
  passes `fetch` options in `Object.create(null)` objects (fetch reads `signal`, `referrer`, ... and `Symbol.iterator`
  through the prototype chain, where a getter on `Object.prototype` would see the headers). Since 3.28 the edit secret is
  in the address on purpose, so app code can read it there (the app is the builder's own; tested in `template.test.ts`);
  the captures still keep saves going to the workshop.
- `workshop-data.js` builds every address absolute from the page's server read at its start (3.25 access review): a
  relative address given to a captured `fetch` still resolves against the page's CURRENT base URL,
  which app code can change with a `<base>` element. Test any new request the client makes with that `<base>` test.
- In Playwright, a document served through `page.route` cannot load files from a real loopback server (Chromium's
  private network check, "Permission was denied for this request to access the `loopback` address space"): route every
  file of such a page, or serve the page from the server and route only one script.
- Apps hide screens both ways (3.25 try 3): with the `hidden` attribute and with CSS classes (`.screen.hidden { display: none }`,
  a class named `hidden`, not the attribute), and a CSS `display` on a class beats the `hidden` attribute. To check what a
  visitor sees on every screen, open each screen (3.28's eval clicks the control named after it) and test real
  visibility there (`checkVisibility` with opacity and visibility, a box larger than 0).
- The deploy check does not parse JavaScript; the builder's PostToolUse hook does (`scriptSyntaxProblem`, 3.25 try 3), so
  the agent hears of a syntax error (a `'` inside a `'...'` string: "missing ) after argument list") while it can fix it.
- Microphone in apps (3.19): Chromium refuses `getUserMedia` in the apps' sandbox (`SecurityError: Invalid security
  origin`, opaque origin), even with `--use-fake-ui-for-media-stream` and a fake device; no header changes that. Prove the
  MediaRecorder path on the same page served WITHOUT `sandbox` (`template-media.test.ts`), and the sandbox path through
  the fallback file input (`page.waitForEvent("filechooser")`, then `setFiles` with a real MediaRecorder recording).
  A file input opens only with a user activation: `recordVoice()` must be called from a click, and its fallback clicks the
  input after the awaited refusal (fine in Chromium's 5 s activation window).
- Images in apps never get a `blob:` address (the CSP's `img-src` has none): decode with `createImageBitmap(file)` and draw
  on an `OffscreenCanvas` (no URL at all), and show the uploaded address. Generate big test pictures and recordings in the
  page (`OffscreenCanvas.convertToBlob`, `MediaRecorder` on an `AudioContext`) instead of committing binaries, and pass
  them to `setInputFiles` as buffers. Under `page.clock.install()` the clock keeps running in real time: fast-forward a
  5-minute timer in two steps with a margin of seconds on each side (296 s, then 5 s), not 299 s + 1.5 s.
- A promise the client hands the app (`recording.done`) that can reject before the app awaits it gets a `.catch(() => {})`
  branch inside the client, or Chromium reports an unhandled rejection as a page error.
- A code example in AGENTS.md that apps copy (rule 15's Record/Stop handler) is tested by running the block itself, taken
  from AGENTS.md (`RULE_APP` in `template-media.test.ts`), so a fix there (3.19 try 2: the `starting` guard against a
  second tap during the microphone prompt) is proved; slow `getUserMedia` with an init script to open that window.
- An eval check of a feature (3.19 try 2: the tag/topic filter) looks for the control itself (a select, field or buttons
  named with "filter" and the word), never for the word in any label: a Tags field in the add form holds "tag" too.
- AI helpers in apps (3.22): test a client helper against the REAL route behind the local test server (`handleAppAiRequest`
  with the fakes of `platform/api/app-ai/fakes.ts`, `template-ai.test.ts`), so the route's own parser judges what the
  helper sends and its own refusals (503, 429, 401) come back; answer a wrong shape from a test hook instead of the route.
  Send media to the route as the path `/app-media/<nick>/<id>`: the route accepts it on any host, a full address only on
  the real domain.
- `page.evaluate("p.then(...)")` awaits the promise the expression ends with: under a paused `page.clock` a helper that
  waits on a timer then never resolves and the test hangs until its timeout. End such an expression with `; undefined`
  and read the result from a `window` variable. A poll every 3 s that gives up after 180 s asks 61 times (0 s to 180 s).
- A route fake whose clock is `Date.now() + offset` (the route's own Transcribe polling, 3.21) polls a varying number of
  times per request: finish a fake job from the test (`looksLeft = 0` and its result) instead of counting looks.
- An eval check of AI suggestions (3.22, `exerciseAi`) gives the stand-in route distinctive fixed answers (`sunflower`,
  12.40) and looks for them in field values and the page's text, in saved bodies only before vs after the eval presses
  Save; tap suggested tag chips or an Accept button only when no field holds the suggestion yet.
- A new optional feature in AGENTS.md (3.22's AI rule) leaks into specs that do not ask for it (run 1: a gallery whose tags
  the visitor types got AI tag suggestions): say in the rule what a spec without it keeps ("stays a plain field"), and
  make the build eval fail the other cases when they use it (`callsAi`). A check that reads the page right after a write
  was recorded must wait for the app to finish drawing (`waitUntil`), as the route records the write before answering.
- Rules every app reads (the edit-link rule, its list of saving controls) never name an optional feature ("AI buttons"):
  3.28 try 2's gallery added a "Suggest tags" button in 3 of 5 runs; with AI named only in the AI rule, 0 of 5 (try 3).
- Test client behaviour on generic hand-written apps of several shapes (`shapeApp` in `template.test.ts`: an element on a
  `hidden` screen, in a closed `<details>`, in an open one inside a closed one, under a CSS class, none, in sight), never
  on one participant's app; a page with its own `index.html` routes every file, `workshop-data.js` too. A closed
  `<details>` hides its content with `content-visibility`, which `checkVisibility` sees but `getClientRects()` does not.
- `expect.poll` waits 1 s by default: a poll that waits on a big picture being decoded and re-encoded (12 megapixels)
  gets `{ timeout: 15_000 }` and its test a 30 s limit, or a busy runner fails it (deploy run 69).
