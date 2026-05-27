# Agent QA Playbook

This playbook defines a repeatable black-box QA flow for an Agent operating RunningHub canvas through the public CLI only.

The goal is not to test implementation internals. The goal is to simulate a real Agent user, run a realistic workflow end to end, and report every blocker, ambiguity, unsafe default, or recovery cost.

## Scope

Use this playbook after bridge, runtime, or CLI changes that affect Agent-facing behavior.

The Agent must:

- use only `runninghub-canvas-bridge ...` for canvas operations when testing a release
- avoid mouse automation and page DOM poking
- avoid `page.eval`
- avoid reading implementation source during the test
- avoid printing cookies, tokens, authorization headers, or private payloads
- report confusion and workaround steps as first-class findings

The Agent may:

- start or stop the local bridge server
- refresh the RunningHub page only when stale runtime or client readiness blocks the CLI flow
- create GitHub Issues for newly discovered defects

## Standard Scenario

Use this as the default workflow scenario unless the test owner specifies another one.

- Local reference image: `/Users/wind/Downloads/luye.jpg`
- Character: 鹿野 from 罗小黑战记
- Story: the character performs a short Tai Chi sequence
- Image model: GPT Image 2 / `text-image-rhart-image-g-2-official-text-to-image`
- Video target: 15 seconds, vertical, reference-conditioned video
- Allowed paid run: image generation
- Forbidden paid run: video generation

Expected end state:

- the canvas is cleared before the test workflow starts
- one usable reference image node exists
- one script text node exists
- one GPT Image 2 image node exists and has a generated image output
- one multimodal video node exists
- the video node is prepared and validates successfully
- the video node is not run

## Test Levels

### Smoke

Run this when checking basic readiness after small CLI changes.

1. Run `agent-manifest`.
2. Run `preflight`.
3. Run `capabilities`.
4. Run `canvas-summary`.
5. Run `resolve-model-alias "GPT image2"`.
6. Run one `--help` command for a mutating command, such as `create-image-node --help`.

Pass criteria:

- `preflight.ok` is `true`, or it returns clear `nextActions`
- no mutating command changes the canvas when `--help` is used
- model alias resolution returns a concrete modelCode
- failures are structured and machine-readable

### Workflow

Run this for normal Agent acceptance testing.

1. Preflight.
   - `runninghub-canvas-bridge agent-manifest`
   - `runninghub-canvas-bridge doctor`
   - `runninghub-canvas-bridge capabilities`
   - Continue only when `preflight.ok` is `true`.

2. Clear the canvas.
   - Read `canvas-summary`.
   - Delete every node with `delete-elements`.
   - Confirm `counts.nodes` and `counts.edges` are both zero.

3. Resolve models.
   - Resolve `GPT image2`.
   - Inspect text-image and text-video or multimodal-video options when needed.
   - Record any mismatch between user-facing names and modelCode values.

4. Import the reference image.
   - Prefer `upload-local-reference-image`.
   - Require a non-null `primaryReference.nodeId`.
   - Require at least one usable URL in `primaryReference.urls`.
   - If upload fails, record the failure and use `create-reference-from-url` only when a known valid URL is available.

5. Create workflow nodes.
   - Create a text node containing the 15-second Tai Chi script.
   - Create a GPT Image 2 image node with a character-consistency prompt.
   - Create a video node with `--multimodal` when the intended video is reference-conditioned.

6. Connect nodes.
   - Connect reference image to image node.
   - Connect text node to image node.
   - Connect generated image node to video node after image output exists.
   - Connect reference image and text node to video node.
   - Verify upstream/downstream relationships with `connections` or `canvas-summary`.

7. Generate the image.
   - Run `validate-node-run <imageNodeId> --require-references`.
   - Run the image node only when image generation is authorized.
   - Poll with `poll-node-result`.
   - Require at least one `outputs[].url`.

8. Prepare the video without running it.
   - Run `prepare-video-node <videoNodeId>`.
   - Use `--prompt-merge-mode merge` or `--append-prompt` when preserving existing constraints matters.
   - Run `validate-video-run <videoNodeId>`.
   - Run `validate-node-run <videoNodeId> --require-references`.
   - Do not run `generate-video-node` without explicit permission.

9. Final verification.
   - Run `canvas-summary`.
   - Confirm node counts, edge counts, image output URL, video prompt, `duration: "15"`, `subType: "multimodal-video"`, and direct upstream references.

### Chaos

Run this after reliability-related changes or before a release.

1. Server offline.
   - Stop the bridge server.
   - Run `preflight`.
   - Run one normal canvas command.
   - Expected: structured errors with recovery `nextActions`.

2. Stale runtime.
   - Restart server after runtime changes while a RunningHub tab remains open.
   - Run `preflight`, `capabilities`, and `canvas-summary`.
   - Expected: stale clients are detected or commands route only to a fresh client.

3. Safe help.
   - Run `--help` for mutating commands.
   - Expected: no nodes or edges are created.

4. Missing references.
   - Create an image or video node without references.
   - Run validation with required references.
   - Expected: clear validation errors and no paid run.

5. Wrong flags.
   - Try flags that sound generic, such as `run-node --validate-references`, on non-video nodes.
   - Expected: either correct generic validation or clear command-specific rejection.

## Report Template

Use this shape when reporting a run.

### Run Metadata

- Date:
- Branch or commit:
- Canvas URL:
- Bridge runtime version:
- Agent:
- Scenario:

### Result

- Overall status: Pass / Pass with issues / Blocked / Failed
- Image generated: Yes / No
- Video generated: No, unless explicitly authorized
- Final canvas state:

### Verified Fixes

- List previously reported issues that now behave correctly.

### Findings

For each finding:

- Title:
- Severity: blocker / high / medium / low
- Command:
- Expected:
- Actual:
- Workaround:
- GitHub Issue:

### Open Questions

- List product or workflow ambiguities that are not clearly defects.

## Pass Criteria

A Workflow run passes when:

- preflight succeeds without unexplained manual steps
- the canvas can be cleared
- model aliases resolve
- the reference image path produces a usable reference or a clear actionable failure
- text/image/video nodes are created without hidden mutation surprises
- image generation completes and exposes `outputs[].url`
- video preparation validates successfully
- no video generation is run
- all errors encountered are structured enough for an Agent to recover

## Issue Policy

Create a GitHub Issue when any of these happen:

- the CLI output is misleading or internally inconsistent
- a command mutates state unexpectedly
- a command returns success without the data required for the next step
- an Agent needs implementation knowledge to continue
- safe validation blocks a valid workflow or lets an unsafe workflow pass
- recovery requires manual browser action that is not surfaced in `nextActions`

Keep issues black-box and reproducible. Include command names, expected behavior, actual behavior, and why it matters for Agent users. Do not include cookies, auth headers, raw private payloads, or private project data.
