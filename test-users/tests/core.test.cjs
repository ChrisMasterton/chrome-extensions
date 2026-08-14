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
  assert.equal(identity.username, '');
  assert.equal(identity.password.length, 16);
  assert.match(identity.password, /[A-Z]/);
  assert.match(identity.password, /[a-z]/);
  assert.match(identity.password, /[0-9]/);
  assert.match(identity.password, /[!@#$%]/);
});

const testUser = {
  name: 'Member Tester',
  email: 'hikestrong.member.x7k2p9@example.test',
  password: 'Secret!234Secret',
};

test('splits person names for first and last name fields', () => {
  assert.deepEqual(Core.splitPersonName('Member Tester'), { first: 'Member', last: 'Tester' });
  assert.deepEqual(Core.splitPersonName('Ana de la Cruz'), { first: 'Ana', last: 'de la Cruz' });
  assert.deepEqual(Core.splitPersonName('Alex'), { first: 'Alex', last: 'Tester' });
  assert.deepEqual(Core.splitPersonName(''), { first: 'Test', last: 'Tester' });
});

test('classifies fields from labels, attributes, and autocomplete', () => {
  assert.equal(Core.classifyFillField({ type: 'text', labelText: 'Name' }), 'full-name');
  assert.equal(Core.classifyFillField({ type: 'text', name: 'fullName' }), 'full-name');
  assert.equal(Core.classifyFillField({ type: 'text', placeholder: 'First name' }), 'first-name');
  assert.equal(Core.classifyFillField({ type: 'text', autocomplete: 'family-name' }), 'last-name');
  assert.equal(Core.classifyFillField({ type: 'text', name: 'email_address' }), 'email');
  assert.equal(Core.classifyFillField({ type: 'text', ariaLabel: 'Username' }), 'username');
  assert.equal(Core.classifyFillField({ type: 'password', name: 'anything' }), 'password');
  assert.equal(Core.classifyFillField({ type: 'text', labelText: 'Company name' }), null);
  assert.equal(Core.classifyFillField({ type: 'search', name: 'name' }), null);
});

test('plans a sign-up form fill including a label-only name field', () => {
  const plan = Core.buildFillPlan(
    [
      { type: 'text', name: 'name', labelText: 'Name', formIndex: 0 },
      { type: 'email', name: 'email', formIndex: 0 },
      { type: 'password', name: 'password', formIndex: 0 },
      { type: 'password', name: 'password_confirmation', formIndex: 0 },
      { type: 'text', name: 'company_name', labelText: 'Company name', formIndex: 0 },
    ],
    testUser
  );

  assert.deepEqual(plan, [
    { index: 0, purpose: 'full-name', value: 'Member Tester' },
    { index: 1, purpose: 'email', value: testUser.email },
    { index: 2, purpose: 'password', value: testUser.password },
    { index: 3, purpose: 'password', value: testUser.password },
  ]);
});

test('plans first and last name fills from the stored display name', () => {
  const plan = Core.buildFillPlan(
    [
      { type: 'text', autocomplete: 'given-name', formIndex: 0 },
      { type: 'text', autocomplete: 'family-name', formIndex: 0 },
      { type: 'email', formIndex: 0 },
      { type: 'password', formIndex: 0 },
    ],
    testUser
  );

  assert.deepEqual(
    plan.map((step) => [step.purpose, step.value]),
    [
      ['first-name', 'Member'],
      ['last-name', 'Tester'],
      ['email', testUser.email],
      ['password', testUser.password],
    ]
  );
});

test('fills username with the full email on login forms without an email field', () => {
  const plan = Core.buildFillPlan(
    [
      { type: 'text', name: 'username', formIndex: 0 },
      { type: 'password', name: 'password', formIndex: 0 },
    ],
    testUser
  );

  assert.deepEqual(
    plan.map((step) => [step.purpose, step.value]),
    [
      ['username', testUser.email],
      ['password', testUser.password],
    ]
  );
});

test('fills username with the email local part when an email field also exists', () => {
  const plan = Core.buildFillPlan(
    [
      { type: 'text', name: 'username', formIndex: 0 },
      { type: 'email', name: 'email', formIndex: 0 },
      { type: 'password', formIndex: 0 },
    ],
    testUser
  );

  assert.equal(plan[0].value, 'hikestrong.member.x7k2p9');
});

test('prefers a stored username over email-derived fallbacks', () => {
  const userWithUsername = { ...testUser, username: 'hike_member' };
  const fields = [
    { type: 'text', name: 'username', formIndex: 0 },
    { type: 'email', name: 'email', formIndex: 0 },
    { type: 'password', formIndex: 0 },
  ];

  const plan = Core.buildFillPlan(fields, userWithUsername);
  assert.equal(plan[0].value, 'hike_member');
  assert.equal(plan[1].value, testUser.email);

  const loginOnlyPlan = Core.buildFillPlan(fields.slice(0, 1).concat(fields.slice(2)), userWithUsername);
  assert.equal(loginOnlyPlan[0].value, 'hike_member');
});

test('fills only matching fields for a username-only user', () => {
  const usernameOnlyUser = { name: 'Member Tester', username: 'hike_member', password: 'Secret!234Secret' };

  const plan = Core.buildFillPlan(
    [
      { type: 'text', name: 'username', formIndex: 0 },
      { type: 'password', formIndex: 0 },
    ],
    usernameOnlyUser
  );
  assert.deepEqual(
    plan.map((step) => [step.purpose, step.value]),
    [
      ['username', 'hike_member'],
      ['password', usernameOnlyUser.password],
    ]
  );

  const emailFormPlan = Core.buildFillPlan(
    [
      { type: 'email', name: 'email', formIndex: 0 },
      { type: 'password', formIndex: 0 },
    ],
    usernameOnlyUser
  );
  assert.deepEqual(
    emailFormPlan.map((step) => step.purpose),
    ['password']
  );
});

test('treats a lone unlabeled text input beside a password as the username', () => {
  const plan = Core.buildFillPlan(
    [
      { type: 'text', name: 'q', placeholder: 'Search docs', formIndex: null },
      { type: 'text', name: 'acct', formIndex: 0 },
      { type: 'password', name: 'pw', formIndex: 0 },
    ],
    testUser
  );

  assert.deepEqual(
    plan.map((step) => [step.purpose, step.value]),
    [
      ['username', testUser.email],
      ['password', testUser.password],
    ]
  );
});

test('describes a fill plan for the confirmation toast', () => {
  assert.equal(
    Core.describeFillPlan([
      { purpose: 'full-name' },
      { purpose: 'email' },
      { purpose: 'password' },
      { purpose: 'password' },
    ]),
    'name, email & 2 password fields'
  );
  assert.equal(
    Core.describeFillPlan([{ purpose: 'email' }, { purpose: 'password' }]),
    'email & password'
  );
  assert.equal(Core.describeFillPlan([{ purpose: 'username' }]), 'username');
});

test('normalizes malformed stored state safely', () => {
  assert.deepEqual(Core.normalizeStoredState(null), { users: [], siteProfiles: {} });
  assert.deepEqual(Core.normalizeStoredState({ users: 'bad', siteProfiles: [] }), {
    users: [],
    siteProfiles: {},
  });
});
