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
- Local CLI for health checks, event inspection, graph snapshots, and first canvas API wrappers.
- Yjs/Nexus canvas commands for querying, creating, updating, moving, connecting, and deleting basic canvas elements.

Not implemented yet:

- Typed RunningHub API models.
- Direct workflow save/create wrapper.
- MCP server packaging for Codex.
- Robust SSE parsing for `/canvas/openclaw/chat`.
- Automated install flow for Chrome extension.

## Repository Layout

- `extension/manifest.json`: Chrome MV3 extension manifest.
- `extension/bridge-main.js`: stable loader injected by Chrome.
- `server/bridge-runtime.js`: hot-loaded page bridge runtime served by the local server.
- `server/server.mjs`: local bridge server.
- `AGENT_QUICKSTART.md`: minimal handoff guide for Agents operating the canvas.
- `docs/agent-usage.md`: fuller operating guide for autonomous Agents.
- `docs/context.md`: research context and known RunningHub internals.
- `docs/next-steps.md`: recommended continuation plan.
- `CONTRIBUTING.md`: Issue reporting guidelines and current contribution policy.

## Quick Start

Prerequisites:

- Node.js 18 or newer.
- Chrome or another Chromium browser that supports unpacked extensions.
- A logged-in RunningHub account.
- An existing RunningHub canvas page, for example:

  `https://rhtv.runninghub.cn/projects/canvas/<canvas_id>`

Setup:

1. Clone this repository and enter the project directory.

2. Start the local bridge server:

   `npm run start`

3. Open Chrome extension management:

   `chrome://extensions/`

4. Enable Developer Mode and load the unpacked extension from this repository:

   `<repo_root>/extension`

5. Open or refresh a RunningHub canvas page:

   `https://rhtv.runninghub.cn/projects/canvas/<canvas_id>`

   On first run, Chrome may ask whether `rhtv.runninghub.cn` can access local devices or services. Allow this prompt so the page can reach the local bridge at `127.0.0.1`.

After the unpacked extension is loaded once, most bridge changes only require restarting the local bridge server if needed and refreshing the RunningHub page. The extension loader fetches the latest runtime from `http://127.0.0.1:8765/bridge-runtime.js`.

Verify:

1. Check local server health:

   `npm run bridge -- health`

2. Check whether the page client is connected:

   `npm run bridge -- events`

3. Run Agent preflight checks:

   `npm run bridge -- preflight`

   Continue only when `preflight.ok` is `true`.

4. Send a basic graph snapshot command:

   `npm run bridge -- snapshot`

5. Read canvas details through the page context:

   `npm run bridge -- get-canvas-detail <canvas_id>`

6. Read workflow list through the page context:

   `npm run bridge -- workflow-list <canvas_id>`

The CLI waits for command results by default. If multiple RunningHub tabs are open, use the `clientId` shown in `events`:

`npm run bridge -- snapshot --client <clientId>`

When no `--client` is passed, the server routes commands to the most recently active RunningHub canvas tab. Use `npm run bridge -- clients` to inspect active page clients.

CLI output is JSON by default for automation. Add `--pretty-summary` to common commands when you want a compact human-readable summary.

Common setup failures:

- `BRIDGE_OFFLINE`: start the local server with `npm run start`.
- `NO_PAGE_CLIENT`: open or refresh a RunningHub canvas page with the unpacked extension enabled.
- `STALE_RUNTIME`: refresh the RunningHub canvas page so it picks up the latest runtime.
- `MISSING_CAPABILITY`: refresh the page and verify the extension loaded from the current repository.

Run `npm run bridge -- diagnose-extension` when `NO_PAGE_CLIENT` persists. It reports local runtime reachability, expected extension matches, recent bridge events, selected client routing, and first-run Chrome local-network permission hints.

For autonomous Agent usage, start with `AGENT_QUICKSTART.md`, then use `docs/agent-usage.md` when implementing longer workflows.

### Optional macOS Service

For a persistent local bridge on macOS:

- `npm run service:install`: create and start a user LaunchAgent.
- `npm run service:status`: check LaunchAgent state and bridge health.
- `npm run service:restart`: restart the local service.
- `npm run service:uninstall`: remove the LaunchAgent.

The service runs `server/server.mjs` locally and does not store cookies, tokens, or private payloads.

## CLI Commands

