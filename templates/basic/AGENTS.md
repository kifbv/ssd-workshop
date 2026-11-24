# Instructions for the coding agent

You build one small web app in this folder, exactly as `SPEC.md` describes it. Read `SPEC.md` first,
then the files below. Replace the starter content (the shared counter) with the app.

## What you can do

You have file tools only: read, write, edit and list files in this folder. There is no shell, no
network and no package manager. You cannot run or preview the app, so check your work by reading it.

## The files

- `index.html`: the single page. Keep the `<link>` to `style.css` and the two `<script ... defer>`
  tags, `workshop-data.js` before `app.js`.
- `style.css`: all styles.
- `app.js`: all behaviour. A classic script (no `import`/`export`), run after the page is parsed.
- `workshop-data.js`: the data client. Do not change it.
- `SPEC.md`: the approved spec. Do not change it.
- `README.md`: explains the files to the participant. If you add a file, add a row for it to the
  table there, in the same plain words.
- `AGENTS.md`: this file. Do not change it.

## Rules

1. Plain HTML, CSS and JavaScript only. No frameworks, no libraries, no build step, no TypeScript,
   no JavaScript modules (`type="module"`, `import`, `export`).
2. One page: `index.html`. Show different screens by hiding and showing sections, not with more
   HTML files. Give each screen a heading, or a tab or button that opens it, carrying the screen's
   name exactly as `SPEC.md` lists it under "Screens" (a screen called "Home" has a "Home" heading
   or tab), so participants find what their spec describes.
3. No outside addresses anywhere, in any file, comments, Markdown and `placeholder` texts included.
   No fonts, images, scripts, styles or APIs from other websites. Draw icons and images as inline
   SVG or CSS, or as `.svg`/`.png` files in this folder, referenced by relative paths such as
   `images/logo.svg`. The deploy check refuses:
   - any address of the form name, colon, two slashes (whatever the name: http, https, ws, wss, ftp,
     git and any other);
   - http, https, ws, wss or ftp followed by a colon and more text, even without slashes;
   - two or more slashes or backslashes followed by a server name after a quote, a backtick, `=`,
     a comma or `url(`, even with spaces between;
   - the same written with HTML entities (`&#47;`, `&colon;`) or escapes (`\2f`, `\/`, `\u002f`).

   The only addresses allowed are these XML namespace names, exactly as written (SVG, MathML and
   `createElementNS` need them; they are never loaded):

   ```
   http://www.w3.org/2000/svg
   http://www.w3.org/1999/xlink
   http://www.w3.org/1999/xhtml
   http://www.w3.org/XML/1998/namespace
   http://www.w3.org/2000/xmlns/
   http://www.w3.org/1998/Math/MathML
   ```

   Do not give SVG files a `<!DOCTYPE>`: it names an address. Start JavaScript comments with two
   slashes and a space, never two slashes and a word: a comment that follows a closing quote with
   no space between looks like an address to the check.
4. No `localStorage`, `sessionStorage`, `indexedDB` or cookies: the app runs in a sandbox where
   using them throws an error. Keep state in variables and store anything that must last with
   `workshop-data.js`.
5. Storing data: `await workshopData.get(key)` returns the stored JSON value or `null`;
   `await workshopData.set(key, value)` stores any JSON value; `await workshopData.remove(key)`
   deletes it. Keys use only letters, digits, `-` and `_`. Every call can fail: wrap it in
   `try`/`catch` and show `error.message` on the page. Limits: 100 KB per value, 100 keys and 1 MB
   per app. All visitors share the same data, and anyone with the app's address can read and change it.
6. No personal data: no email addresses, phone numbers, names of real people, passwords or keys in
   the code, and do not ask visitors for an email address or a password. The app has no sign-in.
7. No `console.log` or `console.error` left in the code, and no errors in the browser console.
8. Phones first: it must work at 375 px wide with nothing scrolling sideways (no fixed widths wider
   than the screen; use `max-width: 100%` on images). Tap targets at least 44 px high.
9. Light and dark mode: keep the colour variables in `style.css` and the
   `prefers-color-scheme: dark` block, and give every new colour a value in both.
10. Accessible: real `<button>`, `<label>` and heading elements, `alt` text on images, enough colour
    contrast, visible focus, and `role="status"` on text that changes after an action.
11. No inline `<script>` or `<style>` elements and no `style="..."` or `on...="..."` attributes
    (`onclick`, `onload`, ...): the app's security policy blocks them, so they would do nothing.
    Put styles in `style.css` and behaviour in `app.js` (use `addEventListener`), and set text with
    `textContent`. The page may load only its own files: images also from `data:` addresses.
12. Set the page's `<title>` and `<h1>` to the app's name from `SPEC.md`.

## The deploy check

Before the app goes live, a check refuses it if any rule below is broken. The whole build then fails.

- Allowed file types only: `.html .css .js .json .md .txt .svg .png .jpg .jpeg .gif .webp .ico .woff .woff2`.
  No other types, no files without a type, no hidden files (names starting with a dot) and no links.
- Text files are saved as UTF-8.
- File and folder names use only letters, digits, `-`, `_` and `.`.
- No outside address in any text file (rule 3). The only address allowed is the workshop's own, and
  the app never needs it: use relative paths.
- All files together at most 5 MB.
- `index.html` stays at the top of the folder.

## When you are done

Re-read `SPEC.md` and check that every screen and action it names is in the app, then re-read your
files against the rules above.
