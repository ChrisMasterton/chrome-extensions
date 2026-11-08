# Vibe Digger

Vibe Digger is a Chrome extension for debugging React apps while you vibe-code. It puts an in-page panel over your running app with three digging tools, and can copy everything it finds as an agent-ready markdown bundle for Claude or Codex — no DevTools, no build step, no server.

## Features

- **Inspect** — choose **Pick element**, then hover any element to see the React component that owns it, with its owner chain. Click to pin the component's props, hooks, class state, render count, and source location (when React provides it) into the panel.
- **Heatmap** — flashes components as they re-render, labeled with cumulative render counts and colored by heat (violet → yellow → orange → red). Great for spotting wasted renders from an unmemoized tree.
- **Network** — records the page's whole network lifecycle in order: every `fetch`, XHR, `sendBeacon`, and **WebSocket** with its request body, response body (JSON/text, bounded, secret-redacted), payload sizes, status, duration, and the **initiator stack** — the code path that fired it. WebSockets appear as one live entry per socket with its sent/received frames (timestamped, redacted, bounded), close code, and clean/unclean verdict. Step through the story yourself, or copy it for an agent: request/response evidence can't be faked by UI that merely looks right. On localhost, capture starts at `document_start`, so boot-time requests are included.
- **Issues** — digs up console errors, React warnings (missing keys, act warnings, etc.), console warnings, uncaught errors, unhandled promise rejections, and failed `fetch`/XHR requests. Duplicates are deduped with counts; obvious secrets are redacted.
- **Copy capture** — puts a markdown capture on the clipboard: page info, the pinned component with props/hooks, top render counts, the ordered network lifecycle with bodies, and the issue list. Paste it straight into a coding agent instead of describing the bug in prose.
- **Scoped copy icons** — copy one network entry, one issue, or the complete Inspect, Network, or Issues view as focused agent-ready Markdown without including unrelated capture data.

## Panel workflow

**Inspect**, **Network**, and **Issues** are separate views. Pick element and Heatmap are independent toggles. The panel keeps a stable frame while views change, and the Copy capture action stays visible below scrolling evidence.

Network and issue disclosures are keyboard-accessible and retain expansion, focus, and reading position when new evidence arrives. Each view and entry also has a scoped copy action. Copy capture waits for both evidence lists and clipboard completion before reporting success; a failed write remains visible and can be retried. Capture continues while minimized, and minimizing exits picking mode.

## Installation

1. Open Chrome and navigate to `chrome://extensions`
2. Enable **Developer mode** using the toggle in the top-right corner
3. Click **Load unpacked** and select this `vibe-digger` folder
4. Click the toolbar icon on any page to toggle the panel

## How it works

Two scripts cooperate across Chrome's script worlds:

- `page-agent.js` runs in the page's **MAIN world**. On `localhost` / `127.0.0.1` it is auto-injected at `document_start`, where it installs a React-DevTools-compatible hook **before React boots** — that is what lets it observe every commit for the heatmap and catch errors from the first paint. It also reads React fiber internals for the inspector and patches `console`, `fetch`, `XMLHttpRequest`, and `WebSocket` (best-effort, secret-redacting, bounded buffers).
- `content.js` runs in the extension's isolated world and renders the panel, tooltip, and flash overlay inside a shadow root. The two talk over `window.postMessage`.

On non-local sites, both scripts are injected on demand when you click the icon (`activeTab`, no broad host permissions). The inspector and issue digger work from that point on. Heatmap becomes available when a renderer registers with the installed hook or an existing compatible DevTools hook supplies a commit connection. Installing a new hook after a renderer has already started does not reconnect that renderer; the panel keeps Heatmap disabled and explains the missed startup.

If the real React DevTools hook is already present, Vibe Digger wraps it instead of replacing it; the two coexist.

The network capture is scoped to the current page load. Closing or hiding the panel
does not clear it. Use **Clear all** to reset it manually; navigating or reloading
the page starts a fresh capture. The buffer keeps at most 300 entries and drops
the oldest entry when a new one exceeds that limit.

Use the **−** control in the title bar to minimize Vibe Digger to a compact restore pill at the
bottom-left of the page. Capture continues while minimized; active Inspect mode
ends so the hidden panel cannot keep intercepting page clicks.

Drag the **Vibe Digger** title bar to move the full panel around the page. Its
position is kept for the current page load and clamped inside the visible
viewport when the window or panel size changes.

### VD-4 React attachment lifecycle

The page agent owns React attachment for the current document. Hook mode (`shim`, `wrapped`, or `none`) describes installation; attachment (`waiting`, `attached`, or `unavailable`) describes evidence of a commit connection. React presence and Heatmap recording are separate: finding a fiber enables inspection, while only an attached renderer enables Heatmap. This follows React's [renderer registration and commit hook](https://github.com/facebook/react/blob/v18.3.1/packages/react-reconciler/src/ReactFiberDevToolsHook.new.js).

