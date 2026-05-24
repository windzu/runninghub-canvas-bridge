# Project Context

## User Goal

wind wants external agents, especially Codex, to operate RunningHub infinite canvas through API/tool-level control.

The target interaction style is:

Codex -> local bridge -> logged-in RunningHub page context -> RunningHub internal canvas APIs -> infinite canvas nodes/edges/tasks

The explicit non-goal is mouse-only UI automation. Mouse automation may be useful for setup, but the core capability should be API/tool based.

## Important URLs

- RunningHub homepage: `https://www.runninghub.cn/`
- Infinite canvas host: `https://rhtv.runninghub.cn/`
- Test canvas used during research: `https://rhtv.runninghub.cn/projects/canvas/2058411776657580034`
- Earlier canvas: `https://rhtv.runninghub.cn/projects/canvas/2057748076759080961`

## Observed Built-in Agent Behavior

The built-in RunningHub Agent can create nodes and edges without manual dragging.

Observed successful test:

- Canvas: `2058411776657580034`
- Prompt: create two text nodes and connect them, no generation and no RH coin consumption.
- Created nodes:
  - `node-1779598635392-mmzm0bf4d`
  - `node-1779598635400-hw447lcjb`
- Created group:
  - `group-1779598635402`
- Created edge:
  - `e-node-1779598635392-mmzm0bf4d-node-1779598635400-hw447lcjb`
- Refresh preserved the graph, so the result was persisted server-side.

## Known RunningHub APIs

Agent/session:

- `/canvas/openclaw/sessions/create`
- `/canvas/openclaw/sessions/list`
- `/canvas/openclaw/sessions/detail`
- `/canvas/openclaw/sessions/delete`
- `/canvas/openclaw/turns/delete`
- `/canvas/openclaw/chat`
- `/napi/_openclaw-direct?target=`
- `/api/agent/media`

Canvas/workflow:

- `/canvas/model/list`
- `/canvas/list`
- `/canvas/case/list`
- `/canvas/create`
- `/canvas/delete`
- `/canvas/checkUserIdByCanvasId`
- `/canvas/workflow/list`
- `/canvas/workflow/save`
- `/canvas/workflow/delete`
- `/canvas/his/list`
- `/canvas/his/delete`
- `/canvas/his/deleteBatch`
- `/canvas/task/run`
- `/canvas/task/cancel`
- `/canvas/task/batchStatus`
- `/canvas/rename`
- `/canvas/workflow/detail`
- `/canvas/case/detail`
- `/canvas/createFromCase`
- `/canvas/getCanvasDetail`
- `/canvas/price/estimate`

Additional namespaces were seen under:

- `/canvas/asset/...`
- `/canvas/team/comment/...`
- `/canvas/director/...`

## Known Local Agent Tool Names

Extracted from frontend chunks:

- `get_canvas_state`
- `get_node_output`
- `get_all_canvas_nodes`
- `get_available_models`
- `focus_canvas_area`
- `get_node_upstream`
- `create_workflow`
- `update_node_params`
- `run_node`
- `delete_node`
- `run_group`
- `quick_actions`
- `set_delivery_plan`

## `create_workflow` Shape

Known schema fields:

- `name`
- `nodes[]`
- `edges[]`
- `group.name`
- `autoRun`
- `metadata`

Known node fields:

- `id`
- `type`: observed values include `rh-text`, `rh-image`, `rh-video`
- `title`
- `content`
- `subType`
- `editAction`
- `aspectRatio`
- `agentNodeType`
- `sourceNodeId`

Known edge fields:

- `source`
- `target`

## Hypothesized Execution Chain

1. User sends message in RunningHub Agent UI.
2. Frontend calls `/canvas/openclaw/chat`.
3. Chat request body includes fields such as:
   - `messages`
   - `sessionId`
   - `stream: true`
   - `temperature`
   - `isNewSession`
   - `agentId`
   - optional `previousResponseId`
   - optional `toolOutputs`
4. Agent response returns text, tool calls, or `canvas-command`.
5. Frontend executes local tool registry, likely through a dispatcher similar to `yu(name,args,{canvasStore,apiContext})`.
6. `create_workflow` returns `_workflowConfig`.
7. A `workflow-config` message with `_pendingAutoApply: true` triggers auto-apply.
8. `handleWorkflowConfirm` converts workflow config into Vue Flow nodes/edges/groups.
9. Canvas state is persisted through internal canvas/workflow endpoints.

## Why a Custom Bridge

Codex already has browser capabilities, but they are mostly for browser automation:

- opening pages
- clicking
- typing
- reading DOM
- screenshots
- limited page inspection

This project needs a higher-permission integration point:

- main-world injection
- request/response capture
- page-context API calls using logged-in browser state
- command channel from Codex to the live page
- preservation of session secrecy by not exporting cookies/tokens

## Current Prototype Behavior

`extension/bridge-main.js`:

- Installs `window.__RUNNINGHUB_CANVAS_BRIDGE__`.
- Patches `window.fetch`.
- Patches `XMLHttpRequest`.
- Captures URLs matching:
  - `openclaw`
  - `canvas/workflow`
  - `canvas/task`
  - `canvas/getCanvasDetail`
  - `canvas/create`
  - `canvas/rename`
- Posts events to `http://127.0.0.1:8765/events`.
- Polls `http://127.0.0.1:8765/commands`.
- Supports commands:
  - `graph.snapshot`
  - `canvas.exportWorkflow`
  - `canvas.yjsSnapshot`
  - `canvas.createTextWorkflow`
  - `canvas.createTextNode`
  - `canvas.connectNodes`
  - `canvas.updateNodePosition`
  - `canvas.updateNodeText`
  - `canvas.deleteElements`
  - `canvas.getDetail`
  - `canvas.workflowList`
  - `api.post`
  - `page.eval`
- Captures WebSocket open/status events with token-bearing query params redacted.

`server/server.mjs`:

- Listens on `127.0.0.1:8765`.
- Stores recent events in memory.
- Queues commands in memory.
- Stores command result events by command id.
