import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../page-agent.js', import.meta.url), 'utf8');

function pageAgent(setup = '') {
  const events = [], listeners = new Map(), timers = new Map();
  let nextTimer = 0;
  const context = vm.createContext({
    console: { warn() {}, error() {} }, navigator: {}, location: { href: 'http://localhost/' },
    performance: { now: () => 1000 }, Element: class {}, nodes: [],
    document: { querySelectorAll: () => context.nodes },
    postMessage: data => events.push(structuredClone(data)),
    addEventListener: (kind, listener) => {
      if (!listeners.has(kind)) listeners.set(kind, []);
      listeners.get(kind).push(listener);
    },
    setTimeout: callback => { const id = ++nextTimer; timers.set(id,callback); return id; },
    clearTimeout: id => timers.delete(id), __listeners: listeners,
  });
  const run = code => vm.runInContext(code, context);
  run('window = globalThis'); run(setup); run(source);
  function control(command, extra = {}) {
    context.__control = {source:'vibe-digger-control',command,...extra};
    run(`for(const listener of __listeners.get('message') || []) listener({source:window,data:__control})`);
  }
  function status() { control('hello'); return events.findLast(event => event.kind === 'status').details; }
  function flush() { for (const [id, callback] of timers) { timers.delete(id); callback(); } }
  return { run, events, control, status, flush };
}

test('a hook installed after React startup cannot enable heatmap without a connected renderer', () => {
  const page = pageAgent(`nodes.push({__reactFiber$fixture:{}})`);
  assert.equal(page.status().reactDetected, true);
  page.control('heatmap', {enabled:true});
  assert.equal(page.status().heatmapEnabled, false, 'a newly installed shim is not an attached renderer');
  assert.equal(page.status().heatmapAvailable, false);
  assert.equal(page.status().attachment.reason, 'missed-startup');
});

test('early injection waits for registration, then commits publish readiness and keep root lifetime correct', () => {
  const page = pageAgent();
  assert.equal(page.status().heatmapAvailable, false);
  page.run(`hook = __REACT_DEVTOOLS_GLOBAL_HOOK__; rendererId = hook.inject({version:'18.3.1'});`);
  assert.equal(page.events.findLast(event => event.kind === 'status').details.heatmapAvailable, true,
    'registration must update an already-open panel');
  page.control('heatmap', {enabled:true});
  page.run(`root = {current:{child:null,memoizedState:{element:{}}}}; hook.onCommitFiberRoot(rendererId,root);`);
  page.flush();
  assert.equal(page.events.findLast(event => event.kind === 'status').details.commitCount, 1);
  assert.equal(page.run(`hook.getFiberRoots(rendererId).has(root)`), true);
  page.run(`root.current.memoizedState.element = null; hook.onCommitFiberRoot(rendererId,root);`);
  assert.equal(page.run(`hook.getFiberRoots(rendererId).has(root)`), false);
});

test('late DOM detection stays unavailable until a renderer really registers with the installed hook', () => {
  const page = pageAgent();
  page.run(`nodes.push({__reactContainer$fixture:{}})`);
  assert.equal(page.status().heatmapAvailable, false);
  page.run(`__REACT_DEVTOOLS_GLOBAL_HOOK__.inject({version:'18.3.1'})`);
  assert.equal(page.status().heatmapAvailable, true);
  assert.equal(page.status().attachment.reason, null);
  assert.equal(page.status().heatmapEnabled, false, 'recovery must not silently start a previously rejected heatmap');
});

test('wrapping DevTools preserves its hook, receiver, arguments, return values, and exceptions', () => {
  const page = pageAgent(`
    nativeError = new Error('DevTools failure'); calls = [];
    originalHook = {
      supportsFiber:true, renderers:new Map([[9,{}]]),
      inject(...args) { calls.push({kind:'inject',receiver:this,args}); return 42; },
      onCommitFiberRoot(...args) { calls.push({kind:'commit',receiver:this,args}); if(args[2]==='throw') throw nativeError; return 'native result'; }
    }; __REACT_DEVTOOLS_GLOBAL_HOOK__ = originalHook;
  `);
  assert.equal(page.status().heatmapAvailable, true);
  assert.equal(page.run(`__REACT_DEVTOOLS_GLOBAL_HOOK__ === originalHook`), true);
  assert.equal(page.run(`originalHook.inject({version:'18.3.1'},'extra')`), 42);
  assert.equal(page.run(`root = {current:{child:null}}; originalHook.onCommitFiberRoot(9,root,'priority',true)`), 'native result');
  assert.equal(page.run(`calls.every(call => call.receiver === originalHook) && calls[1].args.length === 4`), true);
  assert.throws(() => page.run(`originalHook.onCommitFiberRoot(9,root,'throw')`), error => error.message === 'DevTools failure');
  page.run(source);
  const before = page.status().commitCount;
  page.run(`originalHook.onCommitFiberRoot(9,root)`);
  assert.equal(page.status().commitCount, before + 1, 'reinjection must not stack observers');
});

test('failed DevTools registration does not claim attachment, but a later real commit can establish it', () => {
  const page = pageAgent(`__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber:true, renderers:new Map(), inject(){throw new Error('registration failed')}, onCommitFiberRoot(){}
  }`);
  assert.throws(() => page.run(`__REACT_DEVTOOLS_GLOBAL_HOOK__.inject({})`), /registration failed/);
  assert.equal(page.status().heatmapAvailable,false);
  page.run(`__REACT_DEVTOOLS_GLOBAL_HOOK__.onCommitFiberRoot(1,{current:{child:null}})`);
  assert.equal(page.status().heatmapAvailable,true);
});

for (const blocked of ['disabled','unsupported','protected']) {
  test(`${blocked} DevTools hooks remain intact and do not prevent issue capture`, () => {
    const page = pageAgent(`
      originalHook = {supportsFiber:${blocked !== 'unsupported'},isDisabled:${blocked === 'disabled'},renderers:new Map([[1,{}]]),inject(){return 1},onCommitFiberRoot(){}};
      nativeInject=originalHook.inject; nativeCommit=originalHook.onCommitFiberRoot;
      ${blocked === 'protected' ? "Object.defineProperty(originalHook,'onCommitFiberRoot',{writable:false});" : ''}
      __REACT_DEVTOOLS_GLOBAL_HOOK__ = originalHook;
    `);
    assert.equal(page.status().heatmapAvailable, false);
    assert.equal(page.run(`__REACT_DEVTOOLS_GLOBAL_HOOK__ === originalHook`), true);
    assert.equal(page.run(`originalHook.inject===nativeInject && originalHook.onCommitFiberRoot===nativeCommit`), true,
      'a partial wrap must roll back without changing the existing hook');
    page.control('heatmap',{enabled:true});
    assert.equal(page.status().heatmapEnabled, false);
    page.run(`console.warn('capture still works')`);
    assert.equal(page.events.findLast(event => event.kind === 'issue').details.issue.message, 'capture still works');
  });
}
