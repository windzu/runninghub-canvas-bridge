# RunningHub Canvas Bridge

RunningHub Canvas Bridge is a local research bridge for controlling RunningHub infinite canvas through the page's own API context instead of mouse automation.

The goal is:

- Observe what RunningHub's built-in Agent sends and receives.
- Reuse the logged-in browser page as the trusted API caller.
- Let external agents such as Codex create nodes, connect edges, read canvas state, and eventually run canvas workflows.

This repository is intentionally local-first. It should not collect, print, or commit cookies, tokens, or private project data.

## Current Status

Prototype only.

Implemented:

- Chrome unpacked extension injected into `https://rhtv.runninghub.cn/*`.
- Main-world `fetch` and `XMLHttpRequest` interception for selected RunningHub canvas and Agent endpoints.
- Local HTTP bridge at `http://127.0.0.1:8765`.
- Command channel from Codex/local scripts back into the page.
- Basic DOM graph snapshot command.
- Page-context API POST command that uses the browser session without exporting cookies.

Not implemented yet:

- Stable CLI client.
- Typed RunningHub API models.
- Direct workflow save/create wrapper.
- MCP server packaging for Codex.
- Robust SSE parsing for `/canvas/openclaw/chat`.
- Automated install flow for Chrome extension.

## Repository Layout

- `extension/manifest.json`: Chrome MV3 extension manifest.
- `extension/bridge-main.js`: injected page bridge.
- `server/server.mjs`: local bridge server.
- `docs/context.md`: research context and known RunningHub internals.
- `docs/next-steps.md`: recommended continuation plan.

## Quick Start

1. Start the local bridge server:

   `node server/server.mjs`

2. Open Chrome extension management:

   `chrome://extensions/`

3. Enable Developer Mode and load unpacked extension:

   `/Users/wind/Projects/runninghub-canvas-bridge/extension`

4. Refresh a RunningHub canvas page:

   `https://rhtv.runninghub.cn/projects/canvas/<canvas_id>`

5. Check whether the bridge is connected:

   `curl http://127.0.0.1:8765/events`

6. Send a basic graph snapshot command:

   `curl -X POST http://127.0.0.1:8765/command -H 'Content-Type: application/json' -d '{"type":"graph.snapshot"}'`

7. Read the result:

   `curl http://127.0.0.1:8765/events`

## Security Notes

- The extension runs in the page main world and can call RunningHub APIs as the logged-in user.
- The bridge is bound to `127.0.0.1` only.
- Request headers containing `authorization`, `token`, or `cookie` are redacted before being posted to the local bridge.
- The `page.eval` command is intentionally powerful and should remain local-only.
- Do not publish captured request bodies if they contain private project data.

## Working Principle

RunningHub's built-in Agent appears to work in two stages:

1. The page sends conversation messages to `/canvas/openclaw/chat`.
2. The response contains tool calls or `canvas-command` instructions.
3. The frontend executes local tools such as `create_workflow`, `update_node_params`, `run_node`, and `delete_node`.
4. Those tools mutate the Vue Flow canvas state and persist it through canvas/workflow APIs.

This bridge tries to expose the same layer to external agents. It is not trying to replace the browser UI with clicks.

