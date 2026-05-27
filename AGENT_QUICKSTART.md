# Agent Quickstart

This product is a local tool layer for operating a logged-in RunningHub infinite canvas without mouse automation.

When using an installed release, prefer `runninghub-canvas-bridge ...` commands. Do not patch installed package internals to recover from bridge errors; run `runninghub-canvas-bridge doctor` and `runninghub-canvas-bridge report --write` instead.

For repeatable Agent-as-user QA, follow `docs/agent-qa-playbook.md`.

The goal for any Agent is simple:

1. Verify the bridge and page are ready.
2. Read the canvas state.
3. Create or update nodes through structured commands.
4. Validate before paid generation.
5. Run generation only when allowed.
6. Poll nodes for structured output URLs.

## First Commands

Run these before changing the canvas:

- `runninghub-canvas-bridge agent-manifest`
- `runninghub-canvas-bridge doctor`
- `runninghub-canvas-bridge canvas-summary`

Only proceed when `preflight.ok` is `true`.

Important blocking reasons:

- `BRIDGE_OFFLINE`: start `node server/server.mjs`.
- `NO_PAGE_CLIENT`: open or refresh a RunningHub canvas page with the unpacked extension enabled.
- `STALE_RUNTIME`: refresh the RunningHub canvas page or let the runtime auto-reload on the next command.
- `MISSING_CAPABILITY`: the live page runtime does not expose the expected Agent commands.

If `NO_PAGE_CLIENT` persists, run:

- `runninghub-canvas-bridge diagnose-extension`

First-time Chrome setup may show a local-network permission prompt for `rhtv.runninghub.cn`. The user must allow it before the page can reach `127.0.0.1`.

## Upload Local Images

Prefer the one-shot command:

- `runninghub-canvas-bridge upload-local-reference-image --file /absolute/path/image.jpg --config-json '{"x":300,"y":300,"title":"参考图"}' --timeout 60000`

Use these fields from the result:

- `primaryReference.nodeId`: direct upstream image node id for image/video generation.
- `primaryReference.urls[0]`: uploaded image URL.
- `usableReferences[]`: all image reference nodes found after upload.

Avoid relying on the staging node unless you specifically need it for layout. RunningHub may create a separate native upload node; `primaryReference.nodeId` is the Agent-friendly reference.

## Create References From URLs

If you already have a usable image URL, prefer:

- `runninghub-canvas-bridge create-reference-from-url --url <imageUrl> --config-json '{"x":300,"y":300,"title":"参考图"}'`

Use `primaryReference.nodeId` exactly as you would use a locally uploaded reference.

## Create And Connect Nodes

Common primitives:

- `create-text-node`: create a prompt/spec node.
- `create-text-nodes`: create a coherent set of prompt/spec nodes with one rollback id.
- `suggest-empty-region`: find a conservative empty area before adding nodes to a crowded canvas.
- `group-elements`: visually group explicitly provided nodes after creating a coherent block.
- `create-image-node`: create an image generation node without running generation.
- `create-video-node`: create a video generation node without running generation; add `--multimodal` for reference-conditioned video setup.
- `connect-nodes`: connect any two existing nodes.
- `update-node`, `update-node-params`, `update-node-text`: change node fields.
- `move-node`, `move-nodes`: arrange canvas layout.
- `delete-elements --dry-run`: inspect deletion impact before deleting.

Mutation commands return a rollback id when applied. Use `rollback-list` and `rollback` if a command creates the wrong canvas state.

## Safe Video Generation

Use this order:

1. Create or identify an `rh-video` node.
2. Connect at least one direct upstream `rh-image` reference node.
3. Connect or provide prompt text.
   `prepare-video-node` preserves existing video prompt text by default and merges upstream text/reference inputs.
4. Validate:
   `runninghub-canvas-bridge validate-node-run <videoNodeId> --require-references`
5. Dry-run:
   `runninghub-canvas-bridge generate-video-node <videoNodeId> --dry-run --timeout 60000`
6. Confirm:
   - `validation.ok` is `true`
   - `subType` is `multimodal-video`
   - `modelCode` contains `multimodal-video`
   - every `references[].hasDirectUpstreamImage` is `true`
7. Run only when generation is allowed:
   `runninghub-canvas-bridge generate-video-node <videoNodeId> --timeout 180000`
8. Poll output:
   `runninghub-canvas-bridge poll-node-result <videoNodeId> --poll-timeout 300000 --timeout 305000`

The poll result exposes `outputs[].url` for generated media.

If you have a RunningHub `taskId`, use:

- `runninghub-canvas-bridge poll-task-result <taskId> --poll-timeout 300000 --timeout 305000`

This scans canvas node outputs for matching `taskId`.

## Rules For Agents

- Do not use `page.eval` in normal workflows.
- Do not print cookies, tokens, authorization headers, or private payloads.
- Prefer compact `canvas-summary`, `find-elements --summary`, and field-limited output before requesting full node payloads.
- Use `--pretty-summary` for supervised human-readable output, and default JSON for machine parsing.
- Prefer high-level commands over reconstructing RunningHub internals.
- For paid generation, dry-run and validate first.
- Treat returned node ids and URLs as the source of truth; do not infer them from the visible UI.
- If a command returns structured warnings or blocking errors, stop and fix those before running generation.
