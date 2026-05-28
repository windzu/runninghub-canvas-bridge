# Agent Install Guide

This guide is for an external Agent that has only been given this repository URL:

`https://github.com/windzu/runninghub-canvas-bridge`

Your goal is to install and use the released CLI product. Do not clone the repository and patch source files to recover from product errors.

## Install

Install the CLI directly from the latest known release tag:

`npm install -g github:windzu/runninghub-canvas-bridge#v0.1.0`

Then run:

`runninghub-canvas-bridge setup`

Read the JSON output carefully. It includes:

- `extension.unpackedPath`: local Chrome extension directory to load.
- `issueUrl`: where to report product bugs.
- `nextCommands`: commands to run after browser setup.

## Browser Extension Setup

The bridge requires the browser extension because RunningHub API calls must run inside the logged-in page context.

1. Open Chrome in the profile that is logged in to RunningHub.
2. Open `chrome://extensions/`.
3. Enable Developer Mode.
4. Click Load unpacked.
5. Select the `extension.unpackedPath` printed by `runninghub-canvas-bridge setup`.
6. Open or refresh a RunningHub canvas page:

   `https://rhtv.runninghub.cn/projects/canvas/<canvas_id>`

7. If Chrome asks whether `rhtv.runninghub.cn` can access local devices or services, allow it.

## Start And Verify

Start the local bridge server:

`runninghub-canvas-bridge start`

In another terminal, run:

`runninghub-canvas-bridge doctor`

Proceed only when `doctor.ok` is `true`.

Common blocking reasons:

- `BRIDGE_OFFLINE`: start the bridge with `runninghub-canvas-bridge start`.
- `NO_PAGE_CLIENT`: open or refresh a logged-in RunningHub canvas page with the extension enabled.
- `STALE_RUNTIME`: refresh the RunningHub canvas page.
- `MISSING_CAPABILITY`: refresh the page and verify that the installed CLI/extension versions match.

## Use

Before changing the canvas:

`runninghub-canvas-bridge agent-manifest`

`runninghub-canvas-bridge doctor`

`runninghub-canvas-bridge canvas-summary`

Prefer high-level commands:

- `canvas-summary`
- `find-elements`
- `suggest-empty-region`
- `create-text-node`
- `create-image-node`
- `create-video-node`
- `upload-local-reference-image`
- `create-reference-from-url`
- `validate-node-run`
- `generate-video-node --dry-run`
- `poll-node-result`

For mutating or paid workflows, use dry-run and validation first. Do not run paid generation unless the user explicitly authorizes it.

## Failure Handling

Do not modify package internals, installed files, or repository source as a workaround.

If blocked, run:

`runninghub-canvas-bridge report --write`

Attach the generated redacted report to a GitHub Issue:

`https://github.com/windzu/runninghub-canvas-bridge/issues`

Include:

- the command that failed
- what you expected
- what happened
- the redacted diagnostic report

Do not include cookies, tokens, authorization headers, or private RunningHub payloads.

## Updating

To reinstall a specific release tag:

`npm install -g github:windzu/runninghub-canvas-bridge#v0.1.0`

After updating, rerun:

`runninghub-canvas-bridge setup`

Then reload the Chrome extension and refresh the RunningHub canvas tab.
