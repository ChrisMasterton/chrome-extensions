# Release Notes

## 2026-08-23 — Test Users (0.4.0)
### Added
- Provisioned Personas: a site can opt into a same-origin local/staging adapter that advertises roles and scenarios, provisions the extension-generated identity into real application-side fixture state, and returns only an opaque account reference and status.
- Provisioned users show ready, stale, or failed state on their cards. **Provision & fill** creates or refreshes the selected role/scenario; **Reset** restores an already-provisioned scenario without resending the identity or password.
- Adapter URLs are exact-origin only and blocked on ordinary web origins. Capability and result payloads containing user/account lists, names, emails, usernames, passwords, credentials, tokens, secrets, or sessions are rejected.
- Unit coverage now exercises adapter URL boundaries, metadata/result sanitization, and credential-free reset requests. The real-browser smoke lane covers capability discovery, provision-and-fill, persisted opaque state, and reset.

### Fixed
- Saving site identity or adapter settings now preserves form snapshots and updates their site identity instead of reconstructing storage without them.

## 2026-08-17 — Test Users (0.3.0)
### Added
- Form snapshots: on pages with longer forms, **Snapshot page** captures every editable field and its current value — text inputs, selects, checkboxes, radios, and textareas, including open shadow DOM and same-origin iframes — so the whole form can be refilled in one click on the next debugging run.
- Email, username, password, payment (`cc-*`, card number/CVC/expiry), and one-time-code/captcha/promo fields are never captured or refilled; the snapshot editor reports how many sensitive fields were skipped. The same rules are re-checked against the live page at refill time, so a stale or hand-edited snapshot still cannot write into a credential field.
- The snapshot editor lists every captured field with an include/exclude toggle and an editable value (selects render their captured options), rows can be removed, and **Re-scan** merges the page again — adding fields the first capture missed, filling in values for empty ones, and following the page's current radio selection while keeping hand-edited values.
- Refill matches fields by stable identity (id, name, label, placeholder, `autocomplete`) rather than DOM position, and the toast reports the outcome, for example `Refilled 10 of 12 fields — 2 not found on this page`.
- Snapshots are listed on the users screen scoped to the current site (snapshots for the current path sort first), participate in search, and are counted in and deleted with their site under **Settings → Saved sites**.
- The local demo gained a profile page (`demo/profile.html`) with a long form for trying the snapshot flow, and the e2e smoke lane now covers capture, exclusion, value editing, and refill in a real Chrome.

## 2026-08-13 — Test Users (0.2.0)
### Added
- Autofill now fills name fields — full name, first/last name, and username — alongside email and every password field. Fields are matched by labels, placeholders, `autocomplete` attributes, and name/id hints, and inputs inside open shadow DOM are included.
- Autofill now reaches forms inside same-origin iframes: the overlay script is injected into all permitted frames, the background aggregates what each frame filled, and the toast reports the combined result.
- Pressing `Escape` while the panel has focus collapses it to the launcher, matching the close button.
- The local demo page now includes name and confirm-password fields so the full fill behavior is visible out of the box.
- The environment chip is now tinted by risk — indigo for local, amber for staging hosts, red for real websites — with a tooltip reminding you to use generated test accounts only.
- The fill toast now reports exactly what was filled (for example, `Filled name, email & 2 password fields`) instead of a generic confirmation.
- Tabs show live counts, and the current-site tab is named after the detected project so it is obvious which site the list is scoped to.
- An empty current-site list now says where your saved logins actually live and offers a one-click jump to `All sites`.

### Changed
- The header now leads with a prominent site-identity card — site initial, project name, address, and environment chip — with a visible `Edit` affordance, replacing the small caption text that made the active project easy to miss.
- Hidden, disabled, and read-only inputs are skipped during autofill so decoy or honeypot fields no longer swallow credentials.
- Editor buttons were clarified: `Generate` is now `Regenerate` and `Save only` is now `Save`.

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
