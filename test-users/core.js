(function exposeTestUsersCore(root, factory) {
  const api = factory();
  root.TestUsersCore = api;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function createTestUsersCore() {
  const GENERIC_PAGE_NAMES = new Set([
    'account',
    'create account',
    'dashboard',
    'home',
    'log in',
    'login',
    'register',
    'registration',
    'sign in',
    'sign up',
    'signup',
    'welcome',
    'welcome back',
  ]);

  function normalizeWhitespace(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function slugify(value, fallback = 'site') {
    const slug = normalizeWhitespace(value)
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    return slug || fallback;
  }

  function derivePageName(title) {
    const normalized = normalizeWhitespace(title);
    if (!normalized) return 'Untitled page';

    const parts = normalized
      .split(/\s+(?:\||—|–|·|•|-{1,2})\s+|\s*:\s*/)
      .map(normalizeWhitespace)
      .filter(Boolean);

    const meaningfulParts = parts.filter(
      (part) => !GENERIC_PAGE_NAMES.has(part.toLowerCase())
    );

    if (meaningfulParts.length === 1) return meaningfulParts[0];
    if (meaningfulParts.length > 1 && meaningfulParts.length < parts.length) {
      return meaningfulParts.join(' · ');
    }

    return normalized;
  }

  function isLocalHostname(hostname) {
    const value = String(hostname || '').toLowerCase();
    return value === 'localhost' || value === '127.0.0.1' || value === '::1';
  }

  function getEnvironment(hostname) {
    const value = String(hostname || '').toLowerCase();
    if (isLocalHostname(value)) return 'local';
    if (/staging|stage|preview|dev\.|test\./.test(value)) return 'staging';
    return 'web';
  }

  function getSiteIdentity(locationLike, title, projectOverride) {
    const protocol = locationLike?.protocol || 'http:';
    const hostname = locationLike?.hostname || 'localhost';
    const port = locationLike?.port || '';
    const environment = getEnvironment(hostname);
    const origin = locationLike?.origin || `${protocol}//${hostname}${port ? `:${port}` : ''}`;
    const originLabel = `${hostname}${port ? `:${port}` : ''}`;
    const pageName = derivePageName(title);
    const projectName = normalizeWhitespace(projectOverride) || pageName;
    const siteKey = `${environment}:${originLabel.toLowerCase()}:${slugify(projectName)}`;

    return {
      environment,
      isLocal: environment === 'local',
      origin,
      originLabel,
      pageName,
      projectName,
      siteKey,
    };
  }

  function randomInt(max, randomValues) {
    if (typeof randomValues === 'function') {
      return Math.floor(randomValues() * max) % max;
    }

    const values = new Uint32Array(1);
    crypto.getRandomValues(values);
    return values[0] % max;
  }

  function pick(characters, randomValues) {
    return characters[randomInt(characters.length, randomValues)];
  }

  function shuffle(values, randomValues) {
    const result = [...values];
    for (let index = result.length - 1; index > 0; index -= 1) {
      const swapIndex = randomInt(index + 1, randomValues);
      [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
    }
    return result;
  }

  function generatePassword(randomValues) {
    const uppercase = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
    const lowercase = 'abcdefghijkmnopqrstuvwxyz';
    const digits = '23456789';
    const symbols = '!@#$%';
    const all = `${uppercase}${lowercase}${digits}${symbols}`;
    const characters = [
      pick(uppercase, randomValues),
      pick(lowercase, randomValues),
      pick(digits, randomValues),
      pick(symbols, randomValues),
    ];

    while (characters.length < 16) {
      characters.push(pick(all, randomValues));
    }

    return shuffle(characters, randomValues).join('');
  }

  function generateEmail(projectName, role, randomValues) {
    const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
    let suffix = '';
    while (suffix.length < 6) suffix += pick(alphabet, randomValues);

    return `${slugify(projectName)}.${slugify(role, 'user')}.${suffix}@example.test`;
  }

  function buildGeneratedIdentity(projectName, role = 'Member', randomValues) {
    const normalizedRole = normalizeWhitespace(role) || 'Member';
    return {
      name: `${normalizedRole} Tester`,
      role: normalizedRole,
      email: generateEmail(projectName, normalizedRole, randomValues),
      password: generatePassword(randomValues),
      notes: '',
    };
  }

  function normalizeStoredState(value) {
    const state = value && typeof value === 'object' ? value : {};
    return {
      users: Array.isArray(state.users) ? state.users : [],
      siteProfiles:
        state.siteProfiles &&
        typeof state.siteProfiles === 'object' &&
        !Array.isArray(state.siteProfiles)
          ? state.siteProfiles
          : {},
    };
  }

  return {
    buildGeneratedIdentity,
    derivePageName,
    generateEmail,
    generatePassword,
    getEnvironment,
    getSiteIdentity,
    isLocalHostname,
    normalizeStoredState,
    normalizeWhitespace,
    slugify,
  };
});
