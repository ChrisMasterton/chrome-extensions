import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

const background = await readFile(new URL('../background.js', import.meta.url), 'utf8');
const tour = { id: 'review', title: 'Review', steps: [
  { url: 'https://example.test/one', selector: '#one' },
  { url: 'https://example.test/two', selector: '#two' },
] };

function deferred() {
  let resolve;
  const promise = new Promise(complete => { resolve = complete; });
  return { promise, resolve };
}

function browserHarness() {
  const saved = {};
  const tab = { id: 7, url: 'https://example.test/one', status: 'complete' };
  const injections = [];
  const messages = [];
  const badges = [];
  let failInjection = false;
  let acknowledge = true;
  let injectionGate = null;

  function boot() {
    const listeners = {};
    const chrome = {
      storage: { session: {
        get: async key => ({ [key]: structuredClone(saved[key]) }),
        set: async values => Object.assign(saved, structuredClone(values)),
        remove: async key => { delete saved[key]; },
      } },
      action: {
        onClicked: { addListener: fn => { listeners.action = fn; } },
        setBadgeText: async details => { badges.push(details.text); },
        setBadgeBackgroundColor: async () => {}, setTitle: async () => {},
      },
      runtime: { onMessage: { addListener: fn => { listeners.message = fn; } } },
      tabs: {
        onUpdated: { addListener: fn => { listeners.update = fn; } },
        onRemoved: { addListener: fn => { listeners.remove = fn; } },
        get: async () => structuredClone(tab),
        update: (id, changes, callback) => {
          Object.assign(tab, changes);
          callback?.(structuredClone(tab));
          return Promise.resolve(structuredClone(tab));
        },
        sendMessage: async (id, message) => {
          messages.push(structuredClone(message));
          return acknowledge ? { ok: true, resumeToken: message.resumeToken } : undefined;
        },
      },
      scripting: {
        insertCSS: async () => {},
        executeScript: async input => {
          injections.push(input.files[0]);
          if (input.files[0] === 'picker.js') {
            if (injectionGate) await injectionGate.promise;
            if (failInjection) throw new Error('Injection permission unavailable');
          }
          return [{ frameId: 0, documentId: 'document-2' }];
        },
      },
    };
    const context = vm.createContext({ chrome, crypto: webcrypto, URL, console: { warn() {} }, setTimeout });
    vm.runInContext(background, context);
    async function idle() {
      for (let index = 0; index < 12; index++) await new Promise(setImmediate);
    }
    return {
      idle,
      request: message => new Promise(resolve => {
        listeners.message(message, { tab: structuredClone(tab), documentId: 'document-1', frameId: 0 }, resolve);
      }),
      complete: async () => { listeners.update(tab.id, { status: 'complete' }, structuredClone(tab)); await idle(); },
      remove: async () => { listeners.remove(tab.id); await idle(); },
      click: async () => { await listeners.action(structuredClone(tab)); await idle(); },
    };
  }
  return {
    boot, saved, tab, injections, messages, badges,
    fail: value => { failInjection = value; },
    ack: value => { acknowledge = value; },
    gate: value => { injectionGate = value; },
  };
}

async function openTour(worker) {
  const response = await worker.request({
    type: 'ELEMENT_PICKER_OPEN_TOUR_STEP', url: tour.steps[1].url,
    tour, stepIndex: 1, sessionId: 'tour-session', askNotes: [['review:step-1', 'Keep this note']],
  });
  assert.equal(response.ok, true);
}

test('Break on Load survives a cold background and explicit disable persists', async () => {
  const browser = browserHarness();
  let worker = browser.boot();
  assert.equal((await worker.request({ type: 'ELEMENT_PICKER_SET_BREAK_ON_LOAD', enabled: true })).ok, true);
  worker = browser.boot();
  await worker.complete();
  assert.ok(browser.injections.includes('picker.js'));
  assert.ok(browser.messages.some(message => message.type === 'ELEMENT_PICKER_BREAK_ON_LOAD_RESUME'));
  await worker.request({ type: 'ELEMENT_PICKER_SET_BREAK_ON_LOAD', enabled: false });
  browser.injections.length = 0;
  worker = browser.boot();
  await worker.complete();
  assert.equal(browser.injections.length, 0);
});

