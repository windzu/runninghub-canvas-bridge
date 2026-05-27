# Release Guide

This project is released as one product with two installable parts:

- npm CLI package: `runninghub-canvas-bridge`
- Chrome extension zip: `runninghub-canvas-bridge-extension-v<version>.zip`

Both artifacts are attached to the matching GitHub Release. The CLI, local bridge server, browser extension loader, and page runtime must share the same product version and bridge protocol version.

The repository also includes a GitHub Actions workflow that creates a GitHub Release when a `v*` tag is pushed. The release includes the extension zip, extension checksum, and npm tarball.

## User Installation

### Install From GitHub Tag

This is the simplest path for another device/Agent before npm publishing:

`npm install -g github:windzu/runninghub-canvas-bridge#v0.1.0`

Then run:

`runninghub-canvas-bridge setup`

The setup output includes `extension.unpackedPath`. Load that directory in Chrome:

1. Open `chrome://extensions/` in the Chrome profile logged in to RunningHub.
2. Enable Developer mode.
3. Click Load unpacked and select `extension.unpackedPath`.
4. Open or refresh `https://rhtv.runninghub.cn/projects/canvas/<canvas_id>`.
5. Allow Chrome local-network access if prompted.
6. Start the local bridge:

   `runninghub-canvas-bridge start`

7. In another terminal, verify:

   `runninghub-canvas-bridge doctor`

### Install From GitHub Release Asset

Use this path when another device/Agent should install the exact tarball produced by GitHub Actions.

Direct URL install:

`npm install -g https://github.com/windzu/runninghub-canvas-bridge/releases/download/v0.1.0/runninghub-canvas-bridge-0.1.0.tgz`

Then run:

`runninghub-canvas-bridge setup`

Load the `extension.unpackedPath` printed by setup in Chrome.

You can also download the assets manually:

1. Download these assets from the matching GitHub Release:
   - `runninghub-canvas-bridge-<version>.tgz`
   - `runninghub-canvas-bridge-extension-v<version>.zip`
   - `runninghub-canvas-bridge-extension-v<version>.sha256`
2. Install the CLI:

   `npm install -g ./runninghub-canvas-bridge-<version>.tgz`

3. Run setup:

   `runninghub-canvas-bridge setup`

4. Unzip the extension zip.
5. Open `chrome://extensions/` in the Chrome profile logged in to RunningHub.
6. Enable Developer mode.
7. Click Load unpacked and select the unzipped extension directory.
8. Open or refresh `https://rhtv.runninghub.cn/projects/canvas/<canvas_id>`.
9. Allow Chrome local-network access if prompted.
10. Start the local bridge:

    `runninghub-canvas-bridge start`

11. In another terminal, verify:

    `runninghub-canvas-bridge doctor`

Continue only when `doctor.ok` is `true`. If it is not ready, run `runninghub-canvas-bridge report --write` and share the redacted report in GitHub Issues:

`https://github.com/windzu/runninghub-canvas-bridge/issues`

## npm Installation

Use this path after the package has been published to npm.

Install the CLI:

`npm install -g runninghub-canvas-bridge`

Run setup:

`runninghub-canvas-bridge setup`

Install the browser extension:

1. Download `runninghub-canvas-bridge-extension-v<version>.zip` from the GitHub Release.
2. Unzip it locally.
3. Open `chrome://extensions/` in the Chrome profile logged in to RunningHub.
4. Enable Developer mode.
5. Click Load unpacked and select the unzipped extension directory.
6. Open or refresh `https://rhtv.runninghub.cn/projects/canvas/<canvas_id>`.
7. Allow Chrome local-network access if prompted.

Verify:

`runninghub-canvas-bridge start`

In another terminal:

`runninghub-canvas-bridge doctor`

Continue only when `doctor.ok` is `true`.

## Agent Contract

Agents should treat the release as a product boundary:

- Use `runninghub-canvas-bridge` CLI commands, the local HTTP API, or MCP wrappers when available.
- Do not patch installed package internals to recover from errors.
- When blocked, run `runninghub-canvas-bridge doctor`.
- For reportable failures, run `runninghub-canvas-bridge report --write` and share the generated redacted report at `https://github.com/windzu/runninghub-canvas-bridge/issues`.
- Do not print or commit cookies, tokens, authorization headers, or private RunningHub payloads.

## Release Checklist

Before creating a GitHub Release:

1. Update `package.json` version.
2. Update `extension/manifest.json` version.
3. Update `server/server.mjs` `PRODUCT_VERSION`.
4. Update `extension/bridge-main.js` `LOADER_VERSION`.
5. Run `npm run release:check`.
6. Run `npm run release:package`.
7. Publish the npm package.
8. Create a GitHub Release for the same tag.
9. Attach:
   - `dist/runninghub-canvas-bridge-extension-v<version>.zip`
   - `dist/runninghub-canvas-bridge-extension-v<version>.sha256`
10. Include install commands and the protocol version in the release notes.

The automated path is:

1. Create and push a tag such as `v0.1.0`.
2. GitHub Actions runs `npm run release:check`.
3. GitHub Actions runs `npm run release:package`.
4. GitHub Actions runs `npm pack`.
5. GitHub Actions creates a GitHub Release with the extension zip, checksum, and npm tarball attached.

## Local Release Packaging

`npm run release:package` creates:

- `dist/runninghub-canvas-bridge-extension-v<version>.zip`
- `dist/runninghub-canvas-bridge-extension-v<version>.sha256`

The packaging script fails if CLI/server/extension versions drift.

## Compatibility

The current bridge protocol version is `1`.

If the CLI/server and extension versions do not match, refresh the RunningHub tab after updating the extension. If diagnostics still show stale runtime or protocol mismatch, reinstall the extension from the matching GitHub Release.
