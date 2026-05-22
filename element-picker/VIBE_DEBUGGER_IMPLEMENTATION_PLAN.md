# Vibe Debugger Implementation Plan

## Purpose

Build a debugging layer for Element Picker QA Bridge that records how page state changes over time, ties those changes to visible UI behavior, and exports the evidence to Codex. The goal is to replace repeated guess-run-change loops with a watch-window style timeline:

> This value changed, at this time, because of this event, and that is why this UI became hidden, empty, disabled, stale, or wrong.

The first version should work on arbitrary pages with no app code changes. A stronger version should support optional app-level probes for React and product-specific state.

## Product Principles

- Focus on selected UI first. The debugger should explain a visible thing the user cares about, not collect every possible log.
- Record diffs, not noise. A timeline full of unchanged snapshots is not useful.
- Prefer causal evidence over raw output. "Button disabled changed false -> true after click Save" is more useful than a console dump.
- Keep capture artifacts durable and file-based, matching the existing `~/CodexInbox/web-qa` workflow.
- Make the generic browser-extension version useful, but acknowledge its limits. Arbitrary JavaScript local variables cannot be observed precisely without app instrumentation.
- Keep the page safe. Avoid mutation-heavy full-page scanning, avoid scroll stitching during debugging, and keep recording bounded by time and size.

## Architecture Overview

The implementation has five cooperating pieces:

1. **Watch targets**
   - Selected DOM elements and optional app-provided named values.
   - Each watch target has a stable ID, display label, locator, and latest snapshot.

2. **Page recorder**
   - Runs in the active tab.
   - Observes user events, DOM mutations, route changes, network calls, timers, console events, storage writes, and viewport changes.
   - Re-snapshots watched targets after relevant events.

3. **Cause attribution layer**
   - Maintains a current "cause context" such as click, input, fetch response, timer, route change, or app trace.
   - Links snapshot diffs and DOM mutations back to the likely cause.

4. **Debugger UI**
   - Adds a watch drawer or panel to the existing QA Bridge overlay.
   - Shows current watched values, timeline events, diffs, and focused "why hidden / why disabled / why empty" explanations.

5. **Inbox trace export**
   - Extends the local inbox server with trace endpoints.
   - Writes `trace.json`, `trace.md`, and optional images under `~/CodexInbox/web-qa`.
   - Lets Codex inspect the same temporal evidence the user saw.

## Data Model

### Trace

```json
{
  "schemaVersion": "1.0",
  "traceId": "20260522-123456-localhost",
  "page": {
    "url": "http://localhost:5173/tasks",
    "title": "Tasks"
  },
  "startedAt": "2026-05-22T19:34:12.000Z",
  "endedAt": "2026-05-22T19:34:42.000Z",
  "durationMs": 30000,
  "watchTargets": [],
  "events": [],
  "samples": [],
  "mutations": [],
  "network": [],
  "console": [],
  "summaries": []
}
```

### Watch Target

```json
{
  "watchId": "watch-1",
  "kind": "element",
  "label": "Save button",
  "createdAt": "2026-05-22T19:34:12.000Z",
  "locator": {
    "type": "role-name",
    "value": "page.getByRole(\"button\", { name: \"Save\" })"
  },
  "selector": "button[data-testid=\"save\"]",
  "source": {
    "selectionIndex": 1,
    "selectedBy": "qa-bridge"
  }
}
```

### Event

```json
{
  "eventId": "evt-42",
  "timeOffsetMs": 4231,
  "kind": "user.click",
  "label": "click Save",
  "target": {
    "selector": "button[data-testid=\"save\"]",
    "text": "Save"
  },
  "url": "http://localhost:5173/tasks",
  "stack": null
}
```

### Sample

