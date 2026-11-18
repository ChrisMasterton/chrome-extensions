#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = resolve(TEST_DIR, '..');
const SERVER_PATH = join(PROJECT_DIR, 'scripts', 'codex-qa-inbox-server.mjs');
const SMOKE_PATH = '/smoke/vibe-debugger-smoke.html';
const LOCAL_INBOX_PORT_TOKEN = '43117';
const CROSS_ORIGIN_HOST = 'qa-bridge-origin.test';
const execFileAsync = promisify(execFile);

const REQUIRED_EXTENSION_FILES = [
  'manifest.json',
  'background.js',
  'picker.js',
  'picker.css',
  'vibe-page-probe.js',
  'element-source-probe.js',
  'icon16.png',
  'icon48.png',
  'icon128.png',
];

function log(message) {
  console.log(`[vibe-e2e] ${message}`);
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
  await new Promise((resolveListen) => {
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const port = server.address().port;
  await new Promise((resolveClose) => {
    server.close(resolveClose);
  });
  return port;
}

async function waitForHttpJson(url, timeoutMs = 8000) {
  const startedAt = Date.now();
  let lastError = null;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return await response.json();
      }
      lastError = new Error(`${url} returned HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }

    await new Promise((resolveDelay) => {
      setTimeout(resolveDelay, 80);
    });
  }

  throw lastError || new Error(`Timed out waiting for ${url}`);
}

function getContentType(pathname) {
  switch (extname(pathname)) {
    case '.html':
      return 'text/html; charset=utf-8';
    case '.js':
      return 'text/javascript; charset=utf-8';
    case '.css':
      return 'text/css; charset=utf-8';
    case '.png':
      return 'image/png';
    case '.json':
      return 'application/json; charset=utf-8';
    default:
      return 'application/octet-stream';
  }
}

async function startStaticServer(rootDir, tls = null) {
  const port = await getFreePort();
  const baseUrl = tls ? `https://${CROSS_ORIGIN_HOST}:${port}` : `http://127.0.0.1:${port}`;
  let heldNavigation = null;
  const handleRequest = async (request, response) => {
    try {
      const url = new URL(request.url || '/', baseUrl);
      if (url.searchParams.has('hold-tour') && heldNavigation) {
        const hold = heldNavigation;
        heldNavigation = null;
        hold.started = true;
        await hold.wait;
      }
      const pathname = ['/', '/tour-page-two'].includes(url.pathname) ? SMOKE_PATH : url.pathname;
      const requestedPath = resolve(rootDir, `.${decodeURIComponent(pathname)}`);

      if (!requestedPath.startsWith(rootDir)) {
        response.writeHead(403);
        response.end('Forbidden');
        return;
      }

      const body = await readFile(requestedPath);
      response.writeHead(200, { 'content-type': getContentType(pathname) });
      response.end(body);
    } catch (error) {
      response.writeHead(500);
      response.end(error?.message || 'Static server error');
    }
  };
  const server = tls ? createHttpsServer(tls, handleRequest) : createHttpServer(handleRequest);

  await new Promise((resolveListen) => {
    server.listen(port, '127.0.0.1', resolveListen);
  });

  return {
    port,
    baseUrl,
    holdNavigation: () => {
      let release;
      const hold = { started: false, wait: new Promise(resolveHold => { release = resolveHold; }), release: () => release() };
      heldNavigation = hold;
      return hold;
    },
    close: () => new Promise((resolveClose) => {
      server.close(resolveClose);
    }),
  };
}

async function stopProcess(child, signal = 'SIGTERM') {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;

  const exited = once(child, 'exit').then(() => true);
  child.kill(signal);

  const didExit = await Promise.race([
    exited,
    new Promise((resolveTimeout) => {
      setTimeout(() => resolveTimeout(false), 1500);
    }),
  ]);

  if (!didExit && child.exitCode === null && child.signalCode === null) {
    const forcedExit = once(child, 'exit');
    child.kill('SIGKILL');
    await Promise.race([
      forcedExit,
      new Promise((resolveTimeout) => {
        setTimeout(resolveTimeout, 1500);
      }),
    ]);
  }
}

async function startInboxServer(root, port) {
  const output = [];
  const child = spawn(process.execPath, [SERVER_PATH], {
    cwd: PROJECT_DIR,
    env: {
      ...process.env,
      CODEX_QA_INBOX_PORT: String(port),
      CODEX_QA_INBOX_DIR: root,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout.on('data', (chunk) => output.push(chunk.toString()));
  child.stderr.on('data', (chunk) => output.push(chunk.toString()));

  try {
    await waitForHttpJson(`http://127.0.0.1:${port}/health`, 8000);
  } catch (error) {
    error.message = `${error.message}\nInbox server output:\n${output.join('')}`;
    throw error;
  }

  return {
    child,
    output,
    close: () => stopProcess(child),
  };
}

async function copyExtensionForPort(sourceDir, destinationDir, inboxPort) {
  await mkdir(destinationDir, { recursive: true });

  for (const relativePath of REQUIRED_EXTENSION_FILES) {
    const sourcePath = join(sourceDir, relativePath);
    const destinationPath = join(destinationDir, relativePath);
    await mkdir(dirname(destinationPath), { recursive: true });
    await cp(sourcePath, destinationPath);
  }

  for (const relativePath of ['background.js', 'picker.js']) {
    const path = join(destinationDir, relativePath);
    const content = await readFile(path, 'utf8');
    await writeFile(path, content.replaceAll(LOCAL_INBOX_PORT_TOKEN, String(inboxPort)));
  }

  const manifestPath = join(destinationDir, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.name = `${manifest.name} E2E`;
  // Preserve the shipped access policy: pregranting fixture origins here would
  // hide missing permissions for automatic cross-origin reinjection.
  manifest.host_permissions = manifest.host_permissions.map(pattern =>
    pattern.replaceAll(LOCAL_INBOX_PORT_TOKEN, String(inboxPort)));
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

async function findBrowserExecutable() {
  const candidates = [
    process.env.BROWSER_PATH,
    process.env.EDGE_PATH,
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Microsoft Edge Dev.app/Contents/MacOS/Microsoft Edge Dev',
    '/Applications/Microsoft Edge Beta.app/Contents/MacOS/Microsoft Edge Beta',
    '/Applications/Microsoft Edge Canary.app/Contents/MacOS/Microsoft Edge Canary',
    process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (await pathExists(candidate)) return candidate;
  }

  throw new Error('Could not find Edge, Chrome, or Chromium. Set BROWSER_PATH to the browser executable.');
}

async function startBrowser({ browserPath, profileDir, pageUrl }) {
  const args = [
    `--user-data-dir=${profileDir}`,
    '--remote-debugging-pipe',
    '--enable-unsafe-extension-debugging',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-sync',
    '--disable-popup-blocking',
    `--host-resolver-rules=MAP ${CROSS_ORIGIN_HOST} 127.0.0.1`,
    '--no-proxy-server',
    '--ignore-certificate-errors', // Temporary self-signed HTTPS fixture only.
    '--window-size=1280,900',
    pageUrl,
  ];

  if (process.env.CODEX_QA_E2E_HEADLESS === '1') {
    args.splice(args.length - 1, 0, '--headless=new');
  }

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
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Timed out connecting to browser CDP pipe')), 10000);
      }),
    ]);
  } catch (error) {
    error.message = `${error.message}\nBrowser output:\n${output.join('')}`;
    throw error;
  }

  return {
    child,
    cdp,
    profileDir,
    output,
    close: async () => {
      cdp.close();
      await stopProcess(child);
    },
  };
}

async function listTargets(cdp, filter = null) {
  const result = await cdp.send('Target.getTargets', filter ? { filter } : {});
  return result.targetInfos || [];
}

async function waitForTarget(cdp, predicate, label, timeoutMs = 10000, filter = null) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const targets = await listTargets(cdp, filter);
    const target = targets.find(predicate);
    if (target) return target;

    await new Promise((resolveDelay) => {
      setTimeout(resolveDelay, 100);
    });
  }

  const targets = await listTargets(cdp, filter);
  throw new Error(`Timed out waiting for browser target: ${label}\nTargets:\n${JSON.stringify(targets, null, 2)}`);
}

