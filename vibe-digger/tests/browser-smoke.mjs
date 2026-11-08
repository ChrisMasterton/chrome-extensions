import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
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

async function reactDevToolsExtension() {
  if (process.env.REACT_DEVTOOLS_EXTENSION_PATH) return resolve(process.env.REACT_DEVTOOLS_EXTENSION_PATH);
  for (const browser of ['Google/Chrome','Microsoft Edge']) {
    const root = join(homedir(),'Library','Application Support',browser,'Default','Extensions','fmkadmapgofadopljbjfkapdkoienihi');
    let versions;
    try { versions = await readdir(root); } catch { continue; }
    for (const version of versions.sort((a,b) => b.localeCompare(a,undefined,{numeric:true}))) {
      const path = join(root,version);
      try { await access(join(path,'manifest.json')); return path; } catch {}
    }
  }
  throw new Error('Set REACT_DEVTOOLS_EXTENSION_PATH to an unpacked React Developer Tools extension for coexistence verification.');
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
  const lateUrl = `http://localhost:${port}`;
  let demo, browser, cdp;
  try {
    const extensionDir = join(temp, 'extension');
    await cp(ROOT, extensionDir, { recursive: true, filter: source => !source.includes('/node_modules') && !source.includes('/tests') });
    const manifestPath = join(extensionDir, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.host_permissions = [baseUrl + '/*',lateUrl + '/*'];
    // Keep localhost on demand in this isolated fixture so the same real demo
    // can prove late injection without changing the shipped manifest.
    manifest.content_scripts[0].matches = ['http://127.0.0.1/*'];
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

    async function reactStatus() {
      return page.evaluate(`new Promise(resolve => {
        function receive(event) {
          if(event.source !== window || event.data?.source !== 'vibe-digger-agent' || event.data.kind !== 'status') return;
          window.removeEventListener('message',receive); resolve(event.data.details);
        }
        window.addEventListener('message',receive);
        window.postMessage({source:'vibe-digger-control',command:'hello'},'*');
      })`);
    }
    async function attachDigger() {
      await worker.evaluate(`(async () => {
        await chrome.scripting.executeScript({target:{tabId:${tabId}},files:['page-agent.js'],world:'MAIN'});
        await chrome.scripting.executeScript({target:{tabId:${tabId}},files:['content.js']});
      })()`);
      await wait(`!!${shadow}?.querySelector('.vd-panel')`,'attached panel');
    }
    async function inspectCounter() {
      await uiButton('Pick element');
      const point = await page.evaluate(`(() => { const r=document.querySelector('#root main button').getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
      await clickPoint(point.x,point.y);
      await wait(`${shadow}.querySelector('.vd-body').textContent.includes('#0 state: 0')`,'late Counter inspection');
      await key('Escape','Escape',27);
    }

    log('checking stable frame, view navigation, and real React inspection');
    const earlyStatus = await reactStatus();
    assert.equal(earlyStatus.hookMode,'shim');
    assert.equal(earlyStatus.attachment.phase,'attached');
    assert.equal(earlyStatus.heatmapAvailable,true);
    assert.ok(earlyStatus.commitCount > 0,'document_start must observe the initial React mount');
    if (!process.env.VIBE_DIGGER_E2E_ATTACHMENT_ONLY) {
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

    log('checking issue retention, deduplication, clearing, and stale-message recovery');
    const issueRows = () => page.evaluate(`[...${shadow}.querySelectorAll('.vd-issue')].reverse().map(row => ({
      id: row.dataset.id, message: row.querySelector('.vd-issue-msg').textContent,
      count: Number(row.querySelector('.vd-issue-count').textContent.slice(1))
    }))`);
    async function agentIssues() {
      return page.evaluate(`new Promise(resolve => {
        function receive(event) {
          if (event.source !== window || event.data?.source !== 'vibe-digger-agent' || event.data.kind !== 'issues') return;
          window.removeEventListener('message', receive);
          resolve(event.data.details);
        }
        window.addEventListener('message', receive);
        window.postMessage({source:'vibe-digger-control',command:'get-issues'}, '*');
      })`);
    }
    async function assertIssuesAgree() {
      // Read the live projection before requesting a snapshot, so a refresh
      // cannot hide divergence between the stream and the authoritative list.
      const live = await issueRows();
      const snapshot = await agentIssues();
      assert.deepEqual(live, snapshot.issues.map(({id, message, count}) => ({id, message, count})));
      assert.equal(await page.evaluate(`${shadow}.querySelector('[data-view="issues"] .vd-badge').textContent`), String(live.length));
      return snapshot;
    }
    await view('issues');
    await uiButton('Clear all');
    await wait(`${shadow}.querySelectorAll('.vd-issue').length === 0`, 'cleared issues');
    await page.evaluate(`console.warn('retention-issue-0\\noriginal detail')`);
    await wait(`${shadow}.querySelectorAll('.vd-issue').length === 1`, 'first retained issue');
    await page.evaluate(`${shadow}.querySelector('.vd-issue .vd-row-toggle').click()`);
    const evictedId = await page.evaluate(`${shadow}.querySelector('.vd-issue').dataset.id`);
    await page.evaluate(`for (let i = 1; i < 205; i++) console.warn('retention-issue-' + i)`);
    await wait(`${shadow}.querySelector('.vd-body').textContent.includes('retention-issue-204')`, 'live issue burst');
    assert.equal(await page.evaluate(`${shadow}.querySelectorAll('.vd-issue').length`), 200,
      'the live panel must retain the same 200 issues as the page agent');
    assert.equal((await issueRows()).some(row => row.id === evictedId), false);
    assert.equal((await issueRows())[0].message, 'retention-issue-5');
    const originalDuplicate = (await issueRows()).find(row => row.message === 'retention-issue-100');
    await page.evaluate(`console.warn('retention-issue-100\\nrepeat detail')`);
    await wait(`[...${shadow}.querySelectorAll('.vd-issue')].some(row => row.dataset.id === ${JSON.stringify(originalDuplicate.id)} && row.querySelector('.vd-issue-count').textContent === '×2')`, 'deduplicated issue count');
    const beforeClear = await assertIssuesAgree();
    await uiButton('Clear all');
    await wait(`${shadow}.querySelectorAll('.vd-issue').length === 0`, 'issue clear acknowledgement');
    // Replay real pre-clear data through the isolated-world event boundary.
    await isolated(`
      for (const data of ${JSON.stringify([
        { source: 'vibe-digger-agent', kind: 'issues', details: beforeClear },
        { source: 'vibe-digger-agent', kind: 'issue', details: { issue: beforeClear.issues[0], revision: beforeClear.revision, removedIds: [] } },
      ])}) window.dispatchEvent(new MessageEvent('message', { source: window, data }));
    `);
    assert.equal((await issueRows()).length, 0, 'old snapshots and deltas must not undo Clear all');
    await page.evaluate(`console.warn('retention-issue-100\\nfresh detail')`);
    await wait(`${shadow}.querySelectorAll('.vd-issue').length === 1`, 'new observation after clear');
    const fresh = (await issueRows())[0];
    assert.notEqual(fresh.id, originalDuplicate.id);
    assert.equal(fresh.count, 1);
    assert.equal(await page.evaluate(`${shadow}.querySelector('.vd-issue').classList.contains('expanded')`), false);

    const current = await assertIssuesAgree();
    await page.evaluate(`window.issueResyncRequests = 0; window.addEventListener('message', event => {
      if (event.source === window && event.data?.source === 'vibe-digger-control' && event.data.command === 'get-issues') window.issueResyncRequests++;
    })`);
    await isolated(`window.dispatchEvent(new MessageEvent('message', { source: window, data: ${JSON.stringify({
      source: 'vibe-digger-agent', kind: 'issue', details: {
        revision: current.revision + 2, removedIds: [], issue: { ...fresh, id: 'missed-update', message: 'unverified delta' },
      },
    })} }));`);
    await wait(`window.issueResyncRequests > 0`, 'automatic issue snapshot recovery');
    await page.evaluate(`console.warn('after issue resync')`);
    await wait(`${shadow}.querySelectorAll('.vd-issue').length === 2`, 'capture after issue resync');
    assert.equal((await issueRows()).some(row => row.id === 'missed-update'), false);
    await assertIssuesAgree();

    log('checking issue capture while hidden, reopening, and issue clipboard exports');
    await page.evaluate(`${shadow}.querySelector('[aria-label="Minimize Vibe Digger to bottom left"]').click(); console.warn('issue while minimized')`);
    await wait(`${shadow}.querySelector('.vd-minimized').textContent.includes('3 issues')`, 'minimized issue count');
    await page.evaluate(`${shadow}.querySelector('.vd-minimized').click()`);
    await assertIssuesAgree();
    await page.evaluate(`${shadow}.querySelector('[aria-label="Close Vibe Digger"]').click(); console.warn('issue while closed')`);
    await worker.evaluate(`chrome.tabs.sendMessage(${tabId}, {type:'VIBE_DIGGER_TOGGLE'})`);
    await wait(`!!${shadow}.querySelector('.vd-panel')`, 'panel reopening');
    await view('issues');
    await wait(`${shadow}.querySelectorAll('.vd-issue').length === 4`, 'retained issues after reopening');
    await assertIssuesAgree();
    await page.evaluate(`${shadow}.querySelector('button[aria-label="Copy Issues view"]').click()`);
    await wait(`${shadow}.querySelector('.vd-feedback').textContent.includes('issues view')`, 'scoped issue copy');
    const issuesCopy = await isolated('return globalThis.copiedCapture');
    assert.match(issuesCopy, /Vibe Digger Issues \(4\)/);
    assert.match(issuesCopy, /issue while closed/);
    assert.doesNotMatch(issuesCopy, /retention-issue-5\b/);
    await uiButton('Copy capture');
    await wait(`${shadow}.querySelector('.vd-feedback').textContent === 'Capture copied.'`, 'capture copy after issue reset');
    assert.match(await isolated('return globalThis.copiedCapture'), /## Issues \(4\)/);

    log('checking Network clear while HTTP and WebSocket work is still active');
    const networkIds = () => page.evaluate(`[...${shadow}.querySelectorAll('.vd-net')].map(row => row.dataset.id)`);
    async function agentNetwork() {
      return page.evaluate(`new Promise(resolve => {
        function receive(event) {
          if (event.source !== window || event.data?.source !== 'vibe-digger-agent' || event.data.kind !== 'network-list') return;
          window.removeEventListener('message', receive); resolve(event.data.details);
        }
        window.addEventListener('message', receive);
        window.postMessage({source:'vibe-digger-control',command:'get-network'}, '*');
      })`);
    }
    async function assertNetworkAgrees() {
      const liveIds = await networkIds();
      const snapshot = await agentNetwork();
      assert.deepEqual(liveIds, snapshot.entries.map(entry => entry.id));
      assert.equal(await page.evaluate(`${shadow}.querySelector('[data-view="network"] .vd-badge').textContent`), String(liveIds.length));
      return snapshot;
    }
    async function networkStatus(marker, status) {
      await wait(`[...${shadow}.querySelectorAll('.vd-net')].some(row => row.querySelector('.vd-net-path').textContent.includes(${JSON.stringify(marker)}) && row.querySelector('.vd-net-status').textContent === ${JSON.stringify(status)})`, 'network status ' + marker + ': ' + status);
    }
    await view('network');
    const staleNetwork = await agentNetwork();
    await uiButton('Clear all');
    await wait(`${shadow}.querySelectorAll('.vd-net').length === 0`, 'initial Network clear');
    await page.evaluate(`
      window.nativeXhr = (url, outcome) => new Promise(resolve => {
        const xhr = new XMLHttpRequest(); xhr.open('GET',url);
        if (outcome === 'timeout') xhr.timeout = 20;
        xhr.addEventListener('loadend', () => resolve(xhr.status)); xhr.send();
        if (outcome === 'abort') setTimeout(() => xhr.abort(),20);
      });
      window.pendingClearFetch = fetch('/api/slow?clear-fetch').then(response => response.json());
      window.pendingClearXhr = nativeXhr('/api/slow?clear-xhr');
      window.openCaptureSocket = () => new Promise((resolve,reject) => {
        const socket = new WebSocket(location.origin.replace('http','ws') + '/ws/echo');
        socket.replies = []; socket.addEventListener('message', event => socket.replies.push(event.data));
        socket.addEventListener('open', () => resolve(socket), {once:true});
        socket.addEventListener('error', reject, {once:true});
      });
      true;
    `);
    await page.evaluate(`openCaptureSocket().then(socket => { window.retiredSocket = socket; socket.send('before clear'); })`);
    await wait(`retiredSocket.replies.length === 1`, 'native reply before clear');
    await uiButton('Clear all');
    await wait(`${shadow}.querySelectorAll('.vd-net').length === 0`, 'clear active requests and socket');
    await page.evaluate(`retiredSocket.send('after clear')`);
    await wait(`retiredSocket.replies.length === 2`, 'native traffic continues after clear');
    const clearedResults = await page.evaluate(`Promise.all([pendingClearFetch, pendingClearXhr])`);
    assert.equal(clearedResults[0].finally, 'worth the wait'); assert.equal(clearedResults[1], 200);
    await page.evaluate(`new Promise(resolve => { retiredSocket.addEventListener('close', resolve, {once:true}); retiredSocket.close(1000); })`);
    await page.evaluate(`new Promise(resolve => setTimeout(resolve,300))`);
    assert.equal((await networkIds()).length, 0, 'retired completions and socket timers must not recreate rows');
    await isolated(`for (const data of ${JSON.stringify([
      { source:'vibe-digger-agent',kind:'network-list',details:staleNetwork },
      { source:'vibe-digger-agent',kind:'network',details:{entry:staleNetwork.entries[0],revision:staleNetwork.revision,removedIds:[]} },
    ])}) window.dispatchEvent(new MessageEvent('message',{source:window,data}));`);
    assert.equal((await networkIds()).length, 0, 'stale Network messages cannot undo clear');
    await assertNetworkAgrees();
    assert.equal((await agentIssues()).issues.length, 4, 'Network clear must preserve Issues');

    log('checking native HTTP outcomes, beacon acceptance/rejection, and matching export status');
    const nativePayload = await page.evaluate(`fetch('/api/echo?http-post',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({message:'native response',token:'fixture-secret'})}).then(response => response.json())`);
    assert.equal(nativePayload.echoed.token, 'fixture-secret', 'capture must not change native response bodies');
    await page.evaluate(`Promise.all([
      fetch('/api/missing?http-404'), nativeXhr('/api/items?xhr-ok'), nativeXhr('/api/missing?xhr-404'),
      nativeXhr('/api/slow?xhr-abort','abort'), nativeXhr('/api/slow?xhr-timeout','timeout'),
      fetch('http://127.0.0.1:1/network-error').catch(error => error.name),
      (async () => { const control = new AbortController(); const request = fetch('/api/slow?fetch-abort',{signal:control.signal}).catch(error => error.name); control.abort(); return request; })()
    ])`);
    for (const [marker, status] of [['http-post','200'], ['http-404','404'], ['xhr-ok','200'], ['xhr-404','404'], ['xhr-abort','aborted'], ['xhr-timeout','timeout'], ['network-error','ERR'], ['fetch-abort','aborted']]) await networkStatus(marker,status);
    assert.equal(await page.evaluate(`navigator.sendBeacon('/api/echo?beacon-queued', JSON.stringify({beacon:true}))`), true);
    assert.equal(await page.evaluate(`navigator.sendBeacon('/api/echo?beacon-rejected', new Blob(['x'.repeat(70*1024)]))`), false);
    assert.equal(await page.evaluate(`(() => { try { navigator.sendBeacon('ws://localhost/beacon-invalid','body'); } catch(error) { return error.name; } })()`), 'TypeError');
    await networkStatus('beacon-queued','queued'); await networkStatus('beacon-rejected','dropped'); await networkStatus('beacon-invalid','ERR');
    assert.equal(await page.evaluate(`[...${shadow}.querySelectorAll('.vd-net')].find(row => row.querySelector('.vd-net-path').textContent.includes('beacon-rejected')).querySelector('.vd-net-status').classList.contains('bad')`), true);
    await wait(`[...${shadow}.querySelectorAll('.vd-net')].find(row => row.querySelector('.vd-net-path').textContent.includes('http-post')).textContent.includes('[redacted]')`, 'bounded/redacted HTTP body capture');
    const httpSnapshot = await assertNetworkAgrees();
    assert.equal(httpSnapshot.entries.find(entry => entry.url.includes('http-post')).phase, 'completed');
    assert.equal(httpSnapshot.entries.find(entry => entry.url.includes('beacon-rejected')).phase, 'rejected');
    await uiButton('Copy capture');
    await wait(`${shadow}.querySelector('.vd-feedback').textContent === 'Capture copied.'`, 'HTTP/beacon capture copy');
    const beaconCopy = await isolated('return globalThis.copiedCapture');
    assert.match(beaconCopy, /beacon-rejected.*→ dropped/);
    assert.match(beaconCopy, /beacon-queued.*→ queued/);
    assert.doesNotMatch(beaconCopy, /clear-fetch|clear-xhr|fixture-secret/);

    log('checking real WebSocket frames, clean close, and connection failure');
    await page.evaluate(`openCaptureSocket().then(socket => { window.liveCaptureSocket = socket; for(let i=0;i<35;i++) socket.send('native-frame-'+i); })`);
    await wait(`liveCaptureSocket.replies.length === 35`, 'native WebSocket replies');
    let socketSnapshot = await agentNetwork();
    const socketEntry = socketSnapshot.entries.find(entry => entry.kind === 'ws');
    assert.equal(socketEntry.wsState, 'open'); assert.equal(socketEntry.frameCount, 70);
    assert.equal(socketEntry.frames.length, 60); assert.equal(socketEntry.droppedFrames, 10);
    await page.evaluate(`new Promise(resolve => { liveCaptureSocket.addEventListener('close', resolve, {once:true}); liveCaptureSocket.close(1000,'done'); })`);
    socketSnapshot = await agentNetwork();
    assert.equal(socketSnapshot.entries.find(entry => entry.id === socketEntry.id).ok, true);
    await networkStatus('/ws/echo','closed 1000');
    await page.evaluate(`new Promise(resolve => { window.failedCaptureSocket = new WebSocket(location.origin.replace('http','ws')+'/ws/missing'); failedCaptureSocket.addEventListener('close',resolve,{once:true}); })`);
    await networkStatus('/ws/missing','closed 1006');
    assert.equal((await agentNetwork()).entries.find(entry => entry.url.includes('/ws/missing')).ok, false);
    await assertNetworkAgrees();

    log('checking Network eviction while a request and socket are active');
    await uiButton('Clear all');
    await wait(`${shadow}.querySelectorAll('.vd-net').length === 0`, 'Network clear before eviction');
    await page.evaluate(`window.evictedFetch = fetch('/api/slow?evicted-fetch').then(response => response.json()); true`);
    await page.evaluate(`openCaptureSocket().then(socket => { window.evictedSocket = socket; socket.send('before eviction'); })`);
    await wait(`evictedSocket.replies.length === 1`, 'socket before eviction');
    const retiredIds = new Set((await agentNetwork()).entries.map(entry => entry.id));
    await page.evaluate(`for(let i=0;i<301;i++) navigator.sendBeacon('/api/echo?eviction='+i,JSON.stringify({i}))`);
    await networkStatus('eviction=300','queued');
    assert.equal((await networkIds()).length, 300);
    assert.equal((await networkIds()).some(id => retiredIds.has(id)), false);
    await page.evaluate(`evictedSocket.send('after eviction')`);
    await wait(`evictedSocket.replies.length === 2`, 'native socket after eviction');
    assert.equal((await page.evaluate('evictedFetch')).finally, 'worth the wait');
    await page.evaluate(`new Promise(resolve => { evictedSocket.addEventListener('close',resolve,{once:true}); evictedSocket.close(1000); })`);
    await page.evaluate(`new Promise(resolve => setTimeout(resolve,300))`);
    const evictionSnapshot = await assertNetworkAgrees();
    assert.equal(evictionSnapshot.entries.length, 300);
    assert.equal(evictionSnapshot.entries[0].url.includes('eviction=1'), true);
    assert.ok(evictionSnapshot.entries.every((entry,index,entries) => index === 0 || entry.seq > entries[index-1].seq));
    await page.evaluate(`${shadow}.querySelector('button[aria-label="Copy Network view"]').click()`);
    await wait(`${shadow}.querySelector('.vd-feedback').textContent.includes('network view')`, 'retained Network export');
    const retainedCopy = await isolated('return globalThis.copiedCapture');
    assert.match(retainedCopy, /Network \(300\)/); assert.doesNotMatch(retainedCopy, /evicted-fetch|\/ws\/echo/);

    await page.evaluate(`window.networkResyncRequests=0; window.addEventListener('message',event => {
      if(event.source===window && event.data?.source==='vibe-digger-control' && event.data.command==='get-network') window.networkResyncRequests++;
    })`);
    await isolated(`window.dispatchEvent(new MessageEvent('message',{source:window,data:${JSON.stringify({
      source:'vibe-digger-agent',kind:'network',details:{revision:evictionSnapshot.revision+2,removedIds:[],entry:{...evictionSnapshot.entries[0],id:'unverified-network'}},
    })}}));`);
    await wait('window.networkResyncRequests > 0','Network snapshot recovery');
    await assertNetworkAgrees();
    assert.equal((await networkIds()).includes('unverified-network'), false);

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

    log('checking a page reload starts a fresh issue collection');
    await page.evaluate('window.beforeIssueReload = true');
    await page.send('Page.reload');
    await wait(`!window.beforeIssueReload && !!document.querySelector('#root main')`, 'reloaded React demo');
    await worker.evaluate(`chrome.scripting.executeScript({ target: {tabId:${tabId}}, files:['content.js'] })`);
    await wait(`!!${shadow}?.querySelector('.vd-panel')`, 'fresh panel after reload');
    await view('issues');
    await wait(`${shadow}.querySelector('.vd-empty')?.textContent.includes('No issues')`, 'fresh issue view');
    assert.equal((await assertIssuesAgree()).issues.length, 0);
    }

    log('checking late injection without a React DevTools hook');
    await page.send('Page.navigate',{url:lateUrl});
    await wait(`location.origin === ${JSON.stringify(lateUrl)} && !!document.querySelector('#root main')`,'late demo startup');
    assert.equal(await page.evaluate('!!window.__vibeDiggerAgentInstalled'),false);
    assert.equal(await page.evaluate('!!window.__REACT_DEVTOOLS_GLOBAL_HOOK__'),false);
    await attachDigger();
    const missed = await reactStatus();
    assert.equal(missed.reactDetected,true); assert.equal(missed.heatmapAvailable,false);
    assert.equal(missed.attachment.reason,'missed-startup');
    await wait(`${shadow}.querySelector('.vd-status-text').textContent.includes('missed startup')`,'late attachment guidance');
    assert.equal(await page.evaluate(`[...${shadow}.querySelectorAll('.vd-toolbar button')].find(button=>button.textContent==='Heatmap').disabled`),true);
    await page.evaluate(`window.postMessage({source:'vibe-digger-control',command:'heatmap',enabled:true},'*')`);
    assert.equal((await reactStatus()).heatmapEnabled,false,'the agent must reject unavailable heatmap requests');
    await inspectCounter();

    log('checking a renderer loaded before injection whose first mount happens later');
    await page.send('Page.enable');
    const gate = await page.send('Page.addScriptToEvaluateOnNewDocument',{source:`
      Object.defineProperty(window,'ReactDOM',{configurable:true,get(){return this.gatedReactDOM},set(value){
        this.gatedReactDOM=value; let createRoot;
        Object.defineProperty(value,'createRoot',{configurable:true,set(fn){createRoot=fn},get(){return (...args)=>({render(...renderArgs){
          window.resumeReactRender=()=>{
            Object.defineProperty(value,'createRoot',{configurable:true,writable:true,value:createRoot});
            createRoot.apply(value,args).render(...renderArgs);
          };
        }})}});
      }});
    `});
    await page.send('Page.navigate',{url:lateUrl});
    await wait('typeof window.resumeReactRender === "function"','delayed React mount fixture');
    await attachDigger();
    assert.equal((await reactStatus()).attachment.phase,'waiting');
    await page.evaluate('resumeReactRender()');
    // Do not request status here: the DOM discovery observer must update the
    // already-open panel without another click or manual refresh.
    await wait(`${shadow}.querySelector('.vd-status-text').textContent.includes('missed startup')`,'automatic discovery of missed renderer startup');
    assert.equal((await reactStatus()).heatmapAvailable,false);
    await page.send('Page.removeScriptToEvaluateOnNewDocument',{identifier:gate.identifier});

    log('checking coexistence with the installed React Developer Tools extension');
    const devtoolsSource = await reactDevToolsExtension();
    const devtoolsDir = join(temp,'react-devtools');
    await cp(devtoolsSource,devtoolsDir,{recursive:true,filter:path=>!path.includes('/_metadata') && !path.endsWith('.map')});
    const devtoolsManifest = JSON.parse(await readFile(join(devtoolsDir,'manifest.json'),'utf8'));
    const devtoolsExtension = await cdp.send('Extensions.loadUnpacked',{path:devtoolsDir});
    let devtoolsTarget;
    await waitFor(async () => {
      const {targetInfos} = await cdp.send('Target.getTargets');
      devtoolsTarget = targetInfos.find(target => target.type==='service_worker' && target.url===`chrome-extension://${devtoolsExtension.id}/build/background.js`);
      return !!devtoolsTarget;
    },'React DevTools background startup');
    const devtoolsWorker = await attachTarget(cdp,devtoolsTarget);
    await waitFor(() => devtoolsWorker.evaluate(`chrome.scripting.getRegisteredContentScripts().then(scripts=>scripts.some(script=>script.js?.includes('build/installHook.js')))`),'React DevTools document_start hook registration');
    await page.send('Page.navigate',{url:lateUrl});
    await wait(`!!document.querySelector('#root main') && window.__REACT_DEVTOOLS_GLOBAL_HOOK__?.renderers?.size > 0`,'real DevTools renderer registration');
    assert.equal(await page.evaluate('!!window.__vibeDiggerAgentInstalled'),false);
    await page.evaluate(`window.savedDevtoolsHook=__REACT_DEVTOOLS_GLOBAL_HOOK__;
      window.savedDevtoolsRenderers=savedDevtoolsHook.renderers; window.devtoolsCommitCalls=0;
      const nativeCommit=savedDevtoolsHook.onCommitFiberRoot;
      savedDevtoolsHook.onCommitFiberRoot=function(...args){
        window.devtoolsCommitReceiver=this; window.devtoolsCommitCalls++;
        return nativeCommit.apply(this,args);
      };
    `);
    await attachDigger();
    const wrapped = await reactStatus();
    assert.equal(wrapped.hookMode,'wrapped'); assert.equal(wrapped.heatmapAvailable,true);
    assert.equal(await page.evaluate('__REACT_DEVTOOLS_GLOBAL_HOOK__===savedDevtoolsHook && savedDevtoolsHook.renderers===savedDevtoolsRenderers'),true);
    await inspectCounter();
    await uiButton('Heatmap');
    await appButton('Clicked 0 times');
    await wait(`${shadow}.querySelectorAll('.vd-flash').length > 0`,'heatmap through the real DevTools hook');
    await wait(`${shadow}.querySelector('.vd-status-text').textContent.match(/React · [1-9][0-9]* commits observed/)`,'live commit status');
    assert.equal(await page.evaluate('devtoolsCommitCalls > 0 && devtoolsCommitReceiver===savedDevtoolsHook'),true);
    assert.equal(await page.evaluate('[...savedDevtoolsHook.renderers.keys()].some(id=>savedDevtoolsHook.getFiberRoots(id).size>0)'),true,'native DevTools root tracking must keep working');
    await page.evaluate('window.savedWrappedCommit=savedDevtoolsHook.onCommitFiberRoot');
    await worker.evaluate(`chrome.scripting.executeScript({target:{tabId:${tabId}},files:['page-agent.js'],world:'MAIN'})`);
    assert.equal(await page.evaluate('savedDevtoolsHook.onCommitFiberRoot===savedWrappedCommit'),true,'reinjection must not stack React observers');
    log(`passed React attachment with real React Developer Tools ${devtoolsManifest.version}`);
    log(process.env.VIBE_DIGGER_E2E_ATTACHMENT_ONLY
      ? 'passed: early/late React attachment, delayed mount detection, and DevTools coexistence'
      : 'passed: early/late React attachment and DevTools coexistence, network/WebSocket capture, disclosures, copy acknowledgement/failure/retry, issue/network synchronization, hidden capture, and reload reset');
  } finally {
    cdp?.close();
    await stop(browser); await stop(demo);
    await rm(temp, { recursive: true, force: true });
  }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
