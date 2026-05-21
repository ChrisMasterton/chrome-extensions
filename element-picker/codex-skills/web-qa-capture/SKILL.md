---
name: web-qa-capture
description: Inspect and explain the latest local web QA capture, or post a guided review tour, using the Element Picker QA Bridge Chrome extension. Use when the user says "look at latest QA capture", "explain this page capture", "inspect the QA inbox", "what is going on here", "walk me through this page", or asks Codex to debug or annotate a selected webpage element from a Chrome extension capture.
---

# Web QA Capture

Use this skill when the user wants Codex to consume a capture from the local Element Picker QA Bridge.

Use the guided review workflow when the user wants Codex to talk back to the page, walk them through a web UI, or annotate an engineer's delivered work.

## Default Inbox

The extension writes captures to:

`~/CodexInbox/web-qa/latest`

Expected files:

- `manifest.json`: capture ID, timestamp, page URL, selected element count, and artifact paths.
- `bundle.md`: Markdown summary intended for quick reading.
- `bundle.json`: structured page, user comment, guided tour context when present, selected element, locator, style, React, scroll, screenshot, and Playwright repro data.
- `images/`: highlighted viewport and crop images when available.

## Workflow

1. Read `~/CodexInbox/web-qa/latest/manifest.json` first.
2. Read `bundle.md` for a compact summary.
3. Read `bundle.json` when exact selectors, user comments, tour context, styles, React hints, scroll diagnostics, or screenshot file paths matter.
4. Use `view_image` for `images/highlighted-viewport.*` and relevant `images/element-XX.*` files when present.
5. Treat `userComment` as the user's live observation or question about the selected elements, and answer it directly before branching into broader analysis.
6. If `tourContext` is present, treat it as the active guided-review step. Read `tourContext.askText`, the tour title/summary, the step index, step title/body, URL, selector/text target, and target-found flags before analyzing broader page state.
7. Explain what the selected UI appears to be, what state it is in, and what evidence supports that interpretation.
8. If the user wants a fix, map the capture back to the likely owning repo/code path from the URL, locators, text, React component chain, and nearby DOM context, then inspect the real repo before editing.

## Guided Review Workflow

1. Inspect the relevant code, route, test output, or latest capture first so the tour is grounded in real evidence.
2. Create a tour JSON object with a concise `title`, optional `summary`, and `steps`.
3. For each step, prefer a stable `selector` such as `data-testid`, role-backed element selector, or durable ID. Add `url` when a step belongs on a specific page. Use `text` only when no selector exists.
4. Keep `body` short and explanatory: what the user is looking at, what changed, and what to verify.
5. POST the tour to `http://127.0.0.1:43117/tours`.
6. Tell the user to click the extension icon and **Load Tour**. During the tour, the extension hides the normal picker toolbar, locks random page selection, moves the tour panel between corners to avoid the highlighted target, and shows a per-step **Ask Codex about this step...** box. If the panel is still in the way, they can click **Move** to cycle corners. If they want a follow-up on any step, they type there, click **Ask Codex**, and then say `look at latest QA capture`.

Tour shape:

```json
{
  "tour": {
    "title": "Review title",
    "summary": "Optional one-line context",
    "steps": [
      {
        "url": "http://127.0.0.1:5173/example",
        "selector": "[data-testid=\"primary-action\"]",
        "title": "Primary action",
        "body": "This button should now stay enabled after the form validates."
      }
    ]
  }
}
```

POST example:

```sh
curl -sS http://127.0.0.1:43117/tours \
  -H 'content-type: application/json' \
  --data @tour.json
```

## Response Expectations

- Lead with the practical explanation of what is happening on the page.
- Call out suspicious evidence: disabled controls, hidden overflow, pointer-events, stale route/state, duplicated labels, wrong role/name, offscreen content, failed capture, missing image, or non-unique locators.
- Separate confirmed capture facts from inferences.
- Include exact file paths for the capture artifacts you inspected.
- If the inbox is missing or stale, say that clearly and ask the user to click **Send to Codex** again with the inbox server running.

## Useful Commands

```sh
ls -la ~/CodexInbox/web-qa/latest
jq '.captureId, .page, .totalElements, .files' ~/CodexInbox/web-qa/latest/manifest.json
jq '{userComment, tourContext}' ~/CodexInbox/web-qa/latest/bundle.json
jq '.elements[] | {index, tag, text, primaryLocator, reactComponents, styles, formState, scrollDiagnostics}' ~/CodexInbox/web-qa/latest/bundle.json
curl -sS http://127.0.0.1:43117/tours/latest | jq '{title: .tour.title, steps: [.tour.steps[] | {title, url, selector, text}]}'
```
