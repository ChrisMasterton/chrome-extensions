# Element Picker for Claude Code

A Chrome/Arc extension that lets you click on any element and copy its selector + React component info to your clipboard. Perfect for telling Claude Code exactly which element you're talking about.

## Installation

1. Open Arc/Chrome and go to `arc://extensions` (or `chrome://extensions`)
2. Enable **Developer mode** (toggle in top right)
3. Click **Load unpacked**
4. Select this folder (`element-picker`)

## Usage

1. Click the extension icon in your toolbar
2. Hover over elements - they'll highlight in blue
3. Click an element to copy its info to clipboard
4. Press `ESC` to cancel

## What Gets Copied

```
Element: button
Selector: #root > div.sidebar > button.submit-btn
Classes: submit-btn primary
React: SubmitButton → Form → App
Text: "Submit"
Size: 120x40
```

## Notes

- Works with React apps (detects component names)
- Filters out Tailwind utility classes to keep selectors readable
- Press ESC to cancel without selecting

## Missing Icons?

The extension works without icons, but if you want them:
- Create 16x16, 48x48, and 128x128 PNG files
- Name them `icon16.png`, `icon48.png`, `icon128.png`
- Or just remove the icon references from `manifest.json`
