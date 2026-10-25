# Element Picker QA Bridge

A Chrome/Edge/Arc extension that lets you pause a page, select suspicious UI, and hand a rich debug bundle to Codex through a local inbox. Clipboard export still works.

## Workspace

The panel has three keyboard-accessible views: **Capture**, **Trace**, and **Tour**. Only one view is visible at a time. **Move** cycles the panel between corners; tours automatically place the whole workspace away from their target when space allows.

- **Capture** shows selected elements, a comment, **Copy capture**, and **Send capture**. **Picking options** contains Break on Load and Click Through; active options remain summarized when collapsed.
- **Pick elements / Use page** controls how page clicks behave. This is separate from recording: the recording state stays visible in every workspace, and tours expose a Stop recording action while a trace is running. Application timers are never paused.
- **Trace** keeps watch/record/send actions visible above scrolling observations and diffs. Hidden, disabled, and disconnected states retain text labels; a brief optional emphasis marks consequential watch changes.
- **Tour** contains the current review step, a note, and Next/Done. Switching views preserves the step and note. Missing targets offer **Find target again**, and End tour returns to Capture.
- Handoff success and failures stay inside the workspace. A failed send retains the selection and comment and offers Retry send. Saved locations are available on request. Feedback never floats over the controls.

## Major Updates in 1.9

This release turns the old clipboard-oriented element picker into a two-way QA bridge between the browser and Codex:

- Renamed the extension from **Element Picker for Claude** to **Element Picker QA Bridge**.
- Added a persistent floating QA toolbar with selection count, comments, resume/pause, undo, copy, local inbox send, guided tour loading, and close controls.
- Added **Send to Codex**, which posts the full debug bundle to a local Node inbox instead of relying on clipboard payloads.
- Added a dependency-free inbox server at `scripts/codex-qa-inbox-server.mjs` with capture, tour, latest-tour, and health endpoints.
- Added durable capture artifacts under `~/CodexInbox/web-qa`, including `manifest.json`, `bundle.json`, `bundle.md`, highlighted viewport images, and element crop images.
- Added guided review tours so Codex can send review steps back to the extension.
- Added tour navigation across URLs, including reinjection after Chrome finishes loading the next page.
- Added tour-mode UI isolation: the normal bottom QA toolbar hides while the guided tour panel is active, and page clicks no longer add accidental selections.
- Added **Ask Codex** inside tour steps, capturing the highlighted target plus the typed question or observation.
- Added `tourContext` and `userComment` to generated bundles so the next agent turn knows why the capture exists.
- Added smarter visual output: highlighted visible-viewport images, padded element crops, saved image files, and image materialization in the inbox server.
- Added **Vibe Debugger**: watch selected UI, record state diffs and events over time, and export traces to Codex.
- Added `package.json` scripts for `npm run inbox` and `npm run check`.
- Updated the Manifest V3 metadata, extension name, host permission for the local inbox, and version.

The near-zero-friction loop is:

1. Start the local inbox server: `npm run inbox`
2. Click the extension icon on any page.
3. Click one or more suspicious elements.
4. Click **Send capture** in the Capture workspace.
5. In Codex, say: `look at latest QA capture`.

The reverse loop is:

1. Ask Codex to walk you through a page or a change.
2. Codex posts a guided review tour to the local inbox.
3. Click the extension icon on the page.
4. Open **Tour** and click **Load tour**.
5. Step through the highlighted notes in Tour. Picking is locked while this view is active.
6. Type a question or observation in **Ask Codex about this step...**, then click **Ask Codex** to send that step, tour context, and your note back as a fresh capture.

## Project Files

- `manifest.json`: Manifest V3 extension metadata and local inbox host permission.
- `background.js`: extension injection, screenshot capture, image downloads, local inbox posting, latest tour loading, and cross-page tour continuation.
- `picker.js`: page overlay, toolbar, element analysis, locator ranking, screenshots, clipboard export, Send to Codex, guided tour UI, and Vibe Debugger recording.
- `vibe-page-probe.js`: main-world probe for fetch/XHR, route, storage, console, and optional app-provided trace events.
- `picker.css`: overlay, toolbar, responsive controls, tour panel, and tour highlight styling.
- `scripts/codex-qa-inbox-server.mjs`: local capture/tour server used by Codex and the extension.
- `smoke/vibe-debugger-smoke.html`: dependency-free test page for the Vibe Debugger watch and trace workflow.
- `snippets/vibe-debugger-app-probes.js`: optional app-side helpers for React, Redux, Zustand, and React Query/TanStack Query probes.
- `package.json`: local scripts for running the inbox and syntax checking extension code.
- `codex-skills/web-qa-capture/`: repo copy of the Codex skill that reads the local QA inbox and posts guided review tours.

## Codex Skill

This repo includes the Codex-side companion skill at `codex-skills/web-qa-capture`. Install or refresh it into your local Codex skills folder when you want Codex to automatically respond to prompts like `look at latest QA capture`:

```sh
mkdir -p ~/.codex/skills
rsync -a codex-skills/web-qa-capture/ ~/.codex/skills/web-qa-capture/
```

