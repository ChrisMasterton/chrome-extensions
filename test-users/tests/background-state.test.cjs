const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');
const Core = require('../core.js');

const STORAGE_KEY = 'testUsersStateV1';
const ORIGIN = 'http://localhost:3000';
const SITE_ID = 'site:localhost:3000';
const controlUser = { id: 'control', origin: ORIGIN, siteId: SITE_ID, email: 'control@example.test' };
const controlSnapshot = { id: 'control-form', origin: ORIGIN, siteId: SITE_ID, fields: [] };

function seedState() {
  return {
    version: 2,
    sites: { [SITE_ID]: { id: SITE_ID, name: 'Saved project' } },
    origins: { [ORIGIN]: { siteId: SITE_ID, environment: '' } },
    users: [controlUser],
    snapshots: [controlSnapshot],
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((complete) => { resolve = complete; });
  return { promise, resolve };
}

function backgroundHarness(beforeSet = async () => {}) {
  let saved = structuredClone(seedState());
  let onMessage;
  let reads = 0;
  let writes = 0;
  const context = vm.createContext({
    importScripts: (file) => {
      assert.equal(file, 'core.js');
      context.TestUsersCore = Core;
    },
    chrome: {
      runtime: { onMessage: { addListener: (listener) => { onMessage = listener; } } },
      action: { onClicked: { addListener() {} } },
      storage: { local: {
        get: async () => {
          reads += 1;
          return { [STORAGE_KEY]: structuredClone(saved) };
        },
        set: async (value) => {
          writes += 1;
          await beforeSet(writes);
          saved = structuredClone(value[STORAGE_KEY]);
        },
      } },
    },
  });
  vm.runInContext(readFileSync(join(__dirname, '../background.js'), 'utf8'), context);
  return {
    request: (mutation) => new Promise((resolveResponse) => {
      assert.equal(onMessage(
        { type: 'TEST_USERS_MUTATE_STATE', mutation },
        { tab: { id: 1 } },
        (response) => resolveResponse(structuredClone(response))
      ), true);
    }),
    read: () => structuredClone(saved),
    counts: () => ({ reads, writes }),
  };
}

test('overlapping account, snapshot, and settings saves apply to the latest committed state', { timeout: 3000 }, async () => {
  const started = deferred();
  const release = deferred();
  const background = backgroundHarness(async (write) => {
    if (write === 1) {
      started.resolve();
      await release.promise;
    }
  });
  const user = { id: 'new-user', origin: ORIGIN, siteId: SITE_ID, email: 'new@example.test' };
  const snapshot = { id: 'new-form', origin: ORIGIN, siteId: SITE_ID, fields: [{ id: 'company', value: 'Saved input' }] };
  const first = background.request({ type: 'save-user', origin: ORIGIN, user });
  await started.promise;
  const second = background.request({ type: 'save-snapshot', origin: ORIGIN, snapshot });
  const third = background.request({ type: 'set-password-symbols', origin: ORIGIN, symbols: '!%' });
  assert.deepEqual(background.counts(), { reads: 1, writes: 1 }, 'later saves must wait before reading state');
  release.resolve();
  const replies = await Promise.all([first, second, third]);
  assert.ok(replies.every((reply) => reply.ok));
  const saved = background.read();
  assert.deepEqual(saved.users, [user, controlUser]);
  assert.deepEqual(saved.snapshots, [snapshot, controlSnapshot]);
  assert.equal(saved.sites[SITE_ID].passwordSymbols, '!%');
  assert.equal(saved.sites[SITE_ID].name, 'Saved project');
  assert.deepEqual(background.counts(), { reads: 3, writes: 3 });
});

test('a failed write leaves storage unchanged and does not block a queued save', { timeout: 3000 }, async () => {
  const background = backgroundHarness(async (write) => {
    if (write === 1) throw new Error('Storage write rejected');
  });
  const user = { id: 'failed-user', origin: ORIGIN, siteId: SITE_ID, email: 'failed@example.test' };
  const snapshot = { id: 'saved-form', origin: ORIGIN, siteId: SITE_ID, fields: [] };
  const [failed, saved] = await Promise.all([
    background.request({ type: 'save-user', origin: ORIGIN, user }),
    background.request({ type: 'save-snapshot', origin: ORIGIN, snapshot }),
  ]);
  assert.equal(failed.ok, false);
  assert.equal(failed.error, 'Storage write rejected');
  assert.equal(saved.ok, true);
  assert.deepEqual(background.read().users, [controlUser]);
  assert.deepEqual(background.read().snapshots, [snapshot, controlSnapshot]);
});

test('linking and deleting sites use current membership rather than the submitting tab snapshot', () => {
  const targetId = 'site:shared';
  let state = seedState();
  state.sites[targetId] = { id: targetId, name: 'Shared project' };
  const user = { id: 'just-saved', origin: ORIGIN, siteId: SITE_ID, email: 'new@example.test' };
  state = Core.applyStoredMutation(state, { type: 'save-user', origin: ORIGIN, user }).state;
  state = Core.applyStoredMutation(state, {
    type: 'save-settings', origin: ORIGIN, linkedSiteId: targetId,
    siteName: '', environment: '', adapterUrl: '',
  }).state;
  assert.ok(state.users.every((record) => record.siteId === targetId));
  assert.equal(state.snapshots[0].siteId, targetId);
  assert.equal(state.sites[targetId].name, 'Shared project');
  assert.equal(state.sites[SITE_ID], undefined);

  const lateSnapshot = { id: 'late-form', origin: ORIGIN, siteId: SITE_ID, fields: [] };
  state = Core.applyStoredMutation(state, { type: 'save-snapshot', origin: ORIGIN, snapshot: lateSnapshot }).state;
  assert.equal(state.snapshots[0].siteId, targetId, 'a save prepared before linking must follow the latest origin mapping');
  const deleted = Core.applyStoredMutation(state, { type: 'delete-site', id: targetId });
  assert.equal(deleted.result.removedLoginCount, 2);
  assert.equal(deleted.result.removedSnapshotCount, 2);
  assert.deepEqual(deleted.state.users, []);
  assert.deepEqual(deleted.state.snapshots, []);
  assert.deepEqual(deleted.state.origins, {});
});

test('concurrent field edits retain the other edit and current provisioning metadata', () => {
  const base = { ...controlUser, name: 'Original name', notes: 'Original notes' };
  const state = seedState();
  state.users = [{ ...base, provisioning: { status: 'ready', accountRef: 'account-1' } }];
  const notesEdit = Core.applyStoredMutation(state, {
    type: 'save-user', origin: ORIGIN, base, user: { ...base, notes: 'New notes' },
  }).state;
  assert.equal(notesEdit.users[0].provisioning.status, 'ready');
  const nameEdit = Core.applyStoredMutation(notesEdit, {
    type: 'save-user', origin: ORIGIN, base, user: { ...base, name: 'New name' },
  }).state;
  assert.equal(nameEdit.users[0].notes, 'New notes');
  assert.equal(nameEdit.users[0].name, 'New name');
  assert.equal(nameEdit.users[0].provisioning.accountRef, 'account-1');
  assert.equal(nameEdit.users[0].provisioning.status, 'stale', 'changing provisioned identity must invalidate its ready state');

  const snapshotBase = { ...controlSnapshot, name: 'Original form' };
  state.snapshots = [snapshotBase];
  const fieldsEdit = Core.applyStoredMutation(state, {
    type: 'save-snapshot', origin: ORIGIN, base: snapshotBase,
    snapshot: { ...snapshotBase, fields: [{ id: 'company', value: 'New company' }] },
  }).state;
  const renamed = Core.applyStoredMutation(fieldsEdit, {
    type: 'save-snapshot', origin: ORIGIN, base: snapshotBase,
    snapshot: { ...snapshotBase, name: 'Renamed form' },
  }).state;
  assert.equal(renamed.snapshots[0].name, 'Renamed form');
  assert.deepEqual(renamed.snapshots[0].fields, [{ id: 'company', value: 'New company' }]);
});

test('conflicting edits and edits to deleted records cannot overwrite saved work', () => {
  for (const [collection, type, record] of [
    ['users', 'user', { ...controlUser, name: 'Original name' }],
    ['snapshots', 'snapshot', { ...controlSnapshot, name: 'Original form' }],
  ]) {
    const state = seedState();
    state[collection] = [{ ...record, name: 'Other tab name' }];
    const before = structuredClone(state);
    const mutation = {
      type: `save-${type}`, origin: ORIGIN, base: record,
      [type]: { ...record, name: 'My tab name' },
    };
    assert.throws(() => Core.applyStoredMutation(state, mutation), /changed in another tab/);
    assert.deepEqual(state, before, 'a rejected edit must leave stored facts unchanged');
    state[collection] = [];
    assert.throws(() => Core.applyStoredMutation(state, mutation), /deleted in another tab/);
    assert.deepEqual(state[collection], [], 'stale editors must not recreate deleted records');
  }
});

test('settings retain concurrent edits, reject conflicting values, and still allow explicit clears', () => {
  const base = { siteId: SITE_ID, siteName: 'Saved project', environment: '', adapterUrl: '' };
  const save = {
    type: 'save-settings', origin: ORIGIN, linkedSiteId: '',
    siteName: '', environment: '', adapterUrl: '', base,
  };
  const adapterUrl = `${ORIGIN}/__test-users`;
  const adapterEdit = Core.applyStoredMutation(seedState(), { ...save, adapterUrl }).state;
  const renamed = Core.applyStoredMutation(adapterEdit, { ...save, siteName: 'New project name' }).state;
  assert.equal(renamed.origins[ORIGIN].adapterUrl, adapterUrl);
  assert.equal(renamed.sites[SITE_ID].name, 'New project name');
  const before = structuredClone(renamed);
  assert.throws(
    () => Core.applyStoredMutation(renamed, { ...save, adapterUrl: `${ORIGIN}/other-adapter` }),
    /changed in another tab/
  );
  assert.deepEqual(renamed, before);
  const cleared = Core.applyStoredMutation(renamed, {
    ...save, base: { ...base, siteName: 'New project name', adapterUrl },
  }).state;
  assert.equal(cleared.origins[ORIGIN].adapterUrl, '', 'clearing a freshly opened adapter setting must still work');
  assert.equal(cleared.sites[SITE_ID].name, 'New project name');
});

test('competing site links and stale site-name edits cannot change the newly linked site', () => {
  const state = seedState();
  state.sites['site:first'] = { id: 'site:first', name: 'First project' };
  state.sites['site:second'] = { id: 'site:second', name: 'Second project' };
  const save = {
    type: 'save-settings', origin: ORIGIN, linkedSiteId: '', siteName: '',
    environment: '', adapterUrl: '',
    base: { siteId: SITE_ID, siteName: 'Saved project', environment: '', adapterUrl: '' },
  };
  const linked = Core.applyStoredMutation(state, { ...save, linkedSiteId: 'site:first' }).state;
  const before = structuredClone(linked);
  const outcomes = [{ linkedSiteId: 'site:second' }, { siteName: 'Stale source name' }].map((change) => {
    try {
      const applied = Core.applyStoredMutation(linked, { ...save, ...change }).state;
      const siteId = applied.origins[ORIGIN].siteId;
      return { siteId, siteName: applied.sites[siteId].name };
    } catch (error) {
      assert.match(error.message, /changed in another tab/);
      return 'conflict';
    }
  });
  assert.deepEqual(outcomes, ['conflict', 'conflict']);
  assert.deepEqual(linked, before);
});
