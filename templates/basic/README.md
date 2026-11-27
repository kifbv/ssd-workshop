# How this app is made

```mermaid
flowchart LR
  spec[SPEC.md<br/>what the app should do] --> agent[The coding AI<br/>follows AGENTS.md]
  agent --> page[index.html<br/>the page]
  agent --> look[style.css<br/>how it looks]
  agent --> code[app.js<br/>what it does]
  code --> data[workshop-data.js<br/>saves and loads data]
  data --> service[(The workshop's<br/>data service)]
```

You described your idea, the workshop's AI wrote it down as a spec, and a coding AI built the app
from it. Every file is plain HTML, CSS or JavaScript, so you can open any of them and read it.

## The files

| File | What it is |
| --- | --- |
| `index.html` | The page itself: its title, headings, buttons and text. The browser opens this file first. |
| `style.css` | How the page looks: colours, sizes and spacing, in light and dark mode, on a phone or a laptop. |
| `app.js` | What the page does when you tap or type: it reacts, changes the page and saves data. |
| `workshop-data.js` | A small helper that saves and loads the app's data (and any photos or voice recordings) on the workshop's data service. Everyone who opens the app shares the same data. Saving needs the app's edit link (the link or QR code on the workshop page); with the plain address the app is view only. |
| `SPEC.md` | The spec you approved: what the app should do. |
| `AGENTS.md` | The instructions the coding AI followed while building the app. |
| `README.md` | This file. |

## Where the app lives

The app is published at the workshop's address, under `/apps/` and your nickname. Before it goes
live, a check makes sure it holds only web files, uses nothing from other websites and stays under
5 MB.

## Good to know

- Anyone with the app's address can open it and see its data. Only someone with its edit link (the link or QR code
  on the workshop page) can change it: share that link only with people who may save. What they save shows your
  workshop nickname as who saved it. Keep personal details out of it.
- Each change is saved as a commit in this repository, so you can see how the app grew step by step.