The skill tells Codex to read `~/CodexInbox/web-qa/latest/manifest.json`, inspect `bundle.md`, use `bundle.json` for selectors and state, open capture images when available, honor `userComment` and `tourContext`, and post guided review tours back to `http://127.0.0.1:43117/tours`.

## Installation

1. Open Arc, Chrome, or Edge and go to `arc://extensions`, `chrome://extensions`, or `edge://extensions`
2. Enable **Developer mode** (toggle in top right)
3. Click **Load unpacked**
4. Select this folder (`element-picker`)

## Usage

1. Click the extension icon to open QA Bridge in **Capture**.
2. With **Picking elements** active, click one or more elements on the page.
3. Add a comment, then choose **Send capture** or **Copy capture**. Sending writes to the local inbox; copying keeps the workspace open.
4. Switch to **Trace**, choose **Watch selected**, then **Record**.
5. Choose **Use page** to exercise the application while recording. Stop recording and use **Send Trace** to export the evidence.
6. Switch to **Tour → Load tour** to follow a guided review. Add a question and use Ask Codex to capture the current target and note.
7. Escape closes the current tour, or closes the bridge when outside a tour. Enter exports from the page; focused panel controls keep their normal keyboard behavior. Undo removes the latest selection.

> Restricted pages such as `chrome://`, the Web Store, and PDFs show a red **!** on the extension icon when injection is unavailable.

## Local Codex Inbox

Run the dependency-free Node server from this folder before using **Send to Codex**:

```sh
npm run inbox
```

Defaults:

- URL: `http://127.0.0.1:43117/captures`
- Guided review URL: `http://127.0.0.1:43117/tours`
- Latest guided review URL: `http://127.0.0.1:43117/tours/latest`
- Vibe trace URL: `http://127.0.0.1:43117/traces`
- Latest vibe trace URL: `http://127.0.0.1:43117/traces/latest`
- Health check: `http://127.0.0.1:43117/health`
- Output: `~/CodexInbox/web-qa/latest`
- History: `~/CodexInbox/web-qa/history/<capture-id>`
- Guided review history: `~/CodexInbox/web-qa/tours/history/<tour-id>`
- Vibe trace history: `~/CodexInbox/web-qa/traces/history/<trace-id>`

Environment overrides:

```sh
CODEX_QA_INBOX_PORT=43117 CODEX_QA_INBOX_DIR="$HOME/CodexInbox/web-qa" npm run inbox
```

Each capture writes:

- `manifest.json`: capture ID, paths, page URL, selected element count
- `bundle.json`: structured page, element, locator, style, screenshot, and repro data
- `bundle.md`: Markdown summary plus JSON for agent consumption
- `images/`: highlighted viewport and crop images when image capture was available

The server keeps a stable `latest` folder for the most recent capture and a timestamped `history` folder for older captures. That makes it easy to tell Codex, "look at latest QA capture," while still preserving prior debugging evidence.

## Vibe Debugger

The Vibe Debugger adds a lightweight watch window and timeline to the same QA Bridge surface:

Plain English:

- **Watch** chooses the UI target whose state should be sampled over time.
- **Record** starts and stops the timeline of actions, DOM changes, route changes, network calls, console output, app probes, and watched-value diffs.
- **Trace** opens the review panel; **Send Trace** exports the trace artifacts for Codex to inspect.
- **Break on Load** pauses the QA Bridge after SPA route changes or same-origin page loads so you can add watches on the new screen.
- **Click Through** arms the next page click so it goes to the app instead of selecting another element.

1. Open QA Bridge and select the UI you want to observe in **Capture**.
2. Switch to **Trace** and choose **Watch selected**.
3. Choose **Record**, then **Use page**, and interact with the app.
4. In **Capture → Picking options**, enable **Break on Load** when navigation should return to picking mode. **Click Through** sends the next click to the app while picking remains enabled.
5. Return to **Trace** to review watched values, current observations, diffs, and timeline events.
6. Stop and choose **Send Trace**. In Codex, say `look at latest trace`.

Recording continues when changing workspace. Clearing a trace stops recording and clears its timeline while keeping watch targets.

The recorder observes user events, DOM mutations, route changes, fetch/XHR, storage writes, console warnings/errors, selected-element React fiber props/state when available, and optional app probe events. It stores diffs instead of repeated identical snapshots. Events and diffs have timestamps for comparison; temporal proximity alone does not establish a cause. Page timers and animation scheduling are left untouched. Delayed UI changes still appear in DOM diffs, and apps can emit explicit events when more context is useful.

Apps can opt in to clearer product-state traces without importing a package:

```js
window.__VIBE_DEBUGGER__?.watch('TaskList.visibleTasks', visibleTasks.length);
window.__VIBE_DEBUGGER__?.visibility('EmptyState', { visible, filter });
window.__VIBE_DEBUGGER__?.action('Save clicked', { disabled, dirty });
window.__VIBE_DEBUGGER__?.trace('Save finished', { status });
```

For app code that wants reusable helpers, see `snippets/vibe-debugger-app-probes.js`.