| State | Trigger and guard | Transition and behavior |
| --- | --- | --- |
| Initializing | No hook exists and a shim can be installed | Wait for a renderer. Heatmap stays disabled. |
| Initializing | An enabled Fiber-compatible DevTools hook can be wrapped | Preserve the hook, its renderer map, and native callbacks. Existing registered renderers establish attachment; otherwise wait for registration or a valid commit. |
| Initializing | Hook is disabled, unsupported, or protected | Mark Heatmap unavailable. Roll back a partial wrap and keep inspection and capture working. |
| Waiting | Renderer successfully registers, or a valid commit reaches the observer | Become attached and enable the Heatmap control. Recording remains off until explicitly enabled. |
| Waiting | DOM discovery or inspection finds React fibers without a connected renderer | Mark startup missed. Keep inspection working and show Heatmap recovery guidance. Discovery also handles a renderer that loaded before injection but mounts its first root afterward. |
| Unavailable after missed startup | A later renderer registers with this hook, or a valid commit arrives | Become attached without silently starting recording. |
| Attached | Heatmap toggle or native commit | Accept recording changes; update commit status even while recording is off. When enabled, draw bounded flashes. Remove unmounted roots from the shim's root registry. |
| Waiting or unavailable | An enable request reaches the agent | Reject it and acknowledge recording off; the panel reflects the agent's status. |
| Any attachment | Close and reopen the panel | Keep attachment; closing stops Heatmap. Reopening can enable it again when attached. |
| Any attachment | Reload or navigate | Start a new document's attachment lifecycle. |

Registration and commit observation update an already-open panel. DOM discovery scans a bounded set of page elements until React is found; inspecting a fiber also supplies detection evidence. Reinjection does not stack hook wrappers. Wrapped callbacks retain their receiver, arguments, return values, and exceptions.

For missed startup on localhost, reload so automatic `document_start` injection runs first. On other sites, a compatible React Developer Tools hook must be present before React loads, or Vibe Digger must be invoked before the renderer starts. Enabling Heatmap after late injection cannot recover earlier commits.

### VD-3 issue collection lifecycle

The page agent owns the issue collection for the current document. It retains up to 200 distinct issues in first-observed order. A matching kind and bounded message updates the existing issue's count and last-seen time without changing its position. An evicted or cleared issue has no retained identity; its next occurrence starts a new record with count one.

| State | Trigger | Transition and effects |
| --- | --- | --- |
| Empty or populated | Console warning/error, React warning, uncaught error, unhandled rejection, or observed network failure | Add a new issue or update a retained duplicate. Evict the oldest issue when a new distinct issue exceeds 200. Advance the collection revision and publish the update with any evicted IDs. |
| Empty or populated | **Issues → Clear all** | Empty the collection, advance its revision, and publish an authoritative empty snapshot. New observations continue to be captured. |
| Any collection | Open the panel, open Issues, or prepare Copy capture | Read a snapshot of the current collection without changing it. |
| Panel awaiting its first snapshot | Receive a snapshot | Initialize the panel projection and its revision. |
| Panel synchronized | Receive the next revision | Apply the update and eviction together; discard disclosures for removed issues. |
| Panel synchronized | Receive a revision gap | Keep the current projection and request an authoritative snapshot to repair the missing updates. |
| Any panel state | Receive an older snapshot or duplicate/older update | Ignore it, so stale messages cannot undo clearing or eviction. |
| Any collection | Minimize or close the panel | Keep collecting; restoring or reopening shows the retained issues. |
| Any collection | Reload or navigate to a new document | Start a fresh collection. |

**Clear all** resets currently retained issues. An error first observed afterward, including a request failure that completes afterward, is a new observation. Issue collection is independent of the Network buffer and render counts. Scoped Issues copies and Copy capture use the same synchronized issue projection as the panel.

### VD-5 and VD-6 network capture lifecycles

The page agent owns the chronological Network collection, capped at 300 entries. Each operation has a stable ID and sequence number for this document. Retention and transport state are independent: **Clear all** and eviction retire rows without canceling native requests or closing sockets. A retired row never reappears from later metadata, body reads, socket activity, or queued frame updates. An existing retired socket stays hidden until the app creates a new connection.

