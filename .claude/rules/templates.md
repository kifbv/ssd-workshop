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
  `npm run apps -- refresh` (Franck). Keep it passing the deploy check (`deploy.test.ts` checks it): send the token as
  `options.headers.authorization = "Bearer " + pass` (a property set with `=`; `authorization:` or `"authorization",`
  fails the check), and never write the header with a colon in a comment either. Keep it backward compatible: older
  apps' `app.js` call only `get`, `set`, `remove`.
- Sign-in in apps (3.25): the token arrives in the fragment (`#wt=<token>`, nothing else: a name in the address is not
  checked by anyone, try 2) and is removed
  with `history.replaceState` at once (it works in the sandbox's opaque origin in Chromium); in Playwright, a `goto` that
  changes only the fragment does not reload the page: go to `about:blank` first. A visitor's save gets a 401, which
  Chromium logs as a console error: a test of that path allows exactly that line. Style an element made by
  `workshop-data.js` through the CSSOM (`element.style.x = ...`), never a `style` attribute (the CSP refuses it).
- The build eval is noisy: a change to AGENTS.md or the builder's prompt can tip one example (ticket 3.25: placing new
  prompt lines before the WebFetch lines made the Wikipedia example skip WebFetch 3 times in a row). Run the changed
  example several times (`npm run eval -- build --example <n>`), compare with a baseline on `main` before blaming the
  change, then run the whole suite once. Keep the published files with `EVAL_DUMP_DIR=<absolute folder>` and look at a
  failed app before guessing (3.25 try 3). A field beside a button in a flex row needs `min-width: 0` (AGENTS.md rule 9).
- `whoAmI()` (3.25 try 2) is a promise of the nickname the data API confirms for the token (`GET .../data/whoami?whoami=1`
  with the token, once per page load), never a name from the address. A name an app stores inside a value is the app's
  word, not the server's: show who posted from `getInfo(key).updatedBy`.
- App code runs in the same page as `workshop-data.js` (3.25 try 2): `workshop-data.js` is the first script of
  `index.html`, not deferred (the deploy check, `runsDataClientFirst` in `platform/api/build/check.ts`, refuses anything
  else), captures `fetch`, `history.replaceState`, `location.replace` and `window.open` with `.bind` at its top, and
  passes `fetch` options in `Object.create(null)` objects (fetch reads `signal`, `referrer`, ... and `Symbol.iterator`
  through the prototype chain, where a getter on `Object.prototype` would see the headers). This does not make the token
  secret from the app: Chromium's `performance.getEntriesByType("navigation")[0].name` keeps the address the page opened
  with, fragment and token included, after `replaceState` (tested; decision "(3.25) Residual"). Only a separate origin
  or frame for the data client would.
- In Playwright, a document served through `page.route` cannot load files from a real loopback server (Chromium's
  private network check, "Permission was denied for this request to access the `loopback` address space"): route every
  file of such a page, or serve the page from the server and route only one script.
- Apps hide screens both ways (3.25 try 3): with the `hidden` attribute and with CSS classes (`.screen.hidden { display: none }`,
  a class named `hidden`, not the attribute). A check of "what a visitor sees once the screen is open" looks at the element's
  own hiding only (its `hidden`, its own `display`/`opacity`, its `visibility` unless inherited), never at its ancestors.
  `workshop-data.js` shows only the sign-in elements present at `DOMContentLoaded`: AGENTS.md puts them in `index.html`.
- The deploy check does not parse JavaScript; the builder's PostToolUse hook does (`scriptSyntaxProblem`, 3.25 try 3), so
  the agent hears of a syntax error (a `'` inside a `'...'` string: "missing ) after argument list") while it can fix it.