- `npm run bridge -- health`: check local bridge server state.
- `npm run bridge -- diagnose-extension`: diagnose extension injection, localhost reachability, selected client routing, and first-run browser permission blockers.
- `npm run bridge -- clients`: list active bridge clients seen by the local server.
- `npm run bridge -- events`: list recent bridge events.
- `npm run bridge -- snapshot`: return a DOM-level graph snapshot from the live canvas page.
- `npm run bridge -- yjs-snapshot`: return the canonical Yjs canvas nodes and edges.
- `npm run bridge -- canvas-summary`: return compact Agent-oriented canvas state. Use `--full` for full edge output, `--limit <n>`, `--types <csv>`, `--status <csv>`, `--fields <csv>`, `--no-urls`, and `--no-text-preview` to control output size.
- `npm run bridge -- rollback-list`: list recent rollback points created by mutating commands.
- `npm run bridge -- rollback [rollbackId]`: restore the latest or selected rollback point.
- `npm run bridge -- capabilities`: return supported bridge commands and parameter notes.
- `npm run bridge -- find-elements --query-json '<json>'`: find nodes and edges by id, type, text/title query, or position bounds. Use `--summary`, `--fields <csv>`, `--limit <n>`, `--no-outputs`, and `--text-preview-length <n>` for safer compact output.
- `npm run bridge -- suggest-empty-region --near-text '<text>' --width <n> --height <n> --padding <n>`: suggest a conservative empty region for new Agent-created nodes.
- `npm run bridge -- get-element <id>`: return one node or edge by id.
- `npm run bridge -- inspect-node-template <nodeId>`: extract a reusable `create-node` template from an existing node.
- `npm run bridge -- inspect-model-options --sub-type <subType>`: return observed model options and parameter notes.
- `npm run bridge -- resolve-model-alias <modelName>`: map a user-facing model name such as `GPT Image 2` to the observed RunningHub model name and `modelCode`.
- `npm run bridge -- connections <nodeId> --direction <both|upstream|downstream> --depth <n>`: return connected nodes and edges.
- `npm run bridge -- create-text-workflow --config-json '<json>'`: create two text nodes, one group, and one edge through the canvas Yjs room.
- `npm run bridge -- create-text-node --config-json '<json>'`: create one `rh-text` node.
- `npm run bridge -- create-text-nodes --config-json '<json-array>'`: create multiple `rh-text` nodes as one operation with one rollback id.
- `npm run bridge -- group-elements <id...> --title '<name>' --padding <n>`: create a visual group around explicitly provided nodes.
- `npm run bridge -- create-node --config-json '<json>'`: create one generic canvas node from a node template, type, position, and data.
- `npm run bridge -- create-video-node --config-json '<json>' [--multimodal]`: create one native `rh-video` node without running generation; use `--multimodal` for reference-conditioned video setup.
- `npm run bridge -- create-image-node --config-json '<json>'`: create one native `rh-image` text-to-image node without running generation.
- `npm run bridge -- create-reference-from-url --url <url> --config-json '<json>'`: create a directly usable reference image node from an existing URL.
- `npm run bridge -- upload-local-reference-image --file <path> --config-json '<json>'`: create a staging image node, upload the local file, and return directly usable reference node ids and URLs.
- `npm run bridge -- upload-reference-image <nodeId> --file <path>`: inject a local image into an existing rendered image node.
- `npm run bridge -- prepare-video-node <nodeId> --append-prompt '<text>'`: merge upstream prompt/reference inputs into an `rh-video` node without running generation.
- `npm run bridge -- connect-nodes <sourceId> <targetId>`: create one edge between two nodes.
- `npm run bridge -- update-node-model <nodeId> <modelCode>`: update one node's `data.modelCode`.
- `npm run bridge -- update-node-params <nodeId> --params-json '<json>'`: merge values into one node's `data.params`.
- `npm run bridge -- update-node <nodeId> --patch-json '<json>' --data-json '<json>'`: update node fields such as position, data, style, zIndex, width, and height.
- `npm run bridge -- update-node-text <nodeId> <text> --title '<title>'`: update a text node through the canvas Yjs room.
- `npm run bridge -- move-node <nodeId> <x> <y>`: update a node position.
- `npm run bridge -- move-nodes <id...> --dx <n> --dy <n>`: move multiple nodes by delta, or pass `--positions-json` for explicit positions.
- `npm run bridge -- delete-elements <id...>`: delete nodes, groups, and edges by id through the canvas Yjs room.
- `npm run bridge -- validate-node-run <nodeId>`: generic pre-run validation for text, image, and video nodes.
- `npm run bridge -- poll-node-result <nodeId> --poll-timeout <ms>`: wait for generated node outputs and return structured `outputs[].url`.
- `npm run bridge -- poll-task-result <taskId> --poll-timeout <ms>`: wait for canvas outputs matching a RunningHub task id.
- `npm run bridge -- get-canvas-detail <canvasId>`: call `/canvas/getCanvasDetail` inside the logged-in page context.
- `npm run bridge -- workflow-list <canvasId>`: call `/canvas/workflow/list` inside the logged-in page context.
- `npm run bridge -- api-post <endpoint> --body-json '<json>'`: run an arbitrary POST inside the page context.

For endpoints whose body shape changes, override the wrapper default with `--body-json`. Example:

`npm run bridge -- get-canvas-detail <canvas_id> --body-json '{"id":"<canvas_id>"}'`

Mutating commands support `--dry-run`. A dry run executes the mutation on an offline Yjs copy and returns the diff without changing the live canvas. Real mutating commands return a `rollbackId` and before/after diff; use `rollback` to restore a previous point.

## Security Notes

- The extension runs in the page main world and can call RunningHub APIs as the logged-in user.
- The bridge is bound to `127.0.0.1` only.
- Request headers containing `authorization`, `token`, or `cookie` are redacted before being posted to the local bridge.
- WebSocket URLs are redacted before being posted to the local bridge.
- The `page.eval` command is intentionally powerful and should remain local-only.
- Do not publish captured request bodies if they contain private project data.

## Working Principle

RunningHub's built-in Agent appears to work in two stages:

1. The page sends conversation messages to `/canvas/openclaw/chat`.
2. The response contains tool calls or `canvas-command` instructions.
3. The frontend executes local tools such as `create_workflow`, `update_node_params`, `run_node`, and `delete_node`.
4. Those tools mutate the Vue Flow canvas state and persist it through canvas/workflow APIs.

This bridge tries to expose the same layer to external agents. It is not trying to replace the browser UI with clicks.