class PipeCdpClient {
  constructor(input, output) {
    this.input = input;
    this.output = output;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = Buffer.alloc(0);

    this.output.on('data', (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);

      let delimiterIndex = this.buffer.indexOf(0);
      while (delimiterIndex !== -1) {
        const rawMessage = this.buffer.subarray(0, delimiterIndex).toString('utf8');
        this.buffer = this.buffer.subarray(delimiterIndex + 1);
        delimiterIndex = this.buffer.indexOf(0);

        if (!rawMessage) continue;
        this.handleMessage(JSON.parse(rawMessage));
      }
    });

    this.output.on('error', (event) => {
      this.rejectPending(new Error(event.message || 'CDP pipe read error'));
    });

    this.input.on('error', (event) => {
      this.rejectPending(new Error(event.message || 'CDP pipe write error'));
    });
  }

  handleMessage(message) {
    if (!message.id) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);

    if (message.error) {
      pending.reject(new Error(`${message.error.message}: ${message.error.data || ''}`));
    } else {
      pending.resolve(message.result);
    }
  }

  rejectPending(error) {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }

  send(method, params = {}, sessionId = null) {
    const id = this.nextId++;
    const payload = JSON.stringify({
      id,
      method,
      params,
      ...(sessionId ? { sessionId } : {}),
    });

    const promise = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });

    this.input.write(`${payload}\0`);
    return promise;
  }

  async evaluate(expression, sessionId = null) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      timeout: 10000,
    }, sessionId);

    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'Runtime evaluation failed');
    }

    return result.result?.value;
  }

  close() {
    this.input.destroy();
    this.output.destroy();
  }
}

class CdpSession {
  constructor(cdp, sessionId) {
    this.cdp = cdp;
    this.sessionId = sessionId;
  }

  send(method, params = {}) {
    return this.cdp.send(method, params, this.sessionId);
  }

  evaluate(expression) {
    return this.cdp.evaluate(expression, this.sessionId);
  }

  close() {}
}

async function attachTarget(cdp, target) {
  const { sessionId } = await cdp.send('Target.attachToTarget', {
    targetId: target.targetId,
    flatten: true,
  });
  const session = new CdpSession(cdp, sessionId);
  await session.send('Runtime.enable');
  return session;
}

async function waitForExtensionWorker(cdp, extensionId) {
  return waitForTarget(
    cdp,
    (target) => (
      target.type === 'service_worker' &&
      target.url === `chrome-extension://${extensionId}/background.js`
    ),
    `extension service worker ${extensionId}`,
    10000,
    [{ type: 'service_worker', exclude: false }]
  );
}

function jsString(value) {
  return JSON.stringify(value);
}

async function waitForPageCondition(pageClient, expression, label, timeoutMs = 10000) {
  return waitForCondition(() => pageClient.evaluate(expression), label, timeoutMs);
}

async function waitForCondition(check, label, timeoutMs = 10000) {
  const startedAt = Date.now();
  let lastError = null;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }

    await new Promise((resolveDelay) => {
      setTimeout(resolveDelay, 100);
    });
  }

  throw lastError || new Error(`Timed out waiting for page condition: ${label}`);
}

