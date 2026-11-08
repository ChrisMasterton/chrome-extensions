import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../page-agent.js', import.meta.url), 'utf8');

function pageAgent() {
  const events = [];
  const logs = [];
  const listeners = new Map();
  const context = vm.createContext({
    console: { warn: (...args) => logs.push(args), error: (...args) => logs.push(args) },
    location: { href: 'http://localhost/' }, performance: { now: () => 1000 },
    document: { querySelectorAll: () => [] }, Element: class {}, navigator: {},
    URL, TextEncoder, ArrayBuffer, Blob, FormData, Request,
    fetch: async () => ({ status: 500, ok: false, headers: { get: () => null } }),
    postMessage: message => events.push(structuredClone(message)),
    addEventListener: (kind, listener) => {
      if (!listeners.has(kind)) listeners.set(kind, []);
      listeners.get(kind).push(listener);
    },
    __listeners: listeners,
  });
  vm.runInContext('window = globalThis', context);
  const run = code => vm.runInContext(code, context);
  run(source);
  function dispatch(kind, details) {
    context.__event = details;
    context.__kind = kind;
    run(`for (const listener of __listeners.get(__kind) || []) listener({ source: window, ...__event })`);
  }
  function control(command) { dispatch('message', { data: { source: 'vibe-digger-control', command } }); }
  function snapshot() {
    control('get-issues');
    return events.findLast(event => event.kind === 'issues').details;
  }
  return { events, logs, run, dispatch, control, snapshot };
}

test('live issue updates identify evictions and keep duplicate identity at the retention limit', () => {
  const page = pageAgent();
  page.run(`for (let i = 0; i < 205; i++) console.warn('issue-' + i)`);
  const before = page.snapshot();
  assert.equal(before.issues.length, 200);
  assert.equal(before.issues[0].message, 'issue-5');
  assert.equal(page.logs.length, 205, 'capture must still call the native console');
  const updates = page.events.filter(event => event.kind === 'issue');
  assert.deepEqual(updates.slice(-5).flatMap(event => event.details.removedIds),
    updates.slice(0, 5).map(event => event.details.issue.id));

  const original = before.issues.find(issue => issue.message === 'issue-100');
  page.run(`console.warn('issue-100')`);
  const after = page.snapshot();
  assert.equal(after.issues.length, 200);
  assert.equal(after.issues[0].id, before.issues[0].id, 'a duplicate must not evict another issue');
  const repeated = after.issues.find(issue => issue.message === 'issue-100');
  assert.equal(repeated.id, original.id);
  assert.equal(repeated.count, 2);
  assert.equal(repeated.firstAt, original.firstAt);
  assert.ok(repeated.lastAt >= original.lastAt);
  assert.equal(after.revision, before.revision + 1);
});

test('clear advances the collection and a later occurrence starts a new issue', () => {
  const page = pageAgent();
  page.run(`console.error('same problem'); console.error('same problem')`);
  const before = page.snapshot();
  assert.equal(before.issues[0].count, 2);
  page.control('clear-issues');
  const cleared = page.snapshot();
  assert.deepEqual(cleared.issues, []);
  assert.equal(cleared.revision, before.revision + 1);
  assert.equal(page.snapshot().revision, cleared.revision, 'reading a snapshot must not mutate the collection');

  page.run(`console.error('same problem')`);
  const fresh = page.snapshot();
  assert.equal(fresh.issues.length, 1);
  assert.notEqual(fresh.issues[0].id, before.issues[0].id);
  assert.equal(fresh.issues[0].count, 1);
});

test('registered error, rejection, React warning and failed-fetch producers share the issue lifecycle', async () => {
  const page = pageAgent();
  page.dispatch('error', { message: 'uncaught', filename: 'app.js', lineno: 2, colno: 3 });
  page.dispatch('unhandledrejection', { reason: { message: 'rejected', stack: 'rejection detail' } });
  page.run(`console.error('Warning: missing key')`);
  await page.run(`fetch('/failed')`);
  const snapshot = page.snapshot();
  assert.deepEqual(snapshot.issues.map(issue => issue.kind),
    ['uncaught-error', 'unhandled-rejection', 'react-warning', 'network']);
  assert.equal(snapshot.issues[0].detail, 'app.js:2:3');
  page.control('clear-issues');
  await page.run(`fetch('/failed')`);
  assert.deepEqual(page.snapshot().issues.map(issue => [issue.kind, issue.count]), [['network', 1]]);
});
