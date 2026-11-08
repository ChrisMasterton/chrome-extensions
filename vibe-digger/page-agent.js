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
    commitCount: 0,
    lastCommitProcessedAt: 0,
    renderCounts: new Map(), // component name -> cumulative render count
  };

  // The page agent owns retained issues for this document. Every mutation
  // advances the revision; panels only project this collection.
  const issueCollection = { entries: [], nextId: 0, revision: 0 };
  // Membership is the authority for publication. Clear/eviction permanently
  // retire entries while their native requests and sockets can still finish.
  const networkCollection = { entries: new Map(), pending: new Set(), nextId: 0, revision: 0 };
  const reactAttachment = {
    phase: 'waiting', mode: 'none', reason: null, detected: false, rendererIds: new Set(),
  };
  let reactObserver = null;
  let reactDetectionTimer = null;
  let reactStatusTimer = null;

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
    transitionIssues({ type: 'observe', kind, message, detail });
  }

  function postIssues() {
    post('issues', {
      issues: issueCollection.entries.slice(),
      revision: issueCollection.revision,
      renderCounts: topRenderCounts(),
    });
  }

  function transitionIssues(event) {
    if (event.type === 'clear') {
      issueCollection.entries.length = 0;
      issueCollection.revision += 1;
      postIssues();
      return;
    }
    if (event.type !== 'observe') return;

    const boundedMessage = truncate(event.message, 500);
    const existing = issueCollection.entries.find(
      (issue) => issue.kind === event.kind && issue.message === boundedMessage
    );
    const removedIds = [];
    let issue;
    if (existing) {
      existing.count += 1;
      existing.lastAt = Date.now();
      issue = existing;
    } else {
      issue = {
        id: `issue-${++issueCollection.nextId}`,
        kind: event.kind,
        message: boundedMessage,
        detail: truncate(event.detail, 2000),
        count: 1,
        firstAt: Date.now(),
        lastAt: Date.now(),
      };
      issueCollection.entries.push(issue);
      if (issueCollection.entries.length > MAX_ISSUES) {
        removedIds.push(issueCollection.entries.shift().id);
      }
    }

    issueCollection.revision += 1;
    post('issue', { issue, removedIds, revision: issueCollection.revision, total: issueCollection.entries.length });
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

  function utf8ByteLength(value) {
    const text = String(value ?? '');
    if (typeof TextEncoder === 'function') return new TextEncoder().encode(text).byteLength;
    if (typeof Blob === 'function') return new Blob([text]).size;
    return text.length;
  }

  // Payload bytes only: request/response headers and transport framing are not
  // available consistently from page JavaScript.
  function bodyByteLength(body) {
    if (body == null) return 0;
    if (typeof body === 'string') return utf8ByteLength(body);
    if (body instanceof URLSearchParams) return utf8ByteLength(body.toString());
    if (typeof Blob === 'function' && body instanceof Blob) return body.size;
    if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return body.byteLength;
    return null;
  }

  function contentLengthBytes(headers) {
    const raw = headers?.get?.('content-length');
    if (raw == null || raw === '') return null;
    const bytes = Number(raw);
    return Number.isFinite(bytes) && bytes >= 0 ? bytes : null;
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
    entry.id = `req-${++networkCollection.nextId}`;
    entry.seq = networkCollection.nextId;
    entry.startedAt = Date.now();
    entry.sinceLoadMs = Math.round(performance.now());
    entry.status = null;
    entry.durationMs = null;
    if (entry.kind !== 'ws') entry.phase = 'pending';
    if (!Object.hasOwn(entry, 'requestSizeBytes')) entry.requestSizeBytes = 0;
    if (!Object.hasOwn(entry, 'responseSizeBytes')) entry.responseSizeBytes = null;
    networkCollection.entries.set(entry.id, entry);
    const removedIds = [];
    if (networkCollection.entries.size > MAX_NETWORK_ENTRIES) {
      const oldestId = networkCollection.entries.keys().next().value;
      networkCollection.pending.delete(networkCollection.entries.get(oldestId));
      networkCollection.entries.delete(oldestId);
      removedIds.push(oldestId);
    }
    publishNetwork(entry, removedIds);
    return entry;
  }

  function isRetainedRequest(entry) {
    return networkCollection.entries.get(entry.id) === entry;
  }

  function publishNetwork(entry, removedIds = []) {
    networkCollection.pending.delete(entry);
    if (!isRetainedRequest(entry)) return;
    networkCollection.revision += 1;
    post('network', { entry, removedIds, revision: networkCollection.revision, total: networkCollection.entries.size });
  }

  function postNetwork() {
    // Flush throttled socket frames so a snapshot never changes the contents
    // associated with an already-published revision.
    for (const entry of networkCollection.pending) publishNetwork(entry);
    post('network-list', { entries: [...networkCollection.entries.values()], revision: networkCollection.revision });
  }

  function clearNetwork() {
    networkCollection.pending.clear();
    networkCollection.entries.clear();
    networkCollection.revision += 1;
    postNetwork();
  }

  function updateRequestDetails(entry, patch) {
    if (!isRetainedRequest(entry)) return;
    Object.assign(entry, patch);
    publishNetwork(entry);
  }

  function settleRequest(entry, patch, phase = patch.error ? 'failed' : 'completed') {
    if (entry.phase !== 'pending') return;
    entry.phase = phase;
    Object.assign(entry, patch);
    publishNetwork(entry);
    // Issues observe new failures independently, even if the Network row was
    // retired before the failure became known.
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
    const postTimers = new WeakMap();

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
      if (!isRetainedRequest(entry) || postTimers.has(entry)) return;
      postTimers.set(entry, setTimeout(() => {
        postTimers.delete(entry);
        if (networkCollection.pending.has(entry)) publishNetwork(entry);
      }, 250));
    }

    function recordFrame(entry, dir, data) {
      if (!isRetainedRequest(entry) || entry.wsState === 'closed') return;
      const frameSize = bodyByteLength(data) ?? 0;
      entry.frameCount = (entry.frameCount || 0) + 1;
      if (dir === 'send') entry.requestSizeBytes += frameSize;
      else entry.responseSizeBytes += frameSize;
      entry.frames.push({
        dir,
        at: Math.round(performance.now() - entry.sinceLoadMs),
        sizeBytes: frameSize,
        data: redactFrame(data),
      });
      if (entry.frames.length > MAX_WS_FRAMES) {
        entry.frames.shift();
        entry.droppedFrames = (entry.droppedFrames || 0) + 1;
      }
      networkCollection.pending.add(entry);
      schedulePost(entry);
    }

    function transitionSocket(entry, event) {
      if (entry.wsState === 'closed') return;
      switch (event.type) {
        case 'frame':
          recordFrame(entry, event.direction, event.data);
          return;
        case 'open':
          if (entry.wsState !== 'connecting') return;
          entry.wsState = 'open';
          break;
        case 'closing':
          if (entry.wsState === 'closing') return;
          entry.wsState = 'closing';
          break;
        case 'error':
          entry.error = 'socket error';
          break;
        case 'close':
          clearTimeout(postTimers.get(entry));
          postTimers.delete(entry);
          entry.wsState = 'closed';
          entry.closeCode = event.code;
          entry.closeReason = truncate(event.reason || '', 120);
          entry.ok = !!event.wasClean && !entry.error;
          entry.durationMs = event.durationMs;
          if (!entry.ok) addIssue('network',
            `WS ${entry.url} closed uncleanly (${event.code}${entry.closeReason ? ` ${entry.closeReason}` : ''})`);
          break;
        default:
          return;
      }
      publishNetwork(entry);
    }

    function watchSocket(ws, entry) {
      const startedAt = performance.now();
      entriesBySocket.set(ws, entry);
      ws.addEventListener('open', () => transitionSocket(entry, { type: 'open' }));
      ws.addEventListener('message', event => transitionSocket(entry, { type: 'frame', direction: 'recv', data: event.data }));
      ws.addEventListener('error', () => transitionSocket(entry, { type: 'error' }));
      ws.addEventListener('close', event => transitionSocket(entry, { type: 'close',
        code: event.code, reason: event.reason, wasClean: event.wasClean,
        durationMs: Math.round(performance.now() - startedAt) }));
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
          requestSizeBytes: 0,
          responseSizeBytes: 0,
          initiator: '[socket opened before capture started]',
        });
        watchSocket(ws, entry);
      }
      return entry;
    }

    window.WebSocket = function WebSocket(url, protocols) {
      if (!new.target) return OriginalWebSocket.apply(this, arguments);
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
        requestSizeBytes: 0,
        responseSizeBytes: 0,
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
      const wasOpen = this.readyState === OriginalWebSocket.OPEN;
      const result = originalSend.apply(this, arguments);
      try {
        if (wasOpen) transitionSocket(ensureEntry(this), { type: 'frame', direction: 'send', data });
      } catch {
        // Capture must never block the socket.
      }
      return result;
    };
    const originalClose = OriginalWebSocket.prototype.close;
    OriginalWebSocket.prototype.close = function vibeDiggerWsClose() {
      const result = originalClose.apply(this, arguments);
      const entry = entriesBySocket.get(this);
      if (entry && this.readyState === OriginalWebSocket.CLOSING) transitionSocket(entry, { type: 'closing' });
      return result;
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

        const isRequestInput = typeof Request === 'function' && input instanceof Request;
        const requestBody = init?.body;
        const entry = recordRequest({
          kind: 'fetch',
          method: String(method).toUpperCase(),
          url: truncate(url, 500),
          requestBody: describeRequestBody(requestBody),
          requestSizeBytes:
            requestBody != null
              ? bodyByteLength(requestBody)
              : isRequestInput && input.body
                ? null
                : 0,
          initiator: captureInitiator(),
        });

        // A Request object carries its body as a stream; read a clone so the
        // page's copy stays consumable.
        if (entry.requestBody == null && isRequestInput) {
          try {
            input.clone().text().then((text) => {
              if (text) {
                updateRequestDetails(entry, { requestBody: redactBodyText(text) });
              }
            }).catch(() => {});
            input.clone().arrayBuffer().then((buffer) => {
              updateRequestDetails(entry, { requestSizeBytes: buffer.byteLength });
            }).catch(() => {});
          } catch {
            // Body already used or unreadable; leave it null.
          }
        }

        const startedAt = performance.now();
        let request;
        try {
          request = originalFetch.apply(this, arguments);
        } catch (error) {
          settleRequest(entry, { error: error?.message || String(error), ok: false,
            durationMs: Math.round(performance.now() - startedAt) });
          throw error;
        }
        return request.then(
          (response) => {
            const patch = {
              status: response?.status ?? null,
              ok: response?.ok ?? null,
              durationMs: Math.round(performance.now() - startedAt),
              responseSizeBytes: contentLengthBytes(response?.headers),
            };
            const contentType = response?.headers?.get?.('content-type');
            settleRequest(entry, {
              ...patch,
              responseBody: contentType && !isTextLike(contentType) ? `[${contentType.split(';')[0]} body not captured]` : null,
            });
            if (response && isTextLike(contentType)) {
              try {
                response.clone().text().then((text) => {
                  updateRequestDetails(entry, {
                    responseBody: redactBodyText(text),
                    responseSizeBytes: utf8ByteLength(text),
                  });
                }).catch(() => {});
              } catch {
                // Headers already settled the request; an unreadable clone
                // cannot keep the entry pending or change the native response.
              }
            }
            return response;
          },
          (error) => {
            settleRequest(entry, {
              error: error?.message || String(error),
              ok: false,
              durationMs: Math.round(performance.now() - startedAt),
            }, error?.name === 'AbortError' ? 'aborted' : 'failed');
            throw error;
          }
        );
      };
    }

    if (typeof window.XMLHttpRequest === 'function') {
      const originalOpen = XMLHttpRequest.prototype.open;
      const originalSend = XMLHttpRequest.prototype.send;

      XMLHttpRequest.prototype.open = function vibeDiggerXhrOpen(method, url) {
        const result = originalOpen.apply(this, arguments);
        this.__vibeDiggerXhr = {
          method: String(method || 'GET').toUpperCase(),
          url: truncate(url || '', 500),
        };
        return result;
      };

      XMLHttpRequest.prototype.send = function vibeDiggerXhrSend(body) {
        const info = this.__vibeDiggerXhr;
        let entry;
        let cleanup = () => {};
        if (info) {
          entry = recordRequest({
            kind: 'xhr',
            method: info.method,
            url: info.url,
            requestBody: describeRequestBody(body),
            requestSizeBytes: bodyByteLength(body),
            initiator: captureInitiator(),
          });
          const startedAt = performance.now();
          let outcome = 'load';
          const outcomes = new Map(['error', 'abort', 'timeout'].map(kind => [kind, () => { outcome = kind; }]));
          const finish = () => {
            cleanup();
            let responseBody = null;
            let responseSizeBytes = null;
            try {
              const contentType = this.getResponseHeader('content-type');
              const contentLength = this.getResponseHeader('content-length');
              responseSizeBytes = contentLengthBytes({ get: () => contentLength });
              if (isTextLike(contentType)) {
                if (this.responseType === '' || this.responseType === 'text') {
                  responseBody = redactBodyText(this.responseText);
                  responseSizeBytes = utf8ByteLength(this.responseText);
                } else if (this.responseType === 'json') {
                  const rawJson = JSON.stringify(this.response);
                  responseBody = redactBodyText(rawJson);
                  if (responseSizeBytes == null) responseSizeBytes = utf8ByteLength(rawJson);
                }
              } else if (this.responseType === 'arraybuffer') {
                responseSizeBytes = this.response?.byteLength ?? responseSizeBytes;
              } else if (this.responseType === 'blob') {
                responseSizeBytes = this.response?.size ?? responseSizeBytes;
              }
            } catch {
              // Response body unreadable; keep the status line.
            }
            settleRequest(entry, {
              status: this.status || null,
              ok: this.status > 0 && this.status < 400,
              error: outcome === 'abort' ? 'request aborted' : outcome === 'timeout' ? 'request timed out' :
                this.status === 0 ? 'request failed (status 0)' : null,
              durationMs: Math.round(performance.now() - startedAt),
              responseBody,
              responseSizeBytes,
            }, outcome === 'abort' ? 'aborted' : outcome === 'timeout' ? 'timed-out' : this.status === 0 ? 'failed' : 'completed');
          };
          cleanup = () => {
            this.removeEventListener('loadend', finish);
            for (const [kind, listener] of outcomes) this.removeEventListener(kind, listener);
          };
          for (const [kind, listener] of outcomes) this.addEventListener(kind, listener);
          this.addEventListener('loadend', finish);
        }
        try {
          return originalSend.apply(this, arguments);
        } catch (error) {
          cleanup();
          if (entry) settleRequest(entry, { error: error?.message || String(error), ok: false, durationMs: 0 });
          throw error;
        }
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
          requestSizeBytes: bodyByteLength(data),
          initiator: captureInitiator(),
        });
        try {
          const queued = originalBeacon(url, data);
          settleRequest(entry, { status: null, ok: queued, durationMs: 0 }, queued ? 'queued' : 'rejected');
          return queued;
        } catch (error) {
          settleRequest(entry, { error: error?.message || String(error), ok: false, durationMs: 0 });
          throw error;
        }
      };
    }
  }

  // ---------------------------------------------------------------------------
  // React DevTools hook: install a shim before React boots, or wrap an
  // existing hook (e.g. the real React DevTools) if one beat us to it.
  // ---------------------------------------------------------------------------

  function transitionReactAttachment(event) {
    const before = `${reactAttachment.phase}:${reactAttachment.reason}:${reactAttachment.detected}:${reactAttachment.rendererIds.size}`;
    switch (event.type) {
      case 'renderer':
        reactAttachment.rendererIds.add(event.id);
        reactAttachment.detected = true;
        reactAttachment.phase = 'attached';
        reactAttachment.reason = null;
        break;
      case 'commit':
        reactAttachment.detected = true;
        reactAttachment.phase = 'attached';
        reactAttachment.reason = null;
        break;
      case 'dom':
        reactAttachment.detected = true;
        if (reactAttachment.phase === 'waiting') {
          reactAttachment.phase = 'unavailable';
          reactAttachment.reason = 'missed-startup';
        }
        break;
      case 'blocked':
        reactAttachment.phase = 'unavailable';
        reactAttachment.reason = event.reason;
        break;
      default:
        return;
    }
    if (reactAttachment.phase !== 'attached') state.heatmapEnabled = false;
    if (reactAttachment.detected || reactAttachment.phase === 'attached') {
      reactObserver?.disconnect();
      reactObserver = null;
      if (reactDetectionTimer !== null) clearTimeout(reactDetectionTimer);
      reactDetectionTimer = null;
    }
    const after = `${reactAttachment.phase}:${reactAttachment.reason}:${reactAttachment.detected}:${reactAttachment.rendererIds.size}`;
    if (before !== after) postCurrentStatus();
  }

  function installHook() {
    const existing = window.__REACT_DEVTOOLS_GLOBAL_HOOK__;

    if (existing && typeof existing === 'object') {
      reactAttachment.detected = !!existing.renderers?.size;
      if (existing.isDisabled || !existing.supportsFiber) {
        transitionReactAttachment({type:'blocked',reason:existing.isDisabled ? 'disabled' : 'unsupported'});
        return;
      }
      const previousInject = existing.inject;
      const previousCommit = existing.onCommitFiberRoot;
      if (typeof previousInject !== 'function' || typeof previousCommit !== 'function') {
        transitionReactAttachment({type:'blocked',reason:'unsupported'});
        return;
      }
      const wrappedInject = function vibeDiggerInject() {
        const id = previousInject.apply(this, arguments);
        if (id != null) transitionReactAttachment({type:'renderer',id});
        return id;
      };
      const wrappedCommit = function vibeDiggerOnCommit(rendererId, root) {
        try { return previousCommit.apply(this, arguments); }
        finally {
          try { handleCommit(root); }
          catch { /* Debug observation must not change the host hook result. */ }
        }
      };
      const methods = [['inject',wrappedInject],['onCommitFiberRoot',wrappedCommit]].map(([key,value]) =>
        ({key,value,descriptor:Object.getOwnPropertyDescriptor(existing,key)}));
      try {
        for (const {key,value} of methods) {
          existing[key] = value;
          if (existing[key] !== value) throw new Error('Protected React hook');
        }
      } catch {
        for (const {key,value,descriptor} of methods) {
          try {
            if (existing[key] !== value) continue;
            if (descriptor) Object.defineProperty(existing,key,descriptor);
            else delete existing[key];
          } catch { /* Preserve properties another tool owns. */ }
        }
        transitionReactAttachment({type:'blocked',reason:'protected'});
        return;
      }
      reactAttachment.mode = 'wrapped';
      if (existing.renderers?.keys) {
        for (const id of existing.renderers.keys()) transitionReactAttachment({type:'renderer',id});
      }
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
        transitionReactAttachment({type:'renderer',id:nextRendererId});
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
          if (root?.current?.memoizedState?.element === null) hook.getFiberRoots(rendererId).delete(root);
          else hook.getFiberRoots(rendererId).add(root);
          handleCommit(root);
        } catch {
          // Heatmap failures must never break React's commit.
        }
      },
      onCommitFiberUnmount() {},
      onPostCommitFiberRoot() {},
      setStrictMode() {},
    };

    try {
      window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = hook;
      if (window.__REACT_DEVTOOLS_GLOBAL_HOOK__ !== hook) throw new Error('Protected React hook');
      reactAttachment.mode = 'shim';
    } catch {
      transitionReactAttachment({type:'blocked',reason:'protected'});
    }
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
    if (!root?.current) return;
    state.commitCount += 1;
    transitionReactAttachment({type:'commit'});
    if (reactStatusTimer === null) reactStatusTimer = setTimeout(() => {
      reactStatusTimer = null;
      postCurrentStatus();
    }, 150);
    if (!state.heatmapEnabled) return;

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
    transitionReactAttachment({type:'dom'});

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
    if (reactAttachment.detected) return;
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
        transitionReactAttachment({type:'dom'});
        return;
      }
    }
  }

  function watchForReact() {
    if (reactAttachment.detected || typeof MutationObserver !== 'function') return;
    reactObserver = new MutationObserver(() => {
      if (reactDetectionTimer !== null) return;
      reactDetectionTimer = setTimeout(() => {
        reactDetectionTimer = null;
        detectReactLate();
      }, 100);
    });
    reactObserver.observe(document, {childList:true,subtree:true});
  }

  function topRenderCounts(limit = 15) {
    return Array.from(state.renderCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([name, count]) => ({ name, count }));
  }

  function postStatus() {
    detectReactLate();
    postCurrentStatus();
  }

  function postCurrentStatus() {
    post('status', {
      reactDetected: reactAttachment.detected,
      hookMode: reactAttachment.mode,
      attachment: {phase:reactAttachment.phase, reason:reactAttachment.reason, rendererCount:reactAttachment.rendererIds.size},
      heatmapAvailable: reactAttachment.phase === 'attached',
      heatmapEnabled: state.heatmapEnabled,
      commitCount: state.commitCount,
      issueCount: issueCollection.entries.length,
      networkCount: networkCollection.entries.size,
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
          detectReactLate();
          state.heatmapEnabled = !!data.enabled && reactAttachment.phase === 'attached';
          postStatus();
          break;
        case 'reset-render-counts':
          state.renderCounts.clear();
          postStatus();
          break;
        case 'get-issues':
          postIssues();
          break;
        case 'clear-issues':
          transitionIssues({ type: 'clear' });
          break;
        case 'get-network':
          postNetwork();
          break;
        case 'clear-network':
          clearNetwork();
          break;
        default:
          break;
      }
    } catch {
      // Control handling is best-effort.
    }
  });

  installHook();
  detectReactLate();
  watchForReact();
  installConsoleCapture();
  installErrorCapture();
  installNetworkCapture();
  post('agent-ready', { url: location.href, hookMode: reactAttachment.mode });
})();
