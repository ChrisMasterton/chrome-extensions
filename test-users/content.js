(function initializeTestUsersOverlay() {
  const HOST_ID = 'test-users-extension-root';
  const STORAGE_KEY = 'testUsersStateV1';
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
    query: '',
    editingId: null,
    pendingDeleteUserId: null,
    pendingDeleteSiteKey: null,
    snapshotDraft: null,
    pendingDeleteSnapshotId: null,
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

    const demoLocation = {
      protocol: window.location.protocol,
      hostname: window.location.hostname,
      port: window.location.port,
      origin: window.location.origin,
    };
    const identity = Core.getSiteIdentity(demoLocation, document.title);
    const now = new Date().toISOString();

    return {
      users: [
        {
          id: 'demo-admin',
          name: 'Alex Admin',
          role: 'Admin',
          email: 'alex.admin+local@example.test',
          password: 'AdminTest!4827',
          notes: 'Billing, team settings',
          siteKey: identity.siteKey,
          siteLabel: identity.projectName,
          origin: identity.origin,
          environment: identity.environment,
          createdAt: now,
          updatedAt: now,
        },
        {
          id: 'demo-member',
          name: 'Maya Member',
          role: 'Member',
          email: 'maya.member+local@example.test',
          password: 'MemberTest!5938',
          notes: 'Standard paid workspace',
          siteKey: identity.siteKey,
          siteLabel: identity.projectName,
          origin: identity.origin,
          environment: identity.environment,
          createdAt: now,
          updatedAt: now,
        },
        {
          id: 'demo-invited',
          name: 'Pending Invite',
          role: 'Invited',
          email: 'pending.invite+local@example.test',
          password: 'InviteTest!6049',
          notes: 'Onboarding scenario',
          siteKey: identity.siteKey,
          siteLabel: identity.projectName,
          origin: identity.origin,
          environment: identity.environment,
          createdAt: now,
          updatedAt: now,
        },
      ],
      snapshots: [],
      siteProfiles: {},
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
    const origin = window.location.origin;
    const override = storedState.siteProfiles[origin]?.projectName;
    currentIdentity = Core.getSiteIdentity(window.location, document.title, override);
  }

  function getPasswordSymbols() {
    return Core.sanitizePasswordSymbols(
      storedState.siteProfiles[window.location.origin]?.passwordSymbols
    );
  }

  function getVisibleUsers() {
    const query = appState.query.trim().toLowerCase();
    return storedState.users.filter((user) => {
      if (appState.activeTab === 'site' && user.siteKey !== currentIdentity.siteKey) {
        return false;
      }

      if (!query) return true;
      return [user.name, user.email, user.username, user.role, user.notes, user.siteLabel]
        .join(' ')
        .toLowerCase()
        .includes(query);
    });
  }

  function getVisibleSnapshots() {
    const query = appState.query.trim().toLowerCase();
    const currentPath = window.location.pathname;
    return storedState.snapshots
      .filter((snapshot) => {
        if (appState.activeTab === 'site' && snapshot.siteKey !== currentIdentity.siteKey) {
          return false;
        }

        if (!query) return true;
        return [snapshot.name, snapshot.path, snapshot.siteLabel]
          .join(' ')
          .toLowerCase()
          .includes(query);
      })
      .sort(
        (left, right) =>
          Number(right.path === currentPath) - Number(left.path === currentPath)
      );
  }

  function identityFromSavedProfile(origin, profile) {
    try {
      const url = new URL(origin);
      return Core.getSiteIdentity(url, profile?.projectName, profile?.projectName);
    } catch {
      return null;
    }
  }

  function getSavedSites() {
    const sites = new Map();

    storedState.users.forEach((user) => {
      if (!user.siteKey) return;
      const existing = sites.get(user.siteKey);
      let originLabel = user.origin;
      try {
        originLabel = new URL(user.origin).host;
      } catch {
        // Preserve the stored origin when older data is not a valid URL.
      }

      sites.set(user.siteKey, {
        siteKey: user.siteKey,
        projectName: user.siteLabel || 'Untitled site',
        origin: user.origin,
        originLabel,
        environment: user.environment || 'web',
        loginCount: (existing?.loginCount || 0) + 1,
        snapshotCount: existing?.snapshotCount || 0,
      });
    });

    storedState.snapshots.forEach((snapshot) => {
      if (!snapshot.siteKey) return;
      const existing = sites.get(snapshot.siteKey);
      let originLabel = snapshot.origin;
      try {
        originLabel = new URL(snapshot.origin).host;
      } catch {
        // Preserve the stored origin when older data is not a valid URL.
      }

      sites.set(snapshot.siteKey, {
        siteKey: snapshot.siteKey,
        projectName: existing?.projectName || snapshot.siteLabel || 'Untitled site',
        origin: existing?.origin || snapshot.origin,
        originLabel: existing?.originLabel || originLabel,
        environment: existing?.environment || snapshot.environment || 'web',
        loginCount: existing?.loginCount || 0,
        snapshotCount: (existing?.snapshotCount || 0) + 1,
      });
    });

    Object.entries(storedState.siteProfiles).forEach(([origin, profile]) => {
      // Profiles holding only preferences (e.g. password symbols) are not
      // named site identities and should not appear as saved sites.
      if (!profile?.projectName) return;
      const identity = identityFromSavedProfile(origin, profile);
      if (!identity) return;
      const existing = sites.get(identity.siteKey);
      sites.set(identity.siteKey, {
        siteKey: identity.siteKey,
        projectName: identity.projectName,
        origin: identity.origin,
        originLabel: identity.originLabel,
        environment: identity.environment,
        loginCount: existing?.loginCount || 0,
        snapshotCount: existing?.snapshotCount || 0,
      });
    });

    return [...sites.values()].sort((left, right) => {
      if (left.siteKey === currentIdentity.siteKey) return -1;
      if (right.siteKey === currentIdentity.siteKey) return 1;
      return left.projectName.localeCompare(right.projectName);
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
    staging: 'Looks like a staging site — use generated test accounts only',
    web: 'Real website — use generated test accounts only',
  };

  function renderHeader() {
    const environmentLabel = currentIdentity.isLocal
      ? 'LOCAL'
      : currentIdentity.environment.toUpperCase();

    return `
      <header class="tu-header">
        <div class="tu-heading-row">
          <h1>Test Users</h1>
          <button class="tu-icon-button" data-action="close" aria-label="Close Test Users">
            ${icon('x')}
          </button>
        </div>
        <button class="tu-site-identity" data-action="settings" title="Edit how this site is identified">
          <span class="tu-site-badge" aria-hidden="true">${escapeHtml(
            initials(currentIdentity.projectName)
          )}</span>
          <span class="tu-site-identity-copy">
            <span class="tu-site-identity-name">
              <strong>${escapeHtml(currentIdentity.projectName)}</strong>
              <span class="tu-environment tu-environment--${escapeAttribute(
                currentIdentity.environment
              )}" title="${escapeAttribute(
                ENVIRONMENT_TITLES[currentIdentity.environment] || ''
              )}">${escapeHtml(environmentLabel)}</span>
            </span>
            <span class="tu-site-origin">${escapeHtml(currentIdentity.originLabel)}</span>
          </span>
          <span class="tu-site-identity-edit">${icon('edit')}<span>Edit</span></span>
        </button>
      </header>
    `;
  }

  function renderUsersScreen() {
    const users = getVisibleUsers();
    const siteCount = storedState.users.filter(
      (user) => user.siteKey === currentIdentity.siteKey
    ).length;
    const allCount = storedState.users.length;
    const userCards = users.length
      ? users.map(renderUserCard).join('')
      : renderEmptyState();

    return `
      <div class="tu-tabs" role="tablist" aria-label="User scope">
        <button class="tu-tab ${appState.activeTab === 'site' ? 'is-active' : ''}" data-tab="site" role="tab" aria-selected="${appState.activeTab === 'site'}" title="Test users saved for ${escapeAttribute(
          currentIdentity.projectName
        )}">
          <span class="tu-tab-label">${escapeHtml(currentIdentity.projectName)}</span>
          <span class="tu-tab-count">${siteCount}</span>
        </button>
        <button class="tu-tab ${appState.activeTab === 'all' ? 'is-active' : ''}" data-tab="all" role="tab" aria-selected="${appState.activeTab === 'all'}">
          <span class="tu-tab-label">All sites</span>
          <span class="tu-tab-count">${allCount}</span>
        </button>
      </div>
      <div class="tu-search-bar">
        <label class="tu-search">
          ${icon('search')}
          <span class="tu-sr-only">Search users or notes</span>
          <input data-input="search" type="search" placeholder="Search users or notes" value="${escapeAttribute(appState.query)}">
        </label>
      </div>
      <main class="tu-content">
        <div class="tu-user-list">${userCards}</div>
        ${renderSnapshotSection()}
      </main>
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
    if (appState.activeTab === 'all' && snapshot.siteLabel) details.push(snapshot.siteLabel);

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

  function renderUserCard(user) {
    const showProject = appState.activeTab === 'all';
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
          <div class="tu-notes">${escapeHtml(user.notes || 'No notes yet')}</div>
          ${showProject ? `<div class="tu-project-label">${escapeHtml(user.siteLabel)}</div>` : ''}
        </div>
        <div class="tu-card-actions">
          <button class="tu-edit-button" data-action="edit" data-user-id="${escapeAttribute(
            user.id
          )}" aria-label="Edit ${escapeAttribute(user.name)}">${icon('edit')}</button>
          <button class="tu-primary-button tu-fill-button" data-action="fill" data-user-id="${escapeAttribute(
            user.id
          )}">${icon('login-2')}<span>Fill login</span></button>
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
    const heading = onSiteTab
      ? `No test users for ${escapeHtml(currentIdentity.projectName)} yet`
      : 'No test users yet';
    const body =
      onSiteTab && totalUsers
        ? `Your ${totalUsers} saved ${
            totalUsers === 1 ? 'login belongs' : 'logins belong'
          } to other sites. Create one here, or browse everything you have saved.`
        : 'Generate credentials and fill the current login or sign-up form in one step.';

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

  function renderEditorScreen() {
    const existingUser = storedState.users.find((user) => user.id === appState.editingId);
    const passwordSymbols = getPasswordSymbols();
    const generated =
      existingUser ||
      Core.buildGeneratedIdentity(currentIdentity.projectName, 'Member', undefined, passwordSymbols);
    const title = existingUser ? 'Edit test user' : 'New test user';

    return `
      <main class="tu-content tu-editor">
        <button class="tu-back-button" data-action="back">${icon('arrow-left')}<span>Back to users</span></button>
        <div class="tu-section-heading">
          <div>
            <h2>${title}</h2>
            <p>${escapeHtml(currentIdentity.projectName)} · ${escapeHtml(
              currentIdentity.environment
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
            <span>Role</span>
            <select name="role">
              ${['Owner', 'Admin', 'Member', 'Viewer', 'Invited', 'Custom']
                .map(
                  (role) =>
                    `<option value="${role}" ${
                      generated.role === role ? 'selected' : ''
                    }>${role}</option>`
                )
                .join('')}
            </select>
          </label>
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
              )}<span>Save &amp; fill</span></button>
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

  function renderSettingsScreen() {
    return `
      <main class="tu-content tu-settings">
        <button class="tu-back-button" data-action="back">${icon('arrow-left')}<span>Back to users</span></button>
        <div class="tu-section-heading">
          <div>
            <h2>Site identity</h2>
            <p>Test accounts are grouped by address and page name.</p>
          </div>
        </div>
        <form class="tu-form" data-form="settings">
          <label class="tu-form-wide">
            <span>Page name</span>
            <input name="projectName" value="${escapeAttribute(
              currentIdentity.projectName
            )}" required>
            <small>Detected from the browser tab title. You can correct it once for this address.</small>
          </label>
          <div class="tu-identity-preview tu-form-wide">
            <span>Stored site identifier</span>
            <strong>${escapeHtml(currentIdentity.originLabel)} + ${escapeHtml(
              currentIdentity.projectName
            )}</strong>
          </div>
          <div class="tu-form-actions tu-form-wide">
            <button class="tu-secondary-button" type="button" data-action="reset-page-name">Use detected title</button>
            <button class="tu-primary-button" type="submit">${icon(
              'device-floppy'
            )}<span>Save identity</span></button>
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
          <p>Remove an identity and every test login stored beneath it.</p>
        </div>
        <div class="tu-saved-site-list">
          ${savedSites.map(renderSavedSite).join('')}
        </div>
      </section>
    `;
  }

  function renderSavedSite(site) {
    const pending = appState.pendingDeleteSiteKey === site.siteKey;
    let loginLabel = `${site.loginCount} ${site.loginCount === 1 ? 'login' : 'logins'}`;
    if (site.snapshotCount) {
      loginLabel += ` · ${site.snapshotCount} ${site.snapshotCount === 1 ? 'snapshot' : 'snapshots'}`;
    }

    if (pending) {
      return `
        <article class="tu-saved-site tu-saved-site--confirming" data-site-key="${escapeAttribute(
          site.siteKey
        )}">
          <div class="tu-site-delete-copy">
            <strong>Delete ${escapeHtml(site.projectName)}?</strong>
            <p>This removes the site identity and ${escapeHtml(loginLabel)}. Other projects are unaffected.</p>
          </div>
          <div class="tu-site-confirm-actions">
            <button class="tu-secondary-button" type="button" data-action="cancel-delete-site">Cancel</button>
            <button class="tu-danger-button" type="button" data-action="confirm-delete-site" data-site-key="${escapeAttribute(
              site.siteKey
            )}">${icon('trash')}<span>Delete site</span></button>
          </div>
        </article>
      `;
    }

    return `
      <article class="tu-saved-site" data-site-key="${escapeAttribute(site.siteKey)}">
        <div class="tu-saved-site-copy">
          <strong>${escapeHtml(site.projectName)}</strong>
          <span>${escapeHtml(site.originLabel)} · ${escapeHtml(loginLabel)}</span>
        </div>
        <button class="tu-site-delete-button" type="button" data-action="delete-site" data-site-key="${escapeAttribute(
          site.siteKey
        )}" aria-label="Delete ${escapeAttribute(site.projectName)} site">${icon(
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
      if (user) await fillCredentials(user);
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

    if (action === 'reset-page-name') {
      const input = shadow.querySelector('[name="projectName"]');
      if (input) input.value = currentIdentity.pageName;
    }
  }

  function findDraftField(fieldId) {
    return appState.snapshotDraft?.fields.find((field) => field.id === fieldId) || null;
  }

  function regenerateEditorValues() {
    const form = shadow.querySelector('[data-form="user"]');
    if (!form) return;
    const role = form.elements.role.value;
    const generated = Core.buildGeneratedIdentity(
      currentIdentity.projectName,
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
    const origin = window.location.origin;
    const siteProfiles = {
      ...storedState.siteProfiles,
      [origin]: {
        ...storedState.siteProfiles[origin],
        passwordSymbols: symbols,
        updatedAt: new Date().toISOString(),
      },
    };
    await writeStoredState({ ...storedState, siteProfiles });

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
    const now = new Date().toISOString();
    const user = {
      ...existing,
      id: existing?.id || createId(),
      name: Core.normalizeWhitespace(data.get('name')),
      role: Core.normalizeWhitespace(data.get('role')) || 'Member',
      email: Core.normalizeWhitespace(data.get('email')),
      username: Core.normalizeWhitespace(data.get('username')),
      password: String(data.get('password') || ''),
      notes: Core.normalizeWhitespace(data.get('notes')),
      siteKey: currentIdentity.siteKey,
      siteLabel: currentIdentity.projectName,
      origin: currentIdentity.origin,
      environment: currentIdentity.environment,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    };

    const users = existing
      ? storedState.users.map((candidate) => (candidate.id === existing.id ? user : candidate))
      : [user, ...storedState.users];

    await writeStoredState({ ...storedState, users });
    appState.screen = 'users';
    appState.editingId = null;
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

  async function deleteSite(siteKey) {
    const site = getSavedSites().find((candidate) => candidate.siteKey === siteKey);
    if (!site) return;

    const users = storedState.users.filter((user) => user.siteKey !== siteKey);
    const snapshots = storedState.snapshots.filter((snapshot) => snapshot.siteKey !== siteKey);
    const siteProfiles = Object.fromEntries(
      Object.entries(storedState.siteProfiles).filter(([origin, profile]) => {
        const identity = identityFromSavedProfile(origin, profile);
        return identity?.siteKey !== siteKey;
      })
    );
    const removedLoginCount = storedState.users.length - users.length;
    const removedSnapshotCount = storedState.snapshots.length - snapshots.length;

    await writeStoredState({ users, snapshots, siteProfiles });
    appState.pendingDeleteSiteKey = null;
    resolveCurrentIdentity();
    render();
    let removedLabel = `${removedLoginCount} ${removedLoginCount === 1 ? 'login' : 'logins'}`;
    if (removedSnapshotCount) {
      removedLabel += ` and ${removedSnapshotCount} ${
        removedSnapshotCount === 1 ? 'snapshot' : 'snapshots'
      }`;
    }
    showToast(`Deleted ${site.projectName} and ${removedLabel}`);
  }

  async function saveSettingsFromForm(event) {
    event.preventDefault();
    const form = event.currentTarget;
    if (!form.reportValidity()) return;

    const previousIdentity = currentIdentity;
    const projectName = Core.normalizeWhitespace(new FormData(form).get('projectName'));
    const siteProfiles = {
      ...storedState.siteProfiles,
      [previousIdentity.origin]: {
        ...storedState.siteProfiles[previousIdentity.origin],
        projectName,
        updatedAt: new Date().toISOString(),
      },
    };
    const nextIdentity = Core.getSiteIdentity(window.location, document.title, projectName);
    const users = storedState.users.map((user) =>
      user.origin === previousIdentity.origin
        ? {
            ...user,
            siteKey: nextIdentity.siteKey,
            siteLabel: nextIdentity.projectName,
            updatedAt: new Date().toISOString(),
          }
        : user
    );

    await writeStoredState({ users, siteProfiles });
    resolveCurrentIdentity();
    appState.screen = 'users';
    render();
    showToast('Site identity saved');
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
      siteKey: existing?.siteKey || currentIdentity.siteKey,
      siteLabel: existing?.siteLabel || currentIdentity.projectName,
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

    await writeStoredState({ ...storedState, snapshots });
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

  async function fillCredentials(user) {
    const framePurposes = await fillEveryFrame(user);
    const purposes = framePurposes ?? applyFillPlan(user);

    if (!purposes.length) {
      showToast('No login or sign-up fields found on this page', 'error');
      return false;
    }

    showToast(`Filled ${Core.describeFillPlan(purposes.map((purpose) => ({ purpose })))}`);
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
    render();

    if (!isExtensionRuntime) {
      setTimeout(() => {
        const firstUser = storedState.users[0];
        if (firstUser) fillCredentials(firstUser);
      }, 220);
    }
  })();
})();
