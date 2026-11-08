import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../page-agent.js', import.meta.url), 'utf8');

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function response(status = 200, body = null) {
  return { status, ok: status < 400, headers: { get: key => key === 'content-type' && body ? 'text/plain' : null },
    clone: () => ({ text: () => body.promise }) };
}

function pageAgent({ existingSocket = false } = {}) {
  const events = [], fetches = [], sockets = [], beacons = [];
  const listeners = new Map(), timers = new Map();
  let timerId = 0;
  const nativeError = new Error('native synchronous failure');
  class Xhr extends EventTarget {
    open(method, url) { this.method = method; this.url = url; }
    send(body) { if (body === 'throw') throw nativeError; }
    getResponseHeader(key) { return key === 'content-type' ? 'text/plain' : null; }
    finish(kind, status = 0) {
      this.status = status; this.responseType = ''; this.responseText = 'native response';
      this.dispatchEvent(new Event(kind)); this.dispatchEvent(new Event('loadend'));
    }
  }
  class Socket extends EventTarget {
    static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
    constructor(url) { super(); this.url = url; this.readyState = 0; this.sent = []; sockets.push(this); }
    open() { this.readyState = 1; this.dispatchEvent(new Event('open')); }
    send(data) { if (this.readyState === 0) throw nativeError; if (this.readyState === 1) this.sent.push(data); }
    close() { if (this.readyState < 2) this.readyState = 2; }
    receive(data) { this.dispatchEvent(new MessageEvent('message', { data })); }
    finish(code = 1000, wasClean = true) {
      this.readyState = 3;
      const event = new Event('close');
      Object.assign(event, { code, wasClean, reason: '' });
      this.dispatchEvent(event);
    }
  }
  const context = vm.createContext({
    console: { warn() {}, error() {} }, location: { href: 'http://localhost/' }, performance: { now: () => 1000 },
    document: { querySelectorAll: () => [] }, Element: class {},
    URL, URLSearchParams, TextEncoder, ArrayBuffer, Blob, FormData, Request,
    XMLHttpRequest: Xhr, WebSocket: Socket,
    navigator: { sendBeacon(url, body) { beacons.push({url, body}); if (url === '/throw') throw nativeError; return url !== '/reject'; } },
    fetch(input, init) {
      if (input === '/throw') throw nativeError;
      const pending = { ...deferred(), input, init }; fetches.push(pending); return pending.promise;
    },
    setTimeout: callback => { const id = ++timerId; timers.set(id, callback); return id; },
    clearTimeout: id => timers.delete(id),
    postMessage: data => events.push(structuredClone(data)),
    addEventListener: (kind, listener) => {
      if (!listeners.has(kind)) listeners.set(kind, []);
      listeners.get(kind).push(listener);
    },
    __listeners: listeners,
  });
  const run = code => vm.runInContext(code, context);
  run('window = globalThis');
  if (existingSocket) run(`existingSocket = new WebSocket('ws://localhost/preexisting'); existingSocket.open()`);
  run(source);
  function control(command) {
    context.__command = command;
    run(`for (const listener of __listeners.get('message') || []) listener({source:window,data:{source:'vibe-digger-control',command:__command}})`);
  }
  function snapshot() { control('get-network'); return events.findLast(event => event.kind === 'network-list').details; }
  function flushTimers() { for (const [id, callback] of timers) { timers.delete(id); callback(); } }
  return { run, events, fetches, sockets, beacons, nativeError, control, snapshot, flushTimers };
}

test('cleared fetches and delayed Request clones cannot publish back into the collection', async () => {
  const page = pageAgent();
  const pending = page.run(`fetch(new Request('http://localhost/pending', {method:'POST',body:'native body'}))`);
  page.control('clear-network');
  page.events.length = 0;
  const nativeResponse = response();
  page.fetches[0].resolve(nativeResponse);
  assert.equal(await pending, nativeResponse);
  await new Promise(setImmediate);
  assert.equal(page.snapshot().entries.length, 0);
  assert.equal(page.events.filter(event => event.kind === 'network').length, 0,
    'late request metadata or completion must not resurrect a cleared row');
});

test('eviction is published with the new entry and evicted HTTP completions stay retired', async () => {
  const page = pageAgent();
  const pending = page.run(`fetch('/slow')`);
  const oldId = page.snapshot().entries[0].id;
  page.run(`for(let i=0;i<300;i++) navigator.sendBeacon('/beacon-'+i,'body')`);
  assert.equal(page.snapshot().entries.length, 300);
  const update = page.events.filter(event => event.kind === 'network').find(event => event.details.removedIds?.includes(oldId));
  assert.ok(update, 'the admission that evicts a row must identify that row');
  page.events.length = 0;
  page.fetches[0].resolve(response()); await pending;
  assert.equal(page.events.some(event => event.kind === 'network'), false);
  assert.equal(page.snapshot().entries.some(entry => entry.id === oldId), false);
});

test('cleared sockets keep native traffic but cannot publish frames, timers, open or close events', () => {
  const page = pageAgent();
  page.run(`socket = new WebSocket('ws://localhost/echo')`);
  const socket = page.sockets[0];
  socket.open(); page.run(`socket.send('before clear')`);
  page.control('clear-network'); page.events.length = 0;
  page.run(`socket.send('after clear')`); socket.receive('native reply'); socket.finish(); page.flushTimers();
  assert.deepEqual(socket.sent, ['before clear', 'after clear']);
  assert.equal(page.snapshot().entries.length, 0);
  assert.equal(page.events.some(event => event.kind === 'network'), false);
});

