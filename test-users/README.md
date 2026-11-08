# Test Users

Test Users is a Manifest V3 Chrome extension for generating, organizing, and autofilling disposable local or staging accounts.

## Using the panel

- **Accounts** lists saved identities for the selected site and environment. **Forms** lists saved form snapshots for the site, with the current page first. Each view keeps its own search.
- The scope control beside search switches between **This site** and **All sites**. The header always describes the page you are on; browsing another environment does not change the page's environment chip.
- **Fill login** fills matching fields without submitting the application's form. The exact result stays beside the account. Provisioned accounts additionally show **Ready** and a labeled **Reset scenario & fill** action; provisioning failures retain an error and retry action.
- Account creation and snapshot review keep their save actions visible while fields scroll. **More options** in the account editor contains the optional username and password-generation rules.
- Snapshot refill retains its result beside the saved form, including an expandable list of unmatched fields after a partial refill. Editor feedback appears inside the panel so it does not cover save actions.
- Use the arrow keys, Home, or End to switch between Accounts and Forms with keyboard focus. Escape collapses the panel.

## How sites and environments work

A **site** is keyed by the page's address alone — hostname plus port, such as `localhost:3000` or `app.hikestrong.com`. Nothing about the browser-tab title is ever used, so the site never changes as you navigate around an app. You can rename a site in **Settings** (for example to `HikeStrong`); the name seeds generated emails and labels the panel.

Every credential also belongs to one of three **environments** — Local, Staging, or Production — because the same project usually has different accounts in each. The environment is detected from the hostname:

- **Local** — `localhost`, `127.0.0.1`, `[::1]`, `*.localhost`, `*.local`, `*.test`, and private IP ranges.
- **Staging** — a hostname segment like `staging`, `stage`, `preview`, `dev`, `test`, `qa`, `uat`, or `sandbox` (on a `.` or `-` boundary, so `backstage.com` is not staging).
- **Production** — everything else.

Detection only picks the default. The panel has an explicit Local / Staging / Production switch (the dot marks the detected one), and **Settings** can pin an address to a specific environment when detection guesses wrong.

By default each address is its own site. When one project spans several addresses — `localhost:3000`, `staging.hikestrong.com`, and `app.hikestrong.com` — open **Settings** on one of them and use **This address belongs to** to link it to the shared site. Its logins ride along, and every linked address then shows the same site with its own environment's credentials.

## Current functionality

- Generate a unique `@example.test` email and strong password for a chosen role. Per-site checkboxes control which symbols (`!@#$%`) generated passwords may contain, for password fields that reject certain characters — untick them all for alphanumeric-only passwords.
- Save a short name, role, and scenario note with each account, plus an optional username for sites that sign in with a username instead of an email — at least one of email or username is required. Username fields are filled with the stored username when set, falling back to the email (or its local part when the form also has an email field).
- Fill login and sign-up forms: full or first/last name, username, email, and every password field. Fields are matched by labels, placeholders, `autocomplete` attributes, and name/id hints, including inside open shadow DOM and same-origin iframes, and a toast confirms exactly which fields were filled.
- Snapshot longer forms and refill them in one click on the next debugging run. A snapshot captures every editable field on the page — text inputs, selects, checkboxes, radios, and textareas, including open shadow DOM and same-origin iframes — while email, username, password, payment, and one-time-code fields are never captured or refilled.
- Review a snapshot before saving: untick fields to exclude them from refill, edit or correct captured values, remove rows, and **Re-scan** the page to pick up fields the first capture missed (hand-edited values are kept). Refill matches fields by stable identity (id, name, label, placeholder, autocomplete) rather than position, and the saved form reports how many fields matched.
- Filter accounts for the current site and environment, or search across all sites.
- Delete an individual login from its edit screen, or delete a saved site and every login beneath it from **Settings → Saved sites**.
- Keep all extension state in `chrome.storage.local` on the current Chrome profile.
- Save from multiple open tabs without replacing another tab's accounts, snapshots, or settings. Edits to different fields are combined; conflicting edits to the same field keep the later draft open with an error so you can review the latest saved version.
- Tint the environment chip amber on staging and red on production as a reminder to use generated accounts only.
- Optionally connect a same-origin local or explicitly configured staging project adapter. The adapter advertises safe role/scenario metadata; **Provision & fill** creates the generated identity with that application-side state, and **Reset** restores it without resending credentials.

