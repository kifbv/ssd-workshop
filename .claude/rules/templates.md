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
  template's own docs and AGENTS.md must name no `scheme://` address (describe them in words). XML namespace
  names (`http://www.w3.org/2000/svg`, ...) are allowed.
- ESLint lints `templates/**/*.js` as browser scripts with the globals declared in `eslint.config.mjs`;
  a new browser global used there must be added to that list.