test('pending tours survive restart and restore Break on Load, step, and notes together', async () => {
  const browser = browserHarness();
  let worker = browser.boot();
  await worker.request({ type: 'ELEMENT_PICKER_SET_BREAK_ON_LOAD', enabled: true });
  await openTour(worker);
  worker = browser.boot();
  await worker.complete();
  const resumed = browser.messages.find(message => message.type === 'ELEMENT_PICKER_RESUME_TOUR');
  assert.ok(resumed);
  assert.equal(resumed.stepIndex, 1);
  assert.equal(resumed.breakOnLoadEnabled, true);
  assert.deepEqual(resumed.askNotes, [['review:step-1', 'Keep this note']]);
});

test('failed reinjection remains retryable after another background restart', async () => {
  const browser = browserHarness();
  let worker = browser.boot();
  await openTour(worker);
  browser.fail(true);
  await worker.complete();
  assert.equal(browser.messages.some(message => message.type === 'ELEMENT_PICKER_RESUME_TOUR'), false);
  browser.fail(false);
  worker = browser.boot();
  await worker.click();
  assert.ok(browser.messages.some(message => message.type === 'ELEMENT_PICKER_RESUME_TOUR'));
  assert.equal(browser.badges.at(-1), '');
});

test('a missing page acknowledgement does not consume the pending tour', async () => {
  const browser = browserHarness();
  let worker = browser.boot();
  await openTour(worker);
  browser.ack(false);
  await worker.complete();
  browser.ack(true);
  browser.messages.length = 0;
  worker = browser.boot();
  await worker.click();
  assert.ok(browser.messages.some(message => message.type === 'ELEMENT_PICKER_RESUME_TOUR'));
});

test('tab removal cleans persisted navigation state without resurrecting it on restart', async () => {
  const browser = browserHarness();
  let worker = browser.boot();
  await worker.request({ type: 'ELEMENT_PICKER_SET_BREAK_ON_LOAD', enabled: true });
  await openTour(worker);
  await worker.remove();
  browser.injections.length = 0;
  worker = browser.boot();
  await worker.complete();
  assert.equal(browser.injections.length, 0);
  assert.deepEqual(browser.saved, {});
});

test('closing the bridge during reinjection prevents a late continuation', async () => {
  const browser = browserHarness();
  const worker = browser.boot();
  await openTour(worker);
  const gate = deferred();
  browser.gate(gate);
  const completing = worker.complete();
  await worker.idle();
  await worker.request({ type: 'ELEMENT_PICKER_CLEAR_SESSION' });
  gate.resolve();
  await completing;
  await worker.idle();
  assert.equal(browser.messages.some(message => message.type === 'ELEMENT_PICKER_RESUME_TOUR'), false);
  assert.deepEqual(browser.saved, {});
});

test('an old document cannot end a tour already restored in the new document', async () => {
  const browser = browserHarness();
  const worker = browser.boot();
  await openTour(worker);
  await worker.complete();
  const saved = structuredClone(browser.saved);
  browser.messages.length = 0;
  const response = await worker.request({ type: 'ELEMENT_PICKER_CLEAR_TOUR', sessionId: 'tour-session' });
  assert.equal(response.cleared, false);
  assert.deepEqual(browser.saved, saved);
  assert.equal(browser.messages.some(message => message.type === 'ELEMENT_PICKER_TOUR_ENDED'), false);
});

test('a late reinjection cannot consume a replacement tour', async () => {
  const browser = browserHarness();
  const worker = browser.boot();
  await openTour(worker);
  const gate = deferred();
  browser.gate(gate);
  await worker.complete();
  await worker.request({ type: 'ELEMENT_PICKER_CLEAR_SESSION' });
  await worker.request({
    type: 'ELEMENT_PICKER_OPEN_TOUR_STEP', url: tour.steps[0].url,
    tour, stepIndex: 0, sessionId: 'replacement',
  });
  gate.resolve();
  await worker.idle();
  await worker.complete();
  const resumed = browser.messages.filter(message => message.type === 'ELEMENT_PICKER_RESUME_TOUR');
  assert.equal(resumed.length, 1);
  assert.equal(resumed[0].sessionId, 'replacement');
  assert.equal(resumed[0].stepIndex, 0);
});