> Use generated test accounts only. Chrome extension local storage is device-local but is not a password vault for real credentials.

## Provisioned personas

Projects can opt into executable roles and scenarios without exposing their user database. Under **Site settings**, enter a same-origin adapter URL such as `/__test-users`. Test Users refuses adapter URLs on ordinary web origins, refuses cross-origin URLs, and requires HTTPS on staging. The project endpoint must independently enforce its own nonproduction boundary.

`GET /__test-users` advertises metadata only:

```json
{
  "schemaVersion": 1,
  "label": "HikeStrong fixtures",
  "roles": [
    { "id": "member", "label": "Member" },
    { "id": "org-admin", "label": "Admin" }
  ],
  "scenarios": [
    { "id": "standard", "label": "Standard account" },
    { "id": "empty-org", "label": "Empty organization" }
  ],
  "capabilities": { "provision": true, "reset": true }
}
```

Capability responses containing account, user, name, email, username, password, credential, token, secret, or session fields are rejected. The adapter chooses what states are supported; Test Users continues to generate and retain the actual name and credentials locally.

**Provision & fill** sends one explicit `POST` containing the extension-generated identity, selected role/scenario, and a stable idempotency key. A successful adapter response contains no identity or credentials:

```json
{
  "status": "ready",
  "accountRef": "acct_test_123",
  "stateLabel": "Admin · Empty organization",
  "expiresAt": "2026-08-24T12:00:00Z"
}
```

The opaque `accountRef` is stored with the local test-user card. **Reset** sends that reference, role, and scenario, but no name, email, username, or password. Projects should treat the provisioning request as idempotent and reject any non-test identity server-side.

### TU-3 provisioning lifecycle

The serialized storage writer owns provisioning transitions. Each attempt gets a unique request token and starts from the latest saved account. The panel's busy indicator tracks its local request; it does not decide whether a fixture is ready.

| Current state | Trigger and guard | Next state |
| --- | --- | --- |
| Unprovisioned, stale, failed, or pending | Provision/retry with the current same-origin adapter settings | Provisioning, with a new request token |
| Ready | Reset with an unexpired fixture and account reference | Resetting, with a new request token |
| Provisioning or resetting | Success/failure carrying the current token | Ready/failed |
| Any saved provisioning state | Identity, role, scenario, account environment, adapter URL, or adapter environment changes | Stale; pending token revoked |
| Deleted account, superseded attempt, or already settled attempt | Late or duplicate response | No change and no automatic fill |

Notes-only edits preserve the request. Changing relevant values back does not restore a revoked token. A retry from another tab or after a page reload replaces a pending attempt; its older response cannot overwrite the retry. Pending state does not permanently lock the account. A fill miss leaves successful provisioning ready.

Failure acknowledgements can arrive after the storage notification has already exposed Retry. A delayed acknowledgement must still match the current account's request token before showing its error; otherwise it could replace a newer retry's success feedback. The browser regression holds that acknowledgement until the retry finishes and then verifies the old error stays retired.

These guards control local readiness and autofill. They cannot undo work an adapter already performed; adapter requests remain idempotent under the account's stable idempotency key.

### TU-6 adapter connection lifecycle

Each overlay owns a transient connection for the current origin, effective environment, adapter URL, and saved settings revision. `transitionAdapterConnection` controls disabled/loading/ready/error states. Each check has a unique request token; only the pending check for the current saved configuration can install capabilities or report failure. Reloading discovers capabilities again from saved settings.

