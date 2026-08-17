#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = resolve(TEST_DIR, '..');
const RUNTIME_PAGE = '/demo/runtime-login.html';

function log(message) {
  console.log(`[test-users-e2e] ${message}`);
}

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function getFreePort() {
  const server = createNetServer();
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const port = server.address().port;
  await new Promise((resolveClose) => server.close(resolveClose));
  return port;
}

function contentType(pathname) {
  switch (extname(pathname)) {
    case '.html':
      return 'text/html; charset=utf-8';
    case '.css':
      return 'text/css; charset=utf-8';
    case '.js':
      return 'text/javascript; charset=utf-8';
    case '.svg':
      return 'image/svg+xml';
    case '.png':
      return 'image/png';
    default:
      return 'application/octet-stream';
  }
}

async function startStaticServer() {
  const port = await getFreePort();
  const server = createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url || '/', `http://127.0.0.1:${port}`);
      const pathname = requestUrl.pathname === '/' ? RUNTIME_PAGE : requestUrl.pathname;
      const requestedPath = resolve(PROJECT_DIR, `.${decodeURIComponent(pathname)}`);

      if (!requestedPath.startsWith(PROJECT_DIR)) {
        response.writeHead(403);
        response.end('Forbidden');
        return;
      }

      const body = await readFile(requestedPath);
      response.writeHead(200, { 'content-type': contentType(pathname) });
      response.end(body);
    } catch (error) {
      response.writeHead(500);
      response.end(error?.message || 'Static server error');
    }
  });

  await new Promise((resolveListen) => server.listen(port, '127.0.0.1', resolveListen));
  return {
    port,
    close: () => new Promise((resolveClose) => server.close(resolveClose)),
  };
}

async function prepareTestExtension(destination, pagePort) {
  await cp(PROJECT_DIR, destination, {
    recursive: true,
    filter: (source) => !source.includes('/node_modules') && !source.includes('/design'),
  });

  const manifestPath = join(destination, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.name = `${manifest.name} E2E`;
  manifest.host_permissions = [`http://127.0.0.1:${pagePort}/*`];
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

async function stopProcess(child, signal = 'SIGTERM') {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;

  const exited = once(child, 'exit').then(() => true);
  child.kill(signal);
  const didExit = await Promise.race([
    exited,
    new Promise((resolveTimeout) => setTimeout(() => resolveTimeout(false), 1500)),
  ]);

  if (!didExit && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    await Promise.race([
      once(child, 'exit'),
      new Promise((resolveTimeout) => setTimeout(resolveTimeout, 1500)),
    ]);
  }
}

class PipeCdpClient {
  constructor(input, output) {
    this.input = input;
    this.output = output;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = Buffer.alloc(0);

    output.on('data', (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      let delimiterIndex = this.buffer.indexOf(0);

      while (delimiterIndex !== -1) {
        const rawMessage = this.buffer.subarray(0, delimiterIndex).toString('utf8');
        this.buffer = this.buffer.subarray(delimiterIndex + 1);
        delimiterIndex = this.buffer.indexOf(0);
        if (!rawMessage) continue;

        const message = JSON.parse(rawMessage);
        if (!message.id) continue;
        const pending = this.pending.get(message.id);
        if (!pending) continue;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result);
      }
    });
  }

  send(method, params = {}, sessionId = null) {
    const id = this.nextId++;
    const promise = new Promise((resolvePromise, rejectPromise) => {
      this.pending.set(id, { resolve: resolvePromise, reject: rejectPromise });
    });
    this.input.write(
      `${JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })}\0`
    );
    return promise;
  }

  async evaluate(expression, sessionId = null) {
    const result = await this.send(
      'Runtime.evaluate',
      { expression, awaitPromise: true, returnByValue: true, timeout: 10000 },
      sessionId
    );
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || 'Runtime evaluation failed');
    }
    return result.result?.value;
  }

  close() {
    this.input.destroy();
    this.output.destroy();
  }
}

async function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (await pathExists(candidate)) return candidate;
  }
  throw new Error('Chrome or Chromium was not found. Set CHROME_PATH to its executable.');
}

