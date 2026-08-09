const test = require('node:test');
const assert = require('node:assert/strict');

const Core = require('../core.js');

test('derives the product name from common auth page titles', () => {
  assert.equal(Core.derivePageName('Login — HikeStrong'), 'HikeStrong');
  assert.equal(Core.derivePageName('HikeStrong | Sign in'), 'HikeStrong');
  assert.equal(Core.derivePageName('Create account - AOI'), 'AOI');
});

test('keeps a useful full page title when no auth wrapper is present', () => {
  assert.equal(Core.derivePageName('Trail Planner'), 'Trail Planner');
  assert.equal(Core.derivePageName(''), 'Untitled page');
});

test('uses localhost, port, and page name in the site identity', () => {
  const identity = Core.getSiteIdentity(
    {
      protocol: 'http:',
      hostname: 'localhost',
      port: '3000',
      origin: 'http://localhost:3000',
    },
    'Login — HikeStrong'
  );

  assert.equal(identity.environment, 'local');
  assert.equal(identity.originLabel, 'localhost:3000');
  assert.equal(identity.projectName, 'HikeStrong');
  assert.equal(identity.siteKey, 'local:localhost:3000:hikestrong');
});

test('honors a user-provided page-name override', () => {
  const identity = Core.getSiteIdentity(
    {
      protocol: 'http:',
      hostname: 'localhost',
      port: '5173',
      origin: 'http://localhost:5173',
    },
    'Login',
    'Actual Plan'
  );

  assert.equal(identity.pageName, 'Login');
  assert.equal(identity.projectName, 'Actual Plan');
  assert.equal(identity.siteKey, 'local:localhost:5173:actual-plan');
});

test('generates deterministic test credentials with required password classes', () => {
  let cursor = 0;
  const values = [0.01, 0.2, 0.4, 0.6, 0.8];
  const random = () => values[(cursor += 1) % values.length];
  const identity = Core.buildGeneratedIdentity('HikeStrong', 'Admin', random);

  assert.match(identity.email, /^hikestrong\.admin\.[a-z0-9]{6}@example\.test$/);
  assert.equal(identity.password.length, 16);
  assert.match(identity.password, /[A-Z]/);
  assert.match(identity.password, /[a-z]/);
  assert.match(identity.password, /[0-9]/);
  assert.match(identity.password, /[!@#$%]/);
});

test('normalizes malformed stored state safely', () => {
  assert.deepEqual(Core.normalizeStoredState(null), { users: [], siteProfiles: {} });
  assert.deepEqual(Core.normalizeStoredState({ users: 'bad', siteProfiles: [] }), {
    users: [],
    siteProfiles: {},
  });
});