| Current state | Trigger and guard | Next state and behavior |
| --- | --- | --- |
| Initializing or any state | Startup or saved settings change with no adapter URL | Disabled; abort a superseded check and discard capabilities. |
| Initializing or any state | Startup, saved settings change, or **Save & check** with an adapter URL | Loading; clear previous capabilities and validate the saved endpoint before fetching metadata. Callers observing the same pending saved revision share its check. |
| Loading | Same-origin/environment validation fails | Error without issuing a capability request. Production remains blocked. |
| Loading | HTTP success, valid JSON, and valid credential-free metadata with the current token and configuration | Ready; advertise the returned roles, scenarios, provision support, and reset support. |
| Loading | HTTP, transport, JSON, size, or metadata validation fails for the current check | Error with no capabilities. The error stays visible in the panel and settings. |
| Ready, error, or loading | Save & check saves settings again | Check the saved revision, sharing a check already started by its storage notification. A replacement check retires the previous request. |
| Any state | Saved settings change in another tab | Reconcile the connection, discard the previous configuration's capabilities, and discover the current endpoint. |
| Disabled, superseded, settled, or destroyed owner | Late success or failure | Ignore it; it cannot restore retired capabilities or overwrite a newer result. |

Typing settings does not start discovery. **Save & check** persists the form before checking its saved URL. Capability responses update the connection status without replacing unsaved settings input or its conflict-detection base. Provisioning may await the current connection check, while TU-3 independently owns account readiness and rejects outdated provisioning responses.

The obsolete private `renderLoading` option and its loading/toast branches from the retired standalone Check action have been removed. Connection loading and settlement now use the same transition and rendering paths for startup, settings saves, and provisioning callers.

## Install

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this `test-users` folder.
5. Open a local or staging login page and click the **Test Users** toolbar icon.

Click the toolbar icon again to collapse the panel, or press **Escape** while the panel has focus.

The extension requests `activeTab`, `scripting`, and `storage`. It does not request permanent access to every website; the overlay is injected only after you click the toolbar icon.

## Local demo

```sh
npm run demo
```

Then open [http://127.0.0.1:4173/demo/login.html](http://127.0.0.1:4173/demo/login.html). The demo uses temporary sample users and does not write them to Chrome storage. Its safe example adapter is available at `/__test-users`; enter that path under **Site settings → Provisioning adapter** to try provision and reset. For the form-snapshot flow, open [http://127.0.0.1:4173/demo/profile.html](http://127.0.0.1:4173/demo/profile.html), fill a few fields, then select **Forms → Snapshot page**.

## Checks

```sh
npm run verify
```

For focused repeated provisioning, reset, and retry verification:

```sh
npm run test:provisioning
TEST_USERS_E2E_PROVISIONING_ROUNDS=10 npm run test:provisioning
```

The focused lane runs three rounds by default (configurable from 1 to 100), alternating reset and provisioning failures. Every round sends a successful provision, successful reset, forced failure, and retry, checking native requests, stable account references, readiness, and top-frame/iframe autofill. Fixture-only controls delay mutation replies while allowing storage events and newer actions to proceed. Tests await the real click handlers, reject unavailable action buttons, and include card state in timeout diagnostics.

The original audit's retry timeout was reproduced against its source revision by delaying a failed write's acknowledgement: the error was visible while Retry remained disabled, so the test's click was ignored. The enabled-action wait covers that timing window; delayed-reply coverage additionally protects the current implementation from obsolete failure feedback. Chrome profile cleanup uses bounded retries for transient directory-removal races.

The interface uses MIT-licensed Tabler Icons vendored into `icons/`. No dependency installation or build step is needed.

`npm run test:e2e` launches an isolated temporary Chrome profile, loads the unpacked extension, and verifies site recognition, credential generation, local persistence, and login autofill. Adapter checks cover startup loading, preserving unsaved settings, Save & check using the saved URL, HTTP/JSON/metadata failure recovery, and changing/disabling/blocking an adapter while discovery is pending. The suite also covers provision/reset/retry, stale provisioning responses, form snapshots, site linking, and concurrent saves. It does not modify your normal Chrome profile.
