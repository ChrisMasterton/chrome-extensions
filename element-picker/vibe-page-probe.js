// Vibe Debugger page-world probe.
(function() {
  if (window.__elementPickerVibeProbeInstalled) return;
  window.__elementPickerVibeProbeInstalled = true;

  const SOURCE = 'element-picker-vibe-probe';
  const CONTROL_SOURCE = 'element-picker-vibe-probe-control';
  const originals = {};
  const listeners = {};
  let nextId = 1;
  let lastRafPostAt = 0;

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
    if (typeof window.fetch !== 'function') return;
    originals.fetch = window.fetch;

    window.fetch = function patchedFetch(input, init) {
      const details = getFetchDetails(input, init);
      const requestId = `fetch-${nextId++}`;
      const startedAt = now();
      post('network.fetch.start', { requestId, ...details });

      return originals.fetch.apply(this, arguments)
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
    };
  }

  function patchXhr() {
    if (typeof window.XMLHttpRequest !== 'function') return;

    originals.xhrOpen = window.XMLHttpRequest.prototype.open;
    originals.xhrSend = window.XMLHttpRequest.prototype.send;

    window.XMLHttpRequest.prototype.open = function patchedOpen(method, url) {
      this.__elementPickerVibeXhr = {
        requestId: `xhr-${nextId++}`,
        method: String(method || 'GET').toUpperCase(),
        url: truncate(url || '', 500),
      };
      return originals.xhrOpen.apply(this, arguments);
    };

    window.XMLHttpRequest.prototype.send = function patchedSend() {
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

      return originals.xhrSend.apply(this, arguments);
    };
  }

  function patchHistory() {
    originals.pushState = history.pushState;
    originals.replaceState = history.replaceState;

    history.pushState = function patchedPushState() {
      const from = location.href;
      const result = originals.pushState.apply(this, arguments);
      post('route.pushState', { from, to: location.href });
      return result;
    };

    history.replaceState = function patchedReplaceState() {
      const from = location.href;
      const result = originals.replaceState.apply(this, arguments);
      post('route.replaceState', { from, to: location.href });
      return result;
    };

    listeners.popstate = () => post('route.popstate', { to: location.href });
    listeners.hashchange = () => post('route.hashchange', { to: location.href });
    window.addEventListener('popstate', listeners.popstate, true);
    window.addEventListener('hashchange', listeners.hashchange, true);
  }

  function patchTimers() {
    originals.setTimeout = window.setTimeout;
    originals.setInterval = window.setInterval;
    originals.requestAnimationFrame = window.requestAnimationFrame;

    window.setTimeout = function patchedSetTimeout(callback, delay) {
      const timerId = `timeout-${nextId++}`;
      const wrapped = typeof callback === 'function'
        ? function vibeTimeoutCallback() {
          post('timer.timeout.fire', { timerId, delay: Number(delay) || 0 });
          return callback.apply(this, arguments);
        }
        : callback;
      post('timer.timeout.schedule', { timerId, delay: Number(delay) || 0 });
      return originals.setTimeout.call(this, wrapped, delay);
    };

    window.setInterval = function patchedSetInterval(callback, delay) {
      const timerId = `interval-${nextId++}`;
      const wrapped = typeof callback === 'function'
        ? function vibeIntervalCallback() {
          post('timer.interval.fire', { timerId, delay: Number(delay) || 0 });
          return callback.apply(this, arguments);
        }
        : callback;
      post('timer.interval.schedule', { timerId, delay: Number(delay) || 0 });
      return originals.setInterval.call(this, wrapped, delay);
    };

    if (typeof window.requestAnimationFrame === 'function') {
      window.requestAnimationFrame = function patchedRaf(callback) {
        const rafId = `raf-${nextId++}`;
        return originals.requestAnimationFrame.call(this, function vibeRafCallback(timestamp) {
          const at = now();
          if (at - lastRafPostAt > 250) {
            lastRafPostAt = at;
            post('timer.raf.fire', { rafId, timestamp: Math.round(timestamp * 100) / 100 });
          }
          return callback(timestamp);
        });
      };
    }
  }

  function patchStorage() {
    originals.localStorageSetItem = Storage.prototype.setItem;
    originals.localStorageRemoveItem = Storage.prototype.removeItem;
    originals.localStorageClear = Storage.prototype.clear;

    Storage.prototype.setItem = function patchedSetItem(key, value) {
      post('storage.setItem', {
        storage: this === window.localStorage ? 'localStorage' : 'sessionStorage',
        key: shouldRedactKey(key) ? '[redacted]' : truncate(key, 160),
        value: shouldRedactKey(key) ? '[redacted]' : truncate(value, 240),
      });
      return originals.localStorageSetItem.apply(this, arguments);
    };

    Storage.prototype.removeItem = function patchedRemoveItem(key) {
      post('storage.removeItem', {
        storage: this === window.localStorage ? 'localStorage' : 'sessionStorage',
        key: shouldRedactKey(key) ? '[redacted]' : truncate(key, 160),
      });
      return originals.localStorageRemoveItem.apply(this, arguments);
    };

    Storage.prototype.clear = function patchedClear() {
      post('storage.clear', {
        storage: this === window.localStorage ? 'localStorage' : 'sessionStorage',
      });
      return originals.localStorageClear.apply(this, arguments);
    };
  }

  function patchConsole() {
    originals.consoleWarn = console.warn;
    originals.consoleError = console.error;

    console.warn = function patchedWarn() {
      post('console.warn', { args: Array.from(arguments).slice(0, 6).map((arg) => sanitizeValue(arg)) });
      return originals.consoleWarn.apply(this, arguments);
    };

    console.error = function patchedError() {
      post('console.error', { args: Array.from(arguments).slice(0, 6).map((arg) => sanitizeValue(arg)) });
      return originals.consoleError.apply(this, arguments);
    };
  }

  function installAppApi() {
    const existing = window.__VIBE_DEBUGGER__;
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

    if (existing && typeof existing === 'object') {
      window.__VIBE_DEBUGGER_PREVIOUS__ = existing;
    }
    window.__VIBE_DEBUGGER__ = api;
  }

  function restore() {
    if (originals.fetch) window.fetch = originals.fetch;
    if (originals.xhrOpen) window.XMLHttpRequest.prototype.open = originals.xhrOpen;
    if (originals.xhrSend) window.XMLHttpRequest.prototype.send = originals.xhrSend;
    if (originals.pushState) history.pushState = originals.pushState;
    if (originals.replaceState) history.replaceState = originals.replaceState;
    if (originals.setTimeout) window.setTimeout = originals.setTimeout;
    if (originals.setInterval) window.setInterval = originals.setInterval;
    if (originals.requestAnimationFrame) window.requestAnimationFrame = originals.requestAnimationFrame;
    if (originals.localStorageSetItem) Storage.prototype.setItem = originals.localStorageSetItem;
    if (originals.localStorageRemoveItem) Storage.prototype.removeItem = originals.localStorageRemoveItem;
    if (originals.localStorageClear) Storage.prototype.clear = originals.localStorageClear;
    if (originals.consoleWarn) console.warn = originals.consoleWarn;
    if (originals.consoleError) console.error = originals.consoleError;
    if (listeners.popstate) window.removeEventListener('popstate', listeners.popstate, true);
    if (listeners.hashchange) window.removeEventListener('hashchange', listeners.hashchange, true);
    if (listeners.message) window.removeEventListener('message', listeners.message);
    if (window.__VIBE_DEBUGGER_PREVIOUS__) {
      window.__VIBE_DEBUGGER__ = window.__VIBE_DEBUGGER_PREVIOUS__;
      delete window.__VIBE_DEBUGGER_PREVIOUS__;
    } else {
      delete window.__VIBE_DEBUGGER__;
    }
    window.__elementPickerVibeProbeInstalled = false;
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
  patchTimers();
  patchStorage();
  patchConsole();
  installAppApi();
  post('probe.started', { url: location.href });
})();