```json
{
  "sampleId": "sample-17",
  "watchId": "watch-1",
  "timeOffsetMs": 4310,
  "causeEventId": "evt-42",
  "snapshot": {
    "dom": {
      "text": "Saving...",
      "attributes": {
        "disabled": "",
        "aria-busy": "true"
      }
    },
    "visibility": {
      "visible": true,
      "display": "inline-flex",
      "visibility": "visible",
      "opacity": "0.5",
      "hiddenAncestor": null
    },
    "layout": {
      "x": 720,
      "y": 612,
      "width": 114,
      "height": 40
    },
    "react": {
      "components": ["TaskEditor", "SaveButton"],
      "props": {
        "disabled": true,
        "isSaving": true
      },
      "state": []
    }
  },
  "diffs": [
    {
      "path": "dom.text",
      "before": "Save",
      "after": "Saving..."
    },
    {
      "path": "react.props.isSaving",
      "before": false,
      "after": true
    }
  ]
}
```

## Stage 0: Repo Baseline And Guardrails

### Step 0.1: Confirm Current Extension Flow

- Verify `npm run check` still passes.
- Confirm the extension can still:
  - inject `picker.js`
  - select elements
  - send bundles to the inbox
  - load tours
  - write latest capture artifacts

### Step 0.2: Define Non-Goals For The First Version

- No source maps in MVP.
- No full time-travel replay in MVP.
- No attempt to inspect arbitrary lexical variables from closed-over JavaScript functions.
- No heavy full-page polling.
- No automatic upload to remote services.

### Step 0.3: Add A Local Test Page

Create a small static/debug page for repeatable smoke testing. It should include:

- button disabled/enabled changes
- conditional visibility
- class/style toggles
- route-like history changes
- fake fetch
- delayed timer update
- input-driven filtering
- nested hidden ancestor case

Acceptance criteria:

- The test page can reproduce the exact bugs the vibe debugger is supposed to explain.
- The page works without a build step.

## Stage 1: Trace Storage And Inbox Server

### Step 1.1: Add Trace Endpoints

Extend `scripts/codex-qa-inbox-server.mjs` with:

- `POST /traces`
- `GET /traces/latest`
- `GET /health` unchanged

Trace output should mirror captures:

- `~/CodexInbox/web-qa/traces/history/<trace-id>/manifest.json`
- `~/CodexInbox/web-qa/traces/history/<trace-id>/trace.json`
- `~/CodexInbox/web-qa/traces/history/<trace-id>/trace.md`
- `~/CodexInbox/web-qa/traces/latest/...`

Acceptance criteria:

- A valid trace payload is persisted to history and latest.
- Invalid payloads return clear JSON errors.
- Existing capture and tour endpoints continue to work.

### Step 1.2: Define Trace Schema Constants

Add schema version constants:

- `TRACE_SCHEMA_VERSION = "1.0"`
- `TRACE_MAX_EVENTS`
- `TRACE_MAX_SAMPLES`
- `TRACE_MAX_MUTATIONS`
- `TRACE_MAX_BYTES`

Acceptance criteria:

- Oversized traces are rejected or trimmed deliberately.
- The response says when trimming happened.

### Step 1.3: Generate Trace Markdown

Add a Markdown summary writer for traces:

- trace metadata
- watched targets
- most important diffs
- timeline by event
- hidden/disabled/empty summaries
- file paths

Acceptance criteria:

- Codex can read `trace.md` quickly without opening the full JSON first.

## Stage 2: Watch Target Snapshot Engine

### Step 2.1: Extract Snapshot Helpers

In `picker.js`, create focused helper functions that can snapshot an element without requiring a new selection:

- `buildWatchSnapshot(element)`
- `getElementVisibilitySnapshot(element)`
- `getElementDomSnapshot(element)`
- `getElementLayoutSnapshot(element)`
- `getElementReactSnapshot(element)`
- `getElementFormSnapshot(element)`
- `getHiddenAncestorSnapshot(element)`

Reuse existing helpers where possible:

- React fiber extraction
- style diagnostics
- form state
- scroll diagnostics
- locator candidates
- ancestor context

Acceptance criteria:

- Snapshotting a watched element does not add a new selection.
- Snapshot output is serializable and bounded.
- Disconnected elements are handled cleanly.

### Step 2.2: Add Diffing