| Lifecycle | Trigger | Transition and effects |
| --- | --- | --- |
| HTTP pending | `fetch` resolves its headers, or XHR emits `loadend` with an HTTP status | Complete once, preserving status and success/failure evidence. HTTP errors such as 404 are completed responses. Fetch body capture can enrich a retained completed row later; it does not delay status reporting. |
| HTTP pending | Native throw, rejected fetch, or XHR network error | Fail once and preserve the native throw/rejection. Remove XHR listeners even when `send` throws, so they cannot settle a later request. |
| HTTP pending | Fetch abort, XHR abort, or XHR timeout | Settle as aborted or timed out. Repeated terminal events cannot settle the operation again. |
| Beacon pending | Native `sendBeacon` returns or throws | Become queued, rejected, or failed. Return the original boolean or rethrow the original error. Queued means accepted by the browser, with no claim of server delivery. Rejected beacons appear as dropped in both the panel and exports. |
| Socket connecting | Native `open` | Become open. A socket created before capture is adopted on its first successful send. |
| Socket connecting/open | Native `close` enters the closing state | Become closing; invalid close arguments preserve the native exception and do not change capture state. |
| Socket open/closing | Successful native send or received message | Record a bounded frame. Sends rejected by the native API or discarded during closing/closed states do not create frames. Keep the last 60 frames and cumulative byte/frame totals. |
| Socket not closed | Native `error` or `close` | Publish the error immediately; close records code, reason, duration, and clean/unclean outcome. Closed is terminal. |

Collection changes publish a revision and any evicted IDs together. The panel applies consecutive revisions, rejects stale messages, requests a snapshot when it misses an update, and removes disclosures for retired IDs. Snapshots flush buffered frame updates before returning the current collection, so copies and live capture agree.

**Network → Clear all** advances the revision and publishes an empty snapshot. IDs keep increasing within the document. Capture continues while the panel is minimized or closed; new operations get new rows. Reloading or navigating to a new document resets the collection. A newly observed failure can still enter Issues after its Network row was retired, as specified by VD-3.

## Demo app

A small React app that exercises every feature lives in `demo/`:

```sh
npm run demo   # serves http://localhost:5183
```

It ticks every second (turn on the Heatmap and watch the unmemoized tree flash while the memoized clock stays quiet), has a filterable list and counter to inspect, and buttons that produce a missing-key warning, a 404 fetch, an async throw, an unhandled rejection, and a manual warning for the Issues panel. The demo server also exposes a small JSON API (`/api/items` fetched on mount, `/api/echo` POST, `/api/slow`, and a malformed-body 400) plus a WebSocket echo at `/ws/echo`, so the Network tab has a real request/response/frame story to tell.

## Development

```sh
npm run check   # syntax-check all scripts
npm test        # manifest/consistency and issue/network/attachment lifecycle tests
npm run test:e2e # isolated Chrome UI and capture flows (demo requires cdnjs access)
npm run icons   # regenerate icon PNGs
```

## Limits (v1)

- The heatmap flags components whose fiber has React's `PerformedWork` flag — it shows *that* something rendered, not *why* (no props-diff attribution yet).
- Hook values are shown positionally (`#0 state`, `#1 ref`, …); custom hook names are not recoverable from fibers.
- Production React builds minify component names and strip debug source info; the inspector works best against dev builds.
- Network capture covers `fetch`, `XMLHttpRequest`, `sendBeacon`, and WebSockets — not EventSource or static resource loads (images, scripts). Response bodies are captured only for JSON/text-like content types, bounded at ~3KB each; WebSocket entries keep the last 60 frames (~800 chars each, binary frames noted by size only).
- Network size labels count known payload-body bytes, not HTTP headers or transport framing. Text is measured as UTF-8, WebSocket totals accumulate frame payloads, and unknown sizes are shown as `?`.
- Everything is standalone and clipboard-based. Wiring captures into the local Codex inbox (like `element-picker`) is a possible follow-up.

Set `VIBE_DIGGER_E2E_SCREENSHOT_DIR` to an absolute directory to retain browser screenshots. The browser lane uses a temporary profile and the real React demo; it exercises inspection/heatmap, streamed HTTP/WebSocket evidence, keyboard navigation and disclosures, reading position, delayed clipboard acknowledgement, native clipboard success, injected clipboard failure/retry, scoped copying, minimize/restore, and short-window controls. Issue checks cover live retention beyond 200 unique warnings, duplicate counts, clear/reobserve, stale messages, snapshot recovery, capture while minimized/closed, exports, and reload reset. Network checks cover HTTP success/error/abort/timeout, native beacon acceptance/rejection/failure, bounded socket frames and clean/unclean closes, clear/eviction during active requests and sockets, stale messages, snapshot recovery, and matching export status. Attachment checks cover early injection, missed startup, a delayed first mount, and coexistence with the actual React Developer Tools extension. Test profiles, servers, and fixture data are cleaned up afterward.

Coexistence checks copy an installed React Developer Tools extension from Chrome/Edge's default macOS profile into the temporary test profile. Set `REACT_DEVTOOLS_EXTENSION_PATH` to an unpacked extension directory to use another installation. The test waits for DevTools to register its own `document_start` hook before loading the demo. Set `VIBE_DIGGER_E2E_ATTACHMENT_ONLY=1` to run just early/late attachment and DevTools checks.
