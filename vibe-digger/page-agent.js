// Vibe Digger page-world agent.
//
// Runs in the page's MAIN world so it can reach React fiber internals and
// install a React-DevTools-compatible hook before React boots (on localhost it
// is registered as a document_start content script for exactly that reason).
// It talks to the extension's content script over window.postMessage.
(function () {
  if (window.__vibeDiggerAgentInstalled) return;
  window.__vibeDiggerAgentInstalled = true;

  const AGENT_SOURCE = 'vibe-digger-agent';
  const CONTROL_SOURCE = 'vibe-digger-control';

  const MAX_ISSUES = 200;
  const MAX_NETWORK_ENTRIES = 300;
  const MAX_WS_FRAMES = 60;
  const MAX_FLASHES_PER_COMMIT = 40;
  const MAX_FIBERS_PER_COMMIT = 4000;
  const COMMIT_THROTTLE_MS = 50;

  // React fiber tags we treat as user components.
  const FunctionComponent = 0;
  const ClassComponent = 1;
  const HostComponent = 5;
  const HostText = 6;
  const ForwardRef = 11;
  const MemoComponent = 14;
  const SimpleMemoComponent = 15;
  const PerformedWork = 0b01;

  const state = {
    heatmapEnabled: false,
    hookMode: 'none', // 'shim' | 'wrapped' | 'none'
    reactDetected: false,
    commitCount: 0,
    lastCommitProcessedAt: 0,
    issues: [],
    issueSeq: 0,
    network: [],
    networkSeq: 0,
    renderCounts: new Map(), // component name -> cumulative render count
  };

  // ---------------------------------------------------------------------------
  // Messaging
  // ---------------------------------------------------------------------------

  function post(kind, details = {}) {
    try {
      window.postMessage({ source: AGENT_SOURCE, kind, at: Date.now(), details }, '*');
    } catch {
      // Debug instrumentation must never break the page.
    }
  }

  // ---------------------------------------------------------------------------
  // Value sanitization (bounded, secret-aware) for anything leaving the page
  // ---------------------------------------------------------------------------

  function truncate(value, maxLength = 200) {
    const text = String(value ?? '');
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
      if (/bearer\s+[a-z0-9._-]+/i.test(value)) return '[redacted bearer token]';
      return truncate(value, 300);
    }
    if (valueType === 'number' || valueType === 'boolean') return value;
    if (valueType === 'function') return `[function ${value.name || 'anonymous'}]`;
    if (valueType === 'symbol') return String(value);
    if (valueType !== 'object') return String(value);

    if (seen.has(value)) return '[circular]';
    if (depth >= 3) return '[max-depth]';
    seen.add(value);

    if (value instanceof Element) {
      return `[element <${value.tagName.toLowerCase()}>]`;
    }
    if (Array.isArray(value)) {
      const items = value.slice(0, 10).map((item) => sanitizeValue(item, depth + 1, seen));
      if (value.length > 10) items.push(`[+${value.length - 10} more]`);
      return items;
    }

    // React elements serialize noisily; summarize them instead.
    if (value.$$typeof) {
      const name =
        typeof value.type === 'string'
          ? value.type
          : value.type?.displayName || value.type?.name || 'element';
      return `[react <${name}>]`;
    }

    const result = {};
    let count = 0;
    for (const [nestedKey, nestedValue] of Object.entries(value)) {
      if (count >= 14) {
        result.__truncated__ = '[additional keys omitted]';
        break;
      }
      result[nestedKey] = sanitizeValue(nestedValue, depth + 1, seen, nestedKey);
      count += 1;
    }
    return result;
  }

  // ---------------------------------------------------------------------------
  // Issue digger: console, uncaught errors, rejections, failed requests
  // ---------------------------------------------------------------------------

  function formatConsoleArg(arg) {
    if (typeof arg === 'string') return arg;
    if (arg instanceof Error) return arg.stack || arg.message;
    try {
      return JSON.stringify(sanitizeValue(arg));
    } catch {
      return String(arg);
    }
  }

  function addIssue(kind, message, detail = '') {
    const boundedMessage = truncate(message, 500);
    const existing = state.issues.find(
      (issue) => issue.kind === kind && issue.message === boundedMessage
    );
    if (existing) {
      existing.count += 1;
      existing.lastAt = Date.now();
      post('issue', { issue: existing, total: state.issues.length });
      return;
    }

    const issue = {
      id: `issue-${++state.issueSeq}`,
      kind,
      message: boundedMessage,
      detail: truncate(detail, 2000),
      count: 1,
      firstAt: Date.now(),
      lastAt: Date.now(),
    };
    state.issues.push(issue);
    if (state.issues.length > MAX_ISSUES) state.issues.shift();
    post('issue', { issue, total: state.issues.length });
  }

  function installConsoleCapture() {
    const originalError = console.error;
    const originalWarn = console.warn;

    console.error = function vibeDiggerError(...args) {
      try {
        const message = args.map(formatConsoleArg).join(' ');
        const kind = /^Warning:/.test(String(args[0])) ? 'react-warning' : 'console-error';
        addIssue(kind, message.split('\n')[0], message);
      } catch {
        // Never let capture break logging.
      }
      return originalError.apply(this, args);
    };

    console.warn = function vibeDiggerWarn(...args) {
      try {
        const message = args.map(formatConsoleArg).join(' ');
        addIssue('console-warn', message.split('\n')[0], message);
      } catch {
        // Never let capture break logging.
      }
      return originalWarn.apply(this, args);
    };
  }

  function installErrorCapture() {
    window.addEventListener(
      'error',
      (event) => {
        // Resource load errors (img, script) surface here with no message.
        if (!event.message) return;
        const where = event.filename ? `${event.filename}:${event.lineno}:${event.colno}` : '';
        addIssue('uncaught-error', event.message, `${where}\n${event.error?.stack || ''}`.trim());
      },
      true
    );

    window.addEventListener('unhandledrejection', (event) => {
      const reason = event.reason;
      const message = reason?.message || String(reason);
      addIssue('unhandled-rejection', message, reason?.stack || '');
    });
  }

  // ---------------------------------------------------------------------------
  // Network lifecycle: record every fetch/XHR/beacon in page order, with
  // request and response bodies (bounded, redacted) and the initiator stack —
  // the ground-truth story of what the page actually sent and received.
  // ---------------------------------------------------------------------------

  function captureInitiator() {
    const stack = new Error().stack || '';
    return stack
      .split('\n')
      .slice(1)
      .filter((line) => !/vibeDigger|captureInitiator/.test(line))
      .slice(0, 6)
      .map((line) => line.trim())
      .join('\n');
  }

  function redactBodyText(text) {
    if (text == null) return null;
    let bounded = String(text);
    if (bounded.length > 3000) {
      bounded = `${bounded.slice(0, 3000)}\n…[truncated ${text.length} chars total]`;
    }
    bounded = bounded.replace(/bearer\s+[a-z0-9._-]+/gi, '[redacted bearer token]');
    try {
      const parsed = JSON.parse(bounded);
      return JSON.stringify(sanitizeValue(parsed), null, 1);
    } catch {
      return bounded;
    }
  }

  function describeRequestBody(body) {
    if (body == null) return null;
    if (typeof body === 'string') return redactBodyText(body);
    if (body instanceof URLSearchParams) return redactBodyText(body.toString());
    if (typeof FormData === 'function' && body instanceof FormData) {
      const parts = [];
      for (const [key, value] of body.entries()) {
        if (parts.length >= 20) {
          parts.push('…[more fields omitted]');
          break;
        }
        const shown =
          shouldRedactKey(key) ? '[redacted]'
          : typeof value === 'string' ? truncate(value, 200)
          : `[file ${value?.name || ''} ${value?.size ?? '?'} bytes]`;
        parts.push(`${key}=${shown}`);
      }
      return `[FormData] ${parts.join('&')}`;
    }
    if (body instanceof Blob) return `[blob ${body.size} bytes, ${body.type || 'unknown type'}]`;
    if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
      return `[binary ${body.byteLength} bytes]`;
    }
    return `[${Object.prototype.toString.call(body)}]`;
  }

  function recordRequest(entry) {
    entry.id = `req-${++state.networkSeq}`;
    entry.seq = state.networkSeq;
    entry.startedAt = Date.now();
    entry.sinceLoadMs = Math.round(performance.now());
    entry.status = null;
    entry.durationMs = null;
    state.network.push(entry);
    if (state.network.length > MAX_NETWORK_ENTRIES) state.network.shift();
    post('network', { entry, total: state.network.length });
    return entry;
  }

  function settleRequest(entry, patch) {
    Object.assign(entry, patch);
    post('network', { entry, total: state.network.length });
    if (typeof entry.status === 'number' && entry.status >= 400) {
      addIssue('network', `${entry.method} ${entry.url} -> ${entry.status}`);
    } else if (entry.error) {
      addIssue('network', `${entry.method} ${entry.url} failed: ${entry.error}`);
    }
  }

  function isTextLike(contentType) {
    return /json|text|xml|urlencoded|graphql/i.test(contentType || '');
  }

  // WebSockets are streams, not request/response pairs, so each socket becomes
  // ONE network entry whose frame log grows over time: → sent, ← received,
  // then the close code. Frame posts are throttled so chatty sockets don't
  // flood the panel.
  function installWebSocketCapture() {
    if (typeof window.WebSocket !== 'function') return;

    const OriginalWebSocket = window.WebSocket;
    const entriesBySocket = new WeakMap();
    const postScheduled = new WeakSet();

    function redactFrame(data) {
      if (typeof data === 'string') {
        let text = data.length > 800 ? `${data.slice(0, 800)}…[${data.length} chars total]` : data;
        text = text.replace(/bearer\s+[a-z0-9._-]+/gi, '[redacted bearer token]');
        try {
          return JSON.stringify(sanitizeValue(JSON.parse(text)));
        } catch {
          return text;
        }
      }
      if (typeof Blob === 'function' && data instanceof Blob) return `[blob ${data.size} bytes]`;
      if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
        return `[binary ${data.byteLength} bytes]`;
      }
      return '[unknown frame]';
    }

    function schedulePost(entry) {
      if (postScheduled.has(entry)) return;
      postScheduled.add(entry);
      setTimeout(() => {
        postScheduled.delete(entry);
        post('network', { entry, total: state.network.length });
      }, 250);
    }

    function recordFrame(entry, dir, data) {
      entry.frameCount = (entry.frameCount || 0) + 1;
      entry.frames.push({ dir, at: Math.round(performance.now() - entry.sinceLoadMs), data: redactFrame(data) });
      if (entry.frames.length > MAX_WS_FRAMES) {
        entry.frames.shift();
        entry.droppedFrames = (entry.droppedFrames || 0) + 1;
      }
      schedulePost(entry);
    }

    function watchSocket(ws, entry) {
      const startedAt = performance.now();
      entriesBySocket.set(ws, entry);
      ws.addEventListener('open', () => {
        entry.wsState = 'open';
        post('network', { entry, total: state.network.length });
      });
      ws.addEventListener('message', (event) => recordFrame(entry, 'recv', event.data));
      ws.addEventListener('error', () => {
        entry.error = 'socket error';
      });
      ws.addEventListener('close', (event) => {
        entry.wsState = 'closed';
        entry.closeCode = event.code;
        entry.closeReason = truncate(event.reason || '', 120);
        entry.ok = !!event.wasClean && !entry.error;
        entry.durationMs = Math.round(performance.now() - startedAt);
        post('network', { entry, total: state.network.length });
        if (!entry.ok) {
          addIssue(
            'network',
            `WS ${entry.url} closed uncleanly (${event.code}${entry.closeReason ? ` ${entry.closeReason}` : ''})`
          );
        }
      });
    }

    function ensureEntry(ws) {
      let entry = entriesBySocket.get(ws);
      if (!entry) {
        // Socket created before the agent installed; adopt it on first send.
        entry = recordRequest({
          kind: 'ws',
          method: 'WS',
          url: truncate(String(ws.url || '[unknown ws URL]'), 500),
          wsState: ws.readyState === OriginalWebSocket.OPEN ? 'open' : 'connecting',
          frames: [],
          frameCount: 0,
          initiator: '[socket opened before capture started]',
        });
        watchSocket(ws, entry);
      }
      return entry;
    }

    window.WebSocket = function WebSocket(url, protocols) {
      const ws =
        protocols !== undefined
          ? new OriginalWebSocket(url, protocols)
          : new OriginalWebSocket(url);
      const entry = recordRequest({
        kind: 'ws',
        method: 'WS',
        url: truncate(String(ws.url || url), 500),
        wsState: 'connecting',
        frames: [],
        frameCount: 0,
        initiator: captureInitiator(),
      });
      watchSocket(ws, entry);
      return ws;
    };
    window.WebSocket.prototype = OriginalWebSocket.prototype;
    for (const key of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) {
      window.WebSocket[key] = OriginalWebSocket[key];
    }

    const originalSend = OriginalWebSocket.prototype.send;
    OriginalWebSocket.prototype.send = function vibeDiggerWsSend(data) {
      try {
        recordFrame(ensureEntry(this), 'send', data);
      } catch {
        // Capture must never block the socket.
      }
      return originalSend.apply(this, arguments);
    };
  }

  function installNetworkCapture() {
    if (typeof window.fetch === 'function') {
      const originalFetch = window.fetch;
      window.fetch = function vibeDiggerFetch(input, init) {
        let url = '';
        let method = init?.method || 'GET';
        try {
          if (typeof input === 'string' || input instanceof URL) url = String(input);
          else if (input && typeof input === 'object') {
            url = String(input.url || '');
            method = init?.method || input.method || method;
          }
        } catch {
          url = '[unknown fetch URL]';
        }

        const entry = recordRequest({
          kind: 'fetch',
          method: String(method).toUpperCase(),
          url: truncate(url, 500),
          requestBody: describeRequestBody(init?.body),
          initiator: captureInitiator(),
        });

        // A Request object carries its body as a stream; read a clone so the
        // page's copy stays consumable.
        if (entry.requestBody == null && typeof Request === 'function' && input instanceof Request) {
          try {
            input.clone().text().then((text) => {
              if (text) entry.requestBody = redactBodyText(text);
            }).catch(() => {});
          } catch {
            // Body already used or unreadable; leave it null.
          }
        }

        const startedAt = performance.now();
        return originalFetch.apply(this, arguments).then(
          (response) => {
            const patch = {
              status: response?.status ?? null,
              ok: response?.ok ?? null,
              durationMs: Math.round(performance.now() - startedAt),
            };
            const contentType = response?.headers?.get?.('content-type');
            if (response && isTextLike(contentType)) {
              try {
                response.clone().text().then((text) => {
                  settleRequest(entry, { ...patch, responseBody: redactBodyText(text) });
                }).catch(() => settleRequest(entry, patch));
              } catch {
                settleRequest(entry, patch);
              }
            } else {
              settleRequest(entry, {
                ...patch,
                responseBody: contentType ? `[${contentType.split(';')[0]} body not captured]` : null,
              });
            }
            return response;
          },
          (error) => {
            settleRequest(entry, {
              error: error?.message || String(error),
              durationMs: Math.round(performance.now() - startedAt),
            });
            throw error;
          }
        );
      };
    }

    if (typeof window.XMLHttpRequest === 'function') {
      const originalOpen = XMLHttpRequest.prototype.open;
      const originalSend = XMLHttpRequest.prototype.send;

      XMLHttpRequest.prototype.open = function vibeDiggerXhrOpen(method, url) {
        this.__vibeDiggerXhr = {
          method: String(method || 'GET').toUpperCase(),
          url: truncate(url || '', 500),
        };
        return originalOpen.apply(this, arguments);
      };

      XMLHttpRequest.prototype.send = function vibeDiggerXhrSend(body) {
        const info = this.__vibeDiggerXhr;
        if (info) {
          const entry = recordRequest({
            kind: 'xhr',
            method: info.method,
            url: info.url,
            requestBody: describeRequestBody(body),
            initiator: captureInitiator(),
          });
          const startedAt = performance.now();
          this.addEventListener(
            'loadend',
            () => {
              let responseBody = null;
              try {
                const contentType = this.getResponseHeader('content-type');
                if (isTextLike(contentType)) {
                  if (this.responseType === '' || this.responseType === 'text') {
                    responseBody = redactBodyText(this.responseText);
                  } else if (this.responseType === 'json') {
                    responseBody = redactBodyText(JSON.stringify(this.response));
                  }
                }
              } catch {
                // Response body unreadable; keep the status line.
              }
              settleRequest(entry, {
                status: this.status || null,
                ok: this.status > 0 && this.status < 400,
                error: this.status === 0 ? 'request failed (status 0)' : null,
                durationMs: Math.round(performance.now() - startedAt),
                responseBody,
              });
            },
            { once: true }
          );
        }
        return originalSend.apply(this, arguments);
      };
    }

    installWebSocketCapture();

    if (typeof navigator.sendBeacon === 'function') {
      const originalBeacon = navigator.sendBeacon.bind(navigator);
      navigator.sendBeacon = function vibeDiggerBeacon(url, data) {
        const entry = recordRequest({
          kind: 'beacon',
          method: 'POST',
          url: truncate(String(url || ''), 500),
          requestBody: describeRequestBody(data),
          initiator: captureInitiator(),
        });
        const queued = originalBeacon(url, data);
        settleRequest(entry, { status: null, ok: queued, durationMs: 0 });
        return queued;
      };
    }
  }

  // ---------------------------------------------------------------------------
  // React DevTools hook: install a shim before React boots, or wrap an
  // existing hook (e.g. the real React DevTools) if one beat us to it.
  // ---------------------------------------------------------------------------

  function installHook() {
    const existing = window.__REACT_DEVTOOLS_GLOBAL_HOOK__;

    if (existing && typeof existing === 'object') {
      if (existing.renderers && existing.renderers.size > 0) state.reactDetected = true;

      const previousInject = existing.inject;
      if (typeof previousInject === 'function') {
        existing.inject = function vibeDiggerInject(renderer) {
          state.reactDetected = true;
          return previousInject.apply(this, arguments);
        };
      }

      const previousCommit = existing.onCommitFiberRoot;
      existing.onCommitFiberRoot = function vibeDiggerOnCommit(rendererId, root) {
        try {
          handleCommit(root);
        } catch {
          // Heatmap failures must never break the host hook.
        }
        return typeof previousCommit === 'function'
          ? previousCommit.apply(this, arguments)
          : undefined;
      };

      state.hookMode = 'wrapped';
      return;
    }

    let nextRendererId = 0;
    const fiberRootsByRenderer = new Map();
    const hook = {
      renderers: new Map(),
      supportsFiber: true,
      supportsFlight: false,
      isDisabled: false,
      checkDCE() {},
      inject(renderer) {
        nextRendererId += 1;
        hook.renderers.set(nextRendererId, renderer);
        state.reactDetected = true;
        return nextRendererId;
      },
      on() {},
      off() {},
      sub() {
        return function unsubscribe() {};
      },
      emit() {},
      getFiberRoots(rendererId) {
        let roots = fiberRootsByRenderer.get(rendererId);
        if (!roots) {
          roots = new Set();
          fiberRootsByRenderer.set(rendererId, roots);
        }
        return roots;
      },
      onScheduleFiberRoot() {},
      onCommitFiberRoot(rendererId, root) {
        try {
          hook.getFiberRoots(rendererId).add(root);
          handleCommit(root);
        } catch {
          // Heatmap failures must never break React's commit.
        }
      },
      onCommitFiberUnmount() {},
      onPostCommitFiberRoot() {},
      setStrictMode() {},
    };

    window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = hook;
    state.hookMode = 'shim';
  }

  // ---------------------------------------------------------------------------
  // Re-render heatmap: walk the committed fiber tree for components that
  // performed work, resolve their host DOM rects, and hand them to the overlay.
  // ---------------------------------------------------------------------------

  function getFiberName(fiber) {
    const type = fiber.type || fiber.elementType;
    if (!type) return null;
    if (typeof type === 'function') return type.displayName || type.name || 'Anonymous';
    if (typeof type === 'object') {
      // memo(Component) / forwardRef(render)
      const inner = type.type || type.render;
      if (inner) return inner.displayName || inner.name || 'Anonymous';
      return type.displayName || 'Anonymous';
    }
    return null;
  }

  function isComponentFiber(fiber) {
    return (
      fiber.tag === FunctionComponent ||
      fiber.tag === ClassComponent ||
      fiber.tag === ForwardRef ||
      fiber.tag === MemoComponent ||
      fiber.tag === SimpleMemoComponent
    );
  }

  function findHostNode(fiber) {
    let node = fiber;
    let guard = 0;
    while (node && guard < 200) {
      if (node.tag === HostComponent || node.tag === HostText) return node.stateNode;
      node = node.child;
      guard += 1;
    }
    return null;
  }

  function handleCommit(root) {
    state.commitCount += 1;
    if (!state.heatmapEnabled || !root?.current) return;

    const now = performance.now();
    if (now - state.lastCommitProcessedAt < COMMIT_THROTTLE_MS) return;
    state.lastCommitProcessedAt = now;

    const entriesByNode = new Map();
    let visited = 0;
    let fiber = root.current.child;

    // Iterative child/sibling walk; recursion depth is unbounded on big trees.
    while (fiber && visited < MAX_FIBERS_PER_COMMIT) {
      visited += 1;

      if (isComponentFiber(fiber)) {
        const flags = fiber.flags !== undefined ? fiber.flags : fiber.effectTag;
        if ((flags & PerformedWork) !== 0) {
          const name = getFiberName(fiber) || 'Anonymous';
          const count = (state.renderCounts.get(name) || 0) + 1;
          state.renderCounts.set(name, count);

          if (entriesByNode.size < MAX_FLASHES_PER_COMMIT) {
            const hostNode = findHostNode(fiber);
            if (hostNode instanceof Element) {
              const rect = hostNode.getBoundingClientRect();
              if (rect.width > 0 && rect.height > 0 && !entriesByNode.has(hostNode)) {
                entriesByNode.set(hostNode, {
                  name,
                  count,
                  x: rect.left,
                  y: rect.top,
                  w: rect.width,
                  h: rect.height,
                });
              }
            }
          }
        }
      }

      if (fiber.child) {
        fiber = fiber.child;
        continue;
      }
      while (fiber && !fiber.sibling && fiber.return !== root.current && fiber.return) {
        fiber = fiber.return;
      }
      fiber = fiber && fiber.sibling ? fiber.sibling : null;
    }

    const entries = Array.from(entriesByNode.values());
    if (entries.length > 0) {
      post('renders', { entries, commit: state.commitCount });
    }
  }

  // ---------------------------------------------------------------------------
  // Inspector: from a viewport point to a fiber's chain, props, and hooks
  // ---------------------------------------------------------------------------

  function getFiberFromElement(element) {
    let current = element;
    let guard = 0;
    while (current && guard < 12) {
      const fiberKey = Object.keys(current).find(
        (key) => key.startsWith('__reactFiber$') || key.startsWith('__reactInternalInstance$')
      );
      if (fiberKey) return current[fiberKey];
      current = current.parentElement;
      guard += 1;
    }
    return null;
  }

  function describeHooks(fiber) {
    if (
      fiber.tag !== FunctionComponent &&
      fiber.tag !== ForwardRef &&
      fiber.tag !== SimpleMemoComponent
    ) {
      return null;
    }

    const hooks = [];
    let hook = fiber.memoizedState;
    let index = 0;
    while (hook && typeof hook === 'object' && index < 25) {
      const value = hook.memoizedState;
      let entry;
      if (hook.queue) {
        entry = { type: 'state', value: sanitizeValue(value) };
      } else if (value && typeof value === 'object') {
        if ('current' in value && Object.keys(value).length === 1) {
          entry = { type: 'ref', value: sanitizeValue(value.current) };
        } else if (Array.isArray(value) && value.length === 2 && Array.isArray(value[1])) {
          entry = { type: 'memo', value: sanitizeValue(value[0]) };
        } else if (typeof value.create === 'function') {
          entry = { type: 'effect', value: '[effect]' };
        } else {
          entry = { type: 'hook', value: sanitizeValue(value) };
        }
      } else {
        entry = { type: 'hook', value: sanitizeValue(value) };
      }
      hooks.push({ index, ...entry });
      hook = hook.next;
      index += 1;
    }
    return hooks.length > 0 ? hooks : null;
  }

  function buildComponentChain(startFiber) {
    const chain = [];
    let fiber = startFiber;
    let guard = 0;
    while (fiber && guard < 60 && chain.length < 12) {
      if (isComponentFiber(fiber)) {
        const name = getFiberName(fiber);
        if (name) {
          chain.push({
            name,
            key: fiber.key != null ? String(fiber.key) : null,
            propKeys: fiber.memoizedProps
              ? Object.keys(fiber.memoizedProps).slice(0, 10)
              : [],
          });
        }
      }
      fiber = fiber.return;
      guard += 1;
    }
    return chain;
  }

  function describeDomNode(element) {
    const tag = element.tagName.toLowerCase();
    const id = element.id ? `#${element.id}` : '';
    const classes = element.classList
      ? Array.from(element.classList).slice(0, 3).map((c) => `.${c}`).join('')
      : '';
    return {
      summary: `${tag}${id}${classes}`,
      text: truncate(element.textContent?.trim() || '', 120),
    };
  }

  function findSource(fiber) {
    let current = fiber;
    let guard = 0;
    while (current && guard < 20) {
      const source = current._debugSource;
      if (source?.fileName) {
        const fileName = String(source.fileName).split('/').slice(-2).join('/');
        return `${fileName}:${source.lineNumber || '?'}`;
      }
      current = current.return;
      guard += 1;
    }
    return null;
  }

  function inspectAt(x, y, pin) {
    const element = document.elementFromPoint(x, y);
    if (!(element instanceof Element)) {
      post('inspect-result', { pin, found: false });
      return;
    }

    const fiber = getFiberFromElement(element);
    const rect = element.getBoundingClientRect();
    const dom = describeDomNode(element);

    if (!fiber) {
      post('inspect-result', {
        pin,
        found: true,
        react: false,
        dom,
        rect: { x: rect.left, y: rect.top, w: rect.width, h: rect.height },
      });
      return;
    }

    // Walk up to the nearest user component; that's what the user cares about.
    let componentFiber = fiber;
    let guard = 0;
    while (componentFiber && !isComponentFiber(componentFiber) && guard < 60) {
      componentFiber = componentFiber.return;
      guard += 1;
    }

    const chain = buildComponentChain(componentFiber || fiber);
    const details = {};
    if (componentFiber) {
      details.name = getFiberName(componentFiber) || 'Anonymous';
      details.props = sanitizeValue(componentFiber.memoizedProps || {});
      details.hooks = describeHooks(componentFiber);
      if (componentFiber.tag === ClassComponent && componentFiber.stateNode?.state) {
        details.classState = sanitizeValue(componentFiber.stateNode.state);
      }
      details.source = findSource(componentFiber);
      details.renderCount = state.renderCounts.get(details.name) || null;
    }

    post('inspect-result', {
      pin,
      found: true,
      react: true,
      dom,
      chain,
      details,
      rect: { x: rect.left, y: rect.top, w: rect.width, h: rect.height },
    });
  }

  // ---------------------------------------------------------------------------
  // Late React detection for pages where the hook missed the boot (non-local
  // sites where the agent is injected on demand).
  // ---------------------------------------------------------------------------

  function detectReactLate() {
    if (state.reactDetected) return;
    const candidates = document.querySelectorAll('body, body *');
    const limit = Math.min(candidates.length, 400);
    for (let i = 0; i < limit; i += 1) {
      const element = candidates[i];
      const hasFiberKey = Object.keys(element).some(
        (key) =>
          key.startsWith('__reactFiber$') ||
          key.startsWith('__reactContainer$') ||
          key.startsWith('__reactInternalInstance$')
      );
      if (hasFiberKey) {
        state.reactDetected = true;
        return;
      }
    }
  }

  function topRenderCounts(limit = 15) {
    return Array.from(state.renderCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([name, count]) => ({ name, count }));
  }

  function postStatus() {
    detectReactLate();
    post('status', {
      reactDetected: state.reactDetected,
      hookMode: state.hookMode,
      heatmapEnabled: state.heatmapEnabled,
      commitCount: state.commitCount,
      issueCount: state.issues.length,
      networkCount: state.network.length,
      renderCounts: topRenderCounts(),
    });
  }

  // ---------------------------------------------------------------------------
  // Control channel from the content script
  // ---------------------------------------------------------------------------

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== CONTROL_SOURCE) return;

    try {
      switch (data.command) {
        case 'hello':
          postStatus();
          break;
        case 'inspect-point':
          inspectAt(data.x, data.y, !!data.pin);
          break;
        case 'heatmap':
          state.heatmapEnabled = !!data.enabled;
          postStatus();
          break;
        case 'reset-render-counts':
          state.renderCounts.clear();
          postStatus();
          break;
        case 'get-issues':
          post('issues', { issues: state.issues.slice(), renderCounts: topRenderCounts() });
          break;
        case 'clear-issues':
          state.issues.length = 0;
          post('issues', { issues: [], renderCounts: topRenderCounts() });
          break;
        case 'get-network':
          post('network-list', { entries: state.network.slice() });
          break;
        case 'clear-network':
          state.network.length = 0;
          post('network-list', { entries: [] });
          break;
        default:
          break;
      }
    } catch {
      // Control handling is best-effort.
    }
  });

  installHook();
  installConsoleCapture();
  installErrorCapture();
  installNetworkCapture();
  post('agent-ready', { url: location.href, hookMode: state.hookMode });
})();