async function run() {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'vibe-debugger-e2e-'));
  const inboxRoot = join(workspaceRoot, 'web-qa');
  const extensionDir = join(workspaceRoot, 'extension');
  const profileDir = join(workspaceRoot, 'chrome-profile');
  const inboxPort = await getFreePort();
  const staticServer = await startStaticServer(PROJECT_DIR);
  const smokeUrl = `${staticServer.baseUrl}${SMOKE_PATH}`;

  let inbox = null;
  let chrome = null;
  let pageClient = null;
  let serviceWorkerClient = null;
  let diggerWorkerClient = null;
  let navigationHold = null;
  let secureServer = null;

  try {
    const keyPath = join(workspaceRoot, 'fixture-key.pem');
    const certPath = join(workspaceRoot, 'fixture-cert.pem');
    await execFileAsync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', keyPath, '-out', certPath, '-days', '1', '-subj', `/CN=${CROSS_ORIGIN_HOST}`]);
    secureServer = await startStaticServer(PROJECT_DIR, {
      key: await readFile(keyPath), cert: await readFile(certPath),
    });
    await copyExtensionForPort(PROJECT_DIR, extensionDir, inboxPort);
    inbox = await startInboxServer(inboxRoot, inboxPort);

    const browserPath = await findBrowserExecutable();
    log(`launching ${basename(browserPath)}`);
    chrome = await startBrowser({
      browserPath,
      profileDir,
      pageUrl: smokeUrl,
    });
    await chrome.cdp.send('Browser.setDownloadBehavior', {
      behavior: 'allow', downloadPath: join(workspaceRoot, 'downloads'),
    });

    log(`loading extension from ${extensionDir}`);
    const extensionLoad = await chrome.cdp.send('Extensions.loadUnpacked', {
      path: extensionDir,
    });
    assert.ok(extensionLoad.id, 'CDP should return a loaded extension id');

    const loadedExtensions = await chrome.cdp.send('Extensions.getExtensions');
    assert.ok(
      loadedExtensions.extensions?.some((extension) => (
        extension.id === extensionLoad.id &&
        extension.name === 'Element Picker QA Bridge E2E' &&
        extension.enabled
      )),
      'loaded extension should be visible to CDP'
    );

    const pageTarget = await waitForTarget(
      chrome.cdp,
      (target) => target.type === 'page' && target.url.includes(SMOKE_PATH),
      'smoke page'
    );
    pageClient = await attachTarget(chrome.cdp, pageTarget);
    const serviceWorkerTarget = await waitForExtensionWorker(chrome.cdp, extensionLoad.id);
    serviceWorkerClient = await attachTarget(chrome.cdp, serviceWorkerTarget);

    await waitForPageCondition(
      pageClient,
      'document.readyState === "complete" && !!document.querySelector("#save-button")',
      'smoke page ready'
    );

    log('injecting through extension background worker');
    await pageClient.evaluate(`(() => {
      window.smokeOriginalTimers = [setTimeout, setInterval, requestAnimationFrame];
    })()`);
    const injectionResult = await serviceWorkerClient.evaluate(`(async () => {
      const tabs = await chrome.tabs.query({});
      const tab = tabs.find((candidate) => candidate.url && candidate.url.includes(${jsString(SMOKE_PATH)}))
        || (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
      if (!tab) throw new Error('Smoke page tab not found');
      await injectPicker(tab.id);
      return { tabId: tab.id, url: tab.url };
    })()`);
    assert.ok(injectionResult.tabId, 'extension background worker should inject into the smoke page tab');

    await waitForPageCondition(
      pageClient,
      '!!document.querySelector("#__element-picker-toolbar") && !!window.__VIBE_DEBUGGER__',
      'QA Bridge toolbar and Vibe app API'
    );

    async function clickButton(label) {
      await pageClient.evaluate(`(() => {
        const button = [...document.querySelectorAll('#__element-picker-toolbar button')]
          .find((item) => item.textContent.trim() === ${jsString(label)} && item.getClientRects().length && !item.closest('[hidden]'));
        if (!button || button.disabled) throw new Error('Unavailable control: ' + ${jsString(label)});
        button.click();
      })()`);
    }
    async function viewport(width, height) {
      await pageClient.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
      await pageClient.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    }
    async function capture(name) {
      if (!process.env.CODEX_QA_E2E_SCREENSHOT_DIR) return;
      await mkdir(process.env.CODEX_QA_E2E_SCREENSHOT_DIR, { recursive: true });
      const { data } = await pageClient.send('Page.captureScreenshot', { format: 'png' });
      await writeFile(join(process.env.CODEX_QA_E2E_SCREENSHOT_DIR, name + '.png'), Buffer.from(data, 'base64'));
    }
    async function readSubmission(label) {
      const manifest = JSON.parse(await readFile(join(inboxRoot, 'latest', 'manifest.json'), 'utf8'));
      const bundle = JSON.parse(await readFile(manifest.files.bundle, 'utf8'));
      return { label, manifest, bundle };
    }
    async function assertSubmissionImages({ label, manifest, bundle }) {
      assert.equal(bundle.screenshot.status, 'ok', `${label} must include screenshots without an icon click`);
      const crop = bundle.elements[0].screenshotCrop;
      assert.equal(crop.visibleInViewport, true);
      const decoded = [];
      for (const path of [bundle.screenshot.highlightedViewportImageLocalFile, crop.imageLocalFile]) {
        assert.ok(manifest.files.images.includes(path), `${label}: image must be published in the inbox`);
        const bytes = await readFile(path);
        const mime = extname(path) === '.png' ? 'image/png' : 'image/jpeg';
        const dimensions = await pageClient.evaluate(`(async () => {
          const image = new Image();
          image.src = ${jsString(`data:${mime};base64,${bytes.toString('base64')}`)};
          await image.decode();
          return { width: image.naturalWidth, height: image.naturalHeight };
        })()`);
        assert.ok(dimensions.width > 0 && dimensions.height > 0, `${label}: image must decode`);
        decoded.push(dimensions);
      }
      const [viewportImage, cropImage] = decoded;
      assert.ok(cropImage.width <= viewportImage.width && cropImage.height <= viewportImage.height,
        `${label}: element crop must fit inside the viewport capture`);
    }
    async function assertReachable(label) {
      assert.equal(await pageClient.evaluate(`(() => {
        const button = [...document.querySelectorAll('#__element-picker-toolbar button')]
          .find(item => item.textContent.trim() === ${jsString(label)} && item.getClientRects().length && !item.closest('[hidden]'));
        if (!button) return false;
        const r = button.getBoundingClientRect();
        const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        return r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth && button.contains(hit);
      })()`), true, label + ' must remain visible and clickable');
    }
    await viewport(1280, 720);
    log('driving watch, record, page interactions, and trace export');
    const timerArguments = await pageClient.evaluate(`new Promise((resolve) => {
      setTimeout((...args) => resolve(args), 0, 'sentinel', 42);
    })`);
    assert.deepEqual(timerArguments, ['sentinel', 42], 'opening QA Bridge must preserve timer callback arguments');
    assert.equal(await pageClient.evaluate(`
      window.smokeOriginalTimers.every((timer, index) => timer === [setTimeout, setInterval, requestAnimationFrame][index])
    `), true, 'QA Bridge must leave page scheduling APIs untouched');
    await pageClient.evaluate(`(async () => {
      const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const buttonByText = (text) => Array.from(document.querySelectorAll('#__element-picker-toolbar button'))
        .find((button) => button.textContent.trim() === text && button.getClientRects().length && !button.closest('[hidden]'));
      const click = (element) => {
        if (!element) throw new Error('Missing element to click');
        element.dispatchEvent(new MouseEvent('click', {
          bubbles: true,
          cancelable: true,
          view: window,
          clientX: element.getBoundingClientRect().left + 4,
          clientY: element.getBoundingClientRect().top + 4,
        }));
      };
      const save = document.querySelector('#save-button');
      const detailsWrapper = document.querySelector('#details-wrapper');
      click(save);
      await delay(80);
      click(buttonByText('Trace'));
      await delay(80);
      click(buttonByText('Watch selected'));
      await delay(80);
      click(buttonByText('Capture'));
      document.querySelector('.element-picker-capture-options summary').click();
      click(buttonByText('Click Through'));
      await delay(80);
      click(document.querySelector('#toggle-details'));
      await delay(160);
      if (!detailsWrapper.classList.contains('is-hidden')) {
        throw new Error('Click Through should activate the page button while paused');
      }
      if (document.querySelector('#__element-picker-toolbar .element-picker-toolbar-count').textContent.trim() !== '1 selected') {
        throw new Error('Click Through should not add another selected element');
      }
      click(buttonByText('Break on Load'));
      await delay(80);
      click(buttonByText('Trace'));
      click(buttonByText('Record'));
      await delay(120);
      click(buttonByText('Use page'));
      await delay(120);

      click(save);
      await delay(1100);
      click(document.querySelector('#toggle-details'));
      await delay(200);
      const filter = document.querySelector('#filter-input');
      filter.value = 'zzzz';
      filter.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: 'zzzz' }));
      await delay(200);
      click(document.querySelector('#network-button'));
      await delay(300);
      click(document.querySelector('#timer-button'));
      await delay(900);
      click(document.querySelector('#route-button'));
      await delay(300);
      if (!buttonByText('Use page')) {
        throw new Error('Break on Load should pause the QA Bridge after a route change');
      }
      click(buttonByText('Use page'));
      await delay(120);
      click(save);
      await delay(220);
      click(buttonByText('Stop'));
      await delay(160);
      click(buttonByText('Send Trace'));
      await delay(500);
      return {
        toolbar: !!document.querySelector('#__element-picker-toolbar'),
        tracePanel: !!document.querySelector('#__element-picker-trace-panel'),
        saveText: save.textContent,
        emptyVisible: !document.querySelector('#empty-state').hidden,
        routeText: document.querySelector('#route-status').textContent,
      };
    })()`);

    const latestTrace = await waitForHttpJson(`http://127.0.0.1:${inboxPort}/traces/latest`, 10000);
    const trace = latestTrace.trace;
    assert.equal(latestTrace.ok, true);
    assert.ok(trace.watchTargets.length >= 1, 'trace should include watched targets');
    assert.ok(trace.events.some((event) => event.kind === 'user.click'), 'trace should include user click events');
    assert.ok(trace.events.some((event) => event.kind === 'route.pushState'), 'trace should include route pushState events');
    assert.ok(trace.network.some((event) => event.kind === 'network.fetch.end'), 'trace should include fetch completion');
    assert.ok(trace.samples.some((sample) => sample.diffs?.some((diff) => diff.path === 'dom.text')), 'trace should include a DOM text diff');
    assert.ok(trace.samples.some((sample) => sample.watchId === 'app-smoke.state'), 'trace should include app probe samples');
    assert.ok(trace.summaries.length >= 1, 'trace should include focused summaries');
    assert.ok(trace.events.every((event) => !event.kind.startsWith('timer.')), 'trace should omit generic timer noise');
    assert.ok(trace.samples.every((sample) => !('cause' in sample) && !('causeEventId' in sample)),
      'observed diffs must not assign causality from event timing');

    const latestManifestPath = join(inboxRoot, 'traces', 'latest', 'manifest.json');
    const latestMarkdownPath = join(inboxRoot, 'traces', 'latest', 'trace.md');
    const latestManifest = JSON.parse(await readFile(latestManifestPath, 'utf8'));
    const latestMarkdown = await readFile(latestMarkdownPath, 'utf8');

    assert.equal(latestManifest.traceId, latestTrace.manifest.traceId);
    assert.match(latestMarkdown, /Vibe Debugger Trace/);
    assert.match(latestMarkdown, /Recent Diffs|Timeline/);
    assert.doesNotMatch(latestMarkdown, /unknown cause|causeEventId|"confidence"/);

    log('checking selected-element export through the shared inbox sender');
    await pageClient.evaluate(`(() => {
      const panel = document.querySelector('#__element-picker-trace-panel');
      if (!panel.textContent.includes('Current state') || panel.textContent.includes('Cause:')) {
        throw new Error('Trace panel should show observations without automatic cause labels');
      }
      Array.from(document.querySelectorAll('#__element-picker-toolbar button'))
        .find((button) => button.textContent.trim() === 'Capture').click();
      Array.from(document.querySelectorAll('#__element-picker-toolbar button'))
        .find((button) => button.textContent.trim() === 'Send capture').click();
    })()`);
    await waitForPageCondition(pageClient,
      `document.querySelector('.element-picker-handoff')?.dataset.state === 'success'`, 'selected-element capture saved');
    const bundle = JSON.parse(await readFile(join(inboxRoot, 'latest', 'bundle.json'), 'utf8'));
    assert.equal(bundle.elements.length, 1, 'capture should retain the selected element');
    assert.ok(bundle.traceContext.watchTargetCount >= 1, 'capture should retain observed trace context');
    assert.equal('activeCause' in bundle.traceContext, false, 'capture must not reintroduce inferred causes');

    await capture('qa-capture-sent');
    await viewport(360, 480);
    await assertReachable('Send capture');
    await capture('qa-capture-small');
    await viewport(1280, 720);

    log('checking persistent send failure and retry without losing selections or notes');
    await pageClient.evaluate(`document.querySelector('.element-picker-toolbar-comment').value = 'Keep my capture context'`);
    await inbox.close();
    await clickButton('Send capture');
    await waitForPageCondition(pageClient, `document.querySelector('.element-picker-handoff')?.dataset.state === 'error'`, 'persistent capture send error');
    assert.match(await pageClient.evaluate(`document.querySelector('.element-picker-handoff').textContent`), /failed/i);
    assert.equal(await pageClient.evaluate(`document.querySelector('.element-picker-toolbar-comment').value`), 'Keep my capture context');
    await capture('qa-send-error');
    inbox = await startInboxServer(inboxRoot, inboxPort);
    await clickButton('Retry send');
    await waitForPageCondition(pageClient, `document.querySelector('.element-picker-handoff')?.dataset.state === 'success'`, 'capture send recovery');
    const recoveredBundle = JSON.parse(await readFile(join(inboxRoot, 'latest', 'bundle.json'), 'utf8'));
    assert.equal(recoveredBundle.elements.length, 1);
    assert.equal(recoveredBundle.userComment, 'Keep my capture context');

    log('checking trace/tour isolation, target visibility, notes, and missing-target recovery');
    await clickButton('Trace');
    await clickButton('Record');
    const response = await fetch(`http://127.0.0.1:${inboxPort}/tours`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tour: { title: 'UI review', steps: [
        { selector: '#filter-input', title: 'Filter feedback', body: 'Review this field with the trace workspace closed.' },
        { selector: '#recover-tour-target', title: 'Missing target', body: 'Try finding the target again when it appears.' },
      ] } }),
    });
    assert.equal(response.ok, true);
    await clickButton('Tour');
    await clickButton('Load tour');
    await waitForPageCondition(pageClient, `document.querySelector('#__element-picker-tour-panel')?.textContent.includes('Filter feedback')`, 'tour loaded');
    assert.equal(await pageClient.evaluate(`document.querySelector('#__element-picker-trace-panel').hidden`), true, 'a tour must hide the trace workspace');
    assert.match(await pageClient.evaluate(`document.querySelector('.element-picker-recording-state').textContent`), /Recording/);
    await waitForPageCondition(pageClient, `(() => {
      const panel = document.querySelector('#__element-picker-toolbar').getBoundingClientRect();
      const target = document.querySelector('#filter-input').getBoundingClientRect();
      return Math.max(0, Math.min(panel.right, target.right) - Math.max(panel.left, target.left)) *
        Math.max(0, Math.min(panel.bottom, target.bottom) - Math.max(panel.top, target.top)) === 0;
    })()`, 'the entire workspace avoiding the tour target');
    await assertReachable('Next');
    await capture('qa-tour-recording');
    await pageClient.evaluate(`(() => {
      const input = document.querySelector('.element-picker-tour-ask');
      input.value = 'Keep this step note'; input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await clickButton('Trace');
    assert.equal(await pageClient.evaluate(`document.querySelector('#__element-picker-tour-panel').hidden`), true);
    await viewport(360, 480);
    await assertReachable('Stop');
    await capture('qa-trace-small');
    await viewport(1280, 720);
    await clickButton('Tour');
    assert.equal(await pageClient.evaluate(`document.querySelector('.element-picker-tour-ask').value`), 'Keep this step note');
    await clickButton('Ask Codex');
    await waitForPageCondition(pageClient, `document.querySelector('.element-picker-handoff')?.dataset.state === 'success'`, 'tour question capture');
    const tourBundle = JSON.parse(await readFile(join(inboxRoot, 'latest', 'bundle.json'), 'utf8'));
    assert.equal(tourBundle.tourContext.askText, 'Keep this step note');
    assert.equal(tourBundle.tourContext.stepIndex, 1);
    assert.equal(tourBundle.elements.length, 1);
    await pageClient.evaluate(`(() => {
      const tab = document.querySelector('[data-workspace="tour"][role="tab"]');
      tab.focus(); tab.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    })()`);
    assert.equal(await pageClient.evaluate(`document.querySelector('#__element-picker-toolbar').dataset.workspace`), 'trace');
    await clickButton('Tour');
    await clickButton('Next');
    assert.match(await pageClient.evaluate(`document.querySelector('.element-picker-tour-status').textContent`), /Could not find/);
    await pageClient.evaluate(`(() => {
      const target = document.createElement('button'); target.id = 'recover-tour-target';
      target.textContent = 'Recovered target'; document.querySelector('main').prepend(target);
    })()`);
    await clickButton('Find target again');
    assert.match(await pageClient.evaluate(`document.querySelector('.element-picker-tour-status').textContent`), /Highlighting/);
    await clickButton('Stop recording');
    await clickButton('Done');
    assert.equal(await pageClient.evaluate(`document.querySelector('#__element-picker-toolbar').dataset.workspace`), 'capture');
    const previousCorner = await pageClient.evaluate(`document.querySelector('#__element-picker-toolbar').dataset.position`);
    await clickButton('Move');
    assert.notEqual(await pageClient.evaluate(`document.querySelector('#__element-picker-toolbar').dataset.position`), previousCorner, 'Move must advance from the actual corner after a tour ends');
    await capture('qa-capture-final');

    async function stopBackground() {
      await pageClient.send('ServiceWorker.enable');
      if (serviceWorkerClient) {
        await chrome.cdp.send('Target.detachFromTarget', { sessionId: serviceWorkerClient.sessionId });
        serviceWorkerClient = null;
      }
      await pageClient.send('ServiceWorker.stopAllWorkers');
      await waitForCondition(async () => !(await listTargets(chrome.cdp, [{ type: 'service_worker', exclude: false }]))
        .some(target => target.url === `chrome-extension://${extensionLoad.id}/background.js`), 'background worker stopping');
    }

    async function attachBackground({ start = false } = {}) {
      if (start) {
        await pageClient.send('ServiceWorker.startWorker', { scopeURL: `chrome-extension://${extensionLoad.id}/` });
      }
      serviceWorkerClient = await attachTarget(chrome.cdp, await waitForExtensionWorker(chrome.cdp, extensionLoad.id));
    }

    async function reloadPage() {
      await pageClient.evaluate('window.beforeNavigationReload = true');
      await pageClient.send('Page.reload');
      await waitForPageCondition(pageClient, `document.readyState === 'complete' && !window.beforeNavigationReload`, 'a fresh document after reload');
    }

    const tabId = injectionResult.tabId;
    log('stopping the background worker and reloading with Break on Load enabled');
    await waitForPageCondition(serviceWorkerClient, `readTabState(${tabId}).then(state => state.breakOnLoadEnabled)`, 'persisted Break on Load');
    await stopBackground();
    await reloadPage();
    await waitForPageCondition(pageClient, `document.querySelector('.element-picker-workspace-mode > span')?.textContent.includes('Picking')`, 'Break on Load after a background restart');
    await attachBackground();
    assert.match(await pageClient.evaluate(`document.querySelector('.element-picker-capture-options summary').textContent`), /break on load/);

    log('resuming Break on Load and sending captures across HTTP and HTTPS origins after cold worker starts');
    const crossOriginSubmissions = [];
    for (const url of [
      `http://${CROSS_ORIGIN_HOST}:${staticServer.port}${SMOKE_PATH}`,
      `${secureServer.baseUrl}${SMOKE_PATH}`,
      smokeUrl,
    ]) {
      const previousToken = await serviceWorkerClient.evaluate(`readTabState(${tabId}).then(state => state.delivery.token)`);
      await stopBackground();
      await pageClient.send('Page.navigate', { url });
      await waitForPageCondition(pageClient, `location.href === ${jsString(url)} && document.readyState === 'complete'`, 'the new origin loading');
      await attachBackground();
      const state = await waitForPageCondition(serviceWorkerClient, `readTabState(${tabId}).then(state =>
        state.delivery?.token !== ${jsString(previousToken)} && ['active', 'failed'].includes(state.delivery?.status) && state)`, 'cross-origin delivery settling');
      assert.equal(state.delivery.status, 'active', `reinjection on ${url}: ${state.delivery.error}`);
      await waitForPageCondition(pageClient, `document.querySelector('.element-picker-workspace-mode > span')?.textContent.includes('Picking')`, 'Break on Load on the new origin');
      assert.equal(state.breakOnLoadEnabled, true);
      assert.equal(await serviceWorkerClient.evaluate(`chrome.action.getBadgeText({tabId:${tabId}})`), '');
      await pageClient.evaluate(`(() => {
        const target = document.querySelector('#save-button');
        // A page-world React fiber: invisible to picker.js, readable by element-source-probe.js.
        target.__reactFiber$e2e = {
          tag: 5,
          _debugSource: { fileName: '/repo/src/ui/Button.tsx', lineNumber: 20 },
          return: {
            tag: 0,
            type: function SaveButton() {},
            key: 'primary-save',
            memoizedProps: { variant: 'primary', onSave() {}, children: 'Save' },
            _debugStack: { stack: 'Error: react-stack-top-frame\\n' +
              '    at exports.jsxDEV (' + location.origin + '/node_modules/.vite/deps/react_jsx-dev-runtime.js?v=1:250:30)\\n' +
              '    at ProfileForm (' + location.origin + '/src/settings/ProfileForm.tsx?t=17:40:7)' },
            return: { tag: 0, type: function ProfileForm() {}, key: null, memoizedProps: {}, return: null },
          },
        };
        const rect = target.getBoundingClientRect();
        target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true,
          clientX: rect.x + 4, clientY: rect.y + 4 }));
        document.querySelector('.element-picker-toolbar-comment').value = 'Cross-origin image capture';
      })()`);
      // Respect captureVisibleTab's two-calls-per-second quota across test sends.
      await new Promise(resolveDelay => setTimeout(resolveDelay, 600));
      await clickButton('Send capture');
      await waitForPageCondition(pageClient, `document.querySelector('.element-picker-handoff')?.dataset.state === 'success'`, 'cross-origin capture submission');
      const submission = await readSubmission(`Capture on ${new URL(url).origin}`);
      assert.equal(submission.bundle.page.url, url);
      assert.equal(submission.bundle.elements.length, 1);
      assert.equal(submission.bundle.elements[0].id, 'save-button');
      assert.deepEqual(submission.bundle.elements[0].source, {
        framework: 'react',
        elementSource: { file: '/repo/src/ui/Button.tsx', line: 20 },
        components: [
          { name: 'SaveButton', key: 'primary-save', usedAt: { file: '/src/settings/ProfileForm.tsx', line: 40, approximate: true } },
          { name: 'ProfileForm' },
        ],
        props: { variant: 'primary', onSave: '[function]' },
      }, 'capture must read page-world React source details');
      const markdown = await readFile(submission.manifest.files.markdown, 'utf8');
      assert.match(markdown, /Element written at: \/repo\/src\/ui\/Button\.tsx:20/);
      assert.match(markdown, /- <SaveButton key="primary-save"> used at \/src\/settings\/ProfileForm\.tsx:40 \(approx\. line\)/);
      assert.equal(submission.bundle.userComment, 'Cross-origin image capture');
      crossOriginSubmissions.push(submission);
    }

    log('continuing a cross-origin tour after stopping the worker during navigation');
    const firstUrl = await pageClient.evaluate('location.href');
    const secondUrl = `${secureServer.baseUrl}/tour-page-two?hold-tour=second`;
    const navigationTour = await fetch(`http://127.0.0.1:${inboxPort}/tours`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tour: { title: 'Navigation review', steps: [
        { id: 'page-one', url: firstUrl, selector: '#filter-input', title: 'Page one' },
        { id: 'page-two', url: secondUrl, selector: '#save-button', title: 'Page two' },
      ] } }),
    });
    assert.equal(navigationTour.status, 200);
    await clickButton('Tour');
    await clickButton('Load tour');
    await waitForPageCondition(pageClient, `document.querySelector('.element-picker-tour-title')?.textContent === 'Page one'`, 'navigation tour starting');
    await pageClient.evaluate(`(() => {
      const input = document.querySelector('.element-picker-tour-ask');
      input.value = 'Keep the first page note'; input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    navigationHold = secureServer.holdNavigation();
    await clickButton('Next');
    await waitForCondition(() => navigationHold.started, 'the second tour page request being held');
    await waitForPageCondition(serviceWorkerClient, `readTabState(${tabId}).then(state => state.delivery?.status === 'pending' && state.tour?.stepIndex === 1)`, 'persisted pending tour');
    await stopBackground();
    navigationHold.release();
    navigationHold = null;
    await waitForPageCondition(pageClient, `location.href === ${jsString(secondUrl)} && document.querySelector('.element-picker-tour-title')?.textContent === 'Page two'`, 'cross-origin continuation after a cold worker start');
    await attachBackground();
    assert.match(await pageClient.evaluate(`document.querySelector('.element-picker-tour-status').textContent`), /Highlighting/);
    assert.match(await pageClient.evaluate(`document.querySelector('.element-picker-capture-options summary').textContent`), /break on load/);
    await pageClient.evaluate(`(() => {
      const input = document.querySelector('.element-picker-tour-ask');
      input.value = 'Keep the second page note'; input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await waitForPageCondition(serviceWorkerClient, `readTabState(${tabId}).then(state => state.tour.askNotes.some(entry => entry[1] === 'Keep the second page note'))`, 'saved second-page note');
    await clickButton('Ask Codex');
    await waitForPageCondition(pageClient, `document.querySelector('.element-picker-handoff')?.dataset.state === 'success'`, 'tour submission from the HTTPS origin');
    const tourSubmission = await readSubmission('Tour on HTTPS');
    const crossOriginBundle = tourSubmission.bundle;
    assert.equal(crossOriginBundle.page.url, secondUrl);
    assert.equal(crossOriginBundle.tourContext.askText, 'Keep the second page note');
    assert.equal(crossOriginBundle.elements.length, 1);
    crossOriginSubmissions.push(tourSubmission);
    log(`cross-origin screenshot results: ${crossOriginSubmissions.map(({ label, bundle }) => `${label}: ${bundle.screenshot.status}`).join('; ')}`);
    for (const submission of crossOriginSubmissions) await assertSubmissionImages(submission);

    log('retaining a failed cross-origin tour reinjection, restarting, and retrying through the action handler');
    await serviceWorkerClient.evaluate(`(() => {
      const execute = chrome.scripting.executeScript.bind(chrome.scripting);
      chrome.scripting.executeScript = options => options.files?.includes('picker.js')
        ? Promise.reject(new Error('Controlled reinjection failure')) : execute(options);
    })()`);
    await clickButton('Back');
    await clickButton('Open Step');
    await waitForPageCondition(pageClient, `location.href === ${jsString(firstUrl)} && document.readyState === 'complete'`, 'the failed cross-origin tour destination loading');
    await waitForPageCondition(serviceWorkerClient, `readTabState(${tabId}).then(state => state.delivery?.status === 'failed')`, 'durable reinjection failure');
    assert.equal(await pageClient.evaluate(`!!document.querySelector('#__element-picker-toolbar')`), false);
    assert.equal(await serviceWorkerClient.evaluate(`chrome.action.getBadgeText({tabId:${tabId}})`), '!');
    await stopBackground();
    await attachBackground({ start: true });
    await serviceWorkerClient.evaluate(`(async () => handleActionClick(await chrome.tabs.get(${tabId})))()`);
    await waitForPageCondition(pageClient, `document.querySelector('.element-picker-tour-title')?.textContent === 'Page one'`, 'manual reinjection retry restoring the tour');
    assert.equal(await pageClient.evaluate(`document.querySelector('.element-picker-tour-ask').value`), 'Keep the first page note');
    assert.equal(await serviceWorkerClient.evaluate(`chrome.action.getBadgeText({tabId:${tabId}})`), '');
    await clickButton('Next');
    await waitForPageCondition(pageClient, `location.href === ${jsString(secondUrl)} && document.querySelector('.element-picker-tour-title')?.textContent === 'Page two'`, 'cross-origin continuation after retry');
    assert.equal(await pageClient.evaluate(`document.querySelector('.element-picker-tour-ask').value`), 'Keep the second page note');

    log('restoring an acknowledged tour on reload and clearing it explicitly');
    await stopBackground();
    await reloadPage();
    await waitForPageCondition(pageClient, `document.querySelector('.element-picker-tour-title')?.textContent === 'Page two'`, 'tour checkpoint after reload');
    await attachBackground();
    await clickButton('Back');
    await clickButton('Open Step');
    await waitForPageCondition(pageClient, `location.href === ${jsString(firstUrl)} && document.querySelector('.element-picker-tour-title')?.textContent === 'Page one'`, 'returning to the first tour page');
    assert.equal(await pageClient.evaluate(`document.querySelector('.element-picker-tour-ask').value`), 'Keep the first page note');
    await clickButton('End tour');
    await waitForPageCondition(serviceWorkerClient, `readTabState(${tabId}).then(state => !state.tour && state.breakOnLoadEnabled)`, 'ending the saved tour without disabling Break on Load');
    await pageClient.evaluate(`document.querySelector('.element-picker-capture-options').open = true`);
    await clickButton('Break Load On');
    await waitForPageCondition(serviceWorkerClient, `readTabState(${tabId}).then(state => !state.tour && !state.breakOnLoadEnabled)`, 'persisted explicit disable');
    await stopBackground();
    await reloadPage();
    await attachBackground();
    await serviceWorkerClient.evaluate(`readTabState(${tabId})`);
    assert.equal(await pageClient.evaluate(`!!document.querySelector('#__element-picker-toolbar')`), false, 'ended tours and disabled Break on Load must not return');

    log('checking both extensions together, opening QA Bridge before Vibe Digger');
    const diggerDir = join(workspaceRoot, 'vibe-digger-extension');
    await mkdir(diggerDir);
    for (const file of ['manifest.json', 'background.js', 'page-agent.js', 'content.js', 'icon16.png', 'icon48.png', 'icon128.png']) {
      await cp(join(PROJECT_DIR, '..', 'vibe-digger', file), join(diggerDir, file));
    }
    const diggerManifestPath = join(diggerDir, 'manifest.json');
    const diggerManifest = JSON.parse(await readFile(diggerManifestPath, 'utf8'));
    diggerManifest.name = 'Vibe Digger Coexistence E2E';
    diggerManifest.host_permissions = [`${staticServer.baseUrl}/*`];
    await writeFile(diggerManifestPath, JSON.stringify(diggerManifest));
    const diggerShadow = `document.querySelector('#__vibe_digger_host')?.shadowRoot`;

    async function observeProbe() {
      await pageClient.evaluate(`(() => {
        window.coexistProbeEvents = [];
        window.addEventListener('message', event => {
          if (event.source === window && event.data?.source === 'element-picker-vibe-probe')
            window.coexistProbeEvents.push(event.data);
        });
      })()`);
    }
    async function openBridge() {
      await serviceWorkerClient.evaluate(`(async () => handleActionClick(await chrome.tabs.get(${tabId})))()`);
      await waitForPageCondition(pageClient, `!!document.querySelector('#__element-picker-toolbar') && window.coexistProbeEvents.some(event => event.kind === 'probe.started')`, 'QA Bridge probe starting');
      await clickButton('Use page');
      await clickButton('Move');
      await clickButton('Move');
    }
    async function openDigger() {
      await diggerWorkerClient.evaluate(`(async () => {
        await chrome.scripting.executeScript({ target:{tabId:${tabId}}, files:['page-agent.js'], world:'MAIN' });
        await chrome.scripting.executeScript({ target:{tabId:${tabId}}, files:['content.js'] });
      })()`);
      await waitForPageCondition(pageClient, `!!${diggerShadow}?.querySelector('.vd-panel')`, 'Vibe Digger panel opening');
    }
    async function closeBridge() {
      await pageClient.evaluate('window.coexistProbeEvents = []');
      await clickButton('Close');
      await waitForPageCondition(pageClient, `!window.__elementPickerVibeProbeInstalled && window.coexistProbeEvents.some(event => event.kind === 'probe.stopped')`, 'QA Bridge probe stopping');
    }
    async function exerciseBoth(marker, bridgeActive) {
      await pageClient.evaluate('window.coexistProbeEvents = []');
      const result = await pageClient.evaluate(`(async () => {
        const response = await fetch(${jsString(`${SMOKE_PATH}?coexist-fetch=${marker}`)});
        const body = await response.text();
        const xhrStatus = await new Promise((resolveXhr, rejectXhr) => {
          const xhr = new XMLHttpRequest();
          xhr.open('GET', ${jsString(`${SMOKE_PATH}?coexist-xhr=${marker}`)});
          xhr.onload = () => resolveXhr(xhr.status);
          xhr.onerror = () => rejectXhr(new Error('Coexistence XHR failed'));
          xhr.send();
        });
        console.warn(${jsString(`coexist-warning-${marker}`)});
        return { status: response.status, bodyLength: body.length, xhrStatus };
      })()`);
      assert.equal(result.status, 200);
      assert.ok(result.bodyLength > 0);
      assert.equal(result.xhrStatus, 200);
      await pageClient.evaluate(`${diggerShadow}.querySelector('[data-view="network"]').click()`);
      await waitForPageCondition(pageClient, `(() => {
        const rows = [...${diggerShadow}.querySelectorAll('.vd-net')];
        return ['coexist-fetch=', 'coexist-xhr='].every(kind => rows.some(row =>
          row.textContent.includes(kind + ${jsString(marker)}) && row.querySelector('.vd-net-status')?.textContent === '200'));
      })()`, 'Vibe Digger HTTP capture during coexistence');
      await pageClient.evaluate(`${diggerShadow}.querySelector('[data-view="issues"]').click()`);
      await waitForPageCondition(pageClient, `${diggerShadow}.querySelector('.vd-body').textContent.includes(${jsString(`coexist-warning-${marker}`)})`, 'Vibe Digger console capture during coexistence');
      if (bridgeActive) {
        await waitForPageCondition(pageClient, `window.coexistProbeEvents.some(event => event.kind === 'console.warn')`, 'QA Bridge console observation');
        const kinds = await pageClient.evaluate('window.coexistProbeEvents.map(event => event.kind)');
        for (const kind of ['network.fetch.start', 'network.fetch.end', 'network.xhr.start', 'network.xhr.end', 'console.warn']) {
          assert.equal(kinds.filter(value => value === kind).length, 1, `${marker}: one active QA observer per event`);
        }
      } else {
        assert.equal(await pageClient.evaluate('window.coexistProbeEvents.length'), 0, 'a stopped QA probe must remain silent');
      }
    }

    await observeProbe();
    assert.equal(await pageClient.evaluate('!!window.__vibeDiggerAgentInstalled'), false);
    await openBridge();
    const diggerLoad = await chrome.cdp.send('Extensions.loadUnpacked', { path: diggerDir });
    diggerWorkerClient = await attachTarget(chrome.cdp, await waitForExtensionWorker(chrome.cdp, diggerLoad.id));
    await openDigger();
    for (const order of ['bridge-first', 'digger-first']) {
      if (order === 'digger-first') {
        log('checking both extensions together, opening Vibe Digger before QA Bridge');
        await reloadPage();
        await observeProbe();
        await openDigger();
        assert.equal(await pageClient.evaluate('!!window.__elementPickerVibeProbeInstalled'), false);
        await openBridge();
      }
      await exerciseBoth(`${order}-active`, true);
      navigationHold = staticServer.holdNavigation();
      await pageClient.evaluate(`window.coexistPendingFetch = fetch(${jsString(`${SMOKE_PATH}?hold-tour=fetch-${order}`)}).then(response => response.text()); true`);
      await waitForCondition(() => navigationHold.started, 'the in-flight coexistence request being held');
      await closeBridge();
      await exerciseBoth(`${order}-closed`, false);
      await openBridge();
      await pageClient.evaluate('window.coexistProbeEvents = []');
      navigationHold.release();
      navigationHold = null;
      await pageClient.evaluate('window.coexistPendingFetch');
      assert.equal(await pageClient.evaluate(`window.coexistProbeEvents.some(event => event.kind === 'network.fetch.end')`), false, 'a retired installation must not emit into the reopened bridge');
      await exerciseBoth(`${order}-reopened`, true);
      await closeBridge();
      await exerciseBoth(`${order}-closed-again`, false);
    }

    log(`pass: ${latestTrace.manifest.traceId}`);
    log(`artifacts: ${join(inboxRoot, 'traces', 'latest')}`);
  } finally {
    navigationHold?.release();
    pageClient?.close();
    serviceWorkerClient?.close();
    diggerWorkerClient?.close();
    await chrome?.close();
    await inbox?.close();
    await secureServer?.close();
    await staticServer.close();

    if (process.env.CODEX_QA_E2E_KEEP_ARTIFACTS === '1') {
      log(`kept artifacts in ${workspaceRoot}`);
    } else {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