Implement a deterministic shallow/deep diff for bounded snapshots:

- compare primitive values
- compare arrays by serialized value
- compare objects by path
- cap diff count per sample
- ignore volatile fields by default, such as timestamps and raw rect jitter below a small threshold

Acceptance criteria:

- Repeated identical snapshots create no samples.
- Meaningful text, prop, state, visibility, class, and disabled changes are recorded.

### Step 2.3: Add Watch Target Registry

Add in-page state:

- `watchTargets`
- `watchSnapshotsById`
- `watchTimeline`
- `activeTrace`

Each watch target should store:

- DOM element reference
- label
- selector and locator
- created time
- latest snapshot
- latest sample time

Acceptance criteria:

- A selected element can be promoted to a watch target.
- The watch target survives normal page interaction while the element remains connected.
- If the element disconnects, the debugger records that fact instead of failing.

## Stage 3: Recorder Core

### Step 3.1: Add Recording Lifecycle

Add explicit commands:

- Start recording
- Stop recording
- Clear recording
- Export trace

Recording should maintain:

- `startedAt`
- monotonic `performance.now()` base
- bounded event buffer
- bounded sample buffer
- bounded mutation buffer

Acceptance criteria:

- The user can start and stop a trace without closing the picker.
- The recorder can export the last trace after stopping.

### Step 3.2: Observe User Events

Listen in capture phase for:

- `click`
- `input`
- `change`
- `submit`
- `keydown`
- `pointerdown`

For each event, record:

- event type
- target summary
- selected text value if safe
- element role/name/text
- current URL

Acceptance criteria:

- Clicking or typing creates a timeline event.
- Watched targets are sampled after the event settles.

### Step 3.3: Observe DOM Mutations

Use `MutationObserver` for:

- attribute changes
- child list changes
- text changes

Mutation records should be summarized, not dumped raw:

- changed attribute name
- target selector summary
- added/removed count
- text changed flag
- whether a watched target or ancestor was affected

Acceptance criteria:

- Visibility-changing class/style/hidden changes appear in the timeline.
- Large mutation bursts are coalesced.

### Step 3.4: Observe Route Changes

Patch:

- `history.pushState`
- `history.replaceState`
- `popstate`
- `hashchange`

Acceptance criteria:

- URL changes create route events.
- Watched targets are re-evaluated after navigation-like changes.

### Step 3.5: Observe Network

Generic extension instrumentation should capture:

- `fetch`
- `XMLHttpRequest`

For reliable page-level patching, inject a small page-world probe that forwards sanitized events to the content script via `window.postMessage` or `CustomEvent`.

Record:

- method
- URL
- status
- duration
- success/failure
- response size if available

Do not record response bodies in MVP.

Acceptance criteria:

- A fake fetch on the test page appears in the timeline.
- State changes after a response can be attributed to the network response window.

### Step 3.6: Observe Timers And Animation Frames

Patch or observe:

- `setTimeout`
- `setInterval`
- `requestAnimationFrame`

Record creation and callback execution lightly.

Acceptance criteria:

- Delayed UI changes can be attributed to a timer or animation frame callback.

## Stage 4: Cause Attribution

### Step 4.1: Add Cause Context

Maintain a current cause object:

```json
{
  "eventId": "evt-42",
  "kind": "user.click",
  "label": "click Save",
  "startedAtOffsetMs": 4231
}
```

When an event fires:

- set current cause
- run callback or schedule post-event sample
- keep the cause active through a short microtask/macrotask window
- clear or replace cause after timeout

Acceptance criteria:

- Diffs recorded shortly after a click are linked to that click.
- Diffs recorded shortly after a fetch response are linked to that response.

### Step 4.2: Coalesce Event Windows

Avoid noisy timelines by grouping:

- mutation bursts
- repeated layout samples
- rapid input events
- repeated animation frames

Acceptance criteria:

- Typing in an input produces a readable sequence, not hundreds of rows.

### Step 4.3: Add Confidence Levels

Attribution should include:

- `direct`: app probe emitted the value change with an action name
- `strong`: value changed during a known event callback window
- `inferred`: value changed near a mutation/network/timer but no direct callback was observed
- `unknown`: change was observed but no likely cause is known

Acceptance criteria:

- Codex and the UI can distinguish evidence from inference.

## Stage 5: Debugger UI

### Step 5.1: Add Watch Controls

Add controls to the existing toolbar or a compact drawer:

- Watch selected
- Record
- Stop
- Trace
- Export
- Clear

Acceptance criteria:

- Controls fit the existing QA Bridge UI.
- Normal element picking and guided tours are not broken.

### Step 5.2: Add Watch Window

Show each watched target with:

- label
- latest visible/hidden state
- latest text
- key attributes
- React component name
- latest meaningful changed value
- stale/disconnected indicator

Acceptance criteria:

- A user can see current watched values without opening DevTools.

### Step 5.3: Add Timeline View

Show chronological rows:

- time offset
- event kind
- cause label
- watched target
- changed path
- before -> after
- confidence

Acceptance criteria:

- The user can answer "what changed right before this UI changed?"

### Step 5.4: Add Focused Explanation Views

Add helpers:

- Why hidden?
- Why disabled?
- Why empty?
- Why moved?
- Why stale?

Each helper should inspect the latest snapshots and recent diffs.

Examples:

- hidden because selected element has `display: none`
- hidden because ancestor `.modal` has `visibility: hidden`
- disabled because DOM `disabled` exists
- disabled because React prop `disabled` changed false -> true
- empty because text/list count changed after filter input
- stale because watched element disconnected after route change

Acceptance criteria:

- The explanation names the value, the before/after, the likely cause, and the confidence level.

## Stage 6: Export To Codex

### Step 6.1: Add Send Trace To Codex

Extend `background.js` message handling:

- `ELEMENT_PICKER_SEND_TRACE_TO_CODEX`

Send trace payload to:

- `http://127.0.0.1:43117/traces`

Acceptance criteria:

- The extension can post a trace to the local inbox server.
- The server response includes `traceId`, `traceDir`, and `latestDir`.

### Step 6.2: Extend Capture Bundles With Trace References

When a trace exists, normal captures should include:

- latest trace ID
- trace latest path
- watched target IDs related to selected elements
- active cause if recording is running

Acceptance criteria:

- "Look at latest QA capture" can lead Codex to the related trace.

### Step 6.3: Update Codex Skill

Update `codex-skills/web-qa-capture/SKILL.md` so Codex knows to inspect:

- `~/CodexInbox/web-qa/traces/latest/manifest.json`
- `trace.md`
- `trace.json`

The skill should prefer:

1. `trace.md` for overview
2. `trace.json` for exact values
3. screenshot images for visual confirmation
4. source inspection for the code path

Acceptance criteria:

- A user can say "look at latest trace" or "why did this disappear?"
- Codex can answer from temporal evidence, not just the final DOM.

## Stage 7: Optional App SDK

### Step 7.1: Define Global Probe API

Expose a stable page API:

```ts
window.__VIBE_DEBUGGER__?.trace(name, payload)
window.__VIBE_DEBUGGER__?.watch(name, value, options)
window.__VIBE_DEBUGGER__?.visibility(name, payload)
window.__VIBE_DEBUGGER__?.action(name, payload)
```

The content script listens for these events and records them as direct evidence.

Acceptance criteria:

- Apps can send named values without importing extension code.
- If the extension is absent, app code remains harmless.

### Step 7.2: Add React Helper Package Or Snippet

Provide a tiny dev-only helper:

```ts
useVibeWatch("TaskList.visibleTasks", visibleTasks.length)
useVibeWatch("SaveButton.disabled", disabled)
useVibeVisibility("EmptyState", visibleTasks.length === 0, {
  totalTasks,
  activeFilter
})
```

Acceptance criteria:

- React apps can expose meaningful product variables by name.
- Hook output is rate-limited and serializable.

### Step 7.3: Add Store Adapters

Add optional snippets for common stores:

