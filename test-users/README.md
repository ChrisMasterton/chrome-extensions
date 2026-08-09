# Test Users

Test Users is a Manifest V3 Chrome extension for generating, organizing, and autofilling disposable local or staging accounts. Accounts are grouped by a site identity composed from the current address and a normalized browser-tab page name.

For example, a tab titled `Login — HikeStrong` at `http://localhost:3000/login` is stored as:

```text
localhost:3000 + HikeStrong
```

## Current functionality

- Generate a unique `@example.test` email and strong password for a chosen role.
- Save a short name, role, and scenario note with each account.
- Fill login and registration forms, including password-confirmation fields.
- Filter accounts for the current site or search across all projects.
- Correct the detected page name once when a local app uses a generic tab title.
- Delete an individual login from its edit screen, or delete a saved site identity and every login beneath it from **Settings → Saved sites**.
- Keep all extension state in `chrome.storage.local` on the current Chrome profile.

> Use generated test accounts only. Chrome extension local storage is device-local but is not a password vault for real credentials.

## Install

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this `test-users` folder.
5. Open a local or staging login page and click the **Test Users** toolbar icon.

The extension requests `activeTab`, `scripting`, and `storage`. It does not request permanent access to every website; the overlay is injected only after you click the toolbar icon.

## Local demo

```sh
npm run demo
```

Then open [http://127.0.0.1:4173/demo/login.html](http://127.0.0.1:4173/demo/login.html). The demo uses temporary sample users and does not write them to Chrome storage.

## Checks

```sh
npm install
npm run verify
```

The interface uses the MIT-licensed Tabler Icons package. The required SVGs are vendored into `icons/` so the unpacked extension works without a build step.

`npm run test:e2e` launches an isolated temporary Chrome profile, loads the unpacked extension, and verifies site recognition, credential generation, local persistence, and login autofill. It does not modify your normal Chrome profile.
