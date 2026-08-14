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

  const PASSWORD_SYMBOL_CHOICES = '!@#$%';

  // Accepts a stored preference (string or array) and returns only known
  // symbols in canonical order. null/undefined means "all symbols allowed";
  // an empty value means alphanumeric-only passwords.
  function sanitizePasswordSymbols(value) {
    const requested = new Set(
      Array.isArray(value) ? value : String(value ?? PASSWORD_SYMBOL_CHOICES).split('')
    );
    return [...PASSWORD_SYMBOL_CHOICES].filter((symbol) => requested.has(symbol)).join('');
  }

  function generatePassword(randomValues, symbols = PASSWORD_SYMBOL_CHOICES) {
    const uppercase = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
    const lowercase = 'abcdefghijkmnopqrstuvwxyz';
    const digits = '23456789';
    const all = `${uppercase}${lowercase}${digits}${symbols}`;
    const characters = [
      pick(uppercase, randomValues),
      pick(lowercase, randomValues),
      pick(digits, randomValues),
    ];
    if (symbols) characters.push(pick(symbols, randomValues));

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

  function buildGeneratedIdentity(projectName, role = 'Member', randomValues, passwordSymbols) {
    const normalizedRole = normalizeWhitespace(role) || 'Member';
    return {
      name: `${normalizedRole} Tester`,
      role: normalizedRole,
      email: generateEmail(projectName, normalizedRole, randomValues),
      username: '',
      password: generatePassword(randomValues, sanitizePasswordSymbols(passwordSymbols)),
      notes: '',
    };
  }

  const FILL_SKIPPED_INPUT_TYPES = new Set([
    'button',
    'checkbox',
    'color',
    'date',
    'datetime-local',
    'file',
    'hidden',
    'image',
    'month',
    'number',
    'radio',
    'range',
    'reset',
    'search',
    'submit',
    'time',
    'week',
  ]);

  const FILL_AUTOCOMPLETE_PURPOSES = new Map([
    ['current-password', 'password'],
    ['email', 'email'],
    ['family-name', 'last-name'],
    ['given-name', 'first-name'],
    ['name', 'full-name'],
    ['new-password', 'password'],
    ['nickname', 'username'],
    ['username', 'username'],
  ]);

  const NON_PERSON_NAME_PATTERN =
    /\b(business|card|city|company|country|domain|file|host|middle|organi[sz]ation|pet|product|project|school|site|state|street|team)\b/;

  const NON_CREDENTIAL_TEXT_PATTERN =
    /\b(captcha|code|coupon|filter|otp|phone|promo|query|search|tel|token|zip)\b/;

  // Splits camelCase and snake/kebab separators so attribute values like
  // "emailAddress" or "first_name" match the same word patterns as label text.
  function normalizeFieldText(value) {
    return String(value || '')
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }

  function fieldHaystack(field) {
    return normalizeFieldText(
      [field.name, field.id, field.placeholder, field.ariaLabel, field.labelText].join(' ')
    );
  }

  function classifyFillField(field) {
    const type = normalizeFieldText(field.type) || 'text';
    if (type === 'password') return 'password';
    if (FILL_SKIPPED_INPUT_TYPES.has(type)) return null;

    for (const token of String(field.autocomplete || '').toLowerCase().split(/\s+/)) {
      const purpose = FILL_AUTOCOMPLETE_PURPOSES.get(token);
      if (purpose) return purpose;
    }

    const haystack = fieldHaystack(field);
    if (type === 'email' || /\be ?mail\b/.test(haystack)) return 'email';
    if (/\buser ?name\b|\blogin\b|\bhandle\b|\bscreen ?name\b/.test(haystack)) return 'username';
    if (/\b(?:first|given) ?name\b|\bforename\b|\bfname\b/.test(haystack)) return 'first-name';
    if (/\b(?:last|family) ?name\b|\bsurname\b|\blname\b/.test(haystack)) return 'last-name';
    if (/\bname\b/.test(haystack) && !NON_PERSON_NAME_PATTERN.test(haystack)) {
      return 'full-name';
    }

    return null;
  }

  function splitPersonName(name) {
    const parts = normalizeWhitespace(name).split(' ').filter(Boolean);
    if (!parts.length) return { first: 'Test', last: 'Tester' };
    return {
      first: parts[0],
      last: parts.length > 1 ? parts.slice(1).join(' ') : 'Tester',
    };
  }

  function buildFillPlan(fields, user) {
    const entries = fields.map((field, index) => ({
      index,
      purpose: classifyFillField(field),
    }));

    // Terse login forms ("Login" + password with no hints): when nothing was
    // recognized as the account identifier, treat the one plain text input
    // that shares a form with a password field as the username.
    if (!entries.some((entry) => entry.purpose === 'email' || entry.purpose === 'username')) {
      const passwordForms = new Set(
        entries
          .filter((entry) => entry.purpose === 'password')
          .map((entry) => fields[entry.index].formIndex ?? null)
      );
      const candidates = entries.filter((entry) => {
        const field = fields[entry.index];
        const type = normalizeFieldText(field.type) || 'text';
        return (
          !entry.purpose &&
          type === 'text' &&
          passwordForms.has(field.formIndex ?? null) &&
          !NON_CREDENTIAL_TEXT_PATTERN.test(fieldHaystack(field))
        );
      });
      if (candidates.length === 1) candidates[0].purpose = 'username';
    }

    const hasEmailField = entries.some((entry) => entry.purpose === 'email');
    const personName = splitPersonName(user?.name);
    const email = String(user?.email || '');
    const username = normalizeWhitespace(user?.username);
    const valueByPurpose = {
      email,
      password: String(user?.password || ''),
      'full-name': normalizeWhitespace(user?.name) || `${personName.first} ${personName.last}`,
      'first-name': personName.first,
      'last-name': personName.last,
      // Without a stored username, fall back to the email: its local part when
      // the form also has an email field, otherwise the full address.
      username: username || (hasEmailField ? email.split('@')[0] : email),
    };

    return entries
      .filter((entry) => entry.purpose && valueByPurpose[entry.purpose])
      .map((entry) => ({
        index: entry.index,
        purpose: entry.purpose,
        value: valueByPurpose[entry.purpose],
      }));
  }

  function describeFillPlan(plan) {
    const labels = [];
    const purposes = new Set(plan.map((step) => step.purpose));
    if (['full-name', 'first-name', 'last-name'].some((purpose) => purposes.has(purpose))) {
      labels.push('name');
    }
    if (purposes.has('username')) labels.push('username');
    if (purposes.has('email')) labels.push('email');
    const passwordCount = plan.filter((step) => step.purpose === 'password').length;
    if (passwordCount === 1) labels.push('password');
    if (passwordCount > 1) labels.push(`${passwordCount} password fields`);

    if (!labels.length) return '';
    if (labels.length === 1) return labels[0];
    return `${labels.slice(0, -1).join(', ')} & ${labels.at(-1)}`;
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
    PASSWORD_SYMBOL_CHOICES,
    buildFillPlan,
    buildGeneratedIdentity,
    classifyFillField,
    derivePageName,
    describeFillPlan,
    generateEmail,
    generatePassword,
    sanitizePasswordSymbols,
    getEnvironment,
    getSiteIdentity,
    isLocalHostname,
    normalizeStoredState,
    normalizeWhitespace,
    slugify,
    splitPersonName,
  };
});
