# Agent Usage

This project exposes a local bridge for Agents to operate a logged-in RunningHub infinite canvas without mouse automation.

## First Commands

Run these before touching the canvas:

- `node scripts/rh-bridge.mjs agent-manifest`
- `node scripts/rh-bridge.mjs preflight`
- `node scripts/rh-bridge.mjs clients`

`agent-manifest` is machine-readable and works even when the bridge server is offline. `preflight` requires the local bridge server and checks:

- bridge server health
- live RunningHub canvas page client
- runtime version freshness
- required runtime capabilities

Only proceed when `preflight.ok` is `true`.

If `preflight` returns `NO_PAGE_CLIENT`, run `node scripts/rh-bridge.mjs diagnose-extension`. On first Chrome setup, the page may be blocked until the user allows the local-network prompt for `rhtv.runninghub.cn`.

## Safety Rules

- Do not print, store, or commit cookies, tokens, authorization headers, or private payloads.
- Prefer high-level commands over composing low-level commands yourself.
- Use `--dry-run` before mutating or paid workflows when available.
- Do not use `page.eval` in autonomous workflows.
- Do not call paid generation commands unless the user has approved the spend or the task explicitly authorizes generation.

## Video Generation

Preferred command:

- `node scripts/rh-bridge.mjs generate-video-node <videoNodeId> --dry-run --append-prompt "<constraints>"`
- `node scripts/rh-bridge.mjs generate-video-node <videoNodeId> --timeout <ms> --append-prompt "<constraints>"`

The high-level command performs:

1. `prepare-video-node`
2. `validate-video-run`
3. `run-node --validate-references`

`prepare-video-node` preserves the existing video prompt by default, merges upstream text, appends `--append-prompt` constraints, and switches reference-conditioned runs to a multimodal video modelCode. Use `--prompt-merge-mode replace` only when replacement is intentional.

In dry-run mode it returns `run: null` and does not spend credits.

Before a real run, check:

- `validation.ok` is `true`
- every `references[]` item has `hasDirectUpstreamImage: true`
- `subType` is `multimodal-video`
- `modelCode` contains `multimodal-video`
- prompt is non-empty

Do not use plain `run-node` for video unless you pass `--validate-references`.

## Runtime Stability

The server injects a runtime version into `bridge-runtime.js`. Page clients report that version in `clients` and event payloads. If the server runtime changes, the page runtime auto-reloads itself on the next command poll.

The server rejects commands sent to stale clients with:

- `STALE_RUNTIME`

If `preflight` reports stale clients but also shows a fresh selected client, use the fresh client or omit `--client` so routing selects the latest client.

## Common Commands

- `agent-manifest`: machine-readable command catalog and safety metadata.
- `preflight`: health/client/runtime/capability checks.
- `capabilities`: live runtime command list.
- `yjs-snapshot`: read canonical canvas nodes and edges.
- `canvas-summary`: read compact Agent-oriented canvas state. Use `--full` only when full payloads are necessary.
- `find-elements`: query nodes/edges. Use `--summary`, `--fields`, and `--limit` on large or private canvases.
- `suggest-empty-region`: find a conservative placement area before creating new nodes.
- `create-text-node`: create an `rh-text` node.
- `create-text-nodes`: create multiple related `rh-text` nodes in one rollbackable operation.
- `group-elements`: create a visual group around explicitly provided node ids.
- `create-image-node`: create an `rh-image` node without running image generation.
- `create-video-node`: create an `rh-video` node without running video generation; use `--multimodal` when the intended path is reference-conditioned video.
- `create-reference-from-url`: create a usable reference node from an existing image URL.
- `upload-local-reference-image`: one-shot local upload that returns directly usable reference node ids and URLs.
- `upload-reference-image`: upload a local image into the canvas through the live page.
- `prepare-video-node`: collect upstream text/image inputs into video params.
- `validate-node-run`: generic validation before running text/image/video nodes.
- `validate-video-run`: validate effective video references.
- `generate-video-node`: safe high-level video generation.
- `poll-node-result`: wait for node output URLs after generation.
- `poll-task-result`: wait for output URLs matching a RunningHub task id.
- `delete-elements`: remove nodes/edges.

## Agent-Friendly Reference Upload

Prefer:

- `node scripts/rh-bridge.mjs upload-local-reference-image --file <path> --config-json '<json>' --timeout 60000`

Use `result.primaryReference.nodeId` as the upstream image node for later commands. Do not infer the usable reference from the visible staging node; RunningHub may create a separate native upload node.

## Failure Handling

Stable error codes from `agent-manifest.stableErrorCodes`:

- `BRIDGE_OFFLINE`
- `NO_PAGE_CLIENT`
- `STALE_RUNTIME`
- `MISSING_CAPABILITY`
- `VALIDATION_FAILED`
- `WOULD_SPEND_CREDITS`

When a blocking preflight reason is present, fix that reason before sending canvas commands.
