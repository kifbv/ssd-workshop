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
- The deploy check scans every text file, Markdown and comments included, for outside addresses: a
  template's own docs and AGENTS.md must name no `scheme://` address (describe them in words), and no
  `http:`/`https:` followed by text. Only the XML namespace names in `NAMESPACE_ADDRESSES` are allowed.
  Comments start with `// ` (a space): `'x'//note` fails the check.
- The apps' CSP (`default-src 'self'`, `connect-src 'self'`, `img-src 'self' data:`) still lets the page
  load its own files and call the data API under the sandbox (`'self'` is the served address, not the
  opaque origin; tested). No inline `<script>`, `<style>`, `style=` or `on*=`: the CSP blocks them.
- Chromium logs every 404 (and every refused request) as a console error, and the template's test
  fails on any console error: the data API answers a missing key with `200` and `null`, never 404.
- ESLint lints `templates/**/*.js` as browser scripts with the globals declared in `eslint.config.mjs`;
  a new browser global used there must be added to that list.
