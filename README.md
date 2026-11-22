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

Licence: [MIT](LICENSE).