async function startChrome(browserPath, profileDir, pageUrl) {
  const args = [
    `--user-data-dir=${profileDir}`,
    '--remote-debugging-pipe',
    '--enable-unsafe-extension-debugging',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-sync',
    '--disable-popup-blocking',
    '--headless=new',
    '--window-size=1280,900',
    pageUrl,
  ];
  const child = spawn(browserPath, args, {
    stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'],
  });
  const output = [];
  child.stdout.on('data', (chunk) => output.push(chunk.toString()));
  child.stderr.on('data', (chunk) => output.push(chunk.toString()));
  const cdp = new PipeCdpClient(child.stdio[3], child.stdio[4]);

  try {
    await Promise.race([
      cdp.send('Browser.getVersion'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Chrome CDP timeout')), 10000)),
    ]);
  } catch (error) {
    error.message = `${error.message}\n${output.join('')}`;
    throw error;
  }

  return {
    cdp,
    close: async () => {
      cdp.close();
      await stopProcess(child);
    },
  };
}

async function listTargets(cdp, filter) {
  const result = await cdp.send('Target.getTargets', filter ? { filter } : {});
  return result.targetInfos || [];
}

async function waitForTarget(cdp, predicate, label, filter) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 10000) {
    const target = (await listTargets(cdp, filter)).find(predicate);
    if (target) return target;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function attachTarget(cdp, target) {
  const { sessionId } = await cdp.send('Target.attachToTarget', {
    targetId: target.targetId,
    flatten: true,
  });
  await cdp.send('Runtime.enable', {}, sessionId);
  return {
    evaluate: (expression) => cdp.evaluate(expression, sessionId),
  };
}

async function waitForCondition(client, expression, label) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 10000) {
    if (await client.evaluate(expression)) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function run() {
  const tempRoot = await mkdtemp(join(tmpdir(), 'test-users-e2e-'));
  const profileDir = join(tempRoot, 'chrome-profile');
  const extensionDir = join(tempRoot, 'extension');
  const staticServer = await startStaticServer();
  const pageUrl = `http://127.0.0.1:${staticServer.port}${RUNTIME_PAGE}`;
  let browser = null;

  try {
    await prepareTestExtension(extensionDir, staticServer.port);
    const browserPath = await findChrome();
    log('launching isolated Chrome profile');
    browser = await startChrome(browserPath, profileDir, pageUrl);

    const extension = await browser.cdp.send('Extensions.loadUnpacked', {
      path: extensionDir,
    });
    assert.ok(extension.id, 'Chrome should load the unpacked extension');

    const extensions = await browser.cdp.send('Extensions.getExtensions');
    assert.ok(
      extensions.extensions?.some(
        (candidate) =>
          candidate.id === extension.id && candidate.name === 'Test Users E2E' && candidate.enabled
      ),
      'Test Users should be enabled in the isolated profile'
    );

    const pageTarget = await waitForTarget(
      browser.cdp,
      (target) => target.type === 'page' && target.url.includes(RUNTIME_PAGE),
      'runtime login page'
    );
    const page = await attachTarget(browser.cdp, pageTarget);
    const workerTarget = await waitForTarget(
      browser.cdp,
      (target) =>
        target.type === 'service_worker' &&
        target.url === `chrome-extension://${extension.id}/background.js`,
      'extension service worker',
      [{ type: 'service_worker', exclude: false }]
    );
    const worker = await attachTarget(browser.cdp, workerTarget);

    await waitForCondition(page, 'document.readyState === "complete"', 'page readiness');
    log('injecting the action overlay');
    await worker.evaluate(`(async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) throw new Error('Runtime tab not found');
      await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        files: ['core.js', 'content.js']
      });
      return tab.id;
    })()`);

    const shadowRootExpression = `document.querySelector('#test-users-extension-root')?.shadowRoot`;
    await waitForCondition(
      page,
      `!!${shadowRootExpression}?.querySelector('.tu-panel')`,
      'extension overlay'
    );

    const identity = await page.evaluate(`(() => {
      const root = ${shadowRootExpression};
      return {
        project: root.querySelector('.tu-site-identity strong').textContent,
        origin: root.querySelector('.tu-site-origin').textContent,
        environment: root.querySelector('.tu-environment').textContent,
        environmentClass: root.querySelector('.tu-environment').className,
      };
    })()`);
    assert.equal(identity.project, 'HikeStrong');
    assert.match(identity.origin, /^127\.0\.0\.1:\d+$/);
    assert.equal(identity.environment, 'LOCAL');
    assert.match(identity.environmentClass, /tu-environment--local/);

    await page.evaluate(`${shadowRootExpression}.querySelector('[data-action="new-user"]').click()`);
    await waitForCondition(
      page,
      `!!${shadowRootExpression}.querySelector('input[name="email"]')`,
      'credential editor'
    );

    const generated = await page.evaluate(`(() => {
      const root = ${shadowRootExpression};
      return {
        name: root.querySelector('.tu-form input[name="name"]').value,
        email: root.querySelector('input[name="email"]').value,
        password: root.querySelector('input[name="password"]').value,
      };
    })()`);
    assert.match(generated.email, /^hikestrong\.member\.[a-z0-9]{6}@example\.test$/);
    assert.equal(generated.password.length, 16);
    assert.equal(generated.name, 'Member Tester');

    await page.evaluate(`(() => {
      const root = ${shadowRootExpression};
      const notes = root.querySelector('textarea[name="notes"]');
      notes.value = 'Browser smoke scenario';
      notes.dispatchEvent(new Event('input', { bubbles: true }));
      root.querySelector('button[type="submit"]').click();
    })()`);

    await waitForCondition(
      page,
      `document.querySelector('input[type="email"]').value === ${JSON.stringify(generated.email)}`,
      'email autofill'
    );
    const filledForm = await page.evaluate(`(() => ({
      name: document.querySelector('input[name="name"]').value,
      passwords: [...document.querySelectorAll('input[type="password"]')].map(
        (input) => input.value
      ),
    }))()`);
    assert.equal(filledForm.name, generated.name, 'label-only name field should be autofilled');
    assert.deepEqual(
      filledForm.passwords,
      [generated.password, generated.password],
      'both password fields should be autofilled'
    );

    await waitForCondition(
      page,
      `document.querySelector('iframe').contentDocument.querySelector('input[type="email"]').value === ${JSON.stringify(
        generated.email
      )}`,
      'same-origin iframe autofill'
    );
    const filledFrame = await page.evaluate(`(() => {
      const frameDocument = document.querySelector('iframe').contentDocument;
      return {
        email: frameDocument.querySelector('input[type="email"]').value,
        password: frameDocument.querySelector('input[type="password"]').value,
      };
    })()`);
    assert.equal(filledFrame.email, generated.email, 'iframe email should be autofilled');
    assert.equal(filledFrame.password, generated.password, 'iframe password should be autofilled');

    const stored = await worker.evaluate(`(async () => {
      const result = await chrome.storage.local.get('testUsersStateV1');
      return result.testUsersStateV1;
    })()`);
    assert.equal(stored.users.length, 1);
    assert.equal(stored.users[0].siteLabel, 'HikeStrong');
    assert.equal(stored.users[0].notes, 'Browser smoke scenario');
    assert.match(stored.users[0].siteKey, /^local:127\.0\.0\.1:\d+:hikestrong$/);

    await page.evaluate(`(() => {
      const search = ${shadowRootExpression}.querySelector('[data-input="search"]');
      search.focus();
      search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    })()`);
    await waitForCondition(
      page,
      `!${shadowRootExpression}.querySelector('.tu-panel') && !!${shadowRootExpression}.querySelector('.tu-launcher')`,
      'escape collapsing the panel'
    );
    await page.evaluate(`${shadowRootExpression}.querySelector('.tu-launcher').click()`);
    await waitForCondition(
      page,
      `!!${shadowRootExpression}.querySelector('.tu-panel')`,
      'launcher reopening the panel'
    );

    await page.evaluate(`${shadowRootExpression}.querySelector('[data-action="edit"]').click()`);
    await waitForCondition(
      page,
      `!!${shadowRootExpression}.querySelector('[data-action="delete"]')`,
      'individual login editor'
    );
    await page.evaluate(`${shadowRootExpression}.querySelector('[data-action="delete"]').click()`);
    const userDeleteConfirmation = await page.evaluate(
      `${shadowRootExpression}.querySelector('.tu-inline-delete-confirm').textContent`
    );
    assert.match(userDeleteConfirmation, /removes only this saved login/i);
    assert.match(userDeleteConfirmation, /other logins are unaffected/i);
    await page.evaluate(
      `${shadowRootExpression}.querySelector('[data-action="confirm-delete-user"]').click()`
    );
    await waitForCondition(
      page,
      `!!${shadowRootExpression}.querySelector('.tu-empty-state')`,
      'individual login deletion'
    );
    const storedAfterLoginDelete = await worker.evaluate(`(async () => {
      const result = await chrome.storage.local.get('testUsersStateV1');
      return result.testUsersStateV1;
    })()`);
    assert.deepEqual(storedAfterLoginDelete.users, []);

    await page.evaluate(`${shadowRootExpression}.querySelector('[data-action="new-user"]').click()`);
    await waitForCondition(
      page,
      `!!${shadowRootExpression}.querySelector('input[name="email"]')`,
      'replacement credential editor'
    );
    await page.evaluate(`(() => {
      const root = ${shadowRootExpression};
      root.querySelector('textarea[name="notes"]').value = 'Whole-site deletion scenario';
      root.querySelector('button[type="submit"]').click();
    })()`);
    await waitForCondition(
      page,
      `!!${shadowRootExpression}.querySelector('.tu-user-card')`,
      'replacement login save'
    );

    await page.evaluate(
      `${shadowRootExpression}.querySelector('[data-action="settings"]').click()`
    );
    await waitForCondition(
      page,
      `!!${shadowRootExpression}.querySelector('[data-action="delete-site"]')`,
      'saved site management'
    );
    const savedSiteSummary = await page.evaluate(
      `${shadowRootExpression}.querySelector('.tu-saved-site-copy').textContent`
    );
    assert.match(savedSiteSummary, /HikeStrong/);
    assert.match(savedSiteSummary, /1 login/);

    await page.evaluate(
      `${shadowRootExpression}.querySelector('[data-action="delete-site"]').click()`
    );
    const confirmationText = await page.evaluate(
      `${shadowRootExpression}.querySelector('.tu-site-delete-copy').textContent`
    );
    assert.match(confirmationText, /Delete HikeStrong/);
    assert.match(confirmationText, /Other projects are unaffected/);
    await page.evaluate(
      `${shadowRootExpression}.querySelector('[data-action="confirm-delete-site"]').click()`
    );
    await waitForCondition(
      page,
      `${shadowRootExpression}.querySelector('.tu-manage-sites-heading p').textContent.includes('No saved site identities')`,
      'site deletion'
    );

    const storedAfterSiteDelete = await worker.evaluate(`(async () => {
      const result = await chrome.storage.local.get('testUsersStateV1');
      return result.testUsersStateV1;
    })()`);
    assert.deepEqual(storedAfterSiteDelete.users, []);
    assert.deepEqual(storedAfterSiteDelete.siteProfiles, {});

    log('navigating to the profile form page for the snapshot scenario');
    await page.evaluate(`location.assign('/demo/runtime-profile.html')`);
    await waitForCondition(
      page,
      `location.pathname === '/demo/runtime-profile.html' && document.readyState === 'complete'`,
      'profile page load'
    );
    await worker.evaluate(`(async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) throw new Error('Profile tab not found');
      await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        files: ['core.js', 'content.js']
      });
      return tab.id;
    })()`);
    await waitForCondition(
      page,
      `!!${shadowRootExpression}?.querySelector('.tu-panel')`,
      'overlay on the profile page'
    );

    log('filling the long form and capturing a snapshot');
    await page.evaluate(`(() => {
      const set = (selector, value) => {
        const element = document.querySelector(selector);
        element.value = value;
        element.dispatchEvent(new Event('input', { bubbles: true }));
      };
      set('input[name="first_name"]', 'Ava');
      set('input[name="last_name"]', 'Tester');
      set('input[name="company"]', 'HikeStrong QA');
      set('input[name="phone"]', '555-0100');
      set('input[name="address_line1"]', '1 Trail Way');
      set('input[name="city"]', 'Boulder');
      set('input[name="zip"]', '80301');
      set('input[name="email"]', 'real.person@example.com');
      set('input[name="password"]', 'SuperSecret1!');
      set('input[name="card_number"]', '4111111111111111');
      set('input[name="promo_code"]', 'SAVE20');
      set('textarea[name="bio"]', 'Debugging run notes.');
      document.querySelector('select[name="country"]').value = 'US';
      document.querySelector('input[name="plan"][value="pro"]').checked = true;
      document.querySelector('input[name="newsletter"]').checked = true;
    })()`);
    await page.evaluate(
      `${shadowRootExpression}.querySelector('[data-action="new-snapshot"]').click()`
    );
    await waitForCondition(
      page,
      `!!${shadowRootExpression}.querySelector('[data-form="snapshot"]')`,
      'snapshot editor'
    );

    const snapshotRows = await page.evaluate(`(() => {
      const root = ${shadowRootExpression};
      return [...root.querySelectorAll('.tu-snapshot-field')].map((row) => ({
        label: row.querySelector('.tu-snapshot-field-label').textContent,
        included: row.querySelector('[data-snapshot-include]').checked,
      }));
    })()`);
    for (const expected of [/company/i, /city/i, /country/i, /plan/i, /newsletter|trail/i, /bio/i]) {
      assert.ok(
        snapshotRows.some((row) => expected.test(row.label)),
        `snapshot should capture a field matching ${expected}`
      );
    }
    assert.ok(
      snapshotRows.every((row) => !/email|password|card|promo/i.test(row.label)),
      'credential, payment, and promo fields must never be captured'
    );

    log('excluding the phone field and editing the company value');
    await page.evaluate(`(() => {
      const root = ${shadowRootExpression};
      const rows = [...root.querySelectorAll('.tu-snapshot-field')];
      const phoneRow = rows.find((row) =>
        /phone/i.test(row.querySelector('.tu-snapshot-field-label').textContent)
      );
      phoneRow.querySelector('[data-snapshot-include]').click();
    })()`);
    await page.evaluate(`(() => {
      const root = ${shadowRootExpression};
      const rows = [...root.querySelectorAll('.tu-snapshot-field')];
      const companyRow = rows.find((row) =>
        /company/i.test(row.querySelector('.tu-snapshot-field-label').textContent)
      );
      const input = companyRow.querySelector('[data-snapshot-value]');
      input.value = 'HikeStrong QA West';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      root.querySelector('[data-form="snapshot"] button[type="submit"]').click();
    })()`);
    await waitForCondition(
      page,
      `!!${shadowRootExpression}.querySelector('.tu-snapshot-card')`,
      'saved snapshot card'
    );

    log('clearing the form and refilling from the snapshot');
    await page.evaluate(`(() => {
      document.querySelectorAll('form input, form textarea').forEach((element) => {
        if (element.type === 'checkbox' || element.type === 'radio') element.checked = false;
        else element.value = '';
      });
      document.querySelector('select[name="country"]').value = '';
    })()`);
    await page.evaluate(
      `${shadowRootExpression}.querySelector('[data-action="refill-snapshot"]').click()`
    );
    await waitForCondition(
      page,
      `document.querySelector('input[name="company"]').value === 'HikeStrong QA West'`,
      'snapshot refill'
    );
    const refilled = await page.evaluate(`(() => ({
      firstName: document.querySelector('input[name="first_name"]').value,
      lastName: document.querySelector('input[name="last_name"]').value,
      company: document.querySelector('input[name="company"]').value,
      phone: document.querySelector('input[name="phone"]').value,
      address: document.querySelector('input[name="address_line1"]').value,
      city: document.querySelector('input[name="city"]').value,
      zip: document.querySelector('input[name="zip"]').value,
      email: document.querySelector('input[name="email"]').value,
      password: document.querySelector('input[name="password"]').value,
      cardNumber: document.querySelector('input[name="card_number"]').value,
      promoCode: document.querySelector('input[name="promo_code"]').value,
      country: document.querySelector('select[name="country"]').value,
      plan: document.querySelector('input[name="plan"]:checked')?.value || null,
      newsletter: document.querySelector('input[name="newsletter"]').checked,
      bio: document.querySelector('textarea[name="bio"]').value,
    }))()`);
    assert.equal(refilled.firstName, 'Ava');
    assert.equal(refilled.lastName, 'Tester');
    assert.equal(refilled.company, 'HikeStrong QA West', 'edited value should win over capture');
    assert.equal(refilled.address, '1 Trail Way');
    assert.equal(refilled.city, 'Boulder');
    assert.equal(refilled.zip, '80301');
    assert.equal(refilled.country, 'US');
    assert.equal(refilled.plan, 'pro');
    assert.equal(refilled.newsletter, true);
    assert.equal(refilled.bio, 'Debugging run notes.');
    assert.equal(refilled.phone, '', 'excluded field must stay empty');
    assert.equal(refilled.email, '', 'email must never be refilled');
    assert.equal(refilled.password, '', 'password must never be refilled');
    assert.equal(refilled.cardNumber, '', 'card number must never be refilled');
    assert.equal(refilled.promoCode, '', 'promo code must never be refilled');

    const storedSnapshots = await worker.evaluate(`(async () => {
      const result = await chrome.storage.local.get('testUsersStateV1');
      return result.testUsersStateV1.snapshots;
    })()`);
    assert.equal(storedSnapshots.length, 1);
    assert.equal(storedSnapshots[0].name, 'Runtime profile form');
    assert.equal(storedSnapshots[0].path, '/demo/runtime-profile.html');
    assert.ok(
      storedSnapshots[0].fields.every(
        (field) => !/password|SuperSecret|4111|SAVE20|real\.person/.test(JSON.stringify(field))
      ),
      'stored snapshot must not contain credential, card, or promo values'
    );

    log(
      'passed: load, recognize, generate, save, autofill top frame and iframe, escape to close, delete login, delete site, and snapshot capture/exclude/edit/refill'
    );
  } finally {
    await browser?.close();
    await staticServer.close();
    await rm(tempRoot, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
