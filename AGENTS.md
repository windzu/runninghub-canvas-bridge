# AGENTS.md

## Project

This repository investigates RunningHub infinite canvas API/tool-level control for external agents.

Primary goal:

- allow Codex or another Agent to operate RunningHub canvas without mouse automation.

Primary integration shape:

- local bridge server
- Chrome extension injected into the logged-in RunningHub page
- page-context API calls
- eventual MCP server or Codex plugin

## Communication

- Use Chinese when reporting to wind.
- Keep English technical terms when useful.
- Use Chinese corner quotes: 「」.
- Be direct about uncertainty and blockers.
- Do not expose cookies, access tokens, or private payloads in chat or committed files.

## Development Notes

- Prefer small, inspectable changes.
- Keep the bridge local-only by default.
- Do not commit captured private RunningHub data.
- Do not print raw auth headers.
- If adding logs, redact `authorization`, `token`, and `cookie`.
- Treat `page.eval` as a dangerous local debugging hook.

## Useful Commands

- `node --check server/server.mjs`
- `node server/server.mjs`
- `curl http://127.0.0.1:8765/health`
- `curl http://127.0.0.1:8765/events`

