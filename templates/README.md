# App templates

Starters for participants' apps. Advanced-track apps are Python (later phases).

- `basic/` (ticket 2.3): the starter every workshop app is built from: a single page in plain HTML,
  CSS and JavaScript (`index.html`, `style.css`, `app.js`), the data client `workshop-data.js`,
  `SPEC.md` (replaced by the approved spec), a participant-facing `README.md` and `AGENTS.md`, the
  coding agent's instructions.

Templates are plain files, not an npm workspace and not typechecked. Their tests live with the
deploy check in `platform/api/build/` (`check.test.ts`, `template.test.ts`), and an app must pass
that check (`platform/api/build/check.ts`) before it goes live.
