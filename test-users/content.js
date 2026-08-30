(function initializeTestUsersOverlay() {
  const HOST_ID = 'test-users-extension-root';
  const STORAGE_KEY = 'testUsersStateV1';
  const DEFAULT_ROLES = ['Owner', 'Admin', 'Member', 'Viewer', 'Invited', 'Custom'];
  const isExtensionRuntime = Boolean(
    typeof chrome !== 'undefined' && chrome.runtime?.id && chrome.storage?.local
  );
  const Core = globalThis.TestUsersCore;

  if (!Core) {
    console.warn('Test Users core failed to load.');
    return;
  }

  // Every frame exposes the fill, snapshot, and refill hooks so the background
  // can reach same-origin subframes, but only the top frame owns the overlay,
  // storage, and messaging.
  if (!globalThis.__testUsersFillHook) {
    globalThis.__testUsersFillHook = (user) => applyFillPlan(user);
  }
  if (!globalThis.__testUsersSnapshotHook) {
    globalThis.__testUsersSnapshotHook = () => captureSnapshotRawFields();
  }
  if (!globalThis.__testUsersRefillHook) {
    globalThis.__testUsersRefillHook = (fields) => applyRefillPlanInFrame(fields);
  }

  if (window !== window.top) return;

  const existingHost = document.getElementById(HOST_ID);
  if (existingHost?.__testUsersApi) {
    existingHost.__testUsersApi.toggle();
    return;
  }

  const host = document.createElement('div');
  host.id = HOST_ID;
  host.style.all = 'initial';
  document.documentElement.appendChild(host);

  const shadow = host.attachShadow({ mode: 'open' });
  const stylesheet = document.createElement('link');
  stylesheet.rel = 'stylesheet';
  stylesheet.href = assetUrl('overlay.css');
  shadow.appendChild(stylesheet);

  const mount = document.createElement('div');
  mount.className = 'tu-root';
  shadow.appendChild(mount);

  let appState = {
    open: true,
    screen: 'users',
    activeTab: 'site',
    activeEnvironment: 'local',
    query: '',
    editingId: null,
    pendingDeleteUserId: null,
    pendingDeleteSiteKey: null,
    snapshotDraft: null,
    pendingDeleteSnapshotId: null,
    adapter: {
      status: 'disabled',
      capabilities: null,
      error: '',
    },
    provisioningUserId: null,
    toast: null,
  };

  let storedState = Core.normalizeStoredState(null);
  let currentIdentity = null;
  let toastTimer = null;
  let demoState = createDemoState();

  function assetUrl(path) {
    return isExtensionRuntime ? chrome.runtime.getURL(path) : `../${path}`;
  }

  function icon(name, label = '') {
    return `<img class="tu-icon" src="${assetUrl(`icons/${name}.svg`)}" alt="${escapeHtml(
      label
    )}" aria-hidden="${label ? 'false' : 'true'}">`;
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function escapeAttribute(value) {
    return escapeHtml(value).replaceAll('`', '&#096;');
  }

  function createDemoState() {
    if (isExtensionRuntime) return null;

    const info = Core.getOriginInfo(window.location);
    const siteId = Core.siteIdForHost(info.host);
    const environment = info.detectedEnvironment;
    const now = new Date().toISOString();
    const demoUser = (id, name, role, email, password, notes) => ({
      id,
      name,
      role,
      email,
      password,
      notes,
      siteId,
      environment,
      origin: info.origin,
      createdAt: now,
      updatedAt: now,
    });

    return {
      version: 2,
      sites: {
        [siteId]: { id: siteId, name: 'HikeStrong demo', createdAt: now },
      },
      origins: {
        [info.origin]: { siteId, environment: '' },
      },
      users: [
        demoUser(
          'demo-admin',
          'Alex Admin',
          'Admin',
          'alex.admin+local@example.test',
          'AdminTest!4827',
          'Billing, team settings'
        ),
        demoUser(
          'demo-member',
          'Maya Member',
          'Member',
          'maya.member+local@example.test',
          'MemberTest!5938',
          'Standard paid workspace'
        ),
        demoUser(
          'demo-invited',
          'Pending Invite',
          'Invited',
          'pending.invite+local@example.test',
          'InviteTest!6049',
          'Onboarding scenario'
        ),
      ],
      snapshots: [],
    };
  }

  async function readStoredState() {
    if (!isExtensionRuntime) return Core.normalizeStoredState(demoState);

    const result = await chrome.storage.local.get(STORAGE_KEY);
    return Core.normalizeStoredState(result[STORAGE_KEY]);
  }

  async function writeStoredState(nextState) {
    storedState = Core.normalizeStoredState(nextState);

    if (!isExtensionRuntime) {
      demoState = storedState;
      return;
    }

    await chrome.storage.local.set({ [STORAGE_KEY]: storedState });
  }

  function resolveCurrentIdentity() {
    currentIdentity = Core.resolveSiteContext(storedState, window.location);
  }

  // Writes the site and origin records for the current address the first
  // time anything is saved here, so data always lands under a stable id.
  function withCurrentSiteRegistered(state) {
    const next = {
      ...state,
      sites: { ...state.sites },
      origins: { ...state.origins },
    };
    if (!next.sites[currentIdentity.siteId]) {
      next.sites[currentIdentity.siteId] = {
        id: currentIdentity.siteId,
        name: currentIdentity.siteName,
        createdAt: new Date().toISOString(),
      };
    }
    if (!next.origins[currentIdentity.origin]) {
      next.origins[currentIdentity.origin] = {
        siteId: currentIdentity.siteId,
        environment: '',
      };
    }
    return next;
  }

  function siteNameFor(siteId, fallback = 'Unknown site') {
    return storedState.sites[siteId]?.name || fallback;
  }

  function environmentLabel(environment) {
    return Core.ENVIRONMENT_LABELS[environment] || environment;
  }

  function getPasswordSymbols() {
    return Core.sanitizePasswordSymbols(
      storedState.sites[currentIdentity.siteId]?.passwordSymbols
    );
  }

  function getCurrentOriginRecord() {
    return storedState.origins[currentIdentity.origin] || {};
  }

  function getConfiguredAdapterUrl() {
    return getCurrentOriginRecord().adapterUrl || '';
  }

  function adapterIsReady() {
    return appState.adapter.status === 'ready' && Boolean(appState.adapter.capabilities);
  }

  function adapterAppliesToUser(user) {
    return Boolean(
      adapterIsReady() &&
        appState.adapter.capabilities.canProvision &&
        user?.origin === currentIdentity.origin
    );
  }

  function userMatchesQuery(user, query) {
    return [user.name, user.email, user.username, user.role, user.notes, siteNameFor(user.siteId, '')]
      .join(' ')
      .toLowerCase()
      .includes(query);
  }

  function getSiteUsers() {
    return storedState.users.filter((user) => user.siteId === currentIdentity.siteId);
  }

  function getVisibleUsers() {
    const query = appState.query.trim().toLowerCase();
    return storedState.users.filter((user) => {
      if (appState.activeTab === 'site') {
        if (user.siteId !== currentIdentity.siteId) return false;
        if (user.environment !== appState.activeEnvironment) return false;
      }

      return !query || userMatchesQuery(user, query);
    });
  }

  function getVisibleSnapshots() {
    const query = appState.query.trim().toLowerCase();
    const currentPath = window.location.pathname;
    return storedState.snapshots
      .filter((snapshot) => {
        if (appState.activeTab === 'site' && snapshot.siteId !== currentIdentity.siteId) {
          return false;
        }

        if (!query) return true;
        return [snapshot.name, snapshot.path, siteNameFor(snapshot.siteId, '')]
          .join(' ')
          .toLowerCase()
          .includes(query);
      })
      .sort(
        (left, right) =>
          Number(right.path === currentPath) - Number(left.path === currentPath)
      );
  }

  function getSavedSites() {
    const sites = new Map();
    const ensureEntry = (siteId, fallbackName) => {
      if (!sites.has(siteId)) {
        sites.set(siteId, {
          siteId,
          name: siteNameFor(siteId, fallbackName),
          hosts: new Set(),
          loginCount: 0,
          snapshotCount: 0,
          environmentCounts: { local: 0, staging: 0, production: 0 },
        });
      }
      return sites.get(siteId);
    };

    Object.values(storedState.sites).forEach((site) => {
      if (site?.id) ensureEntry(site.id, site.name);
    });
    Object.entries(storedState.origins).forEach(([origin, record]) => {
      if (!record?.siteId) return;
      ensureEntry(record.siteId, Core.hostFromOrigin(origin)).hosts.add(
        Core.hostFromOrigin(origin)
      );
    });
    storedState.users.forEach((user) => {
      if (!user.siteId) return;
      const entry = ensureEntry(user.siteId, Core.hostFromOrigin(user.origin));
      entry.loginCount += 1;
      if (entry.environmentCounts[user.environment] !== undefined) {
        entry.environmentCounts[user.environment] += 1;
      }
      if (user.origin) entry.hosts.add(Core.hostFromOrigin(user.origin));
    });
    storedState.snapshots.forEach((snapshot) => {
      if (!snapshot.siteId) return;
      const entry = ensureEntry(snapshot.siteId, Core.hostFromOrigin(snapshot.origin));
      entry.snapshotCount += 1;
      if (snapshot.origin) entry.hosts.add(Core.hostFromOrigin(snapshot.origin));
    });

    return [...sites.values()]
      .map((entry) => ({ ...entry, hosts: [...entry.hosts].sort() }))
      .sort((left, right) => {
        if (left.siteId === currentIdentity.siteId) return -1;
        if (right.siteId === currentIdentity.siteId) return 1;
        return left.name.localeCompare(right.name);
      });
  }

  function roleClass(role) {
    const value = String(role || '').toLowerCase();
    if (value.includes('admin') || value.includes('owner')) return 'tu-role--admin';
    if (value.includes('invite')) return 'tu-role--invited';
    if (value.includes('member')) return 'tu-role--member';
    return 'tu-role--neutral';
  }

  function initials(name) {
    return String(name || 'User').trim()[0]?.toUpperCase() || 'U';
  }

  function render() {
    if (!appState.open) {
      mount.innerHTML = `
        <button class="tu-launcher" data-action="toggle" aria-label="Open Test Users">
          ${icon('users')}
          <span>Test Users</span>
        </button>
      `;
      bindEvents();
      return;
    }

    mount.innerHTML = `
      <section class="tu-panel" aria-label="Test Users extension">
        ${renderHeader()}
        ${appState.screen === 'users' ? renderUsersScreen() : ''}
        ${appState.screen === 'editor' ? renderEditorScreen() : ''}
        ${appState.screen === 'snapshot' ? renderSnapshotEditorScreen() : ''}
        ${appState.screen === 'settings' ? renderSettingsScreen() : ''}
        ${renderFooter()}
      </section>
      ${appState.toast ? renderToast(appState.toast) : ''}
    `;
    bindEvents();
  }

  const ENVIRONMENT_TITLES = {
    local: 'Local development site',
    staging: 'Staging site — use generated test accounts only',
    production: 'Production site — use generated test accounts only',
  };

  function environmentChipTitle() {
    const base = ENVIRONMENT_TITLES[currentIdentity.environment] || '';
    return currentIdentity.environmentIsManual
      ? `${base} (set manually in settings)`
      : `${base} (detected from the address)`;
  }

  function renderHeader() {
    return `
      <header class="tu-header">
        <div class="tu-heading-row">
          <h1>Test Users</h1>
          <button class="tu-icon-button" data-action="close" aria-label="Close Test Users">
            ${icon('x')}
          </button>
        </div>
        <button class="tu-site-identity" data-action="settings" title="Site & environment settings">
          <span class="tu-site-badge" aria-hidden="true">${escapeHtml(
            initials(currentIdentity.siteName)
          )}</span>
          <span class="tu-site-identity-copy">
            <span class="tu-site-identity-name">
              <strong>${escapeHtml(currentIdentity.siteName)}</strong>
              <span class="tu-environment tu-environment--${escapeAttribute(
                currentIdentity.environment
              )}" title="${escapeAttribute(environmentChipTitle())}">${escapeHtml(
                currentIdentity.environment.toUpperCase()
              )}</span>
            </span>
            <span class="tu-site-origin">${escapeHtml(currentIdentity.originLabel)}</span>
          </span>
          <span class="tu-site-identity-edit">${icon('edit')}<span>Edit</span></span>
        </button>
      </header>
    `;
  }

  function renderEnvironmentSwitch() {
    if (appState.activeTab !== 'site') return '';

    const siteUsers = getSiteUsers();
    const segments = Core.ENVIRONMENTS.map((environment) => {
      const count = siteUsers.filter((user) => user.environment === environment).length;
      const isActive = appState.activeEnvironment === environment;
      const isDetected = currentIdentity.environment === environment;
      const title = isDetected
        ? `${environmentLabel(environment)} — matches this address`
        : environmentLabel(environment);
      return `
        <button class="tu-env-segment ${isActive ? 'is-active' : ''} tu-env-segment--${escapeAttribute(
          environment
        )}" data-env="${escapeAttribute(environment)}" role="tab" aria-selected="${isActive}" title="${escapeAttribute(
          title
        )}">
          <span>${escapeHtml(environmentLabel(environment))}</span>
          <span class="tu-env-count">${count}</span>
          ${isDetected ? '<span class="tu-env-dot" aria-label="Detected environment for this address"></span>' : ''}
        </button>
      `;
    }).join('');

    return `
      <div class="tu-env-switch" role="tablist" aria-label="Environment">
        ${segments}
      </div>
    `;
  }

  function renderUsersScreen() {
    const users = getVisibleUsers();
    const siteCount = getSiteUsers().length;
    const allCount = storedState.users.length;
    const userCards = users.length
      ? users.map(renderUserCard).join('')
      : renderEmptyState();

    return `
      <div class="tu-tabs" role="tablist" aria-label="User scope">
        <button class="tu-tab ${appState.activeTab === 'site' ? 'is-active' : ''}" data-tab="site" role="tab" aria-selected="${appState.activeTab === 'site'}" title="Test users saved for ${escapeAttribute(
          currentIdentity.siteName
        )}">
          <span class="tu-tab-label">${escapeHtml(currentIdentity.siteName)}</span>
          <span class="tu-tab-count">${siteCount}</span>
        </button>
        <button class="tu-tab ${appState.activeTab === 'all' ? 'is-active' : ''}" data-tab="all" role="tab" aria-selected="${appState.activeTab === 'all'}">
          <span class="tu-tab-label">All sites</span>
          <span class="tu-tab-count">${allCount}</span>
        </button>
      </div>
      ${renderEnvironmentSwitch()}
      <div class="tu-search-bar">
        <label class="tu-search">
          ${icon('search')}
          <span class="tu-sr-only">Search users or notes</span>
          <input data-input="search" type="search" placeholder="Search users or notes" value="${escapeAttribute(appState.query)}">
        </label>
      </div>
      <main class="tu-content">
        ${renderAdapterNotice()}
        <div class="tu-user-list">${userCards}</div>
        ${renderSnapshotSection()}
      </main>
    `;
  }

  function renderAdapterNotice() {
    if (!getConfiguredAdapterUrl()) return '';

    const status = appState.adapter.status;
    const message = status === 'ready'
      ? `${appState.adapter.capabilities.label} ready for provisioned personas`
      : status === 'loading'
        ? 'Checking the provisioning adapter…'
        : appState.adapter.error || 'Provisioning adapter unavailable';
    return `
      <div class="tu-adapter-notice tu-adapter-notice--${escapeAttribute(status)}">
        <span>${escapeHtml(message)}</span>
        <button type="button" data-action="settings">${status === 'error' ? 'Fix' : 'Settings'}</button>
      </div>
    `;
  }

  function renderSnapshotSection() {
    const snapshots = getVisibleSnapshots();
    const cards = snapshots.length
      ? `<div class="tu-snapshot-list">${snapshots.map(renderSnapshotCard).join('')}</div>`
      : `<p class="tu-snapshots-hint">Snapshot a longer form once, then refill it in one click on the next debugging run. Email, username, and password fields are never captured.</p>`;

    return `
      <section class="tu-snapshots" aria-labelledby="tu-snapshots-heading">
        <div class="tu-snapshots-heading">
          <h3 id="tu-snapshots-heading">Form snapshots</h3>
          <button class="tu-secondary-button tu-snapshot-new" data-action="new-snapshot" title="Capture every editable field on this page">${icon(
            'camera'
          )}<span>Snapshot page</span></button>
        </div>
        ${cards}
      </section>
    `;
  }

  function renderSnapshotCard(snapshot) {
    const fields = Array.isArray(snapshot.fields) ? snapshot.fields : [];
    const includedCount = fields.filter((field) => !field.excluded).length;
    const details = [
      snapshot.path || '/',
      `${includedCount} ${includedCount === 1 ? 'field' : 'fields'}`,
    ];
    if (appState.activeTab === 'all') details.push(siteNameFor(snapshot.siteId, ''));

    return `
      <article class="tu-snapshot-card" data-snapshot-id="${escapeAttribute(snapshot.id)}">
        <div class="tu-snapshot-copy">
          <strong>${escapeHtml(snapshot.name)}</strong>
          <span title="${escapeAttribute(details.join(' · '))}">${escapeHtml(
            details.join(' · ')
          )}</span>
        </div>
        <div class="tu-snapshot-actions">
          <button class="tu-edit-button" data-action="edit-snapshot" data-snapshot-id="${escapeAttribute(
            snapshot.id
          )}" aria-label="Edit ${escapeAttribute(snapshot.name)}">${icon('edit')}</button>
          <button class="tu-primary-button tu-refill-button" data-action="refill-snapshot" data-snapshot-id="${escapeAttribute(
            snapshot.id
          )}">${icon('forms')}<span>Refill</span></button>
        </div>
      </article>
    `;
  }

  function getProvisioningStatus(user) {
    const provisioning = user?.provisioning;
    if (!provisioning?.status) return 'unprovisioned';
    if (
      provisioning.status === 'ready' &&
      (provisioning.adapterUrl !== getConfiguredAdapterUrl() ||
        (provisioning.expiresAt && new Date(provisioning.expiresAt).getTime() <= Date.now()))
    ) {
      return 'stale';
    }
    return provisioning.status;
  }

  function renderProvisioningBadge(user) {
    const status = getProvisioningStatus(user);
    if (status === 'unprovisioned' || !user.provisioning) return '';

    const labelByStatus = {
      ready: user.provisioning.stateLabel || 'Provisioned',
      stale: 'Needs reprovisioning',
      failed: 'Provisioning failed',
    };
    const title = status === 'failed'
      ? user.provisioning.error || 'The last provisioning request failed'
      : user.provisioning.accountRef || labelByStatus[status];
    return `<span class="tu-provisioning-status tu-provisioning-status--${escapeAttribute(
      status
    )}" title="${escapeAttribute(title)}">${escapeHtml(labelByStatus[status] || status)}</span>`;
  }

  function renderUserCard(user) {
    const showProject = appState.activeTab === 'all';
    const status = getProvisioningStatus(user);
    const canProvision = adapterAppliesToUser(user);
    const isProvisioning = appState.provisioningUserId === user.id;
    const action = canProvision && status !== 'ready' ? 'provision-user' : 'fill';
    const actionLabel = isProvisioning
      ? 'Provisioning…'
      : action === 'provision-user'
        ? status === 'stale' ? 'Reprovision & fill' : 'Provision & fill'
        : 'Fill login';
    const canReset = Boolean(
      canProvision &&
        status === 'ready' &&
        appState.adapter.capabilities.canReset &&
        user.provisioning?.accountRef
    );
    return `
      <article class="tu-user-card" data-user-id="${escapeAttribute(user.id)}">
        <div class="tu-avatar" aria-hidden="true">${escapeHtml(initials(user.name))}</div>
        <div class="tu-user-copy">
          <div class="tu-user-title-row">
            <strong>${escapeHtml(user.name)}</strong>
            <span class="tu-role ${roleClass(user.role)}">${escapeHtml(
              String(user.role || 'User').toUpperCase()
            )}</span>
          </div>
          <div class="tu-email" title="${escapeAttribute(user.email || user.username)}">${escapeHtml(
            user.email || user.username
          )}</div>
          ${user.scenarioLabel ? `<div class="tu-scenario">${escapeHtml(user.scenarioLabel)}</div>` : ''}
          <div class="tu-notes">${escapeHtml(user.notes || 'No notes yet')}</div>
          ${renderProvisioningBadge(user)}
          ${
            showProject
              ? `<div class="tu-project-label">${escapeHtml(
                  siteNameFor(user.siteId, Core.hostFromOrigin(user.origin))
                )} · ${escapeHtml(environmentLabel(user.environment))}</div>`
              : ''
          }
        </div>
        <div class="tu-card-actions">
          <div class="tu-card-icon-actions">
            <button class="tu-edit-button" data-action="edit" data-user-id="${escapeAttribute(
              user.id
            )}" aria-label="Edit ${escapeAttribute(user.name)}">${icon('edit')}</button>
            ${
              canReset
                ? `<button class="tu-edit-button" data-action="reset-user" data-user-id="${escapeAttribute(
                    user.id
                  )}" aria-label="Reset ${escapeAttribute(user.name)} scenario and fill login" title="Reset scenario and fill">${icon(
                    'refresh'
                  )}</button>`
                : ''
            }
          </div>
          <button class="tu-primary-button tu-fill-button" data-action="${action}" data-user-id="${escapeAttribute(
            user.id
          )}" ${isProvisioning ? 'disabled' : ''}>${icon(
            action === 'provision-user' ? 'sparkles' : 'login-2'
          )}<span>${escapeHtml(actionLabel)}</span></button>
        </div>
      </article>
    `;
  }

  function renderEmptyState() {
    const hasQuery = Boolean(appState.query.trim());
    if (hasQuery) {
      return `
        <div class="tu-empty-state">
          <div class="tu-empty-icon">${icon('search')}</div>
          <strong>No matching test users</strong>
          <p>Try a different name, role, email, or note.</p>
        </div>
      `;
    }

    const totalUsers = storedState.users.length;
    const onSiteTab = appState.activeTab === 'site';
    const siteUsers = getSiteUsers();
    const otherEnvironmentCounts = Core.ENVIRONMENTS.filter(
      (environment) => environment !== appState.activeEnvironment
    )
      .map((environment) => ({
        environment,
        count: siteUsers.filter((user) => user.environment === environment).length,
      }))
      .filter((entry) => entry.count);

    const heading = onSiteTab
      ? `No ${escapeHtml(environmentLabel(appState.activeEnvironment).toLowerCase())} test users for ${escapeHtml(
          currentIdentity.siteName
        )} yet`
      : 'No test users yet';
    let body = 'Generate credentials and fill the current login or sign-up form in one step.';
    if (onSiteTab && otherEnvironmentCounts.length) {
      const summary = otherEnvironmentCounts
        .map((entry) => `${entry.count} ${environmentLabel(entry.environment).toLowerCase()}`)
        .join(' · ');
      body = `This site has ${summary} — switch environment above, or create one here.`;
    } else if (onSiteTab && totalUsers) {
      body = `Your ${totalUsers} saved ${
        totalUsers === 1 ? 'login belongs' : 'logins belong'
      } to other sites. Create one here, or browse everything you have saved.`;
    }

    return `
      <div class="tu-empty-state">
        <div class="tu-empty-icon">${icon('users')}</div>
        <strong>${heading}</strong>
        <p>${body}</p>
        <div class="tu-empty-actions">
          <button class="tu-secondary-button" data-action="new-user">+ New test user</button>
          ${
            onSiteTab && totalUsers
              ? `<button class="tu-ghost-button" data-action="show-all">View all sites (${totalUsers})</button>`
              : ''
          }
        </div>
      </div>
    `;
  }

  function getEditorRoleOptions(existingUser) {
    const options = adapterIsReady()
      ? appState.adapter.capabilities.roles.map((role) => ({ ...role }))
      : DEFAULT_ROLES.map((role) => ({ id: role, label: role, description: '' }));
    if (
      existingUser?.role &&
      !options.some(
        (option) => option.id === existingUser.roleId || option.label === existingUser.role
      )
    ) {
      options.unshift({
        id: existingUser.roleId || existingUser.role,
        label: existingUser.role,
        description: 'Saved role',
      });
    }
    return options;
  }

  function getEditorScenarioOptions(existingUser) {
    const options = adapterIsReady()
      ? appState.adapter.capabilities.scenarios.map((scenario) => ({ ...scenario }))
      : [];
    if (
      existingUser?.scenarioId &&
      !options.some((option) => option.id === existingUser.scenarioId)
    ) {
      options.unshift({
        id: existingUser.scenarioId,
        label: existingUser.scenarioLabel || existingUser.scenarioId,
        description: 'Saved scenario',
      });
    }
    return options;
  }

  function renderEditorScreen() {
    const existingUser = storedState.users.find((user) => user.id === appState.editingId);
    const roleOptions = getEditorRoleOptions(existingUser);
    const scenarioOptions = getEditorScenarioOptions(existingUser);
    const passwordSymbols = getPasswordSymbols();
    const generated =
      existingUser ||
      Core.buildGeneratedIdentity(
        currentIdentity.siteName,
        roleOptions.find((role) => role.label === 'Member')?.label || roleOptions[0]?.label || 'Member',
        undefined,
        passwordSymbols
      );
    const title = existingUser ? 'Edit test user' : 'New test user';
    const selectedRoleId = existingUser?.roleId ||
      roleOptions.find((role) => role.label === generated.role)?.id ||
      roleOptions[0]?.id;
    const selectedEnvironment =
      Core.normalizeEnvironment(existingUser?.environment) || appState.activeEnvironment;

    return `
      <main class="tu-content tu-editor">
        <button class="tu-back-button" data-action="back">${icon('arrow-left')}<span>Back to users</span></button>
        <div class="tu-section-heading">
          <div>
            <h2>${title}</h2>
            <p>${escapeHtml(currentIdentity.siteName)} · ${escapeHtml(
              environmentLabel(selectedEnvironment)
            )}</p>
          </div>
          <button class="tu-secondary-button tu-regenerate" data-action="regenerate" title="Replace name, email, and password with fresh values">${icon(
            'sparkles'
          )}<span>Regenerate</span></button>
        </div>
        <form class="tu-form" data-form="user">
          <label>
            <span>Name</span>
            <input name="name" autocomplete="off" value="${escapeAttribute(generated.name)}" required>
          </label>
          <label>
            <span>Environment</span>
            <select name="environment">
              ${Core.ENVIRONMENTS.map(
                (environment) =>
                  `<option value="${escapeAttribute(environment)}" ${
                    selectedEnvironment === environment ? 'selected' : ''
                  }>${escapeHtml(environmentLabel(environment))}</option>`
              ).join('')}
            </select>
          </label>
          <label>
            <span>Role</span>
            <select name="role">
              ${roleOptions
                .map(
                  (role) =>
                    `<option value="${escapeAttribute(role.id)}" data-label="${escapeAttribute(
                      role.label
                    )}" ${selectedRoleId === role.id ? 'selected' : ''}>${escapeHtml(
                      role.label
                    )}</option>`
                )
                .join('')}
            </select>
          </label>
          ${
            scenarioOptions.length
              ? `<label class="tu-form-wide">
                  <span>Scenario</span>
                  <select name="scenario" required>
                    <option value="">Choose a scenario</option>
                    ${scenarioOptions
                      .map(
                        (scenario) =>
                          `<option value="${escapeAttribute(scenario.id)}" data-label="${escapeAttribute(
                            scenario.label
                          )}" ${existingUser?.scenarioId === scenario.id ? 'selected' : ''}>${escapeHtml(
                            scenario.label
                          )}</option>`
                      )
                      .join('')}
                  </select>
                </label>`
              : ''
          }
          <label class="tu-form-wide">
            <span>Email</span>
            <div class="tu-inline-field">
              <input name="email" type="email" autocomplete="off" value="${escapeAttribute(
                generated.email
              )}">
              <button type="button" data-action="copy-field" data-field="email" aria-label="Copy email">${icon(
                'copy'
              )}</button>
            </div>
          </label>
          <label class="tu-form-wide">
            <span>Username</span>
            <div class="tu-inline-field">
              <input name="username" autocomplete="off" value="${escapeAttribute(
                generated.username || ''
              )}" placeholder="Only for sites that sign in with a username">
              <button type="button" data-action="copy-field" data-field="username" aria-label="Copy username">${icon(
                'copy'
              )}</button>
            </div>
          </label>
          <label class="tu-form-wide">
            <span>Password</span>
            <div class="tu-inline-field">
              <input name="password" type="text" autocomplete="off" value="${escapeAttribute(
                generated.password
              )}" required>
              <button type="button" data-action="copy-field" data-field="password" aria-label="Copy password">${icon(
                'copy'
              )}</button>
            </div>
          </label>
          <div class="tu-symbol-toggles tu-form-wide" role="group" aria-label="Symbols allowed in generated passwords">
            <span class="tu-symbol-toggles-label">Symbols in generated passwords</span>
            <div class="tu-symbol-options">
              ${[...Core.PASSWORD_SYMBOL_CHOICES]
                .map(
                  (symbol) => `<label class="tu-symbol-option">
                    <input type="checkbox" data-symbol="${escapeAttribute(symbol)}" ${
                      passwordSymbols.includes(symbol) ? 'checked' : ''
                    }>
                    <span>${escapeHtml(symbol)}</span>
                  </label>`
                )
                .join('')}
            </div>
            <small>Untick any this site rejects — with none ticked, passwords are letters and numbers only. Remembered for this site.</small>
          </div>
          <label class="tu-form-wide">
            <span>Notes</span>
            <textarea name="notes" rows="2" maxlength="160" placeholder="What role or scenario is this for?">${escapeHtml(
              generated.notes || ''
            )}</textarea>
          </label>
          ${
            existingUser && appState.pendingDeleteUserId === existingUser.id
              ? `<div class="tu-inline-delete-confirm tu-form-wide">
                  <div>
                    <strong>Delete ${escapeHtml(existingUser.name)}?</strong>
                    <p>This removes only this saved login. The site identity and its other logins are unaffected.</p>
                  </div>
                  <div>
                    <button class="tu-secondary-button" type="button" data-action="cancel-delete-user">Cancel</button>
                    <button class="tu-danger-button" type="button" data-action="confirm-delete-user" data-user-id="${escapeAttribute(
                      existingUser.id
                    )}">${icon('trash')}<span>Delete login</span></button>
                  </div>
                </div>`
              : ''
          }
          <div class="tu-form-actions tu-form-wide">
            ${
              existingUser
                ? `<button class="tu-danger-button" type="button" data-action="delete" data-user-id="${escapeAttribute(
                    existingUser.id
                  )}">${icon('trash')}<span>Delete</span></button>`
                : '<span></span>'
            }
            <div>
              <button class="tu-secondary-button" type="button" data-action="save-only">Save</button>
              <button class="tu-primary-button" type="submit">${icon(
                'login-2'
              )}<span>${
                adapterIsReady() && appState.adapter.capabilities.canProvision
                  ? 'Save, provision &amp; fill'
                  : 'Save &amp; fill'
              }</span></button>
            </div>
          </div>
        </form>
      </main>
    `;
  }

  function renderSnapshotFieldValue(field) {
    const idAttribute = `data-field-id="${escapeAttribute(field.id)}"`;

    if (field.kind === 'checkbox') {
      return `
        <label class="tu-snapshot-checked">
          <input type="checkbox" data-snapshot-checked ${idAttribute} ${field.checked ? 'checked' : ''}>
          <span>${field.checked ? 'Checked' : 'Unchecked'} when refilled</span>
        </label>
      `;
    }

    if (field.kind === 'radio') {
      return `<span class="tu-snapshot-static">Selected: ${escapeHtml(
        field.value || 'on'
      )} · re-scan after changing the choice on the page</span>`;
    }

    if (field.kind === 'select' && field.multiple) {
      const values = Array.isArray(field.value) ? field.value : [];
      return `<span class="tu-snapshot-static">${
        values.length ? escapeHtml(values.join(', ')) : 'No options selected'
      }</span>`;
    }

    if (field.kind === 'select' && Array.isArray(field.options) && field.options.length) {
      const hasStoredValue = field.options.some((option) => option.value === field.value);
      const storedOption = hasStoredValue
        ? ''
        : `<option value="${escapeAttribute(field.value)}" selected>${escapeHtml(
            field.value || '(empty)'
          )}</option>`;
      return `
        <select data-snapshot-value ${idAttribute}>
          ${storedOption}
          ${field.options
            .map(
              (option) =>
                `<option value="${escapeAttribute(option.value)}" ${
                  option.value === field.value ? 'selected' : ''
                }>${escapeHtml(option.label || option.value)}</option>`
            )
            .join('')}
        </select>
      `;
    }

    if (field.kind === 'textarea') {
      return `<textarea data-snapshot-value ${idAttribute} rows="2">${escapeHtml(
        field.value
      )}</textarea>`;
    }

    return `<input data-snapshot-value ${idAttribute} autocomplete="off" value="${escapeAttribute(
      field.value
    )}" placeholder="(empty)">`;
  }

  function renderSnapshotField(field) {
    return `
      <div class="tu-snapshot-field ${field.excluded ? 'is-excluded' : ''}" data-field-id="${escapeAttribute(
        field.id
      )}">
        <label class="tu-snapshot-include" title="${
          field.excluded ? 'Excluded from refill' : 'Included in refill'
        }">
          <input type="checkbox" data-snapshot-include data-field-id="${escapeAttribute(
            field.id
          )}" ${field.excluded ? '' : 'checked'}>
          <span class="tu-sr-only">Include ${escapeHtml(field.label)} in refill</span>
        </label>
        <div class="tu-snapshot-field-main">
          <span class="tu-snapshot-field-label" title="${escapeAttribute(field.label)}">${escapeHtml(
            field.label
          )}</span>
          ${renderSnapshotFieldValue(field)}
        </div>
        <button type="button" class="tu-edit-button" data-action="remove-snapshot-field" data-field-id="${escapeAttribute(
          field.id
        )}" aria-label="Remove ${escapeAttribute(field.label)} from this snapshot">${icon(
          'trash'
        )}</button>
      </div>
    `;
  }

  function renderSnapshotEditorScreen() {
    const draft = appState.snapshotDraft;
    if (!draft) return '';

    const isExisting = Boolean(draft.id);
    const includedCount = draft.fields.filter((field) => !field.excluded).length;
    const summaryParts = [
      `${draft.fields.length} ${draft.fields.length === 1 ? 'field' : 'fields'} captured`,
      `${includedCount} included`,
    ];
    if (draft.skippedCount) {
      summaryParts.push(
        `${draft.skippedCount} sensitive ${draft.skippedCount === 1 ? 'field' : 'fields'} skipped`
      );
    }

    return `
      <main class="tu-content tu-editor">
        <button class="tu-back-button" data-action="back">${icon('arrow-left')}<span>Back to users</span></button>
        <div class="tu-section-heading">
          <div>
            <h2>${isExisting ? 'Edit snapshot' : 'New snapshot'}</h2>
            <p>${escapeHtml(summaryParts.join(' · '))}</p>
          </div>
          <button class="tu-secondary-button tu-regenerate" data-action="rescan-snapshot" title="Capture the page again: adds new fields, fills in empty values, and keeps your edits">${icon(
            'refresh'
          )}<span>Re-scan</span></button>
        </div>
        <form class="tu-form" data-form="snapshot">
          <label class="tu-form-wide">
            <span>Snapshot name</span>
            <input name="snapshotName" autocomplete="off" value="${escapeAttribute(
              draft.name
            )}" required>
          </label>
          <div class="tu-identity-preview tu-form-wide">
            <span>Captured on</span>
            <strong>${escapeHtml(currentIdentity.originLabel)}${escapeHtml(draft.path || '/')}</strong>
          </div>
          <div class="tu-snapshot-fields tu-form-wide">
            ${draft.fields.map(renderSnapshotField).join('')}
          </div>
          <p class="tu-snapshots-hint tu-form-wide">Unticked fields stay saved but are skipped on refill. Email, username, password, payment, and one-time-code fields are never captured or refilled.</p>
          ${
            isExisting && appState.pendingDeleteSnapshotId === draft.id
              ? `<div class="tu-inline-delete-confirm tu-form-wide">
                  <div>
                    <strong>Delete ${escapeHtml(draft.name)}?</strong>
                    <p>This removes only this saved snapshot. Saved logins are unaffected.</p>
                  </div>
                  <div>
                    <button class="tu-secondary-button" type="button" data-action="cancel-delete-snapshot">Cancel</button>
                    <button class="tu-danger-button" type="button" data-action="confirm-delete-snapshot" data-snapshot-id="${escapeAttribute(
                      draft.id
                    )}">${icon('trash')}<span>Delete snapshot</span></button>
                  </div>
                </div>`
              : ''
          }
          <div class="tu-form-actions tu-form-wide">
            ${
              isExisting
                ? `<button class="tu-danger-button" type="button" data-action="delete-snapshot" data-snapshot-id="${escapeAttribute(
                    draft.id
                  )}">${icon('trash')}<span>Delete</span></button>`
                : '<span></span>'
            }
            <button class="tu-primary-button" type="submit">${icon(
              'device-floppy'
            )}<span>Save snapshot</span></button>
          </div>
        </form>
      </main>
    `;
  }

  function renderAdapterConnectionStatus() {
    const adapterUrl = getConfiguredAdapterUrl();
    if (!adapterUrl) return '';

    const status = appState.adapter.status;
    const capabilities = appState.adapter.capabilities;
    const summary = status === 'ready'
      ? `${capabilities.label} · ${capabilities.roles.length} ${
          capabilities.roles.length === 1 ? 'role' : 'roles'
        } · ${capabilities.scenarios.length} ${
          capabilities.scenarios.length === 1 ? 'scenario' : 'scenarios'
        }`
      : status === 'loading'
        ? 'Checking the project adapter…'
        : appState.adapter.error || 'Adapter is not connected';

    return `
      <div class="tu-adapter-status tu-adapter-status--${escapeAttribute(status)} tu-form-wide">
        <div>
          <strong>${status === 'ready' ? 'Provisioning adapter ready' : 'Provisioning adapter'}</strong>
          <span>${escapeHtml(summary)}</span>
        </div>
      </div>
    `;
  }

  function renderSettingsScreen() {
    const adapterUrl = getConfiguredAdapterUrl();
    const adapterBlocked = currentIdentity.environment === 'production';
    const originRecord = getCurrentOriginRecord();
    const environmentOverride = Core.normalizeEnvironment(originRecord.environment);
    const otherSites = getSavedSites().filter((site) => site.siteId !== currentIdentity.siteId);

    return `
      <main class="tu-content tu-settings">
        <button class="tu-back-button" data-action="back">${icon('arrow-left')}<span>Back to users</span></button>
        <div class="tu-section-heading">
          <div>
            <h2>This address</h2>
            <p>${escapeHtml(currentIdentity.originLabel)} — accounts are grouped by address and environment.</p>
          </div>
        </div>
        <form class="tu-form" data-form="settings">
          <label class="tu-form-wide">
            <span>Site name</span>
            <input name="siteName" value="${escapeAttribute(currentIdentity.siteName)}" required>
            <small>A display name for this site — it never affects how accounts are matched.</small>
          </label>
          <label class="tu-form-wide">
            <span>Environment for this address</span>
            <select name="environment">
              <option value="" ${environmentOverride ? '' : 'selected'}>Auto — detected as ${escapeHtml(
                environmentLabel(currentIdentity.detectedEnvironment)
              )}</option>
              ${Core.ENVIRONMENTS.map(
                (environment) =>
                  `<option value="${escapeAttribute(environment)}" ${
                    environmentOverride === environment ? 'selected' : ''
                  }>${escapeHtml(environmentLabel(environment))}</option>`
              ).join('')}
            </select>
            <small>Auto means: localhost is local, a staging-looking address is staging, everything else is production.</small>
          </label>
          ${
            otherSites.length
              ? `<label class="tu-form-wide">
                  <span>This address belongs to</span>
                  <select name="linkedSiteId">
                    <option value="" selected>${escapeHtml(currentIdentity.siteName)} (this site)</option>
                    ${otherSites
                      .map(
                        (site) =>
                          `<option value="${escapeAttribute(site.siteId)}">${escapeHtml(
                            site.name
                          )}${site.hosts.length ? ` — ${escapeHtml(site.hosts.join(', '))}` : ''}</option>`
                      )
                      .join('')}
                  </select>
                  <small>Pick another site to link this address to it — e.g. link localhost and staging to the same project. Logins saved on this address move with it.</small>
                </label>`
              : ''
          }
          <label class="tu-form-wide">
            <span>Provisioning adapter</span>
            <input name="adapterUrl" type="text" inputmode="url" value="${escapeAttribute(adapterUrl)}" placeholder="/__test-users" ${
              adapterBlocked ? 'disabled' : ''
            }>
            <small>${
              adapterBlocked
                ? 'Provisioning is blocked on production addresses.'
                : 'Optional same-origin endpoint for roles and scenarios. It must never return names, usernames, emails, or passwords.'
            }</small>
          </label>
          ${renderAdapterConnectionStatus()}
          <div class="tu-form-actions tu-form-wide">
            <span></span>
            <button class="tu-primary-button" type="submit">${icon(
              'device-floppy'
            )}<span>Save &amp; check</span></button>
          </div>
        </form>
        ${renderSavedSitesSection()}
        <div class="tu-privacy-card">
          ${icon('lock')}
          <div>
            <strong>Local test credentials only</strong>
            <p>Passwords are stored in Chrome on this device. Use generated accounts, never real credentials.</p>
          </div>
        </div>
      </main>
    `;
  }

  function renderSavedSitesSection() {
    const savedSites = getSavedSites();
    if (!savedSites.length) {
      return `
        <section class="tu-manage-sites" aria-labelledby="tu-saved-sites-heading">
          <div class="tu-manage-sites-heading">
            <h3 id="tu-saved-sites-heading">Saved sites</h3>
            <p>No saved site identities yet.</p>
          </div>
        </section>
      `;
    }

    return `
      <section class="tu-manage-sites" aria-labelledby="tu-saved-sites-heading">
        <div class="tu-manage-sites-heading">
          <h3 id="tu-saved-sites-heading">Saved sites</h3>
          <p>Remove a site and every test login stored beneath it.</p>
        </div>
        <div class="tu-saved-site-list">
          ${savedSites.map(renderSavedSite).join('')}
        </div>
      </section>
    `;
  }

  function describeSavedSiteCounts(site) {
    const environmentParts = Core.ENVIRONMENTS.filter(
      (environment) => site.environmentCounts[environment]
    ).map(
      (environment) =>
        `${site.environmentCounts[environment]} ${environmentLabel(environment).toLowerCase()}`
    );
    let label = environmentParts.length
      ? environmentParts.join(' · ')
      : `${site.loginCount} ${site.loginCount === 1 ? 'login' : 'logins'}`;
    if (site.snapshotCount) {
      label += ` · ${site.snapshotCount} ${site.snapshotCount === 1 ? 'snapshot' : 'snapshots'}`;
    }
    return label;
  }

  function renderSavedSite(site) {
    const pending = appState.pendingDeleteSiteKey === site.siteId;
    const countLabel = describeSavedSiteCounts(site);
    const hostLabel = site.hosts.join(', ') || 'No addresses linked yet';

    if (pending) {
      const loginLabel = `${site.loginCount} ${site.loginCount === 1 ? 'login' : 'logins'}`;
      return `
        <article class="tu-saved-site tu-saved-site--confirming" data-site-key="${escapeAttribute(
          site.siteId
        )}">
          <div class="tu-site-delete-copy">
            <strong>Delete ${escapeHtml(site.name)}?</strong>
            <p>This removes the site and ${escapeHtml(loginLabel)}${
              site.snapshotCount
                ? ` and ${site.snapshotCount} ${site.snapshotCount === 1 ? 'snapshot' : 'snapshots'}`
                : ''
            }. Other sites are unaffected.</p>
          </div>
          <div class="tu-site-confirm-actions">
            <button class="tu-secondary-button" type="button" data-action="cancel-delete-site">Cancel</button>
            <button class="tu-danger-button" type="button" data-action="confirm-delete-site" data-site-key="${escapeAttribute(
              site.siteId
            )}">${icon('trash')}<span>Delete site</span></button>
          </div>
        </article>
      `;
    }

    return `
      <article class="tu-saved-site" data-site-key="${escapeAttribute(site.siteId)}">
        <div class="tu-saved-site-copy">
          <strong>${escapeHtml(site.name)}</strong>
          <span>${escapeHtml(hostLabel)} · ${escapeHtml(countLabel)}</span>
        </div>
        <button class="tu-site-delete-button" type="button" data-action="delete-site" data-site-key="${escapeAttribute(
          site.siteId
        )}" aria-label="Delete ${escapeAttribute(site.name)} site">${icon(
          'trash'
        )}<span>Delete site</span></button>
      </article>
    `;
  }

  function renderFooter() {
    if (appState.screen !== 'users') {
      return `
        <footer class="tu-footer tu-footer--compact">
          <span>${icon('lock')} Stored only on this device</span>
        </footer>
      `;
    }

    return `
      <footer class="tu-footer">
        <div class="tu-footer-actions">
          <button class="tu-secondary-button" data-action="new-user">${icon(
            'plus'
          )}<span>New test user</span></button>
          <button class="tu-icon-button tu-settings-button" data-action="settings" aria-label="Site settings">${icon(
            'settings'
          )}</button>
        </div>
        <span class="tu-storage-note">${icon('lock')} Stored only on this device</span>
      </footer>
    `;
  }

  function renderToast(toast) {
    return `
      <div class="tu-page-toast tu-page-toast--${escapeAttribute(toast.type || 'success')}" role="status">
        ${icon(toast.type === 'error' ? 'alert-circle' : 'circle-check')}
        <span>${escapeHtml(toast.message)}</span>
      </div>
    `;
  }

  function bindEvents() {
    shadow.querySelectorAll('[data-action]').forEach((element) => {
      element.addEventListener('click', handleAction);
    });

    shadow.querySelectorAll('[data-tab]').forEach((element) => {
      element.addEventListener('click', () => {
        appState.activeTab = element.dataset.tab;
        render();
      });
    });

    shadow.querySelectorAll('[data-env]').forEach((element) => {
      element.addEventListener('click', () => {
        appState.activeEnvironment = element.dataset.env;
        render();
      });
    });

    const search = shadow.querySelector('[data-input="search"]');
    search?.addEventListener('input', () => {
      appState.query = search.value;
      render();
      const nextSearch = shadow.querySelector('[data-input="search"]');
      nextSearch?.focus();
      nextSearch?.setSelectionRange(appState.query.length, appState.query.length);
    });

    shadow.querySelectorAll('[data-symbol]').forEach((element) => {
      element.addEventListener('change', handleSymbolToggle);
    });

    shadow.querySelectorAll('[data-snapshot-include]').forEach((element) => {
      element.addEventListener('change', () => {
        const field = findDraftField(element.dataset.fieldId);
        if (!field) return;
        field.excluded = !element.checked;
        render();
      });
    });

    shadow.querySelectorAll('[data-snapshot-value]').forEach((element) => {
      element.addEventListener('input', () => {
        const field = findDraftField(element.dataset.fieldId);
        if (field) field.value = element.value;
      });
    });

    shadow.querySelectorAll('[data-snapshot-checked]').forEach((element) => {
      element.addEventListener('change', () => {
        const field = findDraftField(element.dataset.fieldId);
        if (!field) return;
        field.checked = element.checked;
        render();
      });
    });

    shadow.querySelector('[data-form="snapshot"]')?.addEventListener('submit', async (event) => {
      event.preventDefault();
      await saveSnapshotFromForm(event.currentTarget);
    });

    shadow.querySelector('[data-form="user"]')?.addEventListener('submit', async (event) => {
      event.preventDefault();
      const user = await saveUserFromForm(event.currentTarget);
      if (user) await activateUser(user);
    });

    shadow
      .querySelector('[data-form="settings"]')
      ?.addEventListener('submit', saveSettingsFromForm);
  }

  async function handleAction(event) {
    const action = event.currentTarget.dataset.action;
    const userId = event.currentTarget.dataset.userId;
    const siteKey = event.currentTarget.dataset.siteKey;
    const snapshotId = event.currentTarget.dataset.snapshotId;
    const fieldId = event.currentTarget.dataset.fieldId;

    if (action === 'toggle' || action === 'close') {
      appState.open = !appState.open;
      render();
      return;
    }

    if (action === 'new-user') {
      appState.screen = 'editor';
      appState.editingId = null;
      appState.pendingDeleteUserId = null;
      render();
      return;
    }

    if (action === 'edit') {
      appState.screen = 'editor';
      appState.editingId = userId;
      appState.pendingDeleteUserId = null;
      render();
      return;
    }

    if (action === 'back') {
      appState.screen = 'users';
      appState.editingId = null;
      appState.pendingDeleteUserId = null;
      appState.pendingDeleteSiteKey = null;
      appState.snapshotDraft = null;
      appState.pendingDeleteSnapshotId = null;
      render();
      return;
    }

    if (action === 'settings') {
      appState.screen = 'settings';
      appState.pendingDeleteSiteKey = null;
      render();
      return;
    }

    if (action === 'show-all') {
      appState.activeTab = 'all';
      render();
      return;
    }

    if (action === 'fill') {
      const user = storedState.users.find((candidate) => candidate.id === userId);
      if (user) await fillCredentials(user);
      return;
    }

    if (action === 'provision-user') {
      const user = storedState.users.find((candidate) => candidate.id === userId);
      if (user) await provisionUser(user, 'provision');
      return;
    }

    if (action === 'reset-user') {
      const user = storedState.users.find((candidate) => candidate.id === userId);
      if (user) await provisionUser(user, 'reset');
      return;
    }

    if (action === 'regenerate') {
      regenerateEditorValues();
      return;
    }

    if (action === 'copy-field') {
      const field = shadow.querySelector(`[name="${event.currentTarget.dataset.field}"]`);
      const labels = { email: 'Email', username: 'Username', password: 'Password' };
      if (field) await copyText(field.value, `${labels[field.name] || 'Value'} copied`);
      return;
    }

    if (action === 'save-only') {
      const form = shadow.querySelector('[data-form="user"]');
      if (form) await saveUserFromForm(form);
      return;
    }

    if (action === 'delete') {
      appState.pendingDeleteUserId = userId;
      render();
      scrollPendingConfirmationIntoView('.tu-inline-delete-confirm');
      return;
    }

    if (action === 'cancel-delete-user') {
      appState.pendingDeleteUserId = null;
      render();
      return;
    }

    if (action === 'confirm-delete-user') {
      await deleteUser(userId);
      return;
    }

    if (action === 'delete-site') {
      appState.pendingDeleteSiteKey = siteKey;
      render();
      scrollPendingConfirmationIntoView('.tu-saved-site--confirming');
      return;
    }

    if (action === 'cancel-delete-site') {
      appState.pendingDeleteSiteKey = null;
      render();
      return;
    }

    if (action === 'confirm-delete-site') {
      await deleteSite(siteKey);
      return;
    }

    if (action === 'new-snapshot') {
      await startNewSnapshot();
      return;
    }

    if (action === 'edit-snapshot') {
      const snapshot = storedState.snapshots.find((candidate) => candidate.id === snapshotId);
      if (!snapshot) return;
      appState.snapshotDraft = {
        id: snapshot.id,
        name: snapshot.name,
        path: snapshot.path,
        skippedCount: 0,
        fields: (snapshot.fields || []).map((field) => ({ ...field })),
      };
      appState.screen = 'snapshot';
      appState.pendingDeleteSnapshotId = null;
      render();
      return;
    }

    if (action === 'refill-snapshot') {
      const snapshot = storedState.snapshots.find((candidate) => candidate.id === snapshotId);
      if (snapshot) await refillSnapshot(snapshot);
      return;
    }

    if (action === 'rescan-snapshot') {
      await rescanSnapshotDraft();
      return;
    }

    if (action === 'remove-snapshot-field') {
      if (!appState.snapshotDraft) return;
      appState.snapshotDraft.fields = appState.snapshotDraft.fields.filter(
        (field) => field.id !== fieldId
      );
      render();
      return;
    }

    if (action === 'delete-snapshot') {
      appState.pendingDeleteSnapshotId = snapshotId;
      render();
      scrollPendingConfirmationIntoView('.tu-inline-delete-confirm');
      return;
    }

    if (action === 'cancel-delete-snapshot') {
      appState.pendingDeleteSnapshotId = null;
      render();
      return;
    }

    if (action === 'confirm-delete-snapshot') {
      await deleteSnapshot(snapshotId);
      return;
    }
  }

  function findDraftField(fieldId) {
    return appState.snapshotDraft?.fields.find((field) => field.id === fieldId) || null;
  }

  function regenerateEditorValues() {
    const form = shadow.querySelector('[data-form="user"]');
    if (!form) return;
    const role = form.elements.role.selectedOptions[0]?.dataset.label || form.elements.role.value;
    const generated = Core.buildGeneratedIdentity(
      currentIdentity.siteName,
      role,
      undefined,
      getPasswordSymbols()
    );
    form.elements.name.value = generated.name;
    form.elements.email.value = generated.email;
    form.elements.password.value = generated.password;
    form.elements.email.focus();
    showToast('Fresh credentials generated');
  }

  // Persists the allowed-symbol choice for this site and refreshes the
  // password so the visible value always matches the current rules.
  async function handleSymbolToggle() {
    const symbols = [...shadow.querySelectorAll('[data-symbol]')]
      .filter((input) => input.checked)
      .map((input) => input.dataset.symbol)
      .join('');
    const next = withCurrentSiteRegistered(storedState);
    next.sites[currentIdentity.siteId] = {
      ...next.sites[currentIdentity.siteId],
      passwordSymbols: symbols,
      updatedAt: new Date().toISOString(),
    };
    await writeStoredState(next);

    const passwordInput = shadow.querySelector('[data-form="user"] [name="password"]');
    if (passwordInput) passwordInput.value = Core.generatePassword(undefined, symbols);
  }

  function scrollPendingConfirmationIntoView(selector) {
    requestAnimationFrame(() => {
      shadow.querySelector(selector)?.scrollIntoView({ block: 'nearest' });
    });
  }

  async function copyText(value, message) {
    try {
      await navigator.clipboard.writeText(value);
      showToast(message);
    } catch {
      showToast('Clipboard access was blocked', 'error');
    }
  }

  function createId() {
    if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  async function saveUserFromForm(form) {
    const hasIdentifier =
      form.elements.email.value.trim() || form.elements.username.value.trim();
    form.elements.email.setCustomValidity(hasIdentifier ? '' : 'Add an email or a username');
    if (!form.reportValidity()) return null;

    const data = new FormData(form);
    const existing = storedState.users.find((user) => user.id === appState.editingId);
    const selectedRole = form.elements.role.selectedOptions[0];
    const roleId = Core.normalizeWhitespace(data.get('role')) || 'Member';
    const role = Core.normalizeWhitespace(selectedRole?.dataset.label || selectedRole?.textContent || roleId);
    const scenarioId = Core.normalizeWhitespace(data.get('scenario'));
    const selectedScenario = form.elements.scenario?.selectedOptions?.[0];
    const scenarioLabel = scenarioId
      ? Core.normalizeWhitespace(selectedScenario?.dataset.label || selectedScenario?.textContent || scenarioId)
      : '';
    const now = new Date().toISOString();
    const environment =
      Core.normalizeEnvironment(data.get('environment')) || appState.activeEnvironment;
    let user = {
      ...existing,
      id: existing?.id || createId(),
      name: Core.normalizeWhitespace(data.get('name')),
      role,
      roleId,
      scenarioId,
      scenarioLabel,
      email: Core.normalizeWhitespace(data.get('email')),
      username: Core.normalizeWhitespace(data.get('username')),
      password: String(data.get('password') || ''),
      notes: Core.normalizeWhitespace(data.get('notes')),
      siteId: existing?.siteId || currentIdentity.siteId,
      environment,
      origin: existing?.origin || currentIdentity.origin,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    };

    const provisioningInputsChanged = Boolean(
      existing?.provisioning &&
        ['name', 'email', 'username', 'password', 'roleId', 'scenarioId'].some(
          (key) => String(existing[key] || '') !== String(user[key] || '')
        )
    );
    if (provisioningInputsChanged) {
      user = {
        ...user,
        provisioning: {
          ...existing.provisioning,
          status: 'stale',
          error: '',
        },
      };
    }

    const users = existing
      ? storedState.users.map((candidate) => (candidate.id === existing.id ? user : candidate))
      : [user, ...storedState.users];

    await writeStoredState({ ...withCurrentSiteRegistered(storedState), users });
    appState.screen = 'users';
    appState.editingId = null;
    // Land on the environment the user was just saved to, so it is visible.
    if (user.siteId === currentIdentity.siteId) {
      appState.activeEnvironment = user.environment;
    }
    render();
    showToast(existing ? 'Test user updated' : 'Test user saved');
    return user;
  }

  async function deleteUser(userId) {
    const user = storedState.users.find((candidate) => candidate.id === userId);
    if (!user) return;

    await writeStoredState({
      ...storedState,
      users: storedState.users.filter((candidate) => candidate.id !== userId),
    });
    appState.screen = 'users';
    appState.editingId = null;
    appState.pendingDeleteUserId = null;
    render();
    showToast('Test user deleted');
  }

  async function deleteSite(siteId) {
    const site = getSavedSites().find((candidate) => candidate.siteId === siteId);
    if (!site) return;

    const users = storedState.users.filter((user) => user.siteId !== siteId);
    const snapshots = storedState.snapshots.filter((snapshot) => snapshot.siteId !== siteId);
    const sites = Object.fromEntries(
      Object.entries(storedState.sites).filter(([id]) => id !== siteId)
    );
    const origins = Object.fromEntries(
      Object.entries(storedState.origins).filter(([, record]) => record?.siteId !== siteId)
    );
    const removedLoginCount = storedState.users.length - users.length;
    const removedSnapshotCount = storedState.snapshots.length - snapshots.length;

    await writeStoredState({ version: 2, sites, origins, users, snapshots });
    appState.pendingDeleteSiteKey = null;
    resolveCurrentIdentity();
    render();
    let removedLabel = `${removedLoginCount} ${removedLoginCount === 1 ? 'login' : 'logins'}`;
    if (removedSnapshotCount) {
      removedLabel += ` and ${removedSnapshotCount} ${
        removedSnapshotCount === 1 ? 'snapshot' : 'snapshots'
      }`;
    }
    showToast(`Deleted ${site.name} and ${removedLabel}`);
  }

  async function saveSettingsFromForm(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const environmentOverride = Core.normalizeEnvironment(data.get('environment'));
    const effectiveEnvironment = environmentOverride || currentIdentity.detectedEnvironment;

    const adapterInput = form.elements.adapterUrl;
    let adapterUrl = '';
    try {
      adapterUrl = adapterInput?.disabled
        ? getConfiguredAdapterUrl()
        : Core.normalizeAdapterUrl(
            adapterInput?.value || '',
            currentIdentity.origin,
            effectiveEnvironment
          );
      adapterInput?.setCustomValidity('');
    } catch (error) {
      adapterInput?.setCustomValidity(error?.message || 'Invalid provisioning adapter');
    }
    if (!form.reportValidity()) return;

    const origin = currentIdentity.origin;
    const previousSiteId = currentIdentity.siteId;
    const previousAdapterUrl = getConfiguredAdapterUrl();
    const linkedSiteId = Core.normalizeWhitespace(data.get('linkedSiteId'));
    const siteName = Core.normalizeWhitespace(data.get('siteName'));
    const now = new Date().toISOString();

    const next = withCurrentSiteRegistered(storedState);
    const targetSiteId = linkedSiteId && next.sites[linkedSiteId] ? linkedSiteId : previousSiteId;

    next.origins[origin] = {
      ...next.origins[origin],
      siteId: targetSiteId,
      environment: environmentOverride,
      adapterUrl,
      updatedAt: now,
    };
    if (siteName) {
      next.sites[targetSiteId] = { ...next.sites[targetSiteId], name: siteName, updatedAt: now };
    }

    // Logins and snapshots created on this address follow it to its site, and
    // an adapter change means previously provisioned accounts need redoing.
    next.users = next.users.map((user) => {
      if (user.origin !== origin) return user;
      const provisioning =
        user.provisioning && previousAdapterUrl !== adapterUrl
          ? { ...user.provisioning, status: 'stale', error: '' }
          : user.provisioning;
      if (user.siteId === targetSiteId && provisioning === user.provisioning) return user;
      return { ...user, siteId: targetSiteId, provisioning, updatedAt: now };
    });
    next.snapshots = next.snapshots.map((snapshot) =>
      snapshot.origin === origin && snapshot.siteId !== targetSiteId
        ? { ...snapshot, siteId: targetSiteId, updatedAt: now }
        : snapshot
    );

    // A site left with nothing pointing at it disappears rather than
    // lingering as an empty row under Saved sites.
    if (targetSiteId !== previousSiteId) {
      const previousSiteInUse =
        Object.values(next.origins).some((record) => record?.siteId === previousSiteId) ||
        next.users.some((user) => user.siteId === previousSiteId) ||
        next.snapshots.some((snapshot) => snapshot.siteId === previousSiteId);
      if (!previousSiteInUse) delete next.sites[previousSiteId];
    }

    await writeStoredState(next);
    resolveCurrentIdentity();
    appState.activeEnvironment = currentIdentity.environment;
    appState.adapter = { status: adapterUrl ? 'loading' : 'disabled', capabilities: null, error: '' };
    appState.screen = 'users';
    render();
    showToast(adapterUrl ? 'Saved · checking provisioning adapter' : 'Saved');
    if (adapterUrl) await loadAdapterCapabilities();
  }

  async function readAdapterJson(response) {
    const text = await response.text();
    if (text.length > 65536) throw new Error('Provisioning adapter response is too large');
    try {
      return JSON.parse(text);
    } catch {
      throw new Error('Provisioning adapter did not return JSON');
    }
  }

  async function loadAdapterCapabilities(options = {}) {
    const adapterUrl = getConfiguredAdapterUrl();
    if (!adapterUrl) {
      appState.adapter = { status: 'disabled', capabilities: null, error: '' };
      if (options.renderLoading) render();
      return null;
    }

    try {
      const validatedUrl = Core.normalizeAdapterUrl(
        adapterUrl,
        currentIdentity.origin,
        currentIdentity.environment
      );
      appState.adapter = { status: 'loading', capabilities: null, error: '' };
      if (options.renderLoading) render();

      const response = await fetch(validatedUrl, {
        method: 'GET',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: {
          accept: 'application/json',
          'x-test-users-adapter': 'capabilities',
        },
      });
      if (!response.ok) {
        throw new Error(`Provisioning adapter returned HTTP ${response.status}`);
      }

      const capabilities = Core.normalizeAdapterCapabilities(await readAdapterJson(response));
      appState.adapter = { status: 'ready', capabilities, error: '' };
      render();
      return capabilities;
    } catch (error) {
      appState.adapter = {
        status: 'error',
        capabilities: null,
        error: Core.normalizeWhitespace(error?.message || 'Unable to reach provisioning adapter').slice(
          0,
          180
        ),
      };
      render();
      if (options.renderLoading) showToast(appState.adapter.error, 'error');
      return null;
    }
  }

  async function activateUser(user) {
    if (adapterAppliesToUser(user) && getProvisioningStatus(user) !== 'ready') {
      return provisionUser(user, 'provision');
    }
    return fillCredentials(user);
  }

  async function provisionUser(user, operation) {
    if (!adapterIsReady()) await loadAdapterCapabilities();
    if (!adapterAppliesToUser(user)) {
      showToast('Provisioning adapter is not ready for this site', 'error');
      return false;
    }
    if (operation === 'reset' && !appState.adapter.capabilities.canReset) {
      showToast('This project adapter does not support reset', 'error');
      return false;
    }
    if (operation === 'reset' && !user.provisioning?.accountRef) {
      showToast('Provision this account before resetting it', 'error');
      return false;
    }

    const adapterUrl = getConfiguredAdapterUrl();
    appState.provisioningUserId = user.id;
    render();

    try {
      const validatedUrl = Core.normalizeAdapterUrl(
        adapterUrl,
        currentIdentity.origin,
        currentIdentity.environment
      );
      const response = await fetch(validatedUrl, {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          'x-test-users-adapter': operation,
        },
        body: JSON.stringify(Core.buildAdapterRequest(user, operation)),
      });
      if (!response.ok) {
        throw new Error(`Provisioning adapter returned HTTP ${response.status}`);
      }

      const result = Core.normalizeAdapterResult(
        await readAdapterJson(response),
        user.provisioning?.accountRef
      );
      const now = new Date().toISOString();
      const provisioning = {
        ...result,
        adapterUrl,
        roleId: user.roleId || user.role,
        scenarioId: user.scenarioId || '',
        provisionedAt: now,
        error: '',
      };
      const updatedUser = { ...user, provisioning, updatedAt: now };
      const users = storedState.users.map((candidate) =>
        candidate.id === user.id ? updatedUser : candidate
      );
      await writeStoredState({ ...storedState, users });
      appState.provisioningUserId = null;
      render();

      const filled = await fillCredentials(updatedUser, { quiet: true });
      const verb = operation === 'reset' ? 'Reset' : 'Provisioned';
      showToast(
        filled
          ? `${verb} ${result.stateLabel} and filled login`
          : `${verb} ${result.stateLabel} · open a login page to fill credentials`,
        'success'
      );
      return true;
    } catch (error) {
      const message = Core.normalizeWhitespace(
        error?.message || 'Provisioning request failed'
      ).slice(0, 180);
      const failedUser = {
        ...user,
        provisioning: {
          ...user.provisioning,
          adapterUrl,
          status: 'failed',
          error: message,
        },
        updatedAt: new Date().toISOString(),
      };
      const users = storedState.users.map((candidate) =>
        candidate.id === user.id ? failedUser : candidate
      );
      await writeStoredState({ ...storedState, users });
      appState.provisioningUserId = null;
      render();
      showToast(message, 'error');
      return false;
    }
  }

  async function startNewSnapshot() {
    const rawFields = await snapshotEveryFrame();
    const { fields, skippedCount } = Core.buildSnapshotFields(rawFields);

    if (!fields.length) {
      showToast('No snapshotable form fields found on this page', 'error');
      return;
    }

    appState.snapshotDraft = {
      id: null,
      name: Core.deriveSnapshotName(window.location.pathname),
      path: window.location.pathname,
      skippedCount,
      fields,
    };
    appState.screen = 'snapshot';
    appState.pendingDeleteSnapshotId = null;
    render();
  }

  async function rescanSnapshotDraft() {
    const draft = appState.snapshotDraft;
    if (!draft) return;

    // Preserve the unsaved name before re-rendering from the draft.
    const nameInput = shadow.querySelector('[data-form="snapshot"] [name="snapshotName"]');
    if (nameInput) draft.name = nameInput.value;

    const rawFields = await snapshotEveryFrame();
    const { fields, addedCount, updatedCount } = Core.mergeSnapshotFields(draft.fields, rawFields);
    draft.fields = fields;
    render();

    if (!addedCount && !updatedCount) {
      showToast('No new fields or values found');
      return;
    }
    const parts = [];
    if (addedCount) parts.push(`${addedCount} new ${addedCount === 1 ? 'field' : 'fields'}`);
    if (updatedCount) parts.push(`${updatedCount} updated`);
    showToast(`Re-scan added ${parts.join(' · ')}`);
  }

  async function saveSnapshotFromForm(form) {
    if (!form.reportValidity()) return;
    const draft = appState.snapshotDraft;
    if (!draft) return;

    const existing = storedState.snapshots.find((candidate) => candidate.id === draft.id);
    const now = new Date().toISOString();
    const snapshot = {
      ...existing,
      id: existing?.id || createId(),
      name: Core.normalizeWhitespace(form.elements.snapshotName.value) || 'Form snapshot',
      path: draft.path || existing?.path || window.location.pathname,
      fields: draft.fields,
      siteId: existing?.siteId || currentIdentity.siteId,
      origin: existing?.origin || currentIdentity.origin,
      environment: existing?.environment || currentIdentity.environment,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    };

    const snapshots = existing
      ? storedState.snapshots.map((candidate) =>
          candidate.id === existing.id ? snapshot : candidate
        )
      : [snapshot, ...storedState.snapshots];

    await writeStoredState({ ...withCurrentSiteRegistered(storedState), snapshots });
    appState.screen = 'users';
    appState.snapshotDraft = null;
    appState.pendingDeleteSnapshotId = null;
    render();
    showToast(existing ? 'Snapshot updated' : 'Snapshot saved');
  }

  async function deleteSnapshot(snapshotId) {
    const snapshot = storedState.snapshots.find((candidate) => candidate.id === snapshotId);
    if (!snapshot) return;

    await writeStoredState({
      ...storedState,
      snapshots: storedState.snapshots.filter((candidate) => candidate.id !== snapshotId),
    });
    appState.screen = 'users';
    appState.snapshotDraft = null;
    appState.pendingDeleteSnapshotId = null;
    render();
    showToast('Snapshot deleted');
  }

  async function refillSnapshot(snapshot) {
    const fields = Array.isArray(snapshot.fields) ? snapshot.fields : [];
    const includedCount = fields.filter((field) => !field.excluded).length;
    const matchedIds = await refillEveryFrame(fields);
    const filledCount = new Set(matchedIds).size;

    showToast(
      Core.describeRefillResult(filledCount, includedCount),
      filledCount ? 'success' : 'error'
    );
  }

  function setInputValue(input, value) {
    const prototype = input instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
    if (setter) setter.call(input, value);
    else input.value = value;

    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function isInputVisible(input) {
    if (typeof input.checkVisibility === 'function') {
      return input.checkVisibility({ visibilityProperty: true });
    }
    return input.getClientRects().length > 0;
  }

  function collectFillableInputs() {
    const inputs = [];
    const visit = (root) => {
      root.querySelectorAll('input').forEach((input) => {
        if (input.disabled || input.readOnly) return;
        if (String(input.type).toLowerCase() === 'hidden') return;
        if (!isInputVisible(input)) return;
        inputs.push(input);
      });
      root.querySelectorAll('*').forEach((element) => {
        if (element.shadowRoot && element.id !== HOST_ID) visit(element.shadowRoot);
      });
    };
    visit(document);
    return inputs;
  }

  function labelTextFor(input) {
    const texts = new Set();
    [...(input.labels || [])].forEach((label) => texts.add(label.textContent));

    const labelledBy = input.getAttribute('aria-labelledby');
    if (labelledBy) {
      const rootNode = input.getRootNode();
      labelledBy.split(/\s+/).forEach((id) => {
        const element = rootNode.getElementById?.(id);
        if (element) texts.add(element.textContent);
      });
    }

    return [...texts].join(' ');
  }

  function describeFillTarget(input, forms) {
    let formIndex = null;
    if (input.form) {
      if (!forms.includes(input.form)) forms.push(input.form);
      formIndex = forms.indexOf(input.form);
    }

    return {
      type: input.type,
      autocomplete: input.getAttribute('autocomplete'),
      name: input.name,
      id: input.id,
      placeholder: input.placeholder,
      ariaLabel: input.getAttribute('aria-label'),
      labelText: labelTextFor(input),
      formIndex,
    };
  }

  // Snapshot capture reaches beyond login fills: selects, textareas,
  // checkboxes, radios, and date/number inputs all hold refillable form state.
  function collectSnapshotElements() {
    const elements = [];
    const visit = (root) => {
      root.querySelectorAll('input, textarea, select').forEach((element) => {
        if (element.disabled || element.readOnly) return;
        if (String(element.type).toLowerCase() === 'hidden') return;
        if (!isInputVisible(element)) return;
        elements.push(element);
      });
      root.querySelectorAll('*').forEach((element) => {
        if (element.shadowRoot && element.id !== HOST_ID) visit(element.shadowRoot);
      });
    };
    visit(document);
    return elements;
  }

  function describeSnapshotElement(element, forms) {
    const tag = element.tagName.toLowerCase();
    const described = {
      ...describeFillTarget(element, forms),
      tag,
      value: element.value ?? '',
      checked: null,
      multiple: false,
    };

    if (tag === 'select') {
      described.multiple = Boolean(element.multiple);
      described.value = element.multiple
        ? [...element.selectedOptions].map((option) => option.value)
        : element.value;
      described.options = [...element.options].slice(0, 100).map((option) => ({
        value: option.value,
        label: Core.normalizeWhitespace(option.textContent) || option.value,
      }));
    } else if (element.type === 'checkbox' || element.type === 'radio') {
      described.checked = element.checked;
      // A fieldset legend names the whole choice group ("Plan" for the Pro
      // radio), which both the editor label and refill matching benefit from.
      const legend = element.closest('fieldset')?.querySelector('legend');
      if (legend) {
        described.labelText = Core.normalizeWhitespace(
          `${legend.textContent} ${described.labelText || ''}`
        );
      }
    }

    return described;
  }

  function captureSnapshotRawFields() {
    const forms = [];
    return collectSnapshotElements().map((element) => describeSnapshotElement(element, forms));
  }

  function applyRefillStep(element, step) {
    if (step.kind === 'checkbox' || step.kind === 'radio') {
      const desired = step.kind === 'radio' ? true : Boolean(step.checked);
      // A real click keeps framework-controlled checkboxes and radios in sync.
      if (element.checked !== desired) element.click();
      return;
    }

    if (step.kind === 'select') {
      if (element.multiple && Array.isArray(step.value)) {
        const values = new Set(step.value);
        [...element.options].forEach((option) => {
          option.selected = values.has(option.value);
        });
      } else {
        const setter = Object.getOwnPropertyDescriptor(
          HTMLSelectElement.prototype,
          'value'
        )?.set;
        if (setter) setter.call(element, step.value);
        else element.value = step.value;
      }
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
      return;
    }

    setInputValue(element, String(step.value ?? ''));
  }

  function applyRefillPlanInFrame(snapshotFields) {
    const elements = collectSnapshotElements();
    const forms = [];
    const described = elements.map((element) => describeSnapshotElement(element, forms));
    const { steps } = Core.buildRefillPlan(snapshotFields, described);

    steps.forEach((step) => applyRefillStep(elements[step.index], step));
    return steps.map((step) => step.fieldId);
  }

  async function snapshotEveryFrame() {
    if (isExtensionRuntime) {
      try {
        const response = await chrome.runtime.sendMessage({
          type: 'TEST_USERS_SNAPSHOT_ALL_FRAMES',
        });
        if (Array.isArray(response?.fields)) return response.fields;
      } catch {
        // Fall through to a top-frame-only capture.
      }
    }
    return captureSnapshotRawFields();
  }

  async function refillEveryFrame(fields) {
    if (isExtensionRuntime) {
      try {
        const response = await chrome.runtime.sendMessage({
          type: 'TEST_USERS_REFILL_ALL_FRAMES',
          fields,
        });
        if (Array.isArray(response?.fieldIds)) return response.fieldIds;
      } catch {
        // Fall through to a top-frame-only refill.
      }
    }
    return applyRefillPlanInFrame(fields);
  }

  function applyFillPlan(user) {
    const inputs = collectFillableInputs();
    const forms = [];
    const plan = Core.buildFillPlan(
      inputs.map((input) => describeFillTarget(input, forms)),
      user
    );

    if (!plan.length) return [];

    plan.forEach((step) => setInputValue(inputs[step.index], step.value));
    // Only the top frame claims focus so a filled subframe cannot steal it.
    if (window === window.top) inputs[plan[0].index]?.focus();
    return plan.map((step) => step.purpose);
  }

  async function fillEveryFrame(user) {
    if (!isExtensionRuntime) return null;

    try {
      const response = await chrome.runtime.sendMessage({
        type: 'TEST_USERS_FILL_ALL_FRAMES',
        user,
      });
      return Array.isArray(response?.purposes) ? response.purposes : null;
    } catch {
      return null;
    }
  }

  async function fillCredentials(user, options = {}) {
    const framePurposes = await fillEveryFrame(user);
    const purposes = framePurposes ?? applyFillPlan(user);

    if (!purposes.length) {
      if (!options.quiet) showToast('No login or sign-up fields found on this page', 'error');
      return false;
    }

    if (!options.quiet) {
      showToast(`Filled ${Core.describeFillPlan(purposes.map((purpose) => ({ purpose })))}`);
    }
    return true;
  }

  function showToast(message, type = 'success') {
    appState.toast = { message, type };
    syncToast();
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      appState.toast = null;
      syncToast();
    }, 2600);
  }

  function syncToast() {
    shadow.querySelector('.tu-page-toast')?.remove();
    if (!appState.toast) return;

    mount.insertAdjacentHTML('beforeend', renderToast(appState.toast));
  }

  function toggle() {
    appState.open = !appState.open;
    render();
  }

  function destroy() {
    clearTimeout(toastTimer);
    host.remove();
  }

  host.__testUsersApi = {
    destroy,
    toggle,
    getState: () => ({ appState, storedState, currentIdentity }),
  };

  // Bound once at startup because bindEvents re-runs on every render.
  shadow.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !appState.open) return;
    event.stopPropagation();
    appState.open = false;
    render();
  });

  if (isExtensionRuntime) {
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message?.type !== 'TEST_USERS_TOGGLE') return false;
      toggle();
      sendResponse({ ok: true });
      return false;
    });
  }

  (async () => {
    storedState = await readStoredState();
    resolveCurrentIdentity();
    appState.activeEnvironment = currentIdentity.environment;
    render();
    if (getConfiguredAdapterUrl()) await loadAdapterCapabilities();

    if (!isExtensionRuntime) {
      setTimeout(() => {
        const firstUser = storedState.users[0];
        if (firstUser) fillCredentials(firstUser);
      }, 220);
    }
  })();
})();
