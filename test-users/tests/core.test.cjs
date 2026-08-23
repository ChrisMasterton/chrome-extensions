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

test('allows only same-origin local or staging provisioning adapters', () => {
  assert.equal(
    Core.normalizeAdapterUrl('/__test-users', 'http://localhost:3000', 'local'),
    'http://localhost:3000/__test-users'
  );
  assert.equal(
    Core.normalizeAdapterUrl(
      'https://staging.example.com/qa/users#ignored',
      'https://staging.example.com',
      'staging'
    ),
    'https://staging.example.com/qa/users'
  );
  assert.throws(
    () => Core.normalizeAdapterUrl('https://evil.example/api', 'http://localhost:3000', 'local'),
    /must use this site origin/
  );
  assert.throws(
    () => Core.normalizeAdapterUrl('/__test-users', 'https://app.example.com', 'web'),
    /only on local or staging/
  );
  assert.throws(
    () => Core.normalizeAdapterUrl('/__test-users', 'http://staging.example.com', 'staging'),
    /must use HTTPS/
  );
});

test('normalizes adapter roles and scenarios without accepting credential metadata', () => {
  assert.deepEqual(
    Core.normalizeAdapterCapabilities({
      label: 'HikeStrong fixtures',
      roles: ['Member', { id: 'org-admin', label: 'Admin', description: 'Owns the org' }],
      scenarios: [{ id: 'empty-org', label: 'Empty organization' }],
      capabilities: { provision: true, reset: true },
    }),
    {
      schemaVersion: 1,
      label: 'HikeStrong fixtures',
      roles: [
        { id: 'Member', label: 'Member', description: '' },
        { id: 'org-admin', label: 'Admin', description: 'Owns the org' },
      ],
      scenarios: [{ id: 'empty-org', label: 'Empty organization', description: '' }],
      canProvision: true,
      canReset: true,
    }
  );

  assert.throws(
    () =>
      Core.normalizeAdapterCapabilities({
        roles: ['Member'],
        scenarios: [],
        users: [{ username: 'leaked', password: 'secret' }],
      }),
    /must not include users/
  );
  assert.throws(
    () => Core.normalizeAdapterCapabilities({ roles: [], scenarios: [] }),
    /at least one role/
  );
});

test('adapter results keep only an opaque account reference and state', () => {
  assert.deepEqual(
    Core.normalizeAdapterResult({
      status: 'ready',
      accountRef: 'acct_test_123',
      stateLabel: 'Admin · Empty organization',
      expiresAt: '2026-08-24T12:00:00Z',
    }),
    {
      status: 'ready',
      accountRef: 'acct_test_123',
      stateLabel: 'Admin · Empty organization',
      expiresAt: '2026-08-24T12:00:00.000Z',
    }
  );
  assert.throws(
    () => Core.normalizeAdapterResult({ accountRef: 'acct_test_123', password: 'leaked' }),
    /must not include password/
  );
  assert.throws(
    () => Core.normalizeAdapterResult({ accountRef: 'acct_test_123', name: 'Leaked User' }),
    /must not include name/
  );
  assert.throws(
    () => Core.normalizeAdapterResult({ status: 'ready' }),
    /account reference/
  );
});

