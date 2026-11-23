# SSD Workshop

Platform for an interactive AI workshop: participants take a small app idea from a sentence to a live web app, guided by AI, with every step explained. Fast finishers continue into an advanced track with data apps on Kubernetes (GitOps with Flux) around a shared Subsurface Globe.

- Specification (signed off 2026-11-22): [AI Workshop Platform: Spec](https://claude.ai/artifact/6mNkKPKQysWNoj7eL6Gyus)
- Documentation, decisions and phase briefs: [docs/README.md](docs/README.md)
- How we work with Claude: [CLAUDE.md](CLAUDE.md)

## Layout

| Folder       | Contents                                             |
| ------------ | ---------------------------------------------------- |
| `infra/`     | AWS CDK app (TypeScript) and the access stack        |
| `platform/`  | API and web pages (TypeScript)                       |
| `templates/` | Participant app starters (later phases)              |
| `docs/`      | Decisions and phase briefs                           |

## Checks

```
npm ci
npm run lint
npm run typecheck
npm test
```

## Allow-list (ticket 1.3)

Only people on the allow-list can sign in. Franck loads it from his own machine, with his own AWS
credentials (default credential chain; they need `dynamodb:UpdateItem` and `dynamodb:Scan` on the
`ssd-workshop-data` table in `eu-central-1`):

```
npm run -s allowlist -- import /path/outside/the/repo/people.csv
npm run -s allowlist -- list
```

- The CSV starts with the header `email,group,role`; one person per line, no quoted fields. Role is
  `participant`, `facilitator` or `admin`; emails are stored trimmed and lower-cased. A group that
  holds an `@` is rejected, so an address pasted in the wrong column is never stored.
- Give the file as an absolute path (a relative path is refused). It must stay outside this
  repository and outside any other git work tree (no folder above it holds a `.git`): such a path is
  refused, symlinks included, and so is a file with more than one hard link or a path that is not a
  file. `*.csv` is also in `.gitignore`. A "bare" dotfiles repository (`git --git-dir=~/.cfg
  --work-tree=~`) leaves no `.git` to find, so keep the file out of any such work tree yourself.
- `import` prints how many people were added, updated and rejected, and the line number and reason
  of each rejected line; importing again updates group and role. `list` prints counts per group and
  role. Neither ever prints an address.

## Sign-in code (ticket 1.4)

`POST /api/sign-in/code` with `{"email": "..."}` emails a 6-digit code (valid 10 minutes) to an
allow-listed address, at most 5 codes per address in any hour, and answers every well-formed request
the same way (202 and a neutral message, always 3 seconds after the request arrives). Every
unexpired code stays valid, so asking again does not cancel a code already on its way. After the
deploy, Franck checks it from his own machine (no AWS credentials needed; Claude sessions cannot
reach the site):

```
npm run -s smoke -- signin <your address>
# expect: Status: 202, the neutral answer, and the code email in your inbox
```

Keep the `-s`: without it npm prints the command line, address included. The command prints the
address only masked (`f***@e***.com`).

Licence: [MIT](LICENSE).
