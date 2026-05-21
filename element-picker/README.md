# Element Picker QA Bridge

A Chrome/Arc extension that lets you pause a page, select suspicious UI, and hand a rich debug bundle to Codex through a local inbox. Clipboard export still works.

## Major Updates in 1.8

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
- Added `package.json` scripts for `npm run inbox` and `npm run check`.
- Updated the Manifest V3 metadata, extension name, host permission for the local inbox, and version.

The near-zero-friction loop is:

1. Start the local inbox server: `npm run inbox`
2. Click the extension icon on any page.
3. Click one or more suspicious elements.
4. Click **Send to Codex** in the floating toolbar.
5. In Codex, say: `look at latest QA capture`.

The reverse loop is:

1. Ask Codex to walk you through a page or a change.
2. Codex posts a guided review tour to the local inbox.
3. Click the extension icon on the page.
4. Click **Load Tour** in the floating toolbar.
5. Step through Codex's highlighted notes. During a tour, the normal QA toolbar is replaced by the tour panel so random page clicks do not add extra selections.
6. Type a question or observation in **Ask Codex about this step...**, then click **Ask Codex** to send that step, tour context, and your note back as a fresh capture.

## Project Files

- `manifest.json`: Manifest V3 extension metadata and local inbox host permission.
- `background.js`: extension injection, screenshot capture, image downloads, local inbox posting, latest tour loading, and cross-page tour continuation.
- `picker.js`: page overlay, toolbar, element analysis, locator ranking, screenshots, clipboard export, Send to Codex, and guided tour UI.
- `picker.css`: overlay, toolbar, responsive controls, tour panel, and tour highlight styling.
- `scripts/codex-qa-inbox-server.mjs`: local capture/tour server used by Codex and the extension.
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

1. Open Arc/Chrome and go to `arc://extensions` (or `chrome://extensions`)
2. Enable **Developer mode** (toggle in top right)
3. Click **Load unpacked**
4. Select this folder (`element-picker`)

## Usage

1. Click the extension icon in your toolbar
2. The page starts paused with a floating **QA Bridge** toolbar
3. Hover elements to preview the highlight
4. Click elements to add them to the current bundle
5. Add a short comment in the toolbar when you want Codex to know what you noticed
6. Click **Send to Codex** to write the bundle to `~/CodexInbox/web-qa/latest`
7. Click **Copy** or press `Enter` to export the bundle to clipboard
8. Press `Backspace`/`Delete` (or `Cmd/Ctrl + Z`) to undo the last selection
9. Click **Resume** to restore page interaction or press `ESC` to cancel

## Local Codex Inbox

Run the dependency-free Node server from this folder before using **Send to Codex**:

```sh
npm run inbox
```

Defaults:

- URL: `http://127.0.0.1:43117/captures`
- Guided review URL: `http://127.0.0.1:43117/tours`
- Latest guided review URL: `http://127.0.0.1:43117/tours/latest`
- Health check: `http://127.0.0.1:43117/health`
- Output: `~/CodexInbox/web-qa/latest`
- History: `~/CodexInbox/web-qa/history/<capture-id>`
- Guided review history: `~/CodexInbox/web-qa/tours/history/<tour-id>`

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

Run the JavaScript syntax check before committing extension changes:

```sh
npm run check
```

The check validates `background.js`, `picker.js`, and `scripts/codex-qa-inbox-server.mjs` with Node's parser. Chrome extension API behavior still needs a browser smoke test after loading the unpacked extension.

## What Gets Copied

Each export now includes:

- Page URL + title + timestamp
- Your toolbar comment, when provided
- Tour context and per-step Ask Codex note, when sent from a guided review
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
