import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const probeSource = await readFile(new URL('../vibe-page-probe.js', import.meta.url), 'utf8');
const diggerSource = await readFile(new URL('../../vibe-digger/page-agent.js', import.meta.url), 'utf8');

function harness() {
  const events = [];
  const listeners = new Map();
  const pendingFetches = [];
  const calls = [];
  const response = { status: 200, ok: true, headers: { get: () => 'application/json' },
    clone: () => ({ text: async () => '{"ok":true}' }) };
  class Xhr extends EventTarget {
    open(method, url) { this.method = method; this.url = url; }
    send() {
      this.status = 200;
      this.responseType = '';
      this.responseText = '{"ok":true}';
      this.dispatchEvent(new Event('loadend'));
    }
    getResponseHeader(name) { return name === 'content-type' ? 'application/json' : null; }
  }
  class Store {
    setItem() {}
    removeItem() {}
    clear() {}
  }
  const context = vm.createContext({
    console: { warn() {}, error() {} },
    performance: { now: () => 1000 }, location: { href: 'https://example.test/' },
    document: { querySelectorAll: () => [] }, Element: class {},
    URL, TextEncoder, ArrayBuffer, Blob, FormData, Request,
    XMLHttpRequest: Xhr, Storage: Store, localStorage: new Store(), sessionStorage: new Store(),
    navigator: {}, history: { pushState() {}, replaceState() {} },
    fetch: function (...args) {
      calls.push({ receiver: this, args });
      if (String(args[0]).includes('deferred')) return new Promise(resolve => pendingFetches.push(() => resolve(response)));
      return Promise.resolve(response);
    },
    setTimeout, clearTimeout,
    postMessage: message => events.push(structuredClone(message)),
    addEventListener: (kind, listener) => {
      if (!listeners.has(kind)) listeners.set(kind, new Set());
      listeners.get(kind).add(listener);
    },
    removeEventListener: (kind, listener) => listeners.get(kind)?.delete(listener),
    __listeners: listeners,
  });
  vm.runInContext('window = globalThis', context);
  function dispatch(data) {
    context.__control = data;
    vm.runInContext(`for (const listener of [...(__listeners.get('message') || [])]) listener({source:window,data:__control})`, context);
  }
  return {
    context, events, calls, response, pendingFetches,
    install: () => vm.runInContext(probeSource, context),
    digger: () => vm.runInContext(diggerSource, context),
    stop: () => dispatch({ source: 'element-picker-vibe-probe-control', command: 'stop' }),
    run: code => vm.runInContext(code, context),
    flush: () => new Promise(setImmediate),
  };
}

for (const order of ['bridge-first', 'digger-first']) {
  test(`${order}: closing QA Bridge preserves Digger fetch, XHR, and console capture`, async () => {
    const page = harness();
    if (order === 'bridge-first') { page.install(); page.digger(); }
    else { page.digger(); page.install(); }
    page.stop();
    page.events.length = 0;
    await page.run(`fetch('/after-close'); new XMLHttpRequest().open('GET', '/noop');
      (() => { const xhr = new XMLHttpRequest(); xhr.open('GET','/xhr-after-close'); xhr.send(); })();
      console.warn('after-close-warning');`);
    await page.flush();
    const digger = page.events.filter(event => event.source === 'vibe-digger-agent');
    assert.ok(digger.some(event => event.kind === 'network' && event.details.entry.url === '/after-close'));
    assert.ok(digger.some(event => event.kind === 'network' && event.details.entry.url === '/xhr-after-close'));
    assert.ok(digger.some(event => event.kind === 'issue' && event.details.issue.message === 'after-close-warning'));
    assert.equal(page.events.some(event => event.source === 'element-picker-vibe-probe'), false,
      'a retired probe must be silent even when Digger retains its wrapper');

    page.install();
    page.events.length = 0;
    await page.run(`fetch('/reopened')`);
    await page.flush();
    assert.equal(page.events.filter(event => event.source === 'element-picker-vibe-probe' && event.kind === 'network.fetch.start').length, 1);
    assert.equal(page.events.filter(event => event.source === 'element-picker-vibe-probe' && event.kind === 'network.fetch.end').length, 1);
    page.stop();
  });
}

test('a stopped probe forwards calls captured by later wrappers without changing this or arguments', async () => {
  const page = harness();
  page.install();
  page.run(`savedProbeFetch = fetch; fetch = function () { return savedProbeFetch.apply(this, arguments); }`);
  const laterFetch = page.context.fetch;
  page.stop();
  assert.equal(page.context.fetch, laterFetch, 'cleanup must leave the later owner installed');
  const receiver = {};
  const init = { method: 'POST', body: 'body' };
  assert.equal(await page.context.fetch.call(receiver, '/forwarded', init), page.response);
  assert.equal(page.calls.at(-1).receiver, receiver);
  assert.deepEqual(page.calls.at(-1).args, ['/forwarded', init]);
});

test('in-flight completions from a stopped installation stay silent after reopening', async () => {
  const page = harness();
  page.install();
  page.digger();
  const pending = page.run(`fetch('/deferred')`);
  page.stop();
  page.install();
  page.events.length = 0;
  page.pendingFetches[0]();
  assert.equal(await pending, page.response);
  await page.flush();
  assert.equal(page.events.some(event => event.source === 'element-picker-vibe-probe'), false);
  assert.ok(page.events.some(event => event.source === 'vibe-digger-agent' && event.kind === 'network' && event.details.entry.status === 200));
  page.stop();
});

test('cleanup preserves later history, storage, console and app API owners', () => {
  const page = harness();
  page.run(`originalApi = { watch() {} }; __VIBE_DEBUGGER__ = originalApi;`);
  page.install();
  page.run(`
    laterSlots = [[history,'pushState'],[history,'replaceState'],
      [Storage.prototype,'setItem'],[Storage.prototype,'removeItem'],[Storage.prototype,'clear'],
      [console,'warn'],[console,'error']].map(([target,key]) => {
        const previous = target[key];
        const replacement = function () { return previous.apply(this,arguments); };
        target[key] = replacement; return {target,key,replacement};
      });
    laterApi = { watch() {} }; __VIBE_DEBUGGER__ = laterApi;
  `);
  page.stop();
  assert.equal(page.run(`laterSlots.every(({target,key,replacement}) => target[key] === replacement)`), true);
  assert.equal(page.run(`__VIBE_DEBUGGER__ === laterApi`), true);
  page.events.length = 0;
  page.run(`history.pushState({}, '', '/next'); localStorage.setItem('sample', 'value'); console.error('later owner');`);
  assert.equal(page.events.length, 0);
});

test('cleanup restores owned descriptors, inherited methods, and a pre-existing app API', () => {
  const page = harness();
  page.run(`originalApi = {}; __VIBE_DEBUGGER__ = originalApi;
    originalWarn = Object.getOwnPropertyDescriptor(console,'warn');
    Object.setPrototypeOf(history, { pushState: history.pushState, replaceState: history.replaceState });
    delete history.pushState; delete history.replaceState;
  `);
  page.install();
  page.stop();
  assert.equal(page.run(`__VIBE_DEBUGGER__ === originalApi`), true);
  assert.equal(page.run(`Object.hasOwn(history,'pushState')`), false);
  assert.equal(page.run(`Object.getOwnPropertyDescriptor(console,'warn').value === originalWarn.value`), true);
  assert.equal(page.run(`'__VIBE_DEBUGGER_PREVIOUS__' in window`), false);
});
