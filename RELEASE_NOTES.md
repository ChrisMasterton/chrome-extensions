# Release Notes

## 2026-05-30
### Added
- Added `Break on Load` so QA Bridge can pause again after SPA route changes or same-origin page loads, making it easier to keep Vibe Debugger workflows going across navigation.
- Added `Click Through` so the next page click can go to the app instead of selecting another element while the QA Bridge stays active.

### Changed
- The toolbar icon now toggles the QA Bridge off on a second click, and the Vibe Debugger controls can collapse into a compact `Vibe` section that still shows recording and watch activity.
- Copying a debug bundle now keeps the bridge open so you can continue selecting elements in the same session, and the toolbar layout/status handling is clearer on narrow pages.

### Fixed
- Restricted pages such as `chrome://` tabs, the Chrome Web Store, and PDFs now show a visible badge warning instead of failing silently when the extension cannot run there.

## Project overview to date - 2026-05-25
- Provides Element Picker QA Bridge, a Manifest V3 browser extension for Chrome, Edge, and Arc that helps capture real page state for Codex-assisted QA.
- Supports multi-element debug bundles with user comments, screenshots, stable locator candidates, accessibility/style diagnostics, React clues, scroll diagnostics, and Playwright repro skeletons.
- Sends captures to a local Codex inbox under `~/CodexInbox/web-qa` through `npm run inbox`, while preserving clipboard export for quick handoff.
- Lets Codex send guided review tours back into the page, with highlighted targets, step navigation, cross-page continuation, and Ask Codex follow-up captures.
- Includes Vibe Debugger tracing so selected UI can be watched over time, exported as trace artifacts, and reviewed from the same local inbox workflow.
- Ships a repo-local Codex companion skill plus focused Node checks and a real-browser smoke lane for validating the extension workflow.
