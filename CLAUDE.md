# CLAUDE.md

Guidance for Claude Code when working in this repository.

## Project

Sunkez Claude Editor (`package.json` name `sunkez-claude-editor`) is a
local, Node.js web app that provides a browser-based visual editor/dashboard
for driving the Claude CLI with live preview. `server.js` is an
Express + WebSocket (`ws`) server that spawns and manages Claude CLI
processes per project (via `node-pty`/`child_process`), streams command
output to the browser in real time, watches project files with `chokidar`,
and can launch an integrated Vite/Netlify dev server for a live preview
pane. The frontend is a single static `public/index.html` (vanilla
HTML/CSS/JS, no build step or framework). It's a local developer tool, not
a deployed web service: it runs on the developer's own machine
(`npm start` → http://localhost:3333) against a folder of local projects,
and `server.js`/`run-claude.sh` hardcode local paths (e.g. `GITHUB_PATH`,
the `claude` CLI binary location) that need to be edited per machine.

## Commands

- `npm start` — start the Express/WebSocket server on port 3333
- `npm run dev` — same as `npm start` (also runs `node server.js`)

There is no configured `lint`, `test`, or `build` script — there's no build
step since the frontend is plain static HTML/JS.

## Communication rules (IMPORTANT)

- **Never paste raw bot or webhook content into chat.** This applies to
  deploy bots (Netlify, Vercel, etc.), GitHub event payloads, CI logs, and
  API responses: do not echo raw JSON, escaped HTML, hidden HTML comments,
  or markdown tables verbatim.
- Summarize such content in one or two plain sentences with at most the one
  or two relevant links, e.g. "Netlify deploy preview is ready: <URL>".
- Keep chat replies short and human-readable; the user often reads them on a
  phone.
- Do not subscribe to pull-request activity (`subscribe_pr_activity`) unless
  the user explicitly asks for PR monitoring: the raw GitHub/Netlify event
  notifications are rendered verbatim in the chat, which is exactly the
  noise these rules exist to prevent. To follow up on a PR, use a quiet
  scheduled check-in (e.g. `send_later`) instead.

## Task tracking (IMPORTANT)

- At the start of every session, create a todo list from the user's requests
  (use the task/todo tools): one item per thing the user asks for.
- Update the list as work proceeds — mark items in progress when started and
  completed as each fix lands — so the user can always see current status.
- When the user adds new requests mid-session, add them to the list
  immediately; never leave the list stale.
