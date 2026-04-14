# Element Picker for Coding Agents

A Chrome/Arc extension that lets you build a multi-element debug bundle and copy it to clipboard as Claude-ready Markdown + JSON.

## Installation

1. Open Arc/Chrome and go to `arc://extensions` (or `chrome://extensions`)
2. Enable **Developer mode** (toggle in top right)
3. Click **Load unpacked**
4. Select this folder (`element-picker`)

## Usage

1. Click the extension icon in your toolbar
2. Hover elements to preview highlight
3. Click elements to add them to the current bundle
4. Press `Backspace`/`Delete` (or `Cmd/Ctrl + Z`) to undo the last selection
5. Press `Enter` to export the bundle to clipboard
6. Press `ESC` to cancel

## What Gets Copied

Each export now includes:

- Page URL + title + timestamp
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
