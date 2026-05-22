#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = resolve(TEST_DIR, '..');
const SERVER_PATH = join(PROJECT_DIR, 'scripts', 'codex-qa-inbox-server.mjs');
const SMOKE_PATH = '/smoke/vibe-debugger-smoke.html';
const LOCAL_INBOX_PORT_TOKEN = '43117';

const REQUIRED_EXTENSION_FILES = [
  'manifest.json',
  'background.js',
  'picker.js',
  'picker.css',
  'vibe-page-probe.js',
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

async function startStaticServer(rootDir) {
  const port = await getFreePort();
  const server = createHttpServer(async (request, response) => {
    try {
      const url = new URL(request.url || '/', `http://127.0.0.1:${port}`);
      const pathname = url.pathname === '/' ? SMOKE_PATH : url.pathname;
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
  });

  await new Promise((resolveListen) => {
    server.listen(port, '127.0.0.1', resolveListen);
  });

  return {
    port,
    baseUrl: `http://127.0.0.1:${port}`,
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

async function copyExtensionForPort(sourceDir, destinationDir, inboxPort, pagePort) {
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
  manifest.host_permissions = [
    `http://127.0.0.1:${inboxPort}/*`,
    `http://127.0.0.1:${pagePort}/*`,
  ];
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
      throw new Error(result.exceptionDetails.text || 'Runtime evaluation failed');
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
  const startedAt = Date.now();
  let lastError = null;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const value = await pageClient.evaluate(expression);
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

  try {
    await copyExtensionForPort(PROJECT_DIR, extensionDir, inboxPort, staticServer.port);
    inbox = await startInboxServer(inboxRoot, inboxPort);

    const browserPath = await findBrowserExecutable();
    log(`launching ${basename(browserPath)}`);
    chrome = await startBrowser({
      browserPath,
      profileDir,
      pageUrl: smokeUrl,
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

    log('driving watch, record, page interactions, and trace export');
    await pageClient.evaluate(`(async () => {
      const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const buttonByText = (text) => Array.from(document.querySelectorAll('#__element-picker-toolbar button'))
        .find((button) => button.textContent.trim() === text);
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
      click(save);
      await delay(80);
      click(buttonByText('Watch'));
      await delay(80);
      click(buttonByText('Record'));
      await delay(120);
      click(buttonByText('Resume'));
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

    const latestManifestPath = join(inboxRoot, 'traces', 'latest', 'manifest.json');
    const latestMarkdownPath = join(inboxRoot, 'traces', 'latest', 'trace.md');
    const latestManifest = JSON.parse(await readFile(latestManifestPath, 'utf8'));
    const latestMarkdown = await readFile(latestMarkdownPath, 'utf8');

    assert.equal(latestManifest.traceId, latestTrace.manifest.traceId);
    assert.match(latestMarkdown, /Vibe Debugger Trace/);
    assert.match(latestMarkdown, /Recent Diffs|Timeline/);

    log(`pass: ${latestTrace.manifest.traceId}`);
    log(`artifacts: ${join(inboxRoot, 'traces', 'latest')}`);
  } finally {
    pageClient?.close();
    serviceWorkerClient?.close();
    await chrome?.close();
    await inbox?.close();
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
