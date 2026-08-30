# Vibe Digger

Vibe Digger is a Chrome extension for debugging React apps while you vibe-code. It puts an in-page panel over your running app with three digging tools, and can copy everything it finds as an agent-ready markdown bundle for Claude or Codex — no DevTools, no build step, no server.

## Features

- **Inspect** — hover any element to see the React component that owns it, with its owner chain. Click to pin the component's props, hooks, class state, render count, and source location (when React provides it) into the panel.
- **Heatmap** — flashes components as they re-render, labeled with cumulative render counts and colored by heat (violet → yellow → orange → red). Great for spotting wasted renders from an unmemoized tree.
- **Net** — records the page's whole network lifecycle in order: every `fetch`, XHR, `sendBeacon`, and **WebSocket** with its request body, response body (JSON/text, bounded, secret-redacted), payload sizes, status, duration, and the **initiator stack** — the code path that fired it. WebSockets appear as one live entry per socket with its sent/received frames (timestamped, redacted, bounded), close code, and clean/unclean verdict. Step through the story yourself, or copy it for an agent: request/response evidence can't be faked by UI that merely looks right. On localhost, capture starts at `document_start`, so boot-time requests are included.
- **Issues** — digs up console errors, React warnings (missing keys, act warnings, etc.), console warnings, uncaught errors, unhandled promise rejections, and failed `fetch`/XHR requests. Duplicates are deduped with counts; obvious secrets are redacted.
- **Copy** — puts a markdown capture on the clipboard: page info, the pinned component with props/hooks, top render counts, the ordered network lifecycle with bodies, and the issue list. Paste it straight into a coding agent instead of describing the bug in prose.

## Installation

1. Open Chrome and navigate to `chrome://extensions`
2. Enable **Developer mode** using the toggle in the top-right corner
3. Click **Load unpacked** and select this `vibe-digger` folder
4. Click the toolbar icon on any page to toggle the panel

## How it works

Two scripts cooperate across Chrome's script worlds:

- `page-agent.js` runs in the page's **MAIN world**. On `localhost` / `127.0.0.1` it is auto-injected at `document_start`, where it installs a React-DevTools-compatible hook **before React boots** — that is what lets it observe every commit for the heatmap and catch errors from the first paint. It also reads React fiber internals for the inspector and patches `console`, `fetch`, `XMLHttpRequest`, and `WebSocket` (best-effort, secret-redacting, bounded buffers).
- `content.js` runs in the extension's isolated world and renders the panel, tooltip, and flash overlay inside a shadow root. The two talk over `window.postMessage`.

On non-local sites, both scripts are injected on demand when you click the icon (`activeTab`, no broad host permissions). The inspector and issue digger work from that point on; the heatmap additionally needs a commit hook, so it works there only if React DevTools is installed — otherwise the panel tells you so.

If the real React DevTools hook is already present, Vibe Digger wraps it instead of replacing it; the two coexist.

The Net capture is scoped to the current page load. Closing or hiding the panel
does not clear it. Use **Clear all** to reset it manually; navigating or reloading
the page starts a fresh capture. The buffer keeps at most 300 entries and drops
the oldest entry when a new one exceeds that limit.

Use the **−** control in the title bar to minimize Vibe Digger to a compact restore pill at the
bottom-left of the page. Capture continues while minimized; active Inspect mode
ends so the hidden panel cannot keep intercepting page clicks.

Drag the **Vibe Digger** title bar to move the full panel around the page. Its
position is kept for the current page load and clamped inside the visible
viewport when the window or panel size changes.

## Demo app

A small React app that exercises every feature lives in `demo/`:

```sh
npm run demo   # serves http://localhost:5183
```

It ticks every second (turn on the Heatmap and watch the unmemoized tree flash while the memoized clock stays quiet), has a filterable list and counter to inspect, and buttons that produce a missing-key warning, a 404 fetch, an async throw, an unhandled rejection, and a manual warning for the Issues panel. The demo server also exposes a small JSON API (`/api/items` fetched on mount, `/api/echo` POST, `/api/slow`, and a malformed-body 400) plus a WebSocket echo at `/ws/echo`, so the Net tab has a real request/response/frame story to tell.

## Development

```sh
npm run check   # syntax-check all scripts
npm test        # manifest/consistency tests
npm run icons   # regenerate icon PNGs
```

## Limits (v1)

- The heatmap flags components whose fiber has React's `PerformedWork` flag — it shows *that* something rendered, not *why* (no props-diff attribution yet).
- Hook values are shown positionally (`#0 state`, `#1 ref`, …); custom hook names are not recoverable from fibers.
- Production React builds minify component names and strip debug source info; the inspector works best against dev builds.
- Network capture covers `fetch`, `XMLHttpRequest`, `sendBeacon`, and WebSockets — not EventSource or static resource loads (images, scripts). Response bodies are captured only for JSON/text-like content types, bounded at ~3KB each; WebSocket entries keep the last 60 frames (~800 chars each, binary frames noted by size only).
- Net size labels count known payload-body bytes, not HTTP headers or transport framing. Text is measured as UTF-8, WebSocket totals accumulate frame payloads, and unknown sizes are shown as `?`.
- Everything is standalone and clipboard-based. Wiring captures into the local Codex inbox (like `element-picker`) is a possible follow-up.