test('provision requests send extension-owned identity while reset uses only account reference', () => {
  const user = {
    id: 'local-user-1',
    name: 'Admin Tester',
    role: 'Admin',
    roleId: 'org-admin',
    scenarioId: 'empty-org',
    scenarioLabel: 'Empty organization',
    email: 'admin@example.test',
    username: 'admin-test',
    password: 'Generated!123',
    provisioning: { accountRef: 'acct_test_123' },
  };
  const provision = Core.buildAdapterRequest(user, 'provision');
  assert.deepEqual(provision.identity, {
    name: 'Admin Tester',
    email: 'admin@example.test',
    username: 'admin-test',
    password: 'Generated!123',
  });
  assert.deepEqual(provision.role, { id: 'org-admin', label: 'Admin' });
  assert.deepEqual(provision.scenario, { id: 'empty-org', label: 'Empty organization' });

  const reset = Core.buildAdapterRequest(user, 'reset');
  assert.equal(reset.accountRef, 'acct_test_123');
  assert.equal('identity' in reset, false);
  assert.equal(JSON.stringify(reset).includes('Generated!123'), false);
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

test('restricts generated passwords to the allowed symbols', () => {
  let cursor = 0;
  const values = [0.01, 0.2, 0.4, 0.6, 0.8];
  const random = () => values[(cursor += 1) % values.length];

  const alphanumeric = Core.generatePassword(random, '');
  assert.equal(alphanumeric.length, 16);
  assert.match(alphanumeric, /^[A-Za-z0-9]+$/);

  const restricted = Core.generatePassword(random, '#$');
  assert.equal(restricted.length, 16);
  assert.match(restricted, /^[A-Za-z0-9#$]+$/);
  assert.match(restricted, /[#$]/);

  const identity = Core.buildGeneratedIdentity('HikeStrong', 'Admin', random, '');
  assert.match(identity.password, /^[A-Za-z0-9]+$/);
});

test('sanitizes stored password symbol preferences', () => {
  assert.equal(Core.sanitizePasswordSymbols(undefined), '!@#$%');
  assert.equal(Core.sanitizePasswordSymbols(null), '!@#$%');
  assert.equal(Core.sanitizePasswordSymbols(''), '');
  assert.equal(Core.sanitizePasswordSymbols('#!'), '!#');
  assert.equal(Core.sanitizePasswordSymbols(['$', '@']), '@$');
  assert.equal(Core.sanitizePasswordSymbols('&*~'), '');
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
  assert.deepEqual(Core.normalizeStoredState(null), {
    users: [],
    snapshots: [],
    siteProfiles: {},
  });
  assert.deepEqual(
    Core.normalizeStoredState({ users: 'bad', snapshots: 'bad', siteProfiles: [] }),
    {
      users: [],
      snapshots: [],
      siteProfiles: {},
    }
  );
});

test('never snapshots credential, payment, or one-time-code fields', () => {
  assert.equal(Core.snapshotExclusionReason({ type: 'password', name: 'pw' }), 'credential');
  assert.equal(Core.snapshotExclusionReason({ type: 'email', name: 'contact' }), 'credential');
  assert.equal(Core.snapshotExclusionReason({ type: 'text', name: 'username' }), 'credential');
  assert.equal(
    Core.snapshotExclusionReason({ type: 'text', autocomplete: 'new-password' }),
    'credential'
  );
  assert.equal(
    Core.snapshotExclusionReason({ type: 'text', autocomplete: 'cc-number' }),
    'payment'
  );
  assert.equal(
    Core.snapshotExclusionReason({ tag: 'select', type: 'select-one', autocomplete: 'cc-exp-month' }),
    'payment'
  );
  assert.equal(
    Core.snapshotExclusionReason({ type: 'text', labelText: 'Card number' }),
    'payment'
  );
  assert.equal(
    Core.snapshotExclusionReason({ type: 'text', autocomplete: 'one-time-code' }),
    'one-time'
  );
  assert.equal(Core.snapshotExclusionReason({ type: 'text', name: 'promo_code' }), 'one-time');
  assert.equal(Core.snapshotExclusionReason({ type: 'hidden', name: 'csrf' }), 'unsupported');

  // Ordinary long-form fields stay capturable, including ones login fill skips.
  assert.equal(Core.snapshotExclusionReason({ type: 'tel', name: 'phone' }), null);
  assert.equal(Core.snapshotExclusionReason({ type: 'text', name: 'zip' }), null);
  assert.equal(Core.snapshotExclusionReason({ type: 'text', labelText: 'Company' }), null);
  assert.equal(Core.snapshotExclusionReason({ type: 'text', name: 'first_name' }), null);
  assert.equal(
    Core.snapshotExclusionReason({ tag: 'select', type: 'select-one', name: 'country' }),
    null
  );
});

test('builds snapshot fields, skipping sensitive fields and unchecked radios', () => {
  const { fields, skippedCount } = Core.buildSnapshotFields([
    { tag: 'input', type: 'text', name: 'company', labelText: 'Company', value: 'HikeStrong QA' },
    { tag: 'input', type: 'email', name: 'email', value: 'real@example.com' },
    { tag: 'input', type: 'password', name: 'password', value: 'hunter2' },
    { tag: 'input', type: 'radio', name: 'plan', value: 'starter', checked: false },
    { tag: 'input', type: 'radio', name: 'plan', value: 'pro', checked: true },
    { tag: 'input', type: 'checkbox', name: 'newsletter', value: 'on', checked: true },
    { tag: 'select', type: 'select-one', name: 'country', value: 'US', options: [
      { value: '', label: 'Choose' },
      { value: 'US', label: 'United States' },
    ] },
    { tag: 'textarea', type: 'textarea', name: 'bio', value: 'Notes' },
    { tag: 'input', type: 'text', name: 'city', labelText: 'City', value: '' },
    { tag: 'input', type: 'text', value: 'no identifier at all' },
  ]);

  assert.equal(skippedCount, 2, 'email and password are counted as sensitive skips');
  assert.deepEqual(
    fields.map((field) => [field.id, field.kind, field.excluded]),
    [
      ['f1', 'text', false],
      ['f2', 'radio', false],
      ['f3', 'checkbox', false],
      ['f4', 'select', false],
      ['f5', 'textarea', false],
      ['f6', 'text', true],
      ['f7', 'text', true],
    ]
  );
  assert.equal(fields[1].matcher.radioValue, 'pro');
  assert.equal(fields[2].checked, true);
  assert.equal(fields[3].options.length, 2);
});

const snapshotPageFields = [
  { tag: 'input', type: 'text', id: 'company-field', name: 'company', labelText: 'Company' },
  { tag: 'input', type: 'tel', name: 'phone', labelText: 'Phone' },
  { tag: 'input', type: 'email', name: 'email' },
  { tag: 'input', type: 'radio', name: 'plan', value: 'starter' },
  { tag: 'input', type: 'radio', name: 'plan', value: 'pro' },
  { tag: 'select', type: 'select-one', name: 'country' },
];

test('plans a refill by stable identity, never touching sensitive page fields', () => {
  const { fields } = Core.buildSnapshotFields([
    { tag: 'input', type: 'text', id: 'company-field', name: 'company', labelText: 'Company', value: 'HikeStrong QA' },
    { tag: 'input', type: 'tel', name: 'phone', labelText: 'Phone', value: '555-0100' },
    { tag: 'input', type: 'radio', name: 'plan', value: 'pro', checked: true },
    { tag: 'select', type: 'select-one', name: 'country', value: 'US' },
    { tag: 'input', type: 'text', name: 'missing_on_page', labelText: 'Old field', value: 'gone' },
  ]);

  const { steps, missing } = Core.buildRefillPlan(fields, snapshotPageFields);
  assert.deepEqual(
    steps.map((step) => [step.index, step.value]),
    [
      [0, 'HikeStrong QA'],
      [1, '555-0100'],
      [4, 'pro'],
      [5, 'US'],
    ]
  );
  assert.equal(steps[2].kind, 'radio', 'the pro radio, not the starter radio, is selected');
  assert.deepEqual(missing, [fields[4].id]);
});

test('refill skips excluded fields and refuses tampered credential targets', () => {
  const { fields } = Core.buildSnapshotFields([
    { tag: 'input', type: 'text', name: 'company', value: 'HikeStrong QA' },
    { tag: 'input', type: 'tel', name: 'phone', value: '555-0100' },
  ]);
  fields[1].excluded = true;
  // Simulate hand-edited storage pointing a snapshot field at an email input.
  const tampered = {
    id: 'f9',
    kind: 'text',
    label: 'Sneaky',
    value: 'attacker@example.com',
    excluded: false,
    matcher: {
      tag: 'input', type: 'email', kind: 'text', domId: '', name: 'email',
      placeholder: '', autocomplete: '', label: '', radioValue: '',
    },
  };

  const { steps, missing } = Core.buildRefillPlan([...fields, tampered], snapshotPageFields);
  assert.deepEqual(
    steps.map((step) => step.value),
    ['HikeStrong QA'],
    'excluded phone and credential-targeting fields are never filled'
  );
  assert.deepEqual(missing, ['f9']);
});

test('re-scan merge keeps edits, adopts values for empty fields, and appends new ones', () => {
  const { fields } = Core.buildSnapshotFields([
    { tag: 'input', type: 'text', name: 'company', value: 'Original Co' },
    { tag: 'input', type: 'text', name: 'city', value: '' },
    { tag: 'input', type: 'radio', name: 'plan', value: 'starter', checked: true },
  ]);
  fields[0].value = 'Hand-edited Co';

  const { fields: merged, addedCount, updatedCount } = Core.mergeSnapshotFields(fields, [
    { tag: 'input', type: 'text', name: 'company', value: 'Page Co' },
    { tag: 'input', type: 'text', name: 'city', value: 'Boulder' },
    { tag: 'input', type: 'radio', name: 'plan', value: 'pro', checked: true },
    { tag: 'input', type: 'text', name: 'zip', value: '80301' },
  ]);

  assert.equal(addedCount, 1);
  assert.equal(updatedCount, 2, 'the empty city and the changed radio selection are updated');
  assert.equal(merged[0].value, 'Hand-edited Co', 'hand edits are never overwritten');
  assert.equal(merged[1].value, 'Boulder');
  assert.equal(merged[1].excluded, false, 'a field that gained a value joins the refill');
  assert.equal(merged[2].matcher.radioValue, 'pro', 'radio groups follow the page selection');
  assert.equal(merged[3].name, undefined);
  assert.deepEqual(
    merged.map((field) => field.id),
    ['f1', 'f2', 'f3', 'f4'],
    'new fields continue the id sequence'
  );
});

test('describes refill results for the toast', () => {
  assert.equal(Core.describeRefillResult(5, 5), 'Refilled 5 fields');
  assert.equal(Core.describeRefillResult(1, 1), 'Refilled 1 field');
  assert.equal(
    Core.describeRefillResult(10, 12),
    'Refilled 10 of 12 fields — 2 not found on this page'
  );
  assert.equal(Core.describeRefillResult(0, 4), 'No matching fields found on this page');
  assert.equal(Core.describeRefillResult(0, 0), 'This snapshot has no included fields to refill');
});

test('derives a readable default snapshot name from the page path', () => {
  assert.equal(Core.deriveSnapshotName('/settings/profile'), 'Profile form');
  assert.equal(Core.deriveSnapshotName('/demo/runtime-profile.html'), 'Runtime profile form');
  assert.equal(Core.deriveSnapshotName('/'), 'Form snapshot');
  assert.equal(Core.deriveSnapshotName(''), 'Form snapshot');
});
