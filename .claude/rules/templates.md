---
paths:
  - "templates/**"
---

# App template rules

- Starters for participant apps; advanced-track apps are Python.
- Participant app commits are automatic and never reviewed, so a starter must be safe to deploy
  as it is.
- Apps are served under the sandbox CSP (`APPS_CONTENT_SECURITY_POLICY` in `infra/lib/config.ts`): the page
  has an opaque origin (`origin` is `"null"`). Use classic `<script defer>` tags, never `type="module"`: a
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
