# Element Picker for Claude Code

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
- Ranked locator candidates (`data-testid`, role/name, CSS, XPath, text)
- Uniqueness/match counts and score per locator
- React component chain + props/state (when available)
- A11y/form/style/data-attribute diagnostics
- Viewport screenshot crop metadata for each element
- Embedded preview crop images for smaller bundles
- Generated Playwright repro skeleton

Example (abbreviated):

```
# Element Debug Bundle
Captured at: 2026-02-25T18:14:07.220Z
URL: https://app.example.com/settings
Elements: 3

### 1. button#save
Primary locator: page.getByRole("button", { name: "Save changes" })
Locator ranking:
- data-testid: score 100, 1 match, page.locator("[data-testid=\"save-btn\"]")
- role-name: score 98, 1 match, page.getByRole("button", { name: "Save changes" })
- css: score 80, 1 match, page.locator("#save")

## Playwright Repro Skeleton
import { test, expect } from '@playwright/test';
...
```

## Missing Icons?

The extension works without icons, but if you want them:
- Create 16x16, 48x48, and 128x128 PNG files
- Name them `icon16.png`, `icon48.png`, `icon128.png`
- Or just remove the icon references from `manifest.json`