Use the local smoke page to exercise the core cases:

```sh
open smoke/vibe-debugger-smoke.html
```

## Guided Review Tours

Codex can also talk back to the extension by posting a tour:

```sh
curl -sS http://127.0.0.1:43117/tours \
  -H 'content-type: application/json' \
  --data @tour.json
```

Example `tour.json`:

```json
{
  "tour": {
    "title": "Workout setup review",
    "summary": "Walk through the main changes before handing the page back.",
    "steps": [
      {
        "url": "http://127.0.0.1:42381/workouts/setup",
        "selector": "[data-testid=\"exercise-video-preview\"]",
        "title": "Inline exercise video",
        "body": "This is where the preview should stay visible while the athlete configures the workout."
      },
      {
        "selector": "button[type=\"submit\"]",
        "title": "Save action",
        "body": "Use Ask Codex here if the button state or label looks wrong."
      }
    ]
  }
}
```

Tour steps support `url`, `selector`, `text`, `title`, `body`, and `notes`. The extension prefers `selector`, falls back to a visible text match, and preserves the tour while moving to another URL when Chrome allows reinjection on that tab.

While a tour is active, the page is in guided-review mode: the extension locks normal element picking, hides the bottom QA toolbar, and captures only the highlighted tour target when you click **Ask Codex**. The tour panel automatically moves between corners to avoid covering the highlighted target; use **Move** to cycle the panel manually when you want a different corner. Each tour capture includes `tourContext` with the tour title, step number, step title/body, URL/selector/text target, whether the target was found, and the typed Ask Codex note.

## Development Checks

Run the JavaScript syntax check and focused Node tests before committing extension changes:

```sh
npm test
npm run check
```

For the real browser smoke lane, run:

```sh
npm run test:e2e
```

The smoke lane launches a clean Edge/Chrome/Chromium profile, loads the unpacked extension through the browser's CDP pipe, injects the QA Bridge into `smoke/vibe-debugger-smoke.html`, records a Vibe Debugger trace, sends it to a temporary inbox server, and verifies the exported trace artifacts. It prefers Edge when installed; set `BROWSER_PATH`, `EDGE_PATH`, or `CHROME_PATH` to force a specific browser.

## What Gets Copied

Each export now includes:

- Page URL + title + timestamp
- Your toolbar comment, when provided
- Tour context and per-step Ask Codex note, when sent from a guided review
- Vibe trace context when watch targets or a recently exported trace exist
- Multiple selected elements in one packet
- Ranked locator candidates that prefer stable hooks (`data-testid`, role/name, label, placeholder, alt text, stable IDs)
- Backup locator candidates (`CSS`, `XPath`, generated-looking IDs) separated from stable candidates
- Uniqueness/match counts and score per locator
- Nearest section heading, stable ancestor, and section-like ancestor context
- Scroll diagnostics (`scrollWidth`, `clientWidth`, `scrollLeft`, `overflowX`, hidden overflow, scroll snap)
- React component chain + props/state (when available)
- React Native Web props such as `testID`, `nativeID`, and accessibility props when React exposes them
- A11y/form/style/data-attribute diagnostics
- Clean visible-viewport screenshot metadata; picker UI is hidden during capture
- Padded, highlighted crop images for smaller bundles
- A highlighted visible-viewport image for smaller bundles
- Saved screenshot files in `Downloads/elements` with filenames included in the bundle
- Generated Playwright repro skeleton

The visual capture is intentionally visible-viewport only. The extension does not scroll and stitch the full page because that can mutate page state while debugging.

Example (abbreviated):

```
# Element Debug Bundle
Captured at: 2026-02-25T18:14:07.220Z
URL: https://app.example.com/settings
Elements: 3

### 1. button#save
Primary locator: page.getByRole("button", { name: "Save changes" })
Nearest section heading: "Settings"
Nearest stable ancestor: form [data-testid="settings-form"] "Profile settings Save changes"
Stable locator candidates:
- data-testid: score 100, 1 match, page.getByTestId("save-btn")
- role-name: score 98, 1 match, page.getByRole("button", { name: "Save changes" })
Backup locator candidates:
- css: score 80, 1 match, page.locator("#save")
Screenshot crop: visible in viewport
Capture pixels: x=120, y=340, w=180, h=76, padding=16 CSS px
Crop image file: /Users/name/Downloads/elements/element-picker-2026-02-25-181407-app.example.com-element-01.jpg

## Playwright Repro Skeleton
import { test, expect } from '@playwright/test';
...
```

## Missing Icons?

The extension works without icons, but if you want them:
- Create 16x16, 48x48, and 128x128 PNG files
- Name them `icon16.png`, `icon48.png`, `icon128.png`
- Or just remove the icon references from `manifest.json`

For UI evidence, set `CODEX_QA_E2E_SCREENSHOT_DIR` to an absolute directory when running `npm run test:e2e`. The isolated browser lane covers capture/trace exports, offline retry, tour/trace isolation, target avoidance, note preservation, missing-target recovery, and action visibility at 1280×720 and 360×480.