- Redux
- Zustand
- React Query
- TanStack Router or React Router

Acceptance criteria:

- The debugger can show action/store/query changes when the app opts in.

## Stage 8: Privacy, Safety, And Performance

### Step 8.1: Redaction Rules

Redact by default:

- password fields
- token-like keys
- authorization headers
- cookies
- long text bodies
- response bodies
- email-like values unless explicitly selected

Acceptance criteria:

- Trace output avoids obvious secrets.
- Redactions are visible as `[redacted]`.

### Step 8.2: Size Limits

Apply caps:

- max trace duration
- max event count
- max sample count
- max mutation count
- max serialized value length
- max object depth
- max array length

Acceptance criteria:

- Recording cannot freeze the page during normal use.
- Large pages degrade by trimming, not failing.

### Step 8.3: Main-World Probe Isolation

For page-world patches:

- keep probe code tiny
- avoid dependencies
- avoid changing return values
- preserve original functions
- support cleanup on stop

Acceptance criteria:

- The page continues to behave normally when recording starts and stops.

## Stage 9: Verification Plan

### Step 9.1: Syntax And Static Checks

Run:

```sh
npm run check
```

Acceptance criteria:

- `background.js`, `picker.js`, and the inbox server parse cleanly.

### Step 9.2: Local Test Page Smoke Cases

Smoke scenarios:

1. Watch a button, click it, see disabled/text/React-ish state diffs.
2. Watch a panel, toggle visibility, see hidden ancestor explanation.
3. Watch a filtered list, type query, see empty state explanation.
4. Trigger fake fetch, see network event and post-response UI diff.
5. Trigger timer update, see timer event and delayed UI diff.
6. Route-like history change disconnects target, see stale/disconnected explanation.

Acceptance criteria:

- Each scenario produces a readable trace timeline.
- Each scenario can be exported to the inbox.

### Step 9.3: Real App Smoke

Use the extension on at least one local React app page:

- select a visible control
- start recording
- perform the suspicious action
- export trace
- ask Codex to inspect latest trace

Acceptance criteria:

- Codex can name at least one concrete before/after state change and likely cause.

## Stage 10: Rollout Plan

### MVP Release

Scope:

- watch selected elements
- timeline recorder
- DOM/user/route/network/timer events
- snapshot diffing
- trace export
- trace markdown
- Codex skill update
- local smoke test page

Success criteria:

- A user can answer "what changed before this UI changed?" without opening DevTools.

### Beta Release

Scope:

- focused explanation views
- confidence levels
- better coalescing
- main-world network/timer probe cleanup
- trace-to-capture linking
- performance caps and redaction hardening

Success criteria:

- A user can answer "why is this hidden/disabled/empty?" from the overlay and from Codex.

### App-Instrumented Release

Scope:

- `window.__VIBE_DEBUGGER__` API
- React hooks
- store adapters
- named product variable timelines

Success criteria:

- A local app can expose product state by name, and the debugger can connect named state changes to visible UI changes.

## Open Questions

- Should the first watch UI live in the bottom toolbar, a side drawer, or the tour panel surface?
- Should trace recording start automatically when the picker opens, or only after the user clicks Record?
- How much page-world monkey patching is acceptable for the generic extension mode?
- Should trace history live under `web-qa/traces` only, or should each capture optionally embed a short trace slice?
- Do we want a repo-local app SDK package now, or should the first SDK be a documented copy-paste snippet?

## Recommended First Implementation Slice

Build the smallest useful version in this order:

1. Add trace endpoints to the inbox server.
2. Add watch target registry and snapshot diffing to `picker.js`.
3. Add Record/Stop/Export controls.
4. Add user event and MutationObserver recording.
5. Add a compact timeline drawer.
6. Export `trace.json` and `trace.md`.
7. Update the Codex skill to read latest traces.
8. Add a local smoke page that demonstrates hidden, disabled, empty, network, timer, and stale target cases.

This slice is enough to prove the loop: select UI, record behavior, inspect variable diffs over time, send the trace to Codex, and stop guessing.
