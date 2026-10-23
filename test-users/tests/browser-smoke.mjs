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
  const adapterState = {
    capabilityRequests: 0,
    provisionRequests: [],
    resetRequests: [],
    accountRefsByKey: new Map(),
  };
  const server = createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url || '/', `http://127.0.0.1:${port}`);
      if (requestUrl.pathname === '/__test-users') {
        response.setHeader('content-type', 'application/json; charset=utf-8');
        if (request.method === 'GET') {
          adapterState.capabilityRequests += 1;
          response.writeHead(200);
          response.end(
            JSON.stringify({
              schemaVersion: 1,
              label: 'HikeStrong fixtures',
              roles: [
                { id: 'member', label: 'Member' },
                { id: 'org-admin', label: 'Admin' },
              ],
              scenarios: [
                { id: 'standard', label: 'Standard account' },
                { id: 'empty-org', label: 'Empty organization' },
              ],
              capabilities: { provision: true, reset: true },
            })
          );
          return;
        }

        if (request.method === 'POST') {
          let rawBody = '';
          for await (const chunk of request) {
            rawBody += chunk;
            if (rawBody.length > 65536) throw new Error('Adapter request too large');
          }
          const payload = JSON.parse(rawBody);
          const stateLabel = `${payload.role?.label || 'User'} · ${
            payload.scenario?.label || 'Default state'
          }`;

          if (payload.operation === 'provision') {
            if (!payload.identity?.password || !payload.identity?.email) {
              response.writeHead(400);
              response.end(JSON.stringify({ error: 'Generated identity required' }));
              return;
            }
            const accountRef =
              adapterState.accountRefsByKey.get(payload.idempotencyKey) ||
              `acct_${adapterState.accountRefsByKey.size + 1}`;
            adapterState.accountRefsByKey.set(payload.idempotencyKey, accountRef);
            adapterState.provisionRequests.push(payload);
            response.writeHead(200);
            response.end(JSON.stringify({ status: 'ready', accountRef, stateLabel }));
            return;
          }

          if (payload.operation === 'reset' && payload.accountRef) {
            adapterState.resetRequests.push(payload);
            response.writeHead(200);
            response.end(
              JSON.stringify({ status: 'ready', accountRef: payload.accountRef, stateLabel })
            );
            return;
          }

          response.writeHead(400);
          response.end(JSON.stringify({ error: 'Unsupported adapter operation' }));
          return;
        }

        response.writeHead(405);
        response.end(JSON.stringify({ error: 'Method not allowed' }));
        return;
      }

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
    adapterState,
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
    assert.match(identity.project, /^127\.0\.0\.1:\d+$/, 'a new site is named after its address');
    assert.match(identity.origin, /^127\.0\.0\.1:\d+$/);
    assert.equal(identity.environment, 'LOCAL');
    assert.match(identity.environmentClass, /tu-environment--local/);

    const environmentSwitch = await page.evaluate(`(() => {
      const root = ${shadowRootExpression};
      return {
        segments: [...root.querySelectorAll('.tu-env-segment')].map((segment) => segment.dataset.env),
        active: root.querySelector('.tu-env-segment.is-active')?.dataset.env,
        detected: root.querySelector('.tu-env-dot')?.closest('.tu-env-segment')?.dataset.env,
      };
    })()`);
    assert.deepEqual(environmentSwitch.segments, ['local', 'staging', 'production']);
    assert.equal(environmentSwitch.active, 'local', 'the detected environment starts selected');
    assert.equal(environmentSwitch.detected, 'local', 'the detected environment carries the dot');

    log('naming the site and configuring the same-origin provisioning adapter');
    await page.evaluate(`${shadowRootExpression}.querySelector('[data-action="settings"]').click()`);
    await waitForCondition(
      page,
      `!!${shadowRootExpression}.querySelector('input[name="adapterUrl"]')`,
      'adapter site setting'
    );
    const correctedAdapterIsValid = await page.evaluate(`(() => {
      const root = ${shadowRootExpression};
      const form = root.querySelector('[data-form="settings"]');
      form.elements.adapterUrl.value = 'https://other.example.test/__test-users';
      form.requestSubmit();
      const rejected = form.elements.adapterUrl.validity.customError;
      form.elements.adapterUrl.value = '/__test-users';
      form.elements.adapterUrl.dispatchEvent(new Event('input', { bubbles: true }));
      return { rejected, corrected: form.checkValidity() };
    })()`);
    assert.equal(correctedAdapterIsValid.rejected, true, 'cross-origin adapters must be rejected');
    assert.equal(correctedAdapterIsValid.corrected, true, 'correcting the adapter URL must allow resubmission');
    await page.evaluate(`(() => {
      const root = ${shadowRootExpression};
      root.querySelector('input[name="siteName"]').value = 'HikeStrong';
      root.querySelector('input[name="adapterUrl"]').value = '/__test-users';
      root.querySelector('[data-form="settings"]').requestSubmit();
    })()`);
    await waitForCondition(
      page,
      `!!${shadowRootExpression}.querySelector('[data-action="new-user"]')`,
      'settings save'
    );
    const renamedProject = await page.evaluate(
      `${shadowRootExpression}.querySelector('.tu-site-identity strong').textContent`
    );
    assert.equal(renamedProject, 'HikeStrong', 'the header shows the renamed site');
    await page.evaluate(`${shadowRootExpression}.querySelector('[data-action="settings"]').click()`);
    await waitForCondition(
      page,
      `!!${shadowRootExpression}.querySelector('.tu-adapter-status--ready')`,
      'adapter capability discovery'
    );
    const adapterSummary = await page.evaluate(
      `${shadowRootExpression}.querySelector('.tu-adapter-status').textContent`
    );
    assert.match(adapterSummary, /HikeStrong fixtures/);
    assert.match(adapterSummary, /2 roles/);
    assert.match(adapterSummary, /2 scenarios/);
    const adapterSettingsActions = await page.evaluate(`(() => {
      const root = ${shadowRootExpression};
      return {
        hasMisleadingCheck: Boolean(root.querySelector('[data-action="refresh-adapter"]')),
        submitLabel: root.querySelector('[data-form="settings"] button[type="submit"]')?.textContent.trim(),
      };
    })()`);
    assert.equal(
      adapterSettingsActions.hasMisleadingCheck,
      false,
      'settings must not check and restore the previously saved adapter URL'
    );
    assert.equal(adapterSettingsActions.submitLabel, 'Save & check');
    assert.ok(staticServer.adapterState.capabilityRequests >= 1);
    await page.evaluate(`${shadowRootExpression}.querySelector('[data-action="back"]').click()`);

    await page.evaluate(`${shadowRootExpression}.querySelector('[data-action="new-user"]').click()`);
    await waitForCondition(
      page,
      `!!${shadowRootExpression}.querySelector('input[name="email"]')`,
      'credential editor'
    );

    const adapterOptions = await page.evaluate(`(() => {
      const root = ${shadowRootExpression};
      return {
        roles: [...root.querySelectorAll('select[name="role"] option')].map((option) => ({
          value: option.value,
          label: option.textContent,
        })),
        scenarios: [...root.querySelectorAll('select[name="scenario"] option')].map((option) => ({
          value: option.value,
          label: option.textContent,
        })),
      };
    })()`);
    assert.deepEqual(adapterOptions.roles, [
      { value: 'member', label: 'Member' },
      { value: 'org-admin', label: 'Admin' },
    ]);
    assert.ok(
      adapterOptions.scenarios.some(
        (scenario) => scenario.value === 'empty-org' && scenario.label === 'Empty organization'
      )
    );

    await page.evaluate(`(() => {
      const root = ${shadowRootExpression};
      root.querySelector('select[name="role"]').value = 'org-admin';
      root.querySelector('select[name="scenario"]').value = 'empty-org';
      root.querySelector('[data-action="regenerate"]').click();
    })()`);

    const generated = await page.evaluate(`(() => {
      const root = ${shadowRootExpression};
      return {
        name: root.querySelector('.tu-form input[name="name"]').value,
        email: root.querySelector('input[name="email"]').value,
        password: root.querySelector('input[name="password"]').value,
      };
    })()`);
    assert.match(generated.email, /^hikestrong\.admin\.[a-z0-9]{6}@example\.test$/);
    assert.equal(generated.password.length, 16);
    assert.equal(generated.name, 'Admin Tester');

    log('correcting a rejected save with an email, username, or regenerated identity');
    for (const identifier of ['email', 'username', 'regenerate']) {
      const validity = await page.evaluate(`(() => {
        const root = ${shadowRootExpression};
        const form = root.querySelector('[data-form="user"]');
        for (const name of ['email', 'username']) {
          form.elements[name].value = '';
          form.elements[name].dispatchEvent(new Event('input', { bubbles: true }));
        }
        form.requestSubmit();
        const rejected = form.elements.email.validity.customError;
        if (${JSON.stringify(identifier)} === 'regenerate') {
          root.querySelector('[data-action="regenerate"]').click();
        } else {
          const input = form.elements[${JSON.stringify(identifier)}];
          input.value = ${JSON.stringify(identifier === 'email' ? generated.email : 'admin-smoke')};
          input.dispatchEvent(new Event('input', { bubbles: true }));
        }
        return { rejected, corrected: form.checkValidity() };
      })()`);
      assert.equal(validity.rejected, true, 'saving without either identifier must be rejected');
      assert.equal(validity.corrected, true, `${identifier} correction must allow resubmission`);
    }

    await page.evaluate(`(() => {
      const root = ${shadowRootExpression};
      root.querySelector('input[name="email"]').value = ${JSON.stringify(generated.email)};
      root.querySelector('input[name="email"]').dispatchEvent(new Event('input', { bubbles: true }));
      root.querySelector('input[name="username"]').value = '';
      root.querySelector('input[name="username"]').dispatchEvent(new Event('input', { bubbles: true }));
      root.querySelector('input[name="password"]').value = ${JSON.stringify(generated.password)};
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
    await waitForCondition(
      page,
      `!!${shadowRootExpression}.querySelector('.tu-provisioning-status--ready')`,
      'provisioning completion'
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
    assert.equal(stored.version, 2);
    assert.equal(stored.users.length, 1);
    assert.match(stored.users[0].siteId, /^site:127\.0\.0\.1:\d+$/);
    assert.equal(stored.users[0].environment, 'local');
    assert.equal(stored.sites[stored.users[0].siteId].name, 'HikeStrong');
    assert.equal(stored.users[0].notes, 'Browser smoke scenario');
    assert.equal(stored.users[0].role, 'Admin');
    assert.equal(stored.users[0].roleId, 'org-admin');
    assert.equal(stored.users[0].scenarioId, 'empty-org');
    assert.equal(stored.users[0].scenarioLabel, 'Empty organization');
    assert.equal(stored.users[0].provisioning.status, 'ready');
    assert.equal(stored.users[0].provisioning.accountRef, 'acct_1');
    assert.equal('password' in stored.users[0].provisioning, false);
    assert.equal(staticServer.adapterState.provisionRequests.length, 1);
    assert.equal(staticServer.adapterState.provisionRequests[0].identity.name, generated.name);
    assert.equal(staticServer.adapterState.provisionRequests[0].identity.email, generated.email);
    assert.equal(staticServer.adapterState.provisionRequests[0].identity.password, generated.password);
    assert.equal(staticServer.adapterState.provisionRequests[0].role.id, 'org-admin');
    assert.equal(staticServer.adapterState.provisionRequests[0].scenario.id, 'empty-org');

    log('resetting the provisioned scenario without resending credentials');
    await page.evaluate(`${shadowRootExpression}.querySelector('[data-action="reset-user"]').click()`);
    await waitForCondition(
      page,
      `${shadowRootExpression}.querySelector('.tu-page-toast')?.textContent.includes('Reset Admin · Empty organization')`,
      'scenario reset'
    );
    assert.equal(staticServer.adapterState.resetRequests.length, 1);
    assert.equal(staticServer.adapterState.resetRequests[0].accountRef, 'acct_1');
    assert.equal('identity' in staticServer.adapterState.resetRequests[0], false);
    assert.equal(
      JSON.stringify(staticServer.adapterState.resetRequests[0]).includes(generated.password),
      false
    );

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
      root.querySelector('select[name="scenario"]').value = 'standard';
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
    assert.match(savedSiteSummary, /1 local/);

    await page.evaluate(
      `${shadowRootExpression}.querySelector('[data-action="delete-site"]').click()`
    );
    const confirmationText = await page.evaluate(
      `${shadowRootExpression}.querySelector('.tu-site-delete-copy').textContent`
    );
    assert.match(confirmationText, /Delete HikeStrong/);
    assert.match(confirmationText, /Other sites are unaffected/);
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
    assert.deepEqual(storedAfterSiteDelete.sites, {});
    assert.deepEqual(storedAfterSiteDelete.origins, {});

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

    log('renaming the snapshot, excluding the phone field, and editing the company value');
    await page.evaluate(`(() => {
      const root = ${shadowRootExpression};
      const name = root.querySelector('input[name="snapshotName"]');
      name.value = 'West coast profile';
      name.dispatchEvent(new Event('input', { bubbles: true }));
      const rows = [...root.querySelectorAll('.tu-snapshot-field')];
      const phoneRow = rows.find((row) =>
        /phone/i.test(row.querySelector('.tu-snapshot-field-label').textContent)
      );
      phoneRow.querySelector('[data-snapshot-include]').click();
    })()`);
    assert.equal(
      await page.evaluate(`${shadowRootExpression}.querySelector('input[name="snapshotName"]').value`),
      'West coast profile',
      'changing included fields must preserve the unsaved snapshot name'
    );
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
    assert.equal(storedSnapshots[0].name, 'West coast profile');
    assert.equal(storedSnapshots[0].path, '/demo/runtime-profile.html');
    assert.ok(
      storedSnapshots[0].fields.every(
        (field) => !/password|SuperSecret|4111|SAVE20|real\.person/.test(JSON.stringify(field))
      ),
      'stored snapshot must not contain credential, card, or promo values'
    );

    await page.evaluate(
      `${shadowRootExpression}.querySelector('[data-action="settings"]').click()`
    );
    await page.evaluate(
      `${shadowRootExpression}.querySelector('[data-form="settings"]').requestSubmit()`
    );
    await waitForCondition(
      page,
      `!!${shadowRootExpression}.querySelector('[data-action="new-user"]')`,
      'site settings save after snapshot'
    );
    const snapshotsAfterSettingsSave = await worker.evaluate(`(async () => {
      const result = await chrome.storage.local.get('testUsersStateV1');
      return result.testUsersStateV1.snapshots;
    })()`);
    assert.equal(
      snapshotsAfterSettingsSave.length,
      1,
      'saving site settings must preserve form snapshots'
    );
    await page.evaluate(`${shadowRootExpression}.querySelector('[data-action="edit-snapshot"]').click()`);
    assert.equal(
      await page.evaluate(`${shadowRootExpression}.querySelector('input[name="snapshotName"]').value`),
      'West coast profile',
      'the saved snapshot name must survive reopening'
    );
    await page.evaluate(`${shadowRootExpression}.querySelector('[data-action="back"]').click()`);

    log('linking this address to an existing site without renaming that site');
    const controlUser = {
      id: 'linked-site-control',
      name: 'Control Tester',
      email: 'control@example.test',
      password: 'ControlTest!123',
      role: 'Member',
      siteId: 'site:shared-project',
      origin: 'https://staging.shared-project.test',
      environment: 'staging',
    };
    await worker.evaluate(`(async () => {
      const { testUsersStateV1: state } = await chrome.storage.local.get('testUsersStateV1');
      state.sites['site:shared-project'] = { id: 'site:shared-project', name: 'Shared project' };
      state.origins['https://staging.shared-project.test'] = {
        siteId: 'site:shared-project', environment: 'staging'
      };
      state.users.push(${JSON.stringify(controlUser)});
      await chrome.storage.local.set({ testUsersStateV1: state });
    })()`);

    async function reloadOverlay() {
      await page.evaluate('location.reload()');
      await waitForCondition(
        page,
        `document.readyState === 'complete' && !document.querySelector('#test-users-extension-root')`,
        'profile reload'
      );
      await worker.evaluate(`(async () => {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        await chrome.scripting.executeScript({
          target: { tabId: tab.id, allFrames: true }, files: ['core.js', 'content.js']
        });
      })()`);
      await waitForCondition(
        page,
        `!!${shadowRootExpression}?.querySelector('.tu-panel')`,
        'reloaded overlay'
      );
    }

    await reloadOverlay();
    await page.evaluate(`${shadowRootExpression}.querySelector('[data-action="settings"]').click()`);
    await page.evaluate(`(() => {
      const root = ${shadowRootExpression};
      root.querySelector('select[name="linkedSiteId"]').value = 'site:shared-project';
      root.querySelector('[data-form="settings"]').requestSubmit();
    })()`);
    await waitForCondition(
      page,
      `!!${shadowRootExpression}.querySelector('[data-action="new-user"]')`,
      'site link save'
    );
    const linkedState = await worker.evaluate(`(async () => {
      return (await chrome.storage.local.get('testUsersStateV1')).testUsersStateV1;
    })()`);
    assert.equal(linkedState.sites['site:shared-project'].name, 'Shared project');
    assert.equal(linkedState.origins[new URL(pageUrl).origin].siteId, 'site:shared-project');
    assert.equal(linkedState.snapshots[0].siteId, 'site:shared-project');
    assert.equal(linkedState.snapshots[0].id, storedSnapshots[0].id);
    assert.deepEqual(linkedState.users, [controlUser], 'linking must preserve the other address login');

    await reloadOverlay();
    assert.equal(
      await page.evaluate(`${shadowRootExpression}.querySelector('.tu-site-identity strong').textContent`),
      'Shared project',
      'the linked site identity must survive a page reload'
    );
    await page.evaluate(`${shadowRootExpression}.querySelector('[data-action="edit-snapshot"]').click()`);
    assert.equal(
      await page.evaluate(`${shadowRootExpression}.querySelector('input[name="snapshotName"]').value`),
      'West coast profile',
      'the snapshot must remain available after linking and reloading'
    );

    log('saving independent accounts from two already-open overlays');
    const secondUrl = `http://127.0.0.1:${staticServer.port}${RUNTIME_PAGE}?second-tab`;
    const secondTabId = await worker.evaluate(`(async () => {
      return (await chrome.tabs.create({ url: ${JSON.stringify(secondUrl)}, active: false })).id;
    })()`);
    const secondTarget = await waitForTarget(
      browser.cdp,
      (target) => target.type === 'page' && target.url === secondUrl,
      'second account tab'
    );
    const secondPage = await attachTarget(browser.cdp, secondTarget);
    await waitForCondition(secondPage, 'document.readyState === "complete"', 'second tab readiness');
    await worker.evaluate(`chrome.scripting.executeScript({
      target: { tabId: ${secondTabId}, allFrames: true }, files: ['core.js', 'content.js']
    })`);
    await waitForCondition(
      secondPage,
      `!!${shadowRootExpression}?.querySelector('.tu-panel')`,
      'second overlay'
    );
    await secondPage.evaluate(`(() => {
      const root = ${shadowRootExpression};
      root.querySelector('[data-action="new-user"]').click();
      root.querySelector('input[name="email"]').value = 'second-tab@example.test';
      root.querySelector('textarea[name="notes"]').value = 'Keep this unsaved draft';
    })()`);
    await worker.evaluate(`chrome.scripting.executeScript({
      target: { tabId: ${secondTabId} },
      func: () => {
        globalThis.__testUsersStorageChanged = new Promise((resolveChange) => {
          const listener = (changes, area) => {
            if (area !== 'local' || !changes.testUsersStateV1) return;
            chrome.storage.onChanged.removeListener(listener);
            resolveChange();
          };
          chrome.storage.onChanged.addListener(listener);
        });
      }
    })`);
    await page.evaluate(`${shadowRootExpression}.querySelector('[data-action="back"]').click()`);
    await page.evaluate(`${shadowRootExpression}.querySelector('[data-action="new-user"]').click()`);
    await page.evaluate(`(() => {
      const root = ${shadowRootExpression};
      root.querySelector('input[name="email"]').value = 'first-tab@example.test';
      root.querySelector('[data-action="save-only"]').click();
    })()`);
    await waitForCondition(page, `!!${shadowRootExpression}.querySelector('.tu-user-card')`, 'first tab save');
    await worker.evaluate(`chrome.scripting.executeScript({
      target: { tabId: ${secondTabId} }, func: () => globalThis.__testUsersStorageChanged
    })`);
    assert.equal(
      await secondPage.evaluate(`${shadowRootExpression}.querySelector('input[name="email"]').value`),
      'second-tab@example.test',
      'another tab save must preserve the unsaved account identifier'
    );
    assert.equal(
      await secondPage.evaluate(`${shadowRootExpression}.querySelector('textarea[name="notes"]').value`),
      'Keep this unsaved draft',
      'another tab save must preserve unsaved notes'
    );
    await secondPage.evaluate(`${shadowRootExpression}.querySelector('[data-action="save-only"]').click()`);
    await waitForCondition(secondPage, `!!${shadowRootExpression}.querySelector('.tu-user-card')`, 'second tab save');
    const multiTabState = await worker.evaluate(`(async () => {
      return (await chrome.storage.local.get('testUsersStateV1')).testUsersStateV1;
    })()`);
    assert.deepEqual(
      multiTabState.users.map((user) => user.email).sort(),
      ['control@example.test', 'first-tab@example.test', 'second-tab@example.test'],
      'saving from the second open tab must retain the first tab account'
    );
    assert.deepEqual(multiTabState.users.find((user) => user.id === controlUser.id), controlUser);
    assert.deepEqual(multiTabState.snapshots, linkedState.snapshots);
    assert.equal(multiTabState.users.find((user) => user.email === 'second-tab@example.test').notes, 'Keep this unsaved draft');
    await waitForCondition(
      page,
      `${shadowRootExpression}.querySelectorAll('.tu-user-card').length === 2`,
      'the first tab list synchronizing both local accounts'
    );
    await reloadOverlay();
    assert.equal(
      await page.evaluate(`${shadowRootExpression}.querySelectorAll('.tu-user-card').length`),
      2,
      'both accounts must survive a reload'
    );

    log('holding the first write while a second tab saves simultaneously');
    const primaryTabId = await worker.evaluate(`(async () => {
      return (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id;
    })()`);
    // Gate the old tab writer and the background writer so this same witness
    // remains valid when writes move into the service worker.
    const installWriteGate = `() => {
      const original = chrome.storage.local.set.bind(chrome.storage.local);
      globalThis.__testUsersWriteGate = { held: false, released: false };
      chrome.storage.local.set = async (...args) => {
        const gate = globalThis.__testUsersWriteGate;
        if (!gate.held && !gate.released) {
          gate.held = true;
          await new Promise((resolveWrite) => { gate.release = resolveWrite; });
        }
        return original(...args);
      };
    }`;
    await worker.evaluate(`(${installWriteGate})()`);
    await worker.evaluate(`chrome.scripting.executeScript({
      target: { tabId: ${primaryTabId} }, func: ${installWriteGate}
    })`);
    for (const [client, email] of [[page, 'overlap-first@example.test'], [secondPage, 'overlap-second@example.test']]) {
      await client.evaluate(`${shadowRootExpression}.querySelector('[data-action="new-user"]').click()`);
      await client.evaluate(`(() => {
        const root = ${shadowRootExpression};
        root.querySelector('input[name="email"]').value = ${JSON.stringify(email)};
      })()`);
    }
    await worker.evaluate(`(() => {
      globalThis.__testUsersSaveMessages = 0;
      chrome.runtime.onMessage.addListener((message) => {
        if (message?.type === 'TEST_USERS_MUTATE_STATE') globalThis.__testUsersSaveMessages += 1;
        return false;
      });
    })()`);
    async function saveOverlappingEditors({ fallbackEmail = null, form = 'user', rejectSecond = false } = {}) {
      const saveSelector = form === 'user' ? '[data-action="save-only"]' : `[data-form="${form}"] button[type="submit"]`;
      const armGate = `() => {
        Object.assign(globalThis.__testUsersWriteGate, { held: false, released: false });
      }`;
      await worker.evaluate(`(${armGate})()`);
      await worker.evaluate('globalThis.__testUsersSaveMessages = 0');
      await worker.evaluate(`chrome.scripting.executeScript({
        target: { tabId: ${primaryTabId} }, func: ${armGate}
      })`);
      await page.evaluate(`${shadowRootExpression}.querySelector(${JSON.stringify(saveSelector)}).click()`);
      await waitForCondition(worker, `(async () => {
        const [tabGate] = await chrome.scripting.executeScript({
          target: { tabId: ${primaryTabId} },
          func: () => globalThis.__testUsersWriteGate.held
        });
        return globalThis.__testUsersWriteGate.held || tabGate.result;
      })()`, 'first save held at storage');
      await secondPage.evaluate(`${shadowRootExpression}.querySelector(${JSON.stringify(saveSelector)}).click()`);
      await waitForCondition(worker, `(async () => {
        const { testUsersStateV1: state } = await chrome.storage.local.get('testUsersStateV1');
        return globalThis.__testUsersSaveMessages === 2 ||
          state.users.some((user) => user.email === ${JSON.stringify(fallbackEmail)});
      })()`, 'second save submitted while the first is held');
      const releaseWriteGate = `() => {
        const gate = globalThis.__testUsersWriteGate;
        gate.released = true;
        gate.release?.();
      }`;
      await worker.evaluate(`chrome.scripting.executeScript({
        target: { tabId: ${primaryTabId} }, func: ${releaseWriteGate}
      })`);
      await worker.evaluate(`(${releaseWriteGate})()`);
      for (const [index, client] of [page, secondPage].entries()) {
        await waitForCondition(
          client,
          rejectSecond && index === 1
            ? `${shadowRootExpression}.querySelector('.tu-page-toast--error')?.textContent.includes('changed in another tab')`
            : `!${shadowRootExpression}.querySelector('[data-form="${form}"]')`,
          'overlapping save completion'
        );
      }
      return worker.evaluate(`(async () => {
        return (await chrome.storage.local.get('testUsersStateV1')).testUsersStateV1;
      })()`);
    }

    const overlappingState = await saveOverlappingEditors({ fallbackEmail: 'overlap-second@example.test' });
    assert.deepEqual(
      overlappingState.users.map((user) => user.email).sort(),
      [...multiTabState.users.map((user) => user.email), 'overlap-first@example.test', 'overlap-second@example.test'].sort(),
      'overlapping saves must retain both new accounts and all existing accounts'
    );
    assert.deepEqual(overlappingState.snapshots, multiTabState.snapshots);
    assert.deepEqual(overlappingState.users.find((user) => user.id === controlUser.id), controlUser);

    log('overlapping edits to existing accounts without losing either edit');
    const editedUsers = multiTabState.users.filter((user) => user.id !== controlUser.id);
    for (const [index, client] of [page, secondPage].entries()) {
      await client.evaluate(`(() => {
        const root = ${shadowRootExpression};
        root.querySelector(${JSON.stringify(`[data-action="edit"][data-user-id="${editedUsers[index].id}"]`)}).click();
        const notes = root.querySelector('textarea[name="notes"]');
        notes.value = ${JSON.stringify(`Concurrent edit ${index + 1}`)};
        notes.dispatchEvent(new Event('input', { bubbles: true }));
      })()`);
    }
    const editedState = await saveOverlappingEditors();
    assert.deepEqual(editedState.users.map((user) => user.id).sort(), overlappingState.users.map((user) => user.id).sort());
    for (const [index, user] of editedUsers.entries()) {
      assert.equal(editedState.users.find((record) => record.id === user.id).notes, `Concurrent edit ${index + 1}`);
    }
    for (const user of overlappingState.users.filter((record) => !editedUsers.some((edited) => edited.id === record.id))) {
      assert.deepEqual(editedState.users.find((record) => record.id === user.id), user, 'unrelated accounts must remain unchanged');
    }
    assert.deepEqual(editedState.snapshots, overlappingState.snapshots);

    log('overlapping edits to different fields of the same account');
    const sharedUser = editedState.users.find((user) => user.id === editedUsers[0].id);
    for (const [index, client] of [page, secondPage].entries()) {
      await client.evaluate(`(() => {
        const root = ${shadowRootExpression};
        root.querySelector(${JSON.stringify(`[data-action="edit"][data-user-id="${sharedUser.id}"]`)}).click();
        const input = root.querySelector(${JSON.stringify(index === 0 ? 'textarea[name="notes"]' : 'input[name="name"]')});
        input.value = ${JSON.stringify(index === 0 ? 'Shared account notes' : 'Shared account name')};
        input.dispatchEvent(new Event('input', { bubbles: true }));
      })()`);
    }
    const sharedEditState = await saveOverlappingEditors();
    const sharedSaved = sharedEditState.users.find((user) => user.id === sharedUser.id);
    assert.equal(sharedSaved.name, 'Shared account name');
    assert.equal(sharedSaved.notes, 'Shared account notes', 'a concurrent name edit must preserve the other tab notes edit');
    assert.equal(sharedEditState.users.length, editedState.users.length);
    assert.deepEqual(sharedEditState.snapshots, editedState.snapshots);

    log('keeping conflicting same-field input available for review');
    for (const [index, client] of [page, secondPage].entries()) {
      await client.evaluate(`(() => {
        const root = ${shadowRootExpression};
        root.querySelector(${JSON.stringify(`[data-action="edit"][data-user-id="${sharedUser.id}"]`)}).click();
        root.querySelector('textarea[name="notes"]').value = ${JSON.stringify(index === 0 ? 'First tab conflict notes' : 'Second tab unsaved conflict notes')};
      })()`);
    }
    const conflictState = await saveOverlappingEditors({ rejectSecond: true });
    assert.equal(conflictState.users.find((user) => user.id === sharedUser.id).notes, 'First tab conflict notes');
    assert.equal(
      await secondPage.evaluate(`${shadowRootExpression}.querySelector('textarea[name="notes"]').value`),
      'Second tab unsaved conflict notes',
      'a conflicting save must preserve the rejected draft'
    );
    assert.equal(conflictState.users.length, sharedEditState.users.length);
    await secondPage.evaluate(`${shadowRootExpression}.querySelector('[data-action="back"]').click()`);

    log('overlapping adapter and site-name edits in site settings');
    for (const [index, client] of [page, secondPage].entries()) {
      await client.evaluate(`${shadowRootExpression}.querySelector('[data-action="settings"]').click()`);
      await client.evaluate(`(() => {
        const root = ${shadowRootExpression};
        const input = root.querySelector(${JSON.stringify(index === 0 ? 'input[name="adapterUrl"]' : 'input[name="siteName"]')});
        input.value = ${JSON.stringify(index === 0 ? '/__test-users' : 'Concurrent project name')};
        input.dispatchEvent(new Event('input', { bubbles: true }));
      })()`);
    }
    const settingsState = await saveOverlappingEditors({ form: 'settings' });
    assert.equal(settingsState.sites['site:shared-project'].name, 'Concurrent project name');
    assert.equal(
      settingsState.origins[new URL(pageUrl).origin].adapterUrl,
      `http://127.0.0.1:${staticServer.port}/__test-users`,
      'a concurrent site-name edit must retain the other tab adapter change'
    );
    assert.deepEqual(settingsState.users, conflictState.users);
    assert.deepEqual(settingsState.snapshots, conflictState.snapshots);
    await reloadOverlay();
    assert.equal(
      await page.evaluate(`${shadowRootExpression}.querySelectorAll('.tu-user-card').length`),
      4,
      'all four local accounts must survive a reload after overlapping saves'
    );
    await page.evaluate(`(() => {
      const root = ${shadowRootExpression};
      root.querySelector(${JSON.stringify(`[data-action="edit"][data-user-id="${editedUsers[0].id}"]`)}).click();
    })()`);
    assert.equal(
      await page.evaluate(`${shadowRootExpression}.querySelector('textarea[name="notes"]').value`),
      'First tab conflict notes',
      'the overlapping edit must survive reopening after reload'
    );

    log(
      'passed: load, recognize, adapter and account validation recovery, provision/reset, autofill, delete, snapshot capture/exclude/edit/refill/preservation, site linking, and sequential/overlapping cross-tab creates and edits'
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
