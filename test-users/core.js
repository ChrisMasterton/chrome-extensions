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

  function normalizeAdapterUrl(value, origin, environment) {
    const requested = normalizeWhitespace(value);
    if (!requested) return '';
    if (environment !== 'local' && environment !== 'staging') {
      throw new Error('Provisioning adapters are available only on local or staging sites');
    }

    let adapterUrl;
    let siteOrigin;
    try {
      siteOrigin = new URL(origin);
      adapterUrl = new URL(requested, siteOrigin);
    } catch {
      throw new Error('Enter a valid provisioning adapter URL');
    }

    if (!['http:', 'https:'].includes(adapterUrl.protocol)) {
      throw new Error('Provisioning adapters must use HTTP or HTTPS');
    }
    if (environment === 'staging' && adapterUrl.protocol !== 'https:') {
      throw new Error('Staging provisioning adapters must use HTTPS');
    }
    if (adapterUrl.origin !== siteOrigin.origin) {
      throw new Error('Provisioning adapters must use this site origin');
    }
    if (adapterUrl.username || adapterUrl.password) {
      throw new Error('Provisioning adapter URLs cannot contain credentials');
    }
    adapterUrl.hash = '';
    return adapterUrl.href;
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

  const ADAPTER_CREDENTIAL_KEY = /^(?:accounts?|credentials?|emails?|names?|passwords?|secrets?|sessions?|tokens?|usernames?|users?)$/i;

  function assertAdapterMetadataIsCredentialFree(value, path = 'adapter response', seen = new WeakSet()) {
    if (!value || typeof value !== 'object') return;
    if (seen.has(value)) return;
    seen.add(value);

    if (Array.isArray(value)) {
      value.forEach((item, index) =>
        assertAdapterMetadataIsCredentialFree(item, `${path}[${index}]`, seen)
      );
      return;
    }

    Object.entries(value).forEach(([key, nestedValue]) => {
      if (ADAPTER_CREDENTIAL_KEY.test(key)) {
        throw new Error(`${path} must not include ${key}`);
      }
      assertAdapterMetadataIsCredentialFree(nestedValue, `${path}.${key}`, seen);
    });
  }

  function normalizeAdapterOption(value, index, kind) {
    const raw = typeof value === 'string' ? { id: value, label: value } : value;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

    const label = normalizeWhitespace(raw.label || raw.id).slice(0, 80);
    if (!label) return null;
    const id = normalizeWhitespace(raw.id || slugify(label, `${kind}-${index + 1}`)).slice(0, 80);
    if (!id) return null;

    return {
      id,
      label,
      description: normalizeWhitespace(raw.description).slice(0, 180),
    };
  }

  function normalizeAdapterCapabilities(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('Provisioning adapter returned invalid capabilities');
    }
    assertAdapterMetadataIsCredentialFree(value, 'adapter capabilities');

    const roles = (Array.isArray(value.roles) ? value.roles : [])
      .slice(0, 30)
      .map((role, index) => normalizeAdapterOption(role, index, 'role'))
      .filter(Boolean);
    if (!roles.length) {
      throw new Error('Provisioning adapter must advertise at least one role');
    }

    const scenarios = (Array.isArray(value.scenarios) ? value.scenarios : [])
      .slice(0, 50)
      .map((scenario, index) => normalizeAdapterOption(scenario, index, 'scenario'))
      .filter(Boolean);
    const capabilities = value.capabilities && typeof value.capabilities === 'object'
      ? value.capabilities
      : {};

    return {
      schemaVersion: 1,
      label: normalizeWhitespace(value.label || 'Project adapter').slice(0, 80),
      roles,
      scenarios,
      canProvision: capabilities.provision !== false,
      canReset: capabilities.reset === true,
    };
  }

  function normalizeAdapterResult(value, fallbackAccountRef = '') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('Provisioning adapter returned an invalid result');
    }
    assertAdapterMetadataIsCredentialFree(value, 'adapter result');

    const status = normalizeWhitespace(value.status || 'ready').toLowerCase();
    if (status !== 'ready') {
      throw new Error('Provisioning adapter did not return a ready account');
    }
    const accountRef = normalizeWhitespace(value.accountRef || fallbackAccountRef).slice(0, 180);
    if (!accountRef) {
      throw new Error('Provisioning adapter did not return an account reference');
    }

    let expiresAt = null;
    if (value.expiresAt) {
      const parsed = new Date(value.expiresAt);
      if (!Number.isNaN(parsed.getTime())) expiresAt = parsed.toISOString();
    }

    return {
      status: 'ready',
      accountRef,
      stateLabel: normalizeWhitespace(value.stateLabel || 'Ready').slice(0, 120),
      expiresAt,
    };
  }

  function buildAdapterRequest(user, operation = 'provision') {
    const role = {
      id: normalizeWhitespace(user?.roleId || user?.role),
      label: normalizeWhitespace(user?.role || user?.roleId),
    };
    const scenario = user?.scenarioId
      ? {
          id: normalizeWhitespace(user.scenarioId),
          label: normalizeWhitespace(user.scenarioLabel || user.scenarioId),
        }
      : null;
    const request = {
      schemaVersion: 1,
      operation,
      idempotencyKey: normalizeWhitespace(user?.id),
      role,
      scenario,
    };

    if (operation === 'reset') {
      request.accountRef = normalizeWhitespace(user?.provisioning?.accountRef);
      return request;
    }

    request.identity = {
      name: normalizeWhitespace(user?.name),
      email: normalizeWhitespace(user?.email),
      username: normalizeWhitespace(user?.username),
      password: String(user?.password || ''),
    };
    return request;
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

  // Snapshot capture skips these input types outright; everything else that
  // holds user-entered form state (dates, numbers, checkboxes…) is captured.
  const SNAPSHOT_SKIPPED_INPUT_TYPES = new Set([
    'button',
    'file',
    'hidden',
    'image',
    'password',
    'reset',
    'search',
    'submit',
  ]);

  const SNAPSHOT_CREDENTIAL_AUTOCOMPLETE = new Set([
    'current-password',
    'email',
    'new-password',
    'nickname',
    'username',
  ]);

  const SNAPSHOT_PAYMENT_TEXT_PATTERN =
    /\b(account ?number|card ?number|cardnumber|ccnum|cvc|cvv|expir\w*|iban|routing ?number|security ?code)\b/;

  const SNAPSHOT_ONE_TIME_TEXT_PATTERN =
    /\b(2 ?fa|auth ?code|captcha|coupon|mfa|one ?time|otp|promo|verification ?code)\b/;

  // Why a field must never be captured or refilled, or null when it is fair
  // game. 'unsupported' types are silently dropped; the other reasons count
  // as sensitive skips so the editor can report them.
  function snapshotExclusionReason(field) {
    const tag = String(field.tag || 'input').toLowerCase();
    const type = normalizeFieldText(field.type) || 'text';

    if (tag === 'input' && SNAPSHOT_SKIPPED_INPUT_TYPES.has(type)) {
      return type === 'password' ? 'credential' : 'unsupported';
    }

    for (const token of String(field.autocomplete || '').toLowerCase().split(/\s+/)) {
      if (SNAPSHOT_CREDENTIAL_AUTOCOMPLETE.has(token)) return 'credential';
      if (token === 'one-time-code') return 'one-time';
      if (token.startsWith('cc-')) return 'payment';
    }

    const haystack = fieldHaystack(field);
    if (type === 'email' || /\be ?mail\b/.test(haystack)) return 'credential';
    if (/\buser ?name\b|\bpass ?word\b|\bpass ?phrase\b|\blogin\b|\bhandle\b|\bscreen ?name\b/.test(haystack)) {
      return 'credential';
    }
    if (SNAPSHOT_PAYMENT_TEXT_PATTERN.test(haystack)) return 'payment';
    if (SNAPSHOT_ONE_TIME_TEXT_PATTERN.test(haystack)) return 'one-time';

    return null;
  }

  function snapshotFieldKind(field) {
    const tag = String(field.tag || 'input').toLowerCase();
    if (tag === 'select') return 'select';
    if (tag === 'textarea') return 'textarea';
    const type = normalizeFieldText(field.type) || 'text';
    if (type === 'checkbox') return 'checkbox';
    if (type === 'radio') return 'radio';
    return 'text';
  }

  function snapshotFieldLabel(field) {
    return (
      normalizeWhitespace(field.labelText) ||
      normalizeWhitespace(field.ariaLabel) ||
      normalizeWhitespace(field.placeholder) ||
      normalizeWhitespace(field.name) ||
      normalizeWhitespace(field.id) ||
      'Unnamed field'
    );
  }

  function buildSnapshotMatcher(field) {
    const kind = snapshotFieldKind(field);
    return {
      tag: String(field.tag || 'input').toLowerCase(),
      type: normalizeFieldText(field.type) || 'text',
      kind,
      domId: String(field.id || ''),
      name: String(field.name || ''),
      placeholder: normalizeWhitespace(field.placeholder),
      autocomplete: String(field.autocomplete || '').toLowerCase().trim(),
      label: normalizeFieldText(field.labelText),
      radioValue: kind === 'radio' ? String(field.value ?? '') : '',
    };
  }

  // Scores how confidently a live page field is "the same field" the matcher
  // was captured from. Identity comes from stable attributes, not DOM
  // position, so snapshots survive re-renders. Below 2 (no real identifier
  // agreed) the field is treated as not found.
  function matcherScore(matcher, field) {
    if (String(field.tag || 'input').toLowerCase() !== matcher.tag) return 0;
    if (snapshotFieldKind(field) !== matcher.kind) return 0;
    if (matcher.kind === 'radio' && String(field.value ?? '') !== matcher.radioValue) return 0;

    let score = 0;
    if (matcher.domId && String(field.id || '') === matcher.domId) score += 8;
    if (matcher.name && String(field.name || '') === matcher.name) score += 6;
    if (matcher.label && normalizeFieldText(field.labelText) === matcher.label) score += 4;
    if (matcher.placeholder && normalizeWhitespace(field.placeholder) === matcher.placeholder) {
      score += 2;
    }
    if (
      matcher.autocomplete &&
      String(field.autocomplete || '').toLowerCase().trim() === matcher.autocomplete
    ) {
      score += 1;
    }
    if (score && (normalizeFieldText(field.type) || 'text') !== matcher.type) score -= 1;

    return score >= 2 ? score : 0;
  }

  function snapshotFieldHasValue(field) {
    if (field.kind === 'checkbox' || field.kind === 'radio') return true;
    if (Array.isArray(field.value)) return field.value.length > 0;
    return String(field.value ?? '') !== '';
  }

  function buildSnapshotFields(rawFields) {
    const fields = [];
    let skippedCount = 0;

    (Array.isArray(rawFields) ? rawFields : []).forEach((raw) => {
      if (!raw || typeof raw !== 'object') return;
      const kind = snapshotFieldKind(raw);
      // Only the selected option represents a radio group.
      if (kind === 'radio' && !raw.checked) return;

      const reason = snapshotExclusionReason(raw);
      if (reason === 'unsupported') return;
      if (reason) {
        skippedCount += 1;
        return;
      }

      const matcher = buildSnapshotMatcher(raw);
      const hasIdentifier = Boolean(
        matcher.domId || matcher.name || matcher.label || matcher.placeholder || matcher.autocomplete
      );
      const value =
        kind === 'select' && raw.multiple
          ? (Array.isArray(raw.value) ? raw.value : []).map(String)
          : kind === 'checkbox'
            ? ''
            : String(raw.value ?? '');
      const field = {
        id: `f${fields.length + 1}`,
        kind,
        label: snapshotFieldLabel(raw),
        value,
        checked: kind === 'checkbox' || kind === 'radio' ? Boolean(raw.checked) : null,
        options:
          kind === 'select' && Array.isArray(raw.options)
            ? raw.options.slice(0, 100)
            : null,
        multiple: kind === 'select' ? Boolean(raw.multiple) : false,
        matcher,
      };
      // Empty and unidentifiable fields are kept visible in the editor but
      // start excluded; include them after adding a value or re-scanning.
      field.excluded = !hasIdentifier || !snapshotFieldHasValue(field);
      fields.push(field);
    });

    return { fields, skippedCount };
  }

  function buildRefillPlan(snapshotFields, pageFields) {
    const used = new Set();
    const steps = [];
    const missing = [];

    (Array.isArray(snapshotFields) ? snapshotFields : []).forEach((field) => {
      if (!field || field.excluded || !field.matcher) return;

      let bestIndex = -1;
      let bestScore = 0;
      pageFields.forEach((candidate, index) => {
        if (used.has(index)) return;
        // Refill is bound by the same rules as capture, so a stale or edited
        // snapshot can never write into credential or payment fields.
        if (snapshotExclusionReason(candidate)) return;
        const score = matcherScore(field.matcher, candidate);
        if (score > bestScore) {
          bestScore = score;
          bestIndex = index;
        }
      });

      if (bestIndex === -1) {
        missing.push(field.id);
        return;
      }

      used.add(bestIndex);
      steps.push({
        index: bestIndex,
        fieldId: field.id,
        kind: field.kind,
        value: field.value,
        checked: field.checked,
      });
    });

    return { steps, missing };
  }

  function pseudoFieldFromMatcher(matcher) {
    return {
      tag: matcher.tag,
      type: matcher.type,
      id: matcher.domId,
      name: matcher.name,
      placeholder: matcher.placeholder,
      autocomplete: matcher.autocomplete,
      labelText: matcher.label,
      value: matcher.radioValue,
    };
  }

  // Re-scan merge: hand-entered values win, empty fields adopt the page's
  // value, radios follow the page's current selection, and fields the first
  // capture missed are appended.
  function mergeSnapshotFields(existingFields, rawCapturedFields) {
    const { fields: captured } = buildSnapshotFields(rawCapturedFields);
    const merged = (Array.isArray(existingFields) ? existingFields : []).map((field) => ({
      ...field,
    }));
    let nextId =
      merged.reduce((max, field) => {
        const numeric = Number(String(field.id).replace(/^f/, ''));
        return Number.isFinite(numeric) ? Math.max(max, numeric) : max;
      }, 0) + 1;
    let addedCount = 0;
    let updatedCount = 0;

    captured.forEach((capturedField) => {
      let existing = null;
      if (capturedField.kind === 'radio' && capturedField.matcher.name) {
        // A radio group is one logical field: same name, possibly a new selection.
        existing = merged.find(
          (field) =>
            field.kind === 'radio' &&
            field.matcher?.tag === capturedField.matcher.tag &&
            field.matcher?.name === capturedField.matcher.name
        );
        if (existing && existing.matcher.radioValue !== capturedField.matcher.radioValue) {
          existing.matcher = capturedField.matcher;
          existing.value = capturedField.value;
          existing.label = capturedField.label;
          updatedCount += 1;
        }
      } else {
        existing = merged.find(
          (field) =>
            field.matcher && matcherScore(field.matcher, pseudoFieldFromMatcher(capturedField.matcher))
        );
      }

      if (!existing) {
        merged.push({ ...capturedField, id: `f${nextId}` });
        nextId += 1;
        addedCount += 1;
        return;
      }

      if (!snapshotFieldHasValue(existing) && snapshotFieldHasValue(capturedField)) {
        existing.value = capturedField.value;
        existing.excluded = capturedField.excluded;
        updatedCount += 1;
      }
      if (!existing.options && capturedField.options) existing.options = capturedField.options;
    });

    return { fields: merged, addedCount, updatedCount };
  }

  function describeRefillResult(filledCount, totalCount) {
    if (!totalCount) return 'This snapshot has no included fields to refill';
    if (!filledCount) return 'No matching fields found on this page';
    const noun = filledCount === 1 ? 'field' : 'fields';
    if (filledCount >= totalCount) return `Refilled ${filledCount} ${noun}`;
    const missingCount = totalCount - filledCount;
    return `Refilled ${filledCount} of ${totalCount} fields — ${missingCount} not found on this page`;
  }

  function deriveSnapshotName(pathname) {
    const lastSegment = String(pathname || '')
      .split('/')
      .filter(Boolean)
      .at(-1) || '';
    const cleaned = normalizeWhitespace(
      lastSegment.replace(/\.[a-z0-9]+$/i, '').replace(/[-_]+/g, ' ')
    );
    if (!cleaned) return 'Form snapshot';
    return `${cleaned.charAt(0).toUpperCase()}${cleaned.slice(1)} form`;
  }

  function normalizeStoredState(value) {
    const state = value && typeof value === 'object' ? value : {};
    return {
      users: Array.isArray(state.users) ? state.users : [],
      snapshots: Array.isArray(state.snapshots) ? state.snapshots : [],
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
    buildAdapterRequest,
    buildFillPlan,
    buildGeneratedIdentity,
    buildRefillPlan,
    buildSnapshotFields,
    classifyFillField,
    derivePageName,
    deriveSnapshotName,
    describeFillPlan,
    describeRefillResult,
    mergeSnapshotFields,
    snapshotExclusionReason,
    generateEmail,
    generatePassword,
    sanitizePasswordSymbols,
    getEnvironment,
    getSiteIdentity,
    isLocalHostname,
    normalizeAdapterCapabilities,
    normalizeAdapterResult,
    normalizeAdapterUrl,
    normalizeStoredState,
    normalizeWhitespace,
    slugify,
    splitPersonName,
  };
});
