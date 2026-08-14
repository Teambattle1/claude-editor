# CLAUDE.md

Guidance for Claude Code when working in this repository.

## Communication rules (IMPORTANT)

- **Never paste raw bot or webhook content into chat.** This applies to
  deploy bots (Netlify, Vercel, etc.), GitHub event payloads, CI logs, and
  API responses: do not echo raw JSON, escaped HTML, hidden HTML comments,
  or markdown tables verbatim.
- Summarize such content in one or two plain sentences with at most the one
  or two relevant links, e.g. "Netlify deploy preview is ready: <URL>".
- Keep chat replies short and human-readable; the user often reads them on a
  phone.