test('socket capture follows successful sends and native closing without phantom frames or repeated terminal events', () => {
  const page = pageAgent();
  assert.throws(() => page.run(`WebSocket('ws://localhost/invalid-call')`), error => error.name === 'TypeError');
  assert.equal(page.sockets.length, 0);
  page.run(`socket = new WebSocket('ws://localhost/echo')`);
  assert.throws(() => page.run(`socket.send('too early')`), error => error === page.nativeError);
  assert.equal(page.snapshot().entries[0].frameCount, 0);
  page.sockets[0].open(); page.run(`socket.send('sent'); socket.close()`);
  assert.equal(page.snapshot().entries[0].wsState, 'closing');
  page.run(`socket.send('discarded')`);
  page.sockets[0].finish(); page.flushTimers();
  const closed = page.snapshot();
  assert.equal(closed.entries[0].frameCount, 1);
  assert.equal(closed.entries[0].wsState, 'closed');
  page.sockets[0].finish();
  assert.equal(page.snapshot().revision, closed.revision, 'a terminal socket cannot transition again');
});

test('late socket adoption is bounded and an evicted socket is never adopted a second time', () => {
  const page = pageAgent({ existingSocket: true });
  page.run(`existingSocket.send('first observed send')`);
  const socket = page.sockets[0];
  for (let i = 0; i < 70; i++) socket.receive('reply-' + i);
  const captured = page.snapshot().entries[0];
  assert.equal(captured.wsState, 'open');
  assert.match(captured.initiator, /before capture/);
  assert.equal(captured.frameCount, 71);
  assert.equal(captured.frames.length, 60);
  assert.equal(captured.droppedFrames, 11);
  page.run(`for(let i=0;i<300;i++) navigator.sendBeacon('/later-'+i,'body')`);
  page.events.length = 0;
  page.run(`existingSocket.send('still native')`); socket.receive('still native reply'); page.flushTimers();
  assert.equal(socket.sent.at(-1), 'still native');
  assert.equal(page.events.some(event => event.kind === 'network'), false);
  assert.equal(page.snapshot().entries.some(entry => entry.id === captured.id), false);
});

test('a socket opened after clear remains retired and a fresh socket starts a new row', () => {
  const page = pageAgent();
  page.run(`old = new WebSocket('ws://localhost/old')`);
  const oldId = page.snapshot().entries[0].id;
  page.control('clear-network'); page.events.length = 0;
  page.sockets[0].open(); page.sockets[0].finish(1006, false); page.flushTimers();
  assert.equal(page.events.some(event => event.kind === 'network'), false);
  page.run(`fresh = new WebSocket('ws://localhost/fresh')`);
  assert.equal(page.snapshot().entries.length, 1);
  assert.notEqual(page.snapshot().entries[0].id, oldId);
});

test('native synchronous failures settle fetch, XHR and beacon attempts without changing the thrown error', () => {
  const page = pageAgent();
  for (const code of [`fetch('/throw')`, `xhr = new XMLHttpRequest(); xhr.open('POST','/xhr'); xhr.send('throw')`, `navigator.sendBeacon('/throw','body')`]) {
    assert.throws(() => page.run(code), error => error === page.nativeError);
  }
  assert.deepEqual(page.snapshot().entries.map(entry => entry.phase), ['failed', 'failed', 'failed']);
  assert.equal(page.run(`navigator.sendBeacon('/accept','body')`), true);
  assert.equal(page.run(`navigator.sendBeacon('/reject','body')`), false);
  assert.deepEqual(page.snapshot().entries.slice(-2).map(entry => entry.phase), ['queued', 'rejected']);
});

test('fetch headers settle before clone-body reads, whose late results stay retired after clear', async () => {
  const page = pageAgent(), body = deferred();
  const pending = page.run(`fetch('/stream')`);
  const nativeResponse = response(404, body);
  page.fetches[0].resolve(nativeResponse);
  assert.equal(await pending, nativeResponse);
  assert.equal(page.snapshot().entries[0].status, 404, 'a slow response clone must not keep the status pending');
  assert.equal(page.snapshot().entries[0].phase, 'completed');
  page.control('clear-network'); page.events.length = 0;
  body.resolve('native body'); await new Promise(setImmediate);
  assert.equal(page.events.some(event => event.kind === 'network'), false);
});

test('XHR abort, timeout and completion settle once and failing send listeners cannot attach to a later request', () => {
  const page = pageAgent();
  for (const [kind, phase] of [['abort','aborted'], ['timeout','timed-out'], ['error','failed'], ['load','completed']]) {
    page.run(`xhr = new XMLHttpRequest(); xhr.open('GET','/${kind}'); xhr.send()`);
    page.run(`xhr.finish('${kind}', ${kind === 'load' ? 200 : 0})`);
    assert.equal(page.snapshot().entries.at(-1).phase, phase);
  }
  assert.throws(() => page.run(`xhr = new XMLHttpRequest(); xhr.open('POST','/bad-send'); xhr.send('throw')`));
  page.run(`xhr.open('GET','/reused'); xhr.send(); xhr.finish('load',200)`);
  const entries = page.snapshot().entries;
  assert.equal(entries.at(-2).phase, 'failed');
  assert.equal(entries.at(-1).status, 200);
});
