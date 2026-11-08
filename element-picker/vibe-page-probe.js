// Vibe Debugger page-world probe.
(function() {
  if (window.__elementPickerVibeProbeInstalled) return;

  const SOURCE = 'element-picker-vibe-probe';
  const CONTROL_SOURCE = 'element-picker-vibe-probe-control';
  const owner = { active: true };
  const patches = [];
  const listeners = {};
  let nextId = 1;

  function installOwnedValue(target, key, value) {
    const descriptor = Object.getOwnPropertyDescriptor(target, key);
    target[key] = value;
    if (target[key] === value) patches.push({ target, key, value, descriptor });
  }

  function patchMethod(target, key, observe) {
    const original = target[key];
    if (typeof original !== 'function') return;
    const observed = observe(original);
    const wrapper = function () {
      // Other tools can retain this function inside their own wrappers. Once
      // stopped, forward directly without observing or adding promise callbacks.
      return (owner.active ? observed : original).apply(this, arguments);
    };
    installOwnedValue(target, key, wrapper);
  }

  installOwnedValue(window, '__elementPickerVibeProbeInstalled', owner);

  function now() {
    return Math.round(performance.now() * 100) / 100;
  }

  function truncate(value, maxLength = 180) {
    const text = String(value || '');
    if (text.length <= maxLength) return text;
    return `${text.slice(0, maxLength - 3)}...`;
  }

  function shouldRedactKey(key) {
    return /(password|passwd|secret|token|auth|cookie|session|credential|api[-_]?key)/i.test(String(key || ''));
  }

  function sanitizeValue(value, depth = 0, seen = new WeakSet(), key = '') {
    if (shouldRedactKey(key)) return '[redacted]';
    if (value === null || value === undefined) return value;

    const valueType = typeof value;
    if (valueType === 'string') {
      if (value.length > 1200) return `${value.slice(0, 240)}...[truncated ${value.length} chars]`;
      if (/bearer\s+[a-z0-9._-]+/i.test(value)) return '[redacted bearer token]';
      return truncate(value, 300);
    }
    if (valueType === 'number' || valueType === 'boolean') return value;
    if (valueType === 'function') return '[function]';
    if (valueType !== 'object') return String(value);

    if (seen.has(value)) return '[circular]';
    if (depth >= 2) return '[max-depth]';
    seen.add(value);

    if (Array.isArray(value)) {
      return value.slice(0, 8).map((item) => sanitizeValue(item, depth + 1, seen));
    }

    const result = {};
    let count = 0;
    for (const [nestedKey, nestedValue] of Object.entries(value)) {
      if (count >= 12) {
        result.__truncated__ = '[additional keys omitted]';
        break;
      }
      result[nestedKey] = sanitizeValue(nestedValue, depth + 1, seen, nestedKey);
      count += 1;
    }
    return result;
  }

  function getFetchDetails(input, init = {}) {
    let url = '';
    let method = init?.method || 'GET';

    try {
      if (typeof input === 'string' || input instanceof URL) {
        url = String(input);
      } else if (input && typeof input === 'object') {
        url = String(input.url || '');
        method = init?.method || input.method || method;
      }
    } catch {
      url = '[unknown fetch URL]';
    }

    return {
      url: truncate(url, 500),
      method: String(method || 'GET').toUpperCase(),
    };
  }

  function post(kind, details = {}) {
    if (!owner.active && kind !== 'probe.stopped') return;
    try {
      window.postMessage({
        source: SOURCE,
        eventId: `probe-${nextId++}`,
        kind,
        at: now(),
        details,
      }, '*');
    } catch {
      // Keep the probe best-effort. Debug instrumentation must not break the page.
    }
  }

  function patchFetch() {
    patchMethod(window, 'fetch', originalFetch => function patchedFetch(input, init) {
      const details = getFetchDetails(input, init);
      const requestId = `fetch-${nextId++}`;
      const startedAt = now();
      post('network.fetch.start', { requestId, ...details });

      return originalFetch.apply(this, arguments)
        .then((response) => {
          post('network.fetch.end', {
            requestId,
            ...details,
            url: truncate(response?.url || details.url, 500),
            status: response?.status || null,
            ok: response?.ok ?? null,
            durationMs: Math.round((now() - startedAt) * 100) / 100,
          });
          return response;
        })
        .catch((error) => {
          post('network.fetch.error', {
            requestId,
            ...details,
            error: error?.message || String(error),
            durationMs: Math.round((now() - startedAt) * 100) / 100,
          });
          throw error;
        });
    });
  }

  function patchXhr() {
    if (typeof window.XMLHttpRequest !== 'function') return;

    patchMethod(window.XMLHttpRequest.prototype, 'open', originalOpen => function patchedOpen(method, url) {
      this.__elementPickerVibeXhr = {
        requestId: `xhr-${nextId++}`,
        method: String(method || 'GET').toUpperCase(),
        url: truncate(url || '', 500),
      };
      return originalOpen.apply(this, arguments);
    });

    patchMethod(window.XMLHttpRequest.prototype, 'send', originalSend => function patchedSend() {
      const details = this.__elementPickerVibeXhr || {
        requestId: `xhr-${nextId++}`,
        method: 'GET',
        url: '[unknown xhr URL]',
      };
      const startedAt = now();
      post('network.xhr.start', details);

      const finish = (kind) => {
        post(kind, {
          ...details,
          status: this.status || null,
          durationMs: Math.round((now() - startedAt) * 100) / 100,
        });
      };

      this.addEventListener('loadend', () => finish('network.xhr.end'), { once: true });
      this.addEventListener('error', () => finish('network.xhr.error'), { once: true });
      this.addEventListener('abort', () => finish('network.xhr.abort'), { once: true });

      return originalSend.apply(this, arguments);
    });
  }

  function patchHistory() {
    patchMethod(history, 'pushState', originalPushState => function patchedPushState() {
      const from = location.href;
      const result = originalPushState.apply(this, arguments);
      post('route.pushState', { from, to: location.href });
      return result;
    });

    patchMethod(history, 'replaceState', originalReplaceState => function patchedReplaceState() {
      const from = location.href;
      const result = originalReplaceState.apply(this, arguments);
      post('route.replaceState', { from, to: location.href });
      return result;
    });

    listeners.popstate = () => post('route.popstate', { to: location.href });
    listeners.hashchange = () => post('route.hashchange', { to: location.href });
    window.addEventListener('popstate', listeners.popstate, true);
    window.addEventListener('hashchange', listeners.hashchange, true);
  }

  function patchStorage() {
    patchMethod(Storage.prototype, 'setItem', originalSetItem => function patchedSetItem(key, value) {
      post('storage.setItem', {
        storage: this === window.localStorage ? 'localStorage' : 'sessionStorage',
        key: shouldRedactKey(key) ? '[redacted]' : truncate(key, 160),
        value: shouldRedactKey(key) ? '[redacted]' : truncate(value, 240),
      });
      return originalSetItem.apply(this, arguments);
    });

    patchMethod(Storage.prototype, 'removeItem', originalRemoveItem => function patchedRemoveItem(key) {
      post('storage.removeItem', {
        storage: this === window.localStorage ? 'localStorage' : 'sessionStorage',
        key: shouldRedactKey(key) ? '[redacted]' : truncate(key, 160),
      });
      return originalRemoveItem.apply(this, arguments);
    });

    patchMethod(Storage.prototype, 'clear', originalClear => function patchedClear() {
      post('storage.clear', {
        storage: this === window.localStorage ? 'localStorage' : 'sessionStorage',
      });
      return originalClear.apply(this, arguments);
    });
  }

  function patchConsole() {
    patchMethod(console, 'warn', originalWarn => function patchedWarn() {
      post('console.warn', { args: Array.from(arguments).slice(0, 6).map((arg) => sanitizeValue(arg)) });
      return originalWarn.apply(this, arguments);
    });

    patchMethod(console, 'error', originalError => function patchedError() {
      post('console.error', { args: Array.from(arguments).slice(0, 6).map((arg) => sanitizeValue(arg)) });
      return originalError.apply(this, arguments);
    });
  }

  function installAppApi() {
    const api = {
      trace(name, payload) {
        post('app.trace', { name: truncate(name, 160), payload: sanitizeValue(payload) });
      },
      watch(name, value, options = {}) {
        post('app.watch', {
          name: truncate(name, 160),
          value: sanitizeValue(value),
          options: sanitizeValue(options),
        });
      },
      visibility(name, payload) {
        post('app.visibility', { name: truncate(name, 160), payload: sanitizeValue(payload) });
      },
      action(name, payload) {
        post('app.action', { name: truncate(name, 160), payload: sanitizeValue(payload) });
      },
    };

    installOwnedValue(window, '__VIBE_DEBUGGER__', api);
  }

  function restore() {
    if (!owner.active) return;
    owner.active = false;
    if (listeners.popstate) window.removeEventListener('popstate', listeners.popstate, true);
    if (listeners.hashchange) window.removeEventListener('hashchange', listeners.hashchange, true);
    if (listeners.message) window.removeEventListener('message', listeners.message);
    for (const { target, key, value, descriptor } of patches.reverse()) {
      if (target[key] !== value) continue;
      try {
        if (descriptor) Object.defineProperty(target, key, descriptor);
        else delete target[key];
      } catch {
        // A page can freeze an API after installation. The stopped wrapper is
        // still a pass-through even when its property can no longer be restored.
      }
    }
    post('probe.stopped', {});
  }

  listeners.message = (event) => {
    if (event.source !== window) return;
    if (event.data?.source !== CONTROL_SOURCE) return;
    if (event.data.command === 'stop') {
      restore();
    }
  };
  window.addEventListener('message', listeners.message);

  patchFetch();
  patchXhr();
  patchHistory();
  patchStorage();
  patchConsole();
  installAppApi();
  post('probe.started', { url: location.href });
})();
