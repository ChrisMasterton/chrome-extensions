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

  function getVisibleUsers() {
    const query = appState.query.trim().toLowerCase();
    return storedState.users.filter((user) => {
      if (appState.activeTab === 'site' && user.siteKey !== currentIdentity.siteKey) {
        return false;
      }

      if (!query) return true;
      return [user.name, user.email, user.role, user.notes, user.siteLabel]
        .join(' ')
        .toLowerCase()
        .includes(query);
    });
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
      });
    });

    Object.entries(storedState.siteProfiles).forEach(([origin, profile]) => {
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
        ${appState.screen === 'settings' ? renderSettingsScreen() : ''}
        ${renderFooter()}
      </section>
      ${appState.toast ? renderToast(appState.toast) : ''}
    `;
    bindEvents();
  }

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
              <span class="tu-environment">${escapeHtml(environmentLabel)}</span>
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
      <main class="tu-content">
        <label class="tu-search">
          ${icon('search')}
          <span class="tu-sr-only">Search users or notes</span>
          <input data-input="search" type="search" placeholder="Search users or notes" value="${escapeAttribute(appState.query)}">
        </label>
        <div class="tu-user-list">${userCards}</div>
      </main>
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
          <div class="tu-email" title="${escapeAttribute(user.email)}">${escapeHtml(
            user.email
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
    const generated = existingUser || Core.buildGeneratedIdentity(currentIdentity.projectName, 'Member');
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
              )}" required>
              <button type="button" data-action="copy-field" data-field="email" aria-label="Copy email">${icon(
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
    const loginLabel = `${site.loginCount} ${site.loginCount === 1 ? 'login' : 'logins'}`;

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
      if (field) await copyText(field.value, `${field.name === 'email' ? 'Email' : 'Password'} copied`);
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

    if (action === 'reset-page-name') {
      const input = shadow.querySelector('[name="projectName"]');
      if (input) input.value = currentIdentity.pageName;
    }
  }

  function regenerateEditorValues() {
    const form = shadow.querySelector('[data-form="user"]');
    if (!form) return;
    const role = form.elements.role.value;
    const generated = Core.buildGeneratedIdentity(currentIdentity.projectName, role);
    form.elements.name.value = generated.name;
    form.elements.email.value = generated.email;
    form.elements.password.value = generated.password;
    form.elements.email.focus();
    showToast('Fresh credentials generated');
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
    const siteProfiles = Object.fromEntries(
      Object.entries(storedState.siteProfiles).filter(([origin, profile]) => {
        const identity = identityFromSavedProfile(origin, profile);
        return identity?.siteKey !== siteKey;
      })
    );
    const removedLoginCount = storedState.users.length - users.length;

    await writeStoredState({ users, siteProfiles });
    appState.pendingDeleteSiteKey = null;
    resolveCurrentIdentity();
    render();
    showToast(
      `Deleted ${site.projectName} and ${removedLoginCount} ${
        removedLoginCount === 1 ? 'login' : 'logins'
      }`
    );
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

  async function fillCredentials(user) {
    const inputs = collectFillableInputs();
    const forms = [];
    const plan = Core.buildFillPlan(
      inputs.map((input) => describeFillTarget(input, forms)),
      user
    );

    if (!plan.length) {
      showToast('No login or sign-up fields found on this page', 'error');
      return false;
    }

    plan.forEach((step) => setInputValue(inputs[step.index], step.value));
    inputs[plan[0].index]?.focus();
    showToast(`Filled ${Core.describeFillPlan(plan)}`);
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
