# Test Users

Test Users is a Manifest V3 Chrome extension for generating, organizing, and autofilling disposable local or staging accounts. Accounts are grouped by a site identity composed from the current address and a normalized browser-tab page name.

For example, a tab titled `Login — HikeStrong` at `http://localhost:3000/login` is stored as:

```text
localhost:3000 + HikeStrong
```

## Current functionality

- Generate a unique `@example.test` email and strong password for a chosen role. Per-site checkboxes control which symbols (`!@#$%`) generated passwords may contain, for password fields that reject certain characters — untick them all for alphanumeric-only passwords.
- Save a short name, role, and scenario note with each account, plus an optional username for sites that sign in with a username instead of an email — at least one of email or username is required. Username fields are filled with the stored username when set, falling back to the email (or its local part when the form also has an email field).
- Fill login and sign-up forms: full or first/last name, username, email, and every password field. Fields are matched by labels, placeholders, `autocomplete` attributes, and name/id hints, including inside open shadow DOM and same-origin iframes, and a toast confirms exactly which fields were filled.
- Snapshot longer forms and refill them in one click on the next debugging run. A snapshot captures every editable field on the page — text inputs, selects, checkboxes, radios, and textareas, including open shadow DOM and same-origin iframes — while email, username, password, payment, and one-time-code fields are never captured or refilled.
- Review a snapshot before saving: untick fields to exclude them from refill, edit or correct captured values, remove rows, and **Re-scan** the page to pick up fields the first capture missed (hand-edited values are kept). Refill matches fields by stable identity (id, name, label, placeholder, autocomplete) rather than position, and the toast reports how many fields matched.
- Filter accounts for the current site or search across all sites.
- Correct the detected page name once when a local app uses a generic tab title.
- Delete an individual login from its edit screen, or delete a saved site identity and every login beneath it from **Settings → Saved sites**.
- Keep all extension state in `chrome.storage.local` on the current Chrome profile.
- Tint the environment chip amber on staging hosts and red on real websites as a reminder to use generated accounts only.
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

Then open [http://127.0.0.1:4173/demo/login.html](http://127.0.0.1:4173/demo/login.html). The demo uses temporary sample users and does not write them to Chrome storage. Its safe example adapter is available at `/__test-users`; enter that path under **Site settings → Provisioning adapter** to try provision and reset. For the form-snapshot flow, open [http://127.0.0.1:4173/demo/profile.html](http://127.0.0.1:4173/demo/profile.html), fill a few fields, and click **Snapshot page**.

## Checks

```sh
npm install
npm run verify
```

The interface uses the MIT-licensed Tabler Icons package. The required SVGs are vendored into `icons/` so the unpacked extension works without a build step.

`npm run test:e2e` launches an isolated temporary Chrome profile, loads the unpacked extension, and verifies site recognition, credential generation, local persistence, and login autofill. It does not modify your normal Chrome profile.
