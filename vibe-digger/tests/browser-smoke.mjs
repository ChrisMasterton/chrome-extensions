import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const shadow = `(document.querySelector('#__vibe_digger_host')?.shadowRoot)`;
function log(message) { console.log('[vibe-digger-e2e] ' + message); }
async function freePort() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
async function waitFor(check, label, timeout = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 80));
  }
  throw new Error('Timed out: ' + label);
}
async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode) return;
  child.kill('SIGTERM');
  await waitFor(() => child.exitCode !== null || child.signalCode, 'process exit', 3000);
}
async function browserExecutable() {
  for (const path of [process.env.BROWSER_PATH, process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/usr/bin/chromium'].filter(Boolean)) {
    try { await access(path); return path; } catch {}
  }
  throw new Error('Set BROWSER_PATH to Chrome, Edge, or Chromium.');
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


async function run() {
  const temp = await mkdtemp(join(tmpdir(), 'vibe-digger-e2e-'));
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  let demo, browser, cdp;
  try {
    const extensionDir = join(temp, 'extension');
    await cp(ROOT, extensionDir, { recursive: true, filter: source => !source.includes('/node_modules') && !source.includes('/tests') });
    const manifestPath = join(extensionDir, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.host_permissions = [baseUrl + '/*'];
    await writeFile(manifestPath, JSON.stringify(manifest));
    demo = spawn(process.execPath, [join(ROOT, 'scripts/demo-server.mjs')], {
      env: { ...process.env, PORT: String(port) }, stdio: 'ignore',
    });
    await waitFor(async () => { try { return (await fetch(baseUrl)).ok; } catch { return false; } }, 'demo server');
    browser = spawn(await browserExecutable(), [
      '--user-data-dir=' + join(temp, 'profile'), '--remote-debugging-pipe', '--enable-unsafe-extension-debugging',
      '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-sync',
      '--headless=new', '--window-size=1280,720', 'about:blank',
    ], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
    cdp = new PipeCdpClient(browser.stdio[3], browser.stdio[4]);
    await cdp.send('Browser.getVersion');
    const extension = await cdp.send('Extensions.loadUnpacked', { path: extensionDir });
    const { targetId } = await cdp.send('Target.createTarget', { url: baseUrl });
    let pageTarget, workerTarget;
    await waitFor(async () => {
      const { targetInfos } = await cdp.send('Target.getTargets');
      pageTarget = targetInfos.find(target => target.targetId === targetId);
      workerTarget = targetInfos.find(target => target.type === 'service_worker' && target.url === `chrome-extension://${extension.id}/background.js`);
      return pageTarget && workerTarget;
    }, 'extension and page targets');
    const page = await attachTarget(cdp, pageTarget);
    const worker = await attachTarget(cdp, workerTarget);
    const wait = (expression, label) => waitFor(() => page.evaluate(expression), label);
    // The bundled demo uses the pinned React 18 development scripts from cdnjs.
    await wait(`!!document.querySelector('#root main')`, 'the real React demo to render (requires cdnjs access)');
    const tabId = await worker.evaluate(`(async () => {
      const tabs = await chrome.tabs.query({});
      const tab = tabs.find(tab => tab.url?.startsWith(${JSON.stringify(baseUrl)}));
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['page-agent.js'], world: 'MAIN' });
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
      return tab.id;
    })()`);
    await wait(`!!${shadow}?.querySelector('.vd-panel')`, 'overlay');
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
    async function view(name) { await page.evaluate(`${shadow}.querySelector('[data-view="${name}"]').click()`); }
    async function uiButton(label) {
      await page.evaluate(`(() => {
        const button = [...${shadow}.querySelectorAll('button')].find(button => button.textContent.trim() === ${JSON.stringify(label)});
        if (!button || button.disabled) throw new Error('Unavailable button: ' + ${JSON.stringify(label)});
        button.click();
      })()`);
    }
    async function appButton(label) {
      await page.evaluate(`(() => {
        const button = [...document.querySelectorAll('#root button')].find(button => button.textContent.trim() === ${JSON.stringify(label)});
        if (!button) throw new Error('Missing demo button: ' + ${JSON.stringify(label)});
        button.click();
      })()`);
    }
    async function capture(name) {
      if (!process.env.VIBE_DIGGER_E2E_SCREENSHOT_DIR) return;
      await mkdir(process.env.VIBE_DIGGER_E2E_SCREENSHOT_DIR, { recursive: true });
      const { data } = await page.send('Page.captureScreenshot', { format: 'png' });
      await writeFile(join(process.env.VIBE_DIGGER_E2E_SCREENSHOT_DIR, name + '.png'), Buffer.from(data, 'base64'));
    }
    async function isolated(expression) {
      return worker.evaluate(`(async () => {
        const [result] = await chrome.scripting.executeScript({ target: { tabId: ${tabId} }, func: () => { ${expression} } });
        return result.result;
      })()`);
    }
    async function key(key, code = key, value = 0) {
      await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: value, ...(key === 'Enter' ? { text: '\r' } : {}) });
      await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: value });
    }
    async function clickPoint(x, y) {
      await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
      await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
      await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    }

    log('checking stable frame, view navigation, and real React inspection');
    const rect = () => page.evaluate(`(() => {
      const r = ${shadow}.querySelector('.vd-panel').getBoundingClientRect();
      const t = ${shadow}.querySelector('.vd-tabs').getBoundingClientRect();
      return [r.x, r.y, r.width, r.height, t.y];
    })()`);
    const initialRect = await rect();
    await view('network'); assert.deepEqual(await rect(), initialRect);
    await view('issues'); assert.deepEqual(await rect(), initialRect);
    await view('inspect');
    await page.evaluate(`${shadow}.querySelector('[data-view="inspect"]').focus()`);
    await key('ArrowRight');
    assert.equal(await page.evaluate(`${shadow}.querySelector('[aria-selected="true"]').dataset.view`), 'network');
    await uiButton('Pick element');
    const point = await page.evaluate(`(() => {
      const r = document.querySelector('#root main button').getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()`);
    await clickPoint(point.x, point.y);
    await wait(`${shadow}.querySelector('.vd-body').textContent.includes('#0 state: 0')`, 'Counter hook inspection');
    await key('Escape', 'Escape', 27);
    await uiButton('Heatmap');
    await wait(`${shadow}.querySelectorAll('.vd-flash').length > 0`, 'real React commit heatmap');
    await capture('vibe-inspect');

    log('checking live network disclosures, request bodies, and reading position');
    await view('network');
    await wait(`${shadow}.querySelectorAll('.vd-net').length > 0`, 'boot request capture');
    await page.evaluate(`${shadow}.querySelector('.vd-net .vd-row-toggle').focus()`);
    await key('Enter', 'Enter', 13);
    await wait(`${shadow}.querySelector('.vd-net .vd-row-toggle').getAttribute('aria-expanded') === 'true'`, 'keyboard disclosure');
    const firstId = await page.evaluate(`${shadow}.querySelector('.vd-net').dataset.id`);
    await appButton('Save vibes (POST /api/echo)');
    await wait(`${shadow}.querySelector('.vd-body').textContent.includes('/api/echo')`, 'POST capture');
    assert.equal(await page.evaluate(`${shadow}.querySelector('.vd-net').classList.contains('expanded')`), true);
    await page.evaluate(`Promise.all(Array.from({length: 12}, (_, i) => fetch('/api/items?sample=' + i)))`);
    await wait(`${shadow}.querySelectorAll('.vd-net').length >= 14`, 'streamed requests');
    await page.evaluate(`${shadow}.querySelector('.vd-body').scrollTop = 100`);
    const scrollTop = await page.evaluate(`${shadow}.querySelector('.vd-body').scrollTop`);
    await appButton('Save vibes (POST /api/echo)');
    await wait(`${shadow}.querySelectorAll('.vd-net').length >= 15`, 'new request while reading');
    assert.equal(await page.evaluate(`${shadow}.querySelector('.vd-body').scrollTop`), scrollTop);
    assert.equal(await page.evaluate(`[...${shadow}.querySelectorAll('.vd-net')].find(row => row.dataset.id === ${JSON.stringify(firstId)}).classList.contains('expanded')`), true);
    await appButton('Connect to /ws/echo');
    await wait(`document.querySelector('#root').textContent.includes('socket open')`, 'WebSocket open');
    await appButton('Send a vibe frame');
    await wait(`document.querySelector('#root').textContent.includes('recv:')`, 'WebSocket echo');
    await appButton('Close (1000)');
    await wait(`${shadow}.querySelector('.vd-body').textContent.includes('closed')`, 'WebSocket close evidence');
    await capture('vibe-network');

    log('checking issue disclosures survive new issues');
    await view('issues');
    await appButton('Throw an async error');
    await wait(`${shadow}.querySelector('.vd-issue .vd-row-toggle[aria-expanded]')`, 'error detail');
    await page.evaluate(`${shadow}.querySelector('.vd-issue .vd-row-toggle[aria-expanded]').focus()`);
    await key('Enter', 'Enter', 13);
    const issueId = await page.evaluate(`${shadow}.querySelector('.vd-issue.expanded').dataset.id`);
    await appButton('console.warn');
    await wait(`${shadow}.querySelector('.vd-body').textContent.includes('Manual warning')`, 'new warning');
    assert.equal(await page.evaluate(`[...${shadow}.querySelectorAll('.vd-issue')].find(row => row.dataset.id === ${JSON.stringify(issueId)}).classList.contains('expanded')`), true);
    await capture('vibe-issues');

    log('checking delayed clipboard acknowledgement, failure, and retry');
    await isolated(`
      globalThis.originalClipboardWrite = navigator.clipboard.writeText.bind(navigator.clipboard);
      globalThis.originalExecCommand = document.execCommand.bind(document);
      navigator.clipboard.writeText = text => new Promise((resolve, reject) => {
        globalThis.pendingClipboard = { text, resolve, reject };
      });
    `);
    await uiButton('Copy capture');
    await wait(`${shadow}.querySelector('.vd-feedback').dataset.state === 'pending'`, 'pending capture copy');
    assert.equal(await page.evaluate(`${shadow}.querySelector('.vd-copy-capture').disabled`), true);
    assert.doesNotMatch(await page.evaluate(`${shadow}.querySelector('.vd-feedback').textContent`), /copied/i);
    await waitFor(() => isolated('return Boolean(globalThis.pendingClipboard)'), 'clipboard write pending');
    const payload = await isolated('return globalThis.pendingClipboard.text');
    assert.match(payload, /Counter|React/); assert.match(payload, /api\/echo/);
    assert.match(payload, /Async vibes went sideways/);
    await isolated('return globalThis.originalClipboardWrite(globalThis.pendingClipboard.text).then(globalThis.pendingClipboard.resolve, globalThis.pendingClipboard.reject);');
    await wait(`${shadow}.querySelector('.vd-feedback').textContent === 'Capture copied.'`, 'copy acknowledgement');
    await isolated(`navigator.clipboard.writeText = async () => { throw new Error('Clipboard blocked in test'); }; document.execCommand = () => false;`);
    await uiButton('Copy capture');
    await wait(`${shadow}.querySelector('.vd-feedback').dataset.state === 'error'`, 'copy failure feedback');
    await capture('vibe-copy-error');
    await isolated(`navigator.clipboard.writeText = async text => { globalThis.copiedCapture = text; await globalThis.originalClipboardWrite(text); }; document.execCommand = globalThis.originalExecCommand;`);
    await uiButton('Copy capture');
    await wait(`${shadow}.querySelector('.vd-feedback').dataset.state === 'success'`, 'copy retry');
    await view('network');
    await page.evaluate(`${shadow}.querySelector('button[aria-label="Copy Network view"]').click()`);
    await wait(`${shadow}.querySelector('.vd-feedback').textContent.includes('network view')`, 'scoped copy');
    assert.match(await isolated('return globalThis.copiedCapture'), /Network/);

    log('checking minimize, restore, capture continuity, and narrow-window actions');
    await uiButton('Pick element');
    await page.evaluate(`${shadow}.querySelector('[aria-label="Minimize Vibe Digger to bottom left"]').click()`);
    assert.equal(await page.evaluate(`${shadow}.querySelector('.vd-minimized').classList.contains('visible')`), true);
    await page.evaluate(`fetch('/api/items?minimized=1')`);
    await page.evaluate(`${shadow}.querySelector('.vd-minimized').click()`);
    assert.equal(await page.evaluate(`${shadow}.querySelector('.vd-toolbar button').getAttribute('aria-pressed')`), 'false');
    await view('network');
    assert.match(await page.evaluate(`${shadow}.querySelector('.vd-body').textContent`), /minimized=1/);
    await page.send('Emulation.setDeviceMetricsOverride', { width: 360, height: 480, deviceScaleFactor: 1, mobile: false });
    await page.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    assert.equal(await page.evaluate(`(() => {
      const root = ${shadow}; const button = root.querySelector('.vd-copy-capture'); const r = button.getBoundingClientRect();
      return r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth && button.contains(root.elementFromPoint(r.x + r.width/2, r.y + r.height/2));
    })()`), true, 'Copy capture must stay visible in a short, narrow window');
    await capture('vibe-small');
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
    await capture('vibe-final');
    log('passed: React inspect/heatmap, stable views, network/WebSocket capture, keyboard disclosures, live reading position, copy acknowledgement/failure/retry, and minimize/restore');
  } finally {
    cdp?.close();
    await stop(browser); await stop(demo);
    await rm(temp, { recursive: true, force: true });
  }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
