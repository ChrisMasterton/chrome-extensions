# Release Notes

## Project overview to date - 2026-05-25
- Provides Element Picker QA Bridge, a Manifest V3 browser extension for Chrome, Edge, and Arc that helps capture real page state for Codex-assisted QA.
- Supports multi-element debug bundles with user comments, screenshots, stable locator candidates, accessibility/style diagnostics, React clues, scroll diagnostics, and Playwright repro skeletons.
- Sends captures to a local Codex inbox under `~/CodexInbox/web-qa` through `npm run inbox`, while preserving clipboard export for quick handoff.
- Lets Codex send guided review tours back into the page, with highlighted targets, step navigation, cross-page continuation, and Ask Codex follow-up captures.
- Includes Vibe Debugger tracing so selected UI can be watched over time, exported as trace artifacts, and reviewed from the same local inbox workflow.
- Ships a repo-local Codex companion skill plus focused Node checks and a real-browser smoke lane for validating the extension workflow.
