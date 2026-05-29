// Element Picker QA Bridge
(function() {
  // Prevent multiple injections
  if (window.__elementPickerActive) return;
  window.__elementPickerActive = true;

  const OVERLAY_ID = '__element-picker-overlay';
  const BADGE_LAYER_ID = '__element-picker-badges';
  const TOOLBAR_ID = '__element-picker-toolbar';
  const UI_ATTR = 'data-element-picker-ui';
  const MAX_SELECTIONS = 25;
  const MAX_INLINE_CROPS = 6;
  const CROP_PADDING_CSS_PX = 16;
  const HIGHLIGHT_COLOR = '#ef4444';
  const CODEX_INBOX_URL = 'http://127.0.0.1:43117/captures';
  const CODEX_TRACE_URL = 'http://127.0.0.1:43117/traces';
  const CODEX_TOUR_URL = 'http://127.0.0.1:43117/tours/latest';
  const CODEX_HEALTH_URL = 'http://127.0.0.1:43117/health';
  const TOUR_PANEL_ID = '__element-picker-tour-panel';
  const TOUR_HIGHLIGHT_ID = '__element-picker-tour-highlight';
  const TOUR_PANEL_POSITIONS = ['top-right', 'bottom-right', 'bottom-left', 'top-left'];
  const TOUR_PANEL_OVERLAP_PADDING = 12;
  const TRACE_PANEL_ID = '__element-picker-trace-panel';
  const TRACE_SCHEMA_VERSION = '1.0';
  const TRACE_MAX_EVENTS = 600;
  const TRACE_MAX_SAMPLES = 600;
  const TRACE_MAX_MUTATIONS = 300;
  const TRACE_MAX_NETWORK = 200;
  const TRACE_MAX_CONSOLE = 120;
  const TRACE_MAX_DIFFS_PER_SAMPLE = 32;
  const TRACE_CAUSE_WINDOW_MS = 1400;
  const TRACE_SAMPLE_DELAY_MS = 60;
  const TRACE_MUTATION_FLUSH_MS = 90;
  const BREAK_ON_LOAD_DELAY_MS = 180;
  const TRACE_ACTION_HELP = {
    watch: 'Watch: choose the selected or hovered UI as a target and keep snapshots of its visible text, DOM state, layout, form state, styles, and React state when available.',
    record: 'Record: start or stop the timeline that captures user actions, DOM changes, route changes, network calls, console output, app probes, and diffs for watched targets.',
    trace: 'Trace: open the Vibe Debugger panel to review watched targets, recent diffs, likely causes, timeline events, and export status.',
    send: 'Send Trace: save trace.json, trace.md, and manifest.json to the local Codex QA inbox so Codex can inspect them with "look at latest trace."',
  };
  const BREAK_ON_LOAD_HELP = 'Break on Load: pause the QA Bridge after route changes or same-origin full page loads so you can pick and watch the new screen.';
  const CLICK_THROUGH_HELP = 'Click Through: let the next page click go to the app instead of selecting another element.';

  const TEST_ID_ATTRIBUTES = [
    'data-testid',
    'data-test-id',
    'data-test',
    'data-cy',
    'data-qa',
  ];

  const RN_WEB_PROP_NAMES = [
    'testID',
    'nativeID',
    'accessibilityLabel',
    'accessibilityHint',
    'accessibilityRole',
    'accessible',
  ];

  let overlay = null;
  let badgeLayer = null;
  let toolbar = null;
  let pauseButton = null;
  let breakOnLoadButton = null;
  let clickThroughButton = null;
  let watchButton = null;
  let recordButton = null;
  let traceButton = null;
  let sendTraceButton = null;
  let countBadge = null;
  let commentInput = null;
  let toastLayer = null;
  let statusPill = null;
  let inboxHealth = 'unknown';
  let vibeToggleButton = null;
  let vibeGroup = null;
  let vibeGroupOpen = false;
  let currentElement = null;
  let selections = [];
  let isExporting = false;
  let isPaused = true;
  let breakOnLoadEnabled = false;
  let clickThroughArmed = false;
  let hiddenPickerUiSnapshot = [];
  let activeTour = null;
  let activeTourStepIndex = 0;
  let activeTourElement = null;
  let tourPanel = null;
  let tourHighlight = null;
  let tourAskInput = null;
  let tourAskNotes = new Map();
  let tourPanelPosition = 'top-right';
  let tourPanelPositionLocked = false;
  let tracePanel = null;
  let tracePanelOpen = false;
  let watchTargets = [];
  let watchTargetCounter = 1;
  let traceEventCounter = 1;
  let traceSampleCounter = 1;
  let isTraceRecording = false;
  let traceStartedAt = null;
  let traceStartedAtMs = 0;
  let traceEndedAt = null;
  let traceEndedAtMs = 0;
  let traceEvents = [];
  let traceSamples = [];
  let traceMutations = [];
  let traceNetwork = [];
  let traceConsole = [];
  let traceTrimmed = {};
  let activeTraceCause = null;
  let latestTraceManifest = null;
  let mutationObserver = null;
  let queuedMutations = [];
  let mutationFlushTimer = null;
  let watchSampleTimer = null;
  let breakOnLoadTimer = null;

  function isElementNode(node) {
    return !!node && node.nodeType === Node.ELEMENT_NODE;
  }

  function markPickerUi(element) {
    if (isElementNode(element)) {
      element.setAttribute(UI_ATTR, 'true');
    }
  }

  function isPickerUi(element) {
    if (!isElementNode(element)) return false;
    if (element.getAttribute(UI_ATTR) === 'true') return true;
    return !!element.closest(`[${UI_ATTR}="true"]`);
  }

  function round(value, precision = 2) {
    const factor = 10 ** precision;
    return Math.round(value * factor) / factor;
  }

  function pluralize(count, singular, plural) {
    return count === 1 ? singular : plural;
  }

  function truncate(text, maxLength = 80) {
    const value = String(text || '').trim();
    if (!value) return '';
    if (value.length <= maxLength) return value;
    return `${value.slice(0, maxLength - 3)}...`;
  }

  function normalizeWhitespace(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function normalizeText(value) {
    return normalizeWhitespace(value).toLowerCase();
  }

  function slugifyTracePart(value, fallback = 'item') {
    const slug = normalizeWhitespace(value)
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 72);
    return slug || fallback;
  }

  function shouldRedactTraceKey(key) {
    return /(password|passwd|secret|token|auth|cookie|session|credential|api[-_]?key)/i.test(String(key || ''));
  }

  function sanitizeTraceValue(value, depth = 0, seen = new WeakSet(), key = '') {
    if (shouldRedactTraceKey(key)) return '[redacted]';
    if (value === null || value === undefined) return value;

    const valueType = typeof value;
    if (valueType === 'string') {
      if (/bearer\s+[a-z0-9._-]+/i.test(value)) return '[redacted bearer token]';
      return truncate(value, 240);
    }
    if (valueType === 'number' || valueType === 'boolean') return value;
    if (valueType === 'function') return '[function]';
    if (valueType !== 'object') return String(value);

    if (seen.has(value)) return '[circular]';
    if (depth >= 3) return '[max-depth]';
    seen.add(value);

    if (Array.isArray(value)) {
      return value.slice(0, 8).map((item) => sanitizeTraceValue(item, depth + 1, seen));
    }

    const result = {};
    let count = 0;

    for (const [nestedKey, nestedValue] of Object.entries(value)) {
      if (count >= 14) {
        result.__truncated__ = '[additional keys omitted]';
        break;
      }
      result[nestedKey] = sanitizeTraceValue(nestedValue, depth + 1, seen, nestedKey);
      count += 1;
    }

    return result;
  }

  function cloneForTrace(value) {
    return sanitizeTraceValue(value);
  }

  function getTraceTimeOffsetMs() {
    if (!traceStartedAtMs) return 0;
    return Math.max(0, Math.round((performance.now() - traceStartedAtMs) * 100) / 100);
  }

  function pushBoundedTraceItem(list, item, maxItems, fieldName) {
    if (list.length >= maxItems) {
      list.shift();
      traceTrimmed[fieldName] = (traceTrimmed[fieldName] || 0) + 1;
    }
    list.push(item);
  }

  function getTraceCause() {
    if (!activeTraceCause) return null;
    if (performance.now() > activeTraceCause.expiresAtMs) return null;
    return {
      eventId: activeTraceCause.eventId,
      kind: activeTraceCause.kind,
      label: activeTraceCause.label,
      timeOffsetMs: activeTraceCause.timeOffsetMs,
      confidence: activeTraceCause.confidence || 'inferred',
    };
  }

  function setTraceCause(event, confidence = 'strong', windowMs = TRACE_CAUSE_WINDOW_MS) {
    activeTraceCause = {
      eventId: event.eventId,
      kind: event.kind,
      label: event.label,
      timeOffsetMs: event.timeOffsetMs,
      confidence,
      expiresAtMs: performance.now() + windowMs,
    };
  }

  function toSerializableValue(value, depth = 0, seen = new WeakSet()) {
    if (value === null || value === undefined) return value;

    const valueType = typeof value;
    if (valueType === 'string') return truncate(value, 180);
    if (valueType === 'number' || valueType === 'boolean') return value;
    if (valueType === 'function') return '[function]';
    if (valueType !== 'object') return String(value);

    if (seen.has(value)) return '[circular]';
    if (depth >= 2) return '[max-depth]';
    seen.add(value);

    if (Array.isArray(value)) {
      return value.slice(0, 6).map((item) => toSerializableValue(item, depth + 1, seen));
    }

    const result = {};
    let count = 0;

    for (const [key, nestedValue] of Object.entries(value)) {
      if (count >= 10) {
        result.__truncated__ = '[additional keys omitted]';
        break;
      }
      result[key] = toSerializableValue(nestedValue, depth + 1, seen);
      count += 1;
    }

    return result;
  }

  function cssEscape(value) {
    if (window.CSS && typeof window.CSS.escape === 'function') {
      return window.CSS.escape(String(value));
    }
    return String(value).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
  }

  function escapeCssAttributeValue(value) {
    return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }

  function toRectObject(rect) {
    if (!rect) return null;
    const width = round(rect.width);
    const height = round(rect.height);
    const top = round(rect.top);
    const left = round(rect.left);
    const right = round(left + width);
    const bottom = round(top + height);

    return {
      top,
      left,
      right,
      bottom,
      width,
      height,
    };
  }

  function isVisibleInViewport(rect) {
    if (!rect) return false;
    if (rect.width <= 0 || rect.height <= 0) return false;
    return (
      rect.bottom > 0 &&
      rect.right > 0 &&
      rect.top < window.innerHeight &&
      rect.left < window.innerWidth
    );
  }

  function createOverlay() {
    overlay = document.createElement('div');
    overlay.id = OVERLAY_ID;
    markPickerUi(overlay);
    document.body.appendChild(overlay);
  }

  function createBadgeLayer() {
    badgeLayer = document.createElement('div');
    badgeLayer.id = BADGE_LAYER_ID;
    markPickerUi(badgeLayer);
    badgeLayer.style.cssText = [
      'position: fixed',
      'inset: 0',
      'pointer-events: none',
      'z-index: 2147483647',
    ].join(';');
    document.body.appendChild(badgeLayer);
  }

  function updateOverlay(element) {
    if (!overlay || !element) return;

    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      overlay.style.display = 'none';
      return;
    }

    overlay.style.display = 'block';
    overlay.style.top = `${rect.top}px`;
    overlay.style.left = `${rect.left}px`;
    overlay.style.width = `${rect.width}px`;
    overlay.style.height = `${rect.height}px`;
  }

  function updateBadges() {
    if (!badgeLayer) return;

    badgeLayer.textContent = '';
    selections.forEach((selection, index) => {
      const element = selection.element;
      if (!isElementNode(element) || !element.isConnected) return;

      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;

      const badge = document.createElement('div');
      markPickerUi(badge);
      badge.textContent = String(index + 1);
      badge.style.cssText = [
        'position: fixed',
        `top: ${Math.max(4, rect.top - 10)}px`,
        `left: ${Math.max(4, rect.left - 10)}px`,
        'width: 22px',
        'height: 22px',
        'border-radius: 999px',
        'background: #111827',
        'color: #ffffff',
        'font-family: ui-sans-serif, system-ui, sans-serif',
        'font-size: 12px',
        'font-weight: 700',
        'display: flex',
        'align-items: center',
        'justify-content: center',
        'border: 2px solid #60a5fa',
        'box-shadow: 0 2px 6px rgba(0,0,0,0.25)',
      ].join(';');
      badgeLayer.appendChild(badge);
    });
  }

  function ensureToastLayer() {
    if (toastLayer && toastLayer.isConnected) return toastLayer;

    toastLayer = document.createElement('div');
    markPickerUi(toastLayer);
    toastLayer.style.cssText = [
      'position: fixed',
      'top: 16px',
      'left: 16px',
      'z-index: 2147483647',
      'display: flex',
      'flex-direction: column',
      'gap: 8px',
      'pointer-events: none',
      'max-width: min(460px, calc(100vw - 32px))',
    ].join(';');
    document.body.appendChild(toastLayer);
    return toastLayer;
  }

  function showToast(message, duration = 2000) {
    const layer = ensureToastLayer();

    const toast = document.createElement('div');
    markPickerUi(toast);
    toast.textContent = message;
    toast.style.cssText = [
      'background: #111827',
      'color: #fff',
      'padding: 12px 18px',
      'border-radius: 8px',
      'font-family: ui-sans-serif, system-ui, sans-serif',
      'font-size: 13px',
      'line-height: 1.25',
      'box-shadow: 0 10px 20px rgba(0,0,0,0.35)',
      'pointer-events: none',
      'text-align: left',
    ].join(';');

    layer.appendChild(toast);
    window.setTimeout(() => {
      toast.remove();
      if (toastLayer && !toastLayer.childElementCount) {
        toastLayer.remove();
        toastLayer = null;
      }
    }, duration);
  }

  function createTourHighlight() {
    tourHighlight = document.createElement('div');
    tourHighlight.id = TOUR_HIGHLIGHT_ID;
    markPickerUi(tourHighlight);
    document.body.appendChild(tourHighlight);
  }

  function updateTourHighlight(element) {
    if (!tourHighlight) {
      createTourHighlight();
    }

    if (!element || !element.isConnected) {
      tourHighlight.style.display = 'none';
      return;
    }

    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      tourHighlight.style.display = 'none';
      return;
    }

    tourHighlight.style.display = 'block';
    tourHighlight.style.top = `${rect.top}px`;
    tourHighlight.style.left = `${rect.left}px`;
    tourHighlight.style.width = `${rect.width}px`;
    tourHighlight.style.height = `${rect.height}px`;
  }

  function setTourPanelPosition(position) {
    if (!tourPanel || !TOUR_PANEL_POSITIONS.includes(position)) return;
    tourPanelPosition = position;
    tourPanel.dataset.position = position;
  }

  function getNextTourPanelPosition(position = tourPanelPosition) {
    const index = TOUR_PANEL_POSITIONS.indexOf(position);
    return TOUR_PANEL_POSITIONS[(index + 1) % TOUR_PANEL_POSITIONS.length] || TOUR_PANEL_POSITIONS[0];
  }

  function expandRect(rect, padding) {
    return {
      top: rect.top - padding,
      right: rect.right + padding,
      bottom: rect.bottom + padding,
      left: rect.left - padding,
      width: rect.width + padding * 2,
      height: rect.height + padding * 2,
    };
  }

  function getOverlapArea(a, b) {
    const width = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
    const height = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
    return width * height;
  }

  function getTourTargetAvoidanceRect() {
    if (!activeTourElement || !activeTourElement.isConnected) return null;

    const rect = activeTourElement.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    return expandRect(rect, TOUR_PANEL_OVERLAP_PADDING);
  }

  function chooseTourPanelPosition() {
    if (!tourPanel) return tourPanelPosition;

    const targetRect = getTourTargetAvoidanceRect();
    if (!targetRect) return tourPanelPosition;

    const candidateOrder = [
      tourPanelPosition,
      ...TOUR_PANEL_POSITIONS.filter((position) => position !== tourPanelPosition),
    ];
    const scored = [];

    for (const position of candidateOrder) {
      setTourPanelPosition(position);
      const panelRect = tourPanel.getBoundingClientRect();
      const overlapArea = getOverlapArea(panelRect, targetRect);
      scored.push({ position, overlapArea });

      if (overlapArea === 0) {
        return position;
      }
    }

    return scored.sort((a, b) => a.overlapArea - b.overlapArea)[0]?.position || tourPanelPosition;
  }

  function placeTourPanel(options = {}) {
    if (!tourPanel) return;
    const { forceAuto = false } = options;

    if (forceAuto || !tourPanelPositionLocked) {
      setTourPanelPosition(chooseTourPanelPosition());
      return;
    }

    setTourPanelPosition(tourPanelPosition);
  }

  function queueTourPanelPlacement(options = {}) {
    if (!tourPanel) return;
    window.requestAnimationFrame(() => placeTourPanel(options));
  }

  function normalizeTourUrl(value) {
    try {
      const url = new URL(value, window.location.href);
      url.hash = '';
      return url;
    } catch {
      return null;
    }
  }

  function isCurrentTourStepUrl(step) {
    if (!step?.url) return true;

    const target = normalizeTourUrl(step.url);
    const current = normalizeTourUrl(window.location.href);
    if (!target || !current) return false;

    const targetPath = target.pathname.replace(/\/$/, '') || '/';
    const currentPath = current.pathname.replace(/\/$/, '') || '/';

    return (
      target.origin === current.origin &&
      targetPath === currentPath &&
      (!target.search || target.search === current.search)
    );
  }

  function findElementByTourText(text) {
    const target = normalizeText(text);
    if (!target) return null;

    const candidates = Array.from(document.querySelectorAll('body *'))
      .filter((node) => isElementNode(node) && !isPickerUi(node) && isVisibleElement(node))
      .map((node) => ({
        node,
        text: normalizeText(getTextPreview(node)),
      }))
      .filter((candidate) => candidate.text && candidate.text.includes(target))
      .sort((a, b) => a.text.length - b.text.length);

    return candidates[0]?.node || null;
  }

  function findTourElement(step) {
    if (!step) return null;

    if (step.selector) {
      try {
        const element = document.querySelector(step.selector);
        if (isElementNode(element) && !isPickerUi(element)) {
          return element;
        }
      } catch {
        // Invalid selectors are reported through the tour panel instead.
      }
    }

    if (step.text) {
      return findElementByTourText(step.text);
    }

    return null;
  }

  function createTourPanelButton(label, onClick, variant = 'secondary') {
    const button = document.createElement('button');
    markPickerUi(button);
    button.type = 'button';
    button.textContent = label;
    button.className = `element-picker-tour-button element-picker-tour-button-${variant}`;
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      onClick();
    });
    return button;
  }

  function ensureTourPanel() {
    if (tourPanel) return tourPanel;

    tourPanel = document.createElement('div');
    tourPanel.id = TOUR_PANEL_ID;
    markPickerUi(tourPanel);
    document.body.appendChild(tourPanel);
    setTourPanelPosition(tourPanelPosition);
    return tourPanel;
  }

  function clearTour() {
    if (tourPanel) tourPanel.remove();
    if (tourHighlight) tourHighlight.remove();

    activeTour = null;
    activeTourStepIndex = 0;
    activeTourElement = null;
    tourPanel = null;
    tourHighlight = null;
    tourAskInput = null;
    tourAskNotes.clear();
    tourPanelPosition = 'top-right';
    tourPanelPositionLocked = false;
    updateToolbarState();
  }

  function getActiveTourStep() {
    if (!activeTour?.steps?.length) return null;
    return activeTour.steps[activeTourStepIndex] || null;
  }

  function isTourActive() {
    return !!activeTour?.steps?.length;
  }

  function getTourStepKey(step = getActiveTourStep(), stepIndex = activeTourStepIndex) {
    if (!activeTour || !step) return '';
    const tourKey = activeTour.id || activeTour.title || 'tour';
    const stepKey = step.id || step.selector || step.text || stepIndex;
    return `${tourKey}:${stepKey}`;
  }

  function saveTourAskText(value, step = getActiveTourStep(), stepIndex = activeTourStepIndex) {
    const key = getTourStepKey(step, stepIndex);
    if (key) {
      tourAskNotes.set(key, value || '');
    }
  }

  function getTourAskText(step = getActiveTourStep(), stepIndex = activeTourStepIndex) {
    const key = getTourStepKey(step, stepIndex);
    const activeKey = getTourStepKey();

    if (tourAskInput && key && key === activeKey) {
      return normalizeWhitespace(tourAskInput.value) || null;
    }

    return normalizeWhitespace(tourAskNotes.get(key) || '') || null;
  }

  function createTourAskInput(step, stepIndex) {
    const input = document.createElement('textarea');
    markPickerUi(input);
    input.className = 'element-picker-tour-ask';
    input.placeholder = 'Ask Codex about this step...';
    input.title = 'Add a question or observation for this tour step';
    input.rows = 2;
    input.value = tourAskNotes.get(getTourStepKey(step, stepIndex)) || '';
    input.setAttribute('aria-label', 'Ask Codex about this tour step');
    input.addEventListener('input', () => saveTourAskText(input.value, step, stepIndex));
    return input;
  }

  function getActiveTourContext(extra = {}) {
    const step = getActiveTourStep();
    if (!activeTour || !step) return null;

    return {
      tourId: activeTour.id || null,
      tourTitle: activeTour.title || null,
      tourSummary: activeTour.summary || null,
      stepIndex: activeTourStepIndex + 1,
      totalSteps: activeTour.steps.length,
      currentUrlMatches: isCurrentTourStepUrl(step),
      targetFound: !!activeTourElement,
      step: {
        id: step.id || null,
        title: step.title || null,
        body: step.body || null,
        url: step.url || null,
        selector: step.selector || null,
        text: step.text || null,
        action: step.action || null,
        notes: step.notes || null,
      },
      ...extra,
    };
  }

  async function navigateToTourStep(step, stepIndex = activeTourStepIndex) {
    if (!step?.url) return;

    try {
      const response = await chrome.runtime.sendMessage({
        type: 'ELEMENT_PICKER_OPEN_TOUR_STEP',
        url: step.url,
        tour: activeTour,
        stepIndex,
      });

      if (response?.ok) return;
    } catch {
      // Fall back to normal navigation below.
    }

    window.location.href = step.url;
  }

  async function askCodexAboutTourStep() {
    const step = getActiveTourStep();
    const element = activeTourElement || findTourElement(step);
    const askText = getTourAskText(step, activeTourStepIndex);

    if (!element) {
      showToast('Tour step element was not found on this page.', 2600);
      return;
    }

    clearSelections();
    currentElement = element;
    updateOverlay(element);
    addSelection(element, { silent: true });

    await sendBundleToCodex({
      tourContext: getActiveTourContext({ askText }),
    });
  }

  function renderTourStep() {
    const step = getActiveTourStep();
    if (!step) {
      clearTour();
      return;
    }

    const panel = ensureTourPanel();
    const total = activeTour.steps.length;
    const onCurrentUrl = isCurrentTourStepUrl(step);
    activeTourElement = onCurrentUrl ? findTourElement(step) : null;
    currentElement = null;
    if (overlay) overlay.style.display = 'none';
    updateTourHighlight(activeTourElement);

    const eyebrow = document.createElement('div');
    eyebrow.className = 'element-picker-tour-eyebrow';
    eyebrow.textContent = `${activeTour.title || 'Codex tour'} - ${activeTourStepIndex + 1} of ${total}`;

    const title = document.createElement('div');
    title.className = 'element-picker-tour-title';
    title.textContent = step.title || `Step ${activeTourStepIndex + 1}`;

    const body = document.createElement('div');
    body.className = 'element-picker-tour-body';
    body.textContent = step.body || step.notes || 'Codex marked this part of the page for review.';

    const status = document.createElement('div');
    status.className = 'element-picker-tour-status';
    if (!onCurrentUrl && step.url) {
      status.textContent = `Open ${step.url} to view this step.`;
    } else if (activeTourElement) {
      status.textContent = step.selector
        ? `Highlighting ${step.selector}`
        : `Highlighting text match "${truncate(step.text, 56)}"`;
    } else {
      status.textContent = 'Could not find the target element on this page.';
    }

    const controls = document.createElement('div');
    controls.className = 'element-picker-tour-controls';

    const backButton = createTourPanelButton('Back', () => {
      saveTourAskText(tourAskInput?.value || '', step, activeTourStepIndex);
      tourPanelPositionLocked = false;
      activeTourStepIndex = Math.max(0, activeTourStepIndex - 1);
      renderTourStep();
    });
    backButton.disabled = activeTourStepIndex === 0;

    const closeButton = createTourPanelButton('Close', () => {
      clearTour();
      showToast('Guided review closed.', 1500);
    });

    const moveButton = createTourPanelButton('Move', () => {
      tourPanelPositionLocked = true;
      setTourPanelPosition(getNextTourPanelPosition());
      showToast('Moved the tour guide box.', 1200);
    });

    const askButton = createTourPanelButton('Ask Codex', () => {
      askCodexAboutTourStep();
    }, 'primary');
    askButton.disabled = !activeTourElement;

    const nextButton = createTourPanelButton(activeTourStepIndex === total - 1 ? 'Done' : 'Next', () => {
      if (activeTourStepIndex >= total - 1) {
        clearTour();
        showToast('Guided review complete.', 1700);
        return;
      }

      saveTourAskText(tourAskInput?.value || '', step, activeTourStepIndex);
      tourPanelPositionLocked = false;
      const nextStep = activeTour.steps[activeTourStepIndex + 1];
      activeTourStepIndex += 1;
      if (nextStep?.url && !isCurrentTourStepUrl(nextStep)) {
        navigateToTourStep(nextStep, activeTourStepIndex);
        return;
      }
      renderTourStep();
    }, 'primary');

    controls.append(backButton, moveButton);
    if (!onCurrentUrl && step.url) {
      controls.append(createTourPanelButton('Open Step', () => navigateToTourStep(step), 'primary'));
    } else {
      controls.append(askButton);
    }
    controls.append(nextButton, closeButton);

    tourAskInput = onCurrentUrl ? createTourAskInput(step, activeTourStepIndex) : null;

    if (tourAskInput) {
      panel.replaceChildren(eyebrow, title, body, status, tourAskInput, controls);
    } else {
      panel.replaceChildren(eyebrow, title, body, status, controls);
    }

    queueTourPanelPlacement();
    updateToolbarState();
  }

  async function loadLatestTour() {
    try {
      showToast('Loading latest Codex guided review...', 1600);
      const response = await chrome.runtime.sendMessage({
        type: 'ELEMENT_PICKER_GET_LATEST_TOUR',
        tourUrl: CODEX_TOUR_URL,
      });

      if (!response?.ok || !response.tour) {
        throw new Error(response?.error || 'No guided review is available');
      }

      activeTour = response.tour;
      activeTourStepIndex = 0;
      tourPanelPositionLocked = false;
      clearSelections();
      isPaused = true;
      renderTourStep();
      updateToolbarState();
      setInboxHealth('online');
      showToast(`Loaded guided review: ${activeTour.title}`, 2400);
    } catch (error) {
      console.error('Failed to load Codex guided review:', error);
      showToast(`Tour load failed: ${error?.message || 'start the Codex QA inbox server'}`, 4200);
    }
  }

  function onRuntimeMessage(message, sender, sendResponse) {
    if (message?.type === 'ELEMENT_PICKER_TOGGLE') {
      cleanup();
      if (typeof sendResponse === 'function') {
        sendResponse({ ok: true, closed: true });
      }
      return;
    }

    if (message?.type === 'ELEMENT_PICKER_BREAK_ON_LOAD_RESUME') {
      setBreakOnLoadEnabled(true, { persist: false });
      isPaused = true;
      updateToolbarState();
      showToast('Break on Load paused this page. Pick a target, then click Watch.', 3000);
      return;
    }

    if (message?.type !== 'ELEMENT_PICKER_RESUME_TOUR' || !message.tour) {
      return;
    }

    activeTour = message.tour;
    activeTourStepIndex = Math.max(0, Math.min(
      Number.parseInt(message.stepIndex || 0, 10),
      activeTour.steps.length - 1
    ));
    tourPanelPositionLocked = false;
    clearSelections();
    isPaused = true;
    renderTourStep();
    updateToolbarState();
    showToast(`Continuing guided review: ${activeTour.title}`, 2400);
  }

  function createToolbarButton(label, title, onClick, variant = 'secondary') {
    const button = document.createElement('button');
    markPickerUi(button);
    button.type = 'button';
    button.textContent = label;
    button.title = title;
    button.setAttribute('aria-label', title || label);
    button.className = `element-picker-toolbar-button element-picker-toolbar-button-${variant}`;
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      onClick();
    });
    return button;
  }

  function createCommentInput() {
    const input = document.createElement('textarea');
    markPickerUi(input);
    input.className = 'element-picker-toolbar-comment';
    input.placeholder = 'Comment for Codex...';
    input.title = 'Add context to include with Send to Codex or Copy';
    input.rows = 1;
    input.setAttribute('aria-label', 'Comment for Codex');
    return input;
  }

  function getUserComment() {
    return normalizeWhitespace(commentInput?.value || '') || null;
  }

  const INBOX_HEALTH_LABELS = {
    online: 'Inbox',
    offline: 'Inbox off',
    checking: 'Inbox…',
    unknown: 'Inbox?',
  };

  const INBOX_HEALTH_TITLES = {
    online: 'Codex QA inbox is reachable. Click to re-check.',
    offline: 'Codex QA inbox is offline. Run `npm run inbox`, then click to re-check.',
    checking: 'Checking the Codex QA inbox connection…',
    unknown: 'Click to check the Codex QA inbox connection.',
  };

  function setInboxHealth(state) {
    inboxHealth = state;
    if (!statusPill) return;

    statusPill.dataset.state = state;
    const label = statusPill.querySelector('.element-picker-toolbar-status-label');
    if (label) label.textContent = INBOX_HEALTH_LABELS[state] || INBOX_HEALTH_LABELS.unknown;
    statusPill.title = INBOX_HEALTH_TITLES[state] || INBOX_HEALTH_TITLES.unknown;
  }

  async function checkInboxHealth({ silent = true } = {}) {
    setInboxHealth('checking');

    try {
      const response = await chrome.runtime.sendMessage({
        type: 'ELEMENT_PICKER_CHECK_INBOX',
        healthUrl: CODEX_HEALTH_URL,
      });

      if (response?.ok) {
        setInboxHealth('online');
        if (!silent) showToast('Codex QA inbox is reachable.', 1800);
        return true;
      }

      setInboxHealth('offline');
      if (!silent) showToast('Codex QA inbox is offline. Run `npm run inbox` to enable Send to Codex.', 3400);
      return false;
    } catch {
      setInboxHealth('offline');
      if (!silent) showToast('Codex QA inbox is offline. Run `npm run inbox` to enable Send to Codex.', 3400);
      return false;
    }
  }

  function createStatusPill() {
    const pill = document.createElement('button');
    markPickerUi(pill);
    pill.type = 'button';
    pill.className = 'element-picker-toolbar-status';
    pill.dataset.state = 'unknown';

    const dot = document.createElement('span');
    dot.className = 'element-picker-toolbar-status-dot';

    const label = document.createElement('span');
    label.className = 'element-picker-toolbar-status-label';
    label.textContent = INBOX_HEALTH_LABELS.unknown;

    pill.append(dot, label);
    pill.title = INBOX_HEALTH_TITLES.unknown;
    pill.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      checkInboxHealth({ silent: false });
    });
    return pill;
  }

  function setVibeGroupOpen(open) {
    vibeGroupOpen = open;
    if (vibeGroup) {
      vibeGroup.classList.toggle('element-picker-toolbar-group-hidden', !open);
      vibeGroup.setAttribute('aria-hidden', open ? 'false' : 'true');
    }
    if (vibeToggleButton) {
      vibeToggleButton.setAttribute('aria-expanded', open ? 'true' : 'false');
    }
    updateTraceUi();
  }

  function isTextEntryElement(element) {
    if (!isElementNode(element)) return false;

    const tagName = element.tagName.toLowerCase();
    return (
      tagName === 'textarea' ||
      tagName === 'input' ||
      element.isContentEditable
    );
  }

  function updateToolbarState() {
    const tourActive = isTourActive();

    if (toolbar) {
      toolbar.classList.toggle('element-picker-toolbar-hidden-by-tour', tourActive);
      toolbar.setAttribute('aria-hidden', tourActive ? 'true' : 'false');
    }

    if (pauseButton) {
      pauseButton.textContent = isPaused ? 'Resume' : 'Pause';
      pauseButton.title = isPaused
        ? 'Resume normal page interaction'
        : 'Pause page interaction and inspect elements';
    }

    if (breakOnLoadButton) {
      breakOnLoadButton.textContent = breakOnLoadEnabled ? 'Break Load On' : 'Break on Load';
      breakOnLoadButton.title = breakOnLoadEnabled
        ? 'Break on Load is on. QA Bridge will pause after route changes or same-origin page loads.'
        : BREAK_ON_LOAD_HELP;
      breakOnLoadButton.setAttribute('aria-label', breakOnLoadButton.title);
      breakOnLoadButton.setAttribute('aria-pressed', breakOnLoadEnabled ? 'true' : 'false');
      breakOnLoadButton.classList.toggle('element-picker-toolbar-button-primary', breakOnLoadEnabled);
    }

    if (clickThroughButton) {
      clickThroughButton.textContent = clickThroughArmed ? 'Click Armed' : 'Click Through';
      clickThroughButton.title = clickThroughArmed
        ? 'The next page click will go to the app instead of selecting another element.'
        : CLICK_THROUGH_HELP;
      clickThroughButton.setAttribute('aria-label', clickThroughButton.title);
      clickThroughButton.setAttribute('aria-pressed', clickThroughArmed ? 'true' : 'false');
      clickThroughButton.classList.toggle('element-picker-toolbar-button-primary', clickThroughArmed);
    }

    if (countBadge) {
      countBadge.textContent = `${selections.length} selected`;
    }

    if (overlay) {
      overlay.style.display = isPaused && !tourActive && currentElement ? overlay.style.display : 'none';
    }
  }

  function persistBreakOnLoadState() {
    try {
      chrome.runtime.sendMessage({
        type: 'ELEMENT_PICKER_SET_BREAK_ON_LOAD',
        enabled: breakOnLoadEnabled,
      }, () => {
        if (chrome.runtime.lastError) {
          console.warn('Unable to persist Break on Load state:', chrome.runtime.lastError.message);
        }
      });
    } catch (error) {
      console.warn('Unable to persist Break on Load state:', error);
    }
  }

  function setBreakOnLoadEnabled(enabled, options = {}) {
    const { notify = false, persist = true } = options;
    breakOnLoadEnabled = !!enabled;

    if (!breakOnLoadEnabled && breakOnLoadTimer) {
      window.clearTimeout(breakOnLoadTimer);
      breakOnLoadTimer = null;
    }

    if (persist) {
      persistBreakOnLoadState();
    }

    updateToolbarState();

    if (notify) {
      showToast(
        breakOnLoadEnabled
          ? 'Break on Load enabled. Resume and navigate; QA Bridge will pause on the next screen.'
          : 'Break on Load disabled.',
        2400
      );
    }
  }

  function pauseForBreakOnLoad(reason = 'route change') {
    if (!breakOnLoadEnabled || isTourActive()) return;

    if (breakOnLoadTimer) {
      window.clearTimeout(breakOnLoadTimer);
    }

    breakOnLoadTimer = window.setTimeout(() => {
      breakOnLoadTimer = null;
      if (!breakOnLoadEnabled || isTourActive()) return;

      isPaused = true;
      updateToolbarState();
      showToast(`Break on Load paused after ${reason}. Pick a target, then click Watch.`, 3000);
    }, BREAK_ON_LOAD_DELAY_MS);
  }

  function createToolbar() {
    toolbar = document.createElement('div');
    toolbar.id = TOOLBAR_ID;
    markPickerUi(toolbar);

    const title = document.createElement('div');
    markPickerUi(title);
    title.className = 'element-picker-toolbar-title';
    title.textContent = 'QA Bridge';

    countBadge = document.createElement('div');
    markPickerUi(countBadge);
    countBadge.className = 'element-picker-toolbar-count';

    statusPill = createStatusPill();

    commentInput = createCommentInput();

    pauseButton = createToolbarButton('Resume', 'Resume normal page interaction', () => {
      isPaused = !isPaused;
      if (!isPaused) {
        clickThroughArmed = false;
      }
      updateToolbarState();
      showToast(isPaused ? 'Page paused. Click elements to inspect.' : 'Page interaction resumed. Toolbar remains available.', 1800);
    });

    breakOnLoadButton = createToolbarButton('Break on Load', BREAK_ON_LOAD_HELP, () => {
      setBreakOnLoadEnabled(!breakOnLoadEnabled, { notify: true });
    });

    clickThroughButton = createToolbarButton('Click Through', CLICK_THROUGH_HELP, () => {
      clickThroughArmed = !clickThroughArmed;
      updateToolbarState();
      showToast(
        clickThroughArmed
          ? 'Click Through armed. The next page click will go to the app.'
          : 'Click Through cancelled.',
        2200
      );
    });

    const undoButton = createToolbarButton('Undo', 'Remove latest selected element', () => {
      removeLastSelection();
      updateToolbarState();
    });

    vibeToggleButton = createToolbarButton('Vibe ▾', 'Show or hide the Vibe Debugger controls (Watch, Record, Trace)', () => {
      setVibeGroupOpen(!vibeGroupOpen);
      if (vibeGroupOpen) showToast('Vibe Debugger controls shown.', 1200);
    });
    vibeToggleButton.setAttribute('aria-expanded', 'false');

    watchButton = createToolbarButton('Watch', TRACE_ACTION_HELP.watch, () => {
      watchCurrentSelection();
    });

    recordButton = createToolbarButton('Record', TRACE_ACTION_HELP.record, () => {
      toggleTraceRecording();
    });

    traceButton = createToolbarButton('Trace', TRACE_ACTION_HELP.trace, () => {
      toggleTracePanel();
    });

    sendTraceButton = createToolbarButton('Send Trace', TRACE_ACTION_HELP.send, () => {
      sendTraceToCodex();
    }, 'primary');

    vibeGroup = document.createElement('div');
    markPickerUi(vibeGroup);
    vibeGroup.className = 'element-picker-toolbar-group element-picker-toolbar-group-hidden';
    vibeGroup.setAttribute('aria-hidden', 'true');
    vibeGroup.append(watchButton, recordButton, traceButton, sendTraceButton);

    const copyButton = createToolbarButton('Copy', 'Copy selected element bundle to clipboard (keeps the bridge open)', () => {
      exportBundle();
    });

    const sendButton = createToolbarButton('Send to Codex', 'Save selected element bundle to the local Codex QA inbox', () => {
      sendBundleToCodex();
    }, 'primary');

    const tourButton = createToolbarButton('Load Tour', 'Load the latest Codex guided review from the local QA inbox', () => {
      loadLatestTour();
    });

    const closeButton = createToolbarButton('Close', 'Close the QA bridge', () => {
      cleanup();
    });

    toolbar.append(
      title,
      statusPill,
      countBadge,
      commentInput,
      pauseButton,
      breakOnLoadButton,
      clickThroughButton,
      undoButton,
      vibeToggleButton,
      vibeGroup,
      copyButton,
      sendButton,
      tourButton,
      closeButton
    );
    document.body.appendChild(toolbar);
    updateToolbarState();
    updateTraceUi();
    checkInboxHealth({ silent: true });
  }

  function getReactFiberNode(element) {
    const fiberKey = Object.keys(element).find(
      (key) => key.startsWith('__reactFiber$') || key.startsWith('__reactInternalInstance$')
    );
    return fiberKey ? element[fiberKey] : null;
  }

  function getReactInfo(element) {
    let fiber = getReactFiberNode(element);
    if (!fiber) return null;

    const components = [];
    while (fiber) {
      if (fiber.type && typeof fiber.type === 'function') {
        const name = fiber.type.displayName || fiber.type.name;
        if (name && !name.startsWith('_')) {
          components.push(name);
        }
      }
      fiber = fiber.return;
    }

    return components.length > 0 ? components : null;
  }

  function getReactState(element) {
    let fiber = getReactFiberNode(element);
    if (!fiber) return null;

    while (fiber) {
      if (fiber.type && typeof fiber.type === 'function') {
        const result = {};

        if (fiber.memoizedProps) {
          const props = {};
          for (const [key, value] of Object.entries(fiber.memoizedProps)) {
            if (key === 'children') continue;
            if (typeof value === 'function') {
              props[key] = '[function]';
            } else if (typeof value === 'object' && value !== null) {
              try {
                props[key] = JSON.stringify(value).slice(0, 120);
              } catch {
                props[key] = '[object]';
              }
            } else {
              props[key] = value;
            }
          }

          if (Object.keys(props).length > 0) {
            result.props = props;
          }
        }

        if (fiber.memoizedState && typeof fiber.memoizedState === 'object') {
          try {
            const states = [];
            let stateNode = fiber.memoizedState;
            let count = 0;
            while (stateNode && count < 4) {
              if (
                stateNode.memoizedState !== undefined &&
                stateNode.memoizedState !== null &&
                typeof stateNode.memoizedState !== 'function'
              ) {
                states.push(toSerializableValue(stateNode.memoizedState));
              }
              stateNode = stateNode.next;
              count += 1;
            }
            if (states.length > 0) {
              result.state = states;
            }
          } catch {
            // React internals are version-dependent; ignore extraction errors.
          }
        }

        if (Object.keys(result).length > 0) return result;
      }
      fiber = fiber.return;
    }

    return null;
  }

  function getFiberDisplayName(fiber) {
    const type = fiber?.type || fiber?.elementType;
    if (!type) return null;
    if (typeof type === 'string') return type;
    return type.displayName || type.name || null;
  }

  function getReactNativeWebProps(element) {
    let fiber = getReactFiberNode(element);
    if (!fiber) return null;

    const props = {};
    let depth = 0;

    while (fiber && depth < 8) {
      const source = getFiberDisplayName(fiber);
      const memoizedProps = fiber.memoizedProps;

      if (memoizedProps && typeof memoizedProps === 'object') {
        for (const propName of RN_WEB_PROP_NAMES) {
          if (!(propName in memoizedProps)) continue;
          if (props[propName]) continue;

          props[propName] = {
            value: toSerializableValue(memoizedProps[propName]),
            source,
            depth,
          };
        }
      }

      fiber = fiber.return;
      depth += 1;
    }

    return Object.keys(props).length > 0 ? props : null;
  }

  function isUtilityClassName(className) {
    const utilityPrefixes = [
      'p', 'px', 'py', 'pt', 'pr', 'pb', 'pl',
      'm', 'mx', 'my', 'mt', 'mr', 'mb', 'ml',
      'w', 'h', 'min-w', 'min-h', 'max-w', 'max-h',
      'flex', 'grid', 'text', 'bg', 'border', 'rounded',
      'shadow', 'items', 'justify', 'gap', 'space', 'overflow',
      'opacity', 'z', 'inset', 'top', 'right', 'bottom', 'left',
    ];

    return utilityPrefixes.some((prefix) => className.startsWith(`${prefix}-`));
  }

  function isLikelyGeneratedClassName(className) {
    if (!className) return false;

    return (
      /^css-[a-z]+-[a-z0-9]+$/i.test(className) ||
      /^r-[a-z0-9]{6,}$/i.test(className) ||
      (/^[_-]?[a-z0-9]{7,}$/i.test(className) && /\d/.test(className)) ||
      /__[a-z0-9_-]*[a-f0-9]{5,}$/i.test(className) ||
      /(^|[-_])[a-f0-9]{8,}($|[-_])/i.test(className)
    );
  }

  function getClassDiagnostics(element) {
    const raw = Array.from(element.classList);
    const generated = raw.filter(isLikelyGeneratedClassName);
    const utility = raw.filter((className) => !generated.includes(className) && isUtilityClassName(className));
    const meaningful = raw
      .filter((className) => !generated.includes(className) && !utility.includes(className))
      .slice(0, 6);

    if (raw.length === 0) return null;

    return {
      meaningful,
      totalCount: raw.length,
      generatedCount: generated.length,
      utilityCount: utility.length,
      omittedGeneratedExamples: generated.slice(0, 4),
    };
  }

  function getMeaningfulClasses(element) {
    const diagnostics = getClassDiagnostics(element);
    return diagnostics?.meaningful.slice(0, 3) || [];
  }

  function getCssSelector(element) {
    if (element.id && !isLikelyGeneratedIdentifier(element.id)) {
      return `#${cssEscape(element.id)}`;
    }

    const path = [];
    let current = element;

    while (current && current.nodeType === Node.ELEMENT_NODE) {
      let selector = current.tagName.toLowerCase();

      if (current.id && !isLikelyGeneratedIdentifier(current.id)) {
        selector = `#${cssEscape(current.id)}`;
        path.unshift(selector);
        break;
      }

      const meaningfulClasses = getMeaningfulClasses(current);
      if (meaningfulClasses.length > 0) {
        selector += meaningfulClasses.map((className) => `.${cssEscape(className)}`).join('');
      } else if (current.parentElement) {
        const sameTagSiblings = Array.from(current.parentElement.children)
          .filter((child) => child.tagName === current.tagName);

        if (sameTagSiblings.length > 1) {
          const index = sameTagSiblings.indexOf(current) + 1;
          selector += `:nth-of-type(${index})`;
        }
      }

      path.unshift(selector);
      current = current.parentElement;

      if (path.length >= 5) break;
    }

    return path.join(' > ');
  }

  function getXPath(element) {
    if (!isElementNode(element)) return null;

    if (element.id) {
      const escapedId = String(element.id).replace(/"/g, '\\"');
      return `//*[@id="${escapedId}"]`;
    }

    const segments = [];
    let current = element;

    while (current && current.nodeType === Node.ELEMENT_NODE) {
      const tag = current.tagName.toLowerCase();
      const siblings = current.parentNode
        ? Array.from(current.parentNode.children).filter((sibling) => sibling.tagName === current.tagName)
        : [];
      const index = siblings.length > 1 ? siblings.indexOf(current) + 1 : 1;
      segments.unshift(`${tag}[${index}]`);
      current = current.parentElement;
    }

    return `/${segments.join('/')}`;
  }

  function getTextPreview(element) {
    const text = normalizeWhitespace(element.innerText || element.textContent || '');
    return truncate(text, 100);
  }

  function getHtmlSnippet(element, maxLength = 500) {
    const html = element.outerHTML;
    if (!html) return null;
    if (html.length <= maxLength) return html;

    const sliced = html.slice(0, maxLength);
    const safeCut = Math.max(sliced.lastIndexOf('>'), sliced.lastIndexOf(' '), maxLength - 60);
    return `${sliced.slice(0, safeCut)}...`;
  }

  function getDebugStyles(element) {
    const computed = window.getComputedStyle(element);
    const styles = {};

    if (computed.display === 'none') styles.display = 'none';
    if (computed.visibility === 'hidden') styles.visibility = 'hidden';
    if (parseFloat(computed.opacity) < 1) styles.opacity = computed.opacity;

    if (computed.position !== 'static') {
      styles.position = computed.position;
      if (computed.zIndex !== 'auto') styles.zIndex = computed.zIndex;
    }

    if (computed.pointerEvents === 'none') styles.pointerEvents = 'none';
    if (computed.overflow !== 'visible') styles.overflow = computed.overflow;
    if (computed.overflowX !== 'visible') styles.overflowX = computed.overflowX;
    if (computed.overflowY !== 'visible') styles.overflowY = computed.overflowY;
    if (computed.scrollSnapType && computed.scrollSnapType !== 'none') {
      styles.scrollSnapType = computed.scrollSnapType;
    }
    if (computed.scrollSnapAlign && computed.scrollSnapAlign !== 'none') {
      styles.scrollSnapAlign = computed.scrollSnapAlign;
    }

    if (computed.display.includes('flex')) {
      styles.display = computed.display;
      styles.flexDirection = computed.flexDirection;
      styles.justifyContent = computed.justifyContent;
      styles.alignItems = computed.alignItems;
    }

    if (computed.display.includes('grid')) {
      styles.display = computed.display;
      styles.gridTemplateColumns = computed.gridTemplateColumns;
      styles.gridTemplateRows = computed.gridTemplateRows;
    }

    return Object.keys(styles).length > 0 ? styles : null;
  }

  function getFormState(element) {
    const tag = element.tagName.toLowerCase();
    if (!['input', 'select', 'textarea', 'button'].includes(tag)) return null;

    const state = {};

    if (element.type) state.type = element.type;
    if (element.value !== undefined && element.value !== '') state.value = element.value;
    if (element.checked !== undefined) state.checked = element.checked;
    if (element.disabled) state.disabled = true;
    if (element.required) state.required = true;
    if (element.readOnly) state.readOnly = true;
    if (element.validity && !element.validity.valid) {
      state.validationMessage = element.validationMessage;
    }

    return Object.keys(state).length > 0 ? state : null;
  }

  function getA11yInfo(element) {
    const info = {};

    const role = element.getAttribute('role');
    if (role) info.role = role;

    for (const attribute of Array.from(element.attributes)) {
      if (attribute.name.startsWith('aria-')) {
        info[attribute.name] = attribute.value;
      }
    }

    if (element.tabIndex !== -1 && element.tabIndex !== 0) {
      info.tabIndex = element.tabIndex;
    }

    return Object.keys(info).length > 0 ? info : null;
  }

  function getAccessibleNameInfo(element) {
    const ariaLabel = element.getAttribute('aria-label');
    if (ariaLabel) return { name: truncate(ariaLabel, 120), source: 'aria-label' };

    const labelledBy = element.getAttribute('aria-labelledby');
    if (labelledBy) {
      const ids = labelledBy
        .split(/\s+/)
        .map((id) => id.trim())
        .filter(Boolean);
      const text = ids
        .map((id) => document.getElementById(id)?.innerText || document.getElementById(id)?.textContent || '')
        .join(' ')
        .trim();
      if (text) return { name: truncate(text, 120), source: 'aria-labelledby' };
    }

    const title = element.getAttribute('title');
    if (title) return { name: truncate(title, 120), source: 'title' };

    if (element.alt) return { name: truncate(element.alt, 120), source: 'alt' };

    const tag = element.tagName.toLowerCase();
    if (tag === 'input' || tag === 'textarea') {
      const placeholder = element.getAttribute('placeholder');
      if (placeholder) return { name: truncate(placeholder, 120), source: 'placeholder' };
      if (element.value) return { name: truncate(element.value, 120), source: 'value' };
    }

    const text = getTextPreview(element);
    return text ? { name: text, source: 'visible-text' } : null;
  }

  function getAccessibleName(element) {
    return getAccessibleNameInfo(element)?.name || '';
  }

  function inferRole(element) {
    const explicitRole = element.getAttribute('role');
    if (explicitRole) return explicitRole;

    const tag = element.tagName.toLowerCase();
    const type = (element.getAttribute('type') || '').toLowerCase();

    if (tag === 'button') return 'button';
    if (tag === 'a' && element.hasAttribute('href')) return 'link';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'select') return 'combobox';
    if (tag === 'img') return 'img';
    if (tag === 'ul' || tag === 'ol') return 'list';
    if (tag === 'li') return 'listitem';
    if (tag === 'table') return 'table';
    if (tag === 'tr') return 'row';
    if (tag === 'th') return 'columnheader';

    if (tag === 'input') {
      if (['button', 'submit', 'reset'].includes(type)) return 'button';
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'range') return 'slider';
      return 'textbox';
    }

    return null;
  }

  function getStableHook(element) {
    if (!isElementNode(element)) return null;

    for (const attribute of TEST_ID_ATTRIBUTES) {
      const value = element.getAttribute(attribute);
      if (!value) continue;

      return {
        type: attribute,
        value,
        selector: `[${attribute}="${escapeCssAttributeValue(value)}"]`,
      };
    }

    if (element.id && !isLikelyGeneratedIdentifier(element.id)) {
      return {
        type: 'id',
        value: element.id,
        selector: `#${cssEscape(element.id)}`,
      };
    }

    const ariaLabel = element.getAttribute('aria-label');
    if (ariaLabel) {
      return {
        type: 'aria-label',
        value: truncate(ariaLabel, 120),
        selector: `[aria-label="${escapeCssAttributeValue(ariaLabel)}"]`,
      };
    }

    const role = inferRole(element);
    const accessibleNameInfo = getAccessibleNameInfo(element);
    if (shouldUseRoleNameLocator(role, accessibleNameInfo)) {
      return {
        type: 'role-name',
        value: `${role}: ${accessibleNameInfo.name}`,
        role,
        accessibleName: accessibleNameInfo.name,
        accessibleNameSource: accessibleNameInfo.source,
      };
    }

    if (element.id) {
      return {
        type: 'id-fallback',
        value: element.id,
        selector: `#${cssEscape(element.id)}`,
      };
    }

    return null;
  }

  function describeElementBrief(element, depth = 0) {
    if (!isElementNode(element)) return null;

    const tag = element.tagName.toLowerCase();
    const hook = getStableHook(element);
    const role = inferRole(element);
    const text = getTextPreview(element);
    const rect = element.getBoundingClientRect();

    return {
      tag,
      depth,
      id: element.id || null,
      role,
      hook,
      text: text ? truncate(text, 90) : null,
      dimensions: `${Math.round(rect.width)}x${Math.round(rect.height)}`,
    };
  }

  function isVisibleElement(element) {
    if (!isElementNode(element)) return false;

    const rect = element.getBoundingClientRect();
    const styles = window.getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && styles.display !== 'none' && styles.visibility !== 'hidden';
  }

  function findNearestHeading(element) {
    let current = element.parentElement;
    let depth = 0;

    while (current && current !== document.documentElement && depth < 8) {
      const headings = Array.from(current.querySelectorAll('h1,h2,h3,h4,h5,h6,[role="heading"]'))
        .filter((heading) => heading !== element && !heading.contains(element))
        .filter(isVisibleElement);

      const precedingHeadings = headings.filter((heading) => {
        const relation = heading.compareDocumentPosition(element);
        return Boolean(relation & Node.DOCUMENT_POSITION_FOLLOWING);
      });

      const heading = precedingHeadings[precedingHeadings.length - 1];
      const text = heading ? getTextPreview(heading) : '';
      if (text) {
        return {
          text: truncate(text, 120),
          tag: heading.tagName.toLowerCase(),
          depth,
          hook: getStableHook(heading),
        };
      }

      current = current.parentElement;
      depth += 1;
    }

    return null;
  }

  function isSectionLike(element) {
    if (!isElementNode(element)) return false;

    const tag = element.tagName.toLowerCase();
    const role = element.getAttribute('role');

    return (
      ['section', 'article', 'main', 'aside', 'nav', 'header', 'footer', 'form'].includes(tag) ||
      ['region', 'group', 'list', 'grid', 'tabpanel', 'dialog'].includes(role)
    );
  }

  function getAncestorContext(element) {
    const path = [];
    let nearestStableAncestor = null;
    let nearestSection = null;
    let current = element.parentElement;
    let depth = 1;

    while (current && current !== document.documentElement && depth <= 8) {
      if (!isPickerUi(current)) {
        const description = describeElementBrief(current, depth);
        if (description && path.length < 5) {
          path.push(description);
        }

        if (!nearestStableAncestor && description?.hook) {
          nearestStableAncestor = description;
        }

        if (!nearestSection && isSectionLike(current)) {
          nearestSection = description;
        }
      }

      current = current.parentElement;
      depth += 1;
    }

    const sectionHeading = findNearestHeading(element);

    if (!nearestStableAncestor && !nearestSection && !sectionHeading && path.length === 0) {
      return null;
    }

    return {
      nearestStableAncestor,
      nearestSection,
      sectionHeading,
      path,
    };
  }

  function isScrollableOverflow(overflowValue) {
    return ['auto', 'scroll', 'overlay'].includes(overflowValue);
  }

  function isClippingOverflow(overflowValue) {
    return ['hidden', 'clip'].includes(overflowValue);
  }

  function getScrollNodeInfo(element, depth = 0) {
    if (!isElementNode(element)) return null;

    const computed = window.getComputedStyle(element);
    const scrollWidth = Math.round(element.scrollWidth);
    const scrollHeight = Math.round(element.scrollHeight);
    const clientWidth = Math.round(element.clientWidth);
    const clientHeight = Math.round(element.clientHeight);
    const scrollLeft = Math.round(element.scrollLeft);
    const scrollTop = Math.round(element.scrollTop);
    const horizontalOverflow = scrollWidth > clientWidth + 1;
    const verticalOverflow = scrollHeight > clientHeight + 1;
    const canScrollHorizontally = horizontalOverflow && isScrollableOverflow(computed.overflowX);
    const canScrollVertically = verticalOverflow && isScrollableOverflow(computed.overflowY);
    const clipsHorizontal = horizontalOverflow && isClippingOverflow(computed.overflowX);
    const clipsVertical = verticalOverflow && isClippingOverflow(computed.overflowY);
    const hiddenOverflowRight = horizontalOverflow && scrollLeft + clientWidth < scrollWidth - 1;
    const hiddenOverflowBottom = verticalOverflow && scrollTop + clientHeight < scrollHeight - 1;
    const scrollSnapType = computed.scrollSnapType && computed.scrollSnapType !== 'none'
      ? computed.scrollSnapType
      : null;
    const scrollSnapAlign = computed.scrollSnapAlign && computed.scrollSnapAlign !== 'none'
      ? computed.scrollSnapAlign
      : null;

    return {
      element: describeElementBrief(element, depth),
      overflowX: computed.overflowX,
      overflowY: computed.overflowY,
      scrollWidth,
      clientWidth,
      scrollLeft,
      scrollHeight,
      clientHeight,
      scrollTop,
      horizontalOverflow,
      verticalOverflow,
      canScrollHorizontally,
      canScrollVertically,
      clipsHorizontal,
      clipsVertical,
      hiddenOverflowRight,
      hiddenOverflowBottom,
      scrollSnapType,
      scrollSnapAlign,
    };
  }

  function isInterestingScrollNode(info) {
    if (!info) return false;

    return (
      info.horizontalOverflow ||
      info.verticalOverflow ||
      info.canScrollHorizontally ||
      info.canScrollVertically ||
      info.clipsHorizontal ||
      info.clipsVertical ||
      info.scrollSnapType ||
      info.scrollSnapAlign ||
      info.overflowX !== 'visible' ||
      info.overflowY !== 'visible'
    );
  }

  function getScrollDiagnostics(element) {
    const selected = getScrollNodeInfo(element, 0);
    const containers = [];
    let current = element;
    let depth = 0;

    while (current && current !== document.documentElement && depth <= 8) {
      if (!isPickerUi(current)) {
        const info = getScrollNodeInfo(current, depth);
        if (isInterestingScrollNode(info)) {
          containers.push(info);
        }
      }

      current = current.parentElement;
      depth += 1;
    }

    const nearestHorizontalContainer = containers.find((info) => (
      info.canScrollHorizontally ||
      info.clipsHorizontal ||
      info.horizontalOverflow ||
      info.scrollSnapType?.includes('x')
    )) || null;

    const nearestVerticalContainer = containers.find((info) => (
      info.canScrollVertically ||
      info.clipsVertical ||
      info.verticalOverflow ||
      info.scrollSnapType?.includes('y')
    )) || null;

    return {
      selected,
      nearestHorizontalContainer,
      nearestVerticalContainer,
      containers: containers.slice(0, 6),
    };
  }

  function cssMatchCount(selector) {
    try {
      return document.querySelectorAll(selector).length;
    } catch {
      return null;
    }
  }

  function xpathMatchCount(xpath) {
    try {
      const result = document.evaluate(`count(${xpath})`, document, null, XPathResult.NUMBER_TYPE, null);
      return Math.round(result.numberValue);
    } catch {
      return null;
    }
  }

  function attributeMatchCount(attributeName, value, tagName = '*') {
    const selector = `${tagName}[${attributeName}="${escapeCssAttributeValue(value)}"]`;
    return cssMatchCount(selector);
  }

  function exactVisibleTextMatchCount(text) {
    const normalizedTarget = normalizeText(text);
    if (!normalizedTarget) return 0;

    return Array.from(document.querySelectorAll('*')).filter((node) => {
      if (isPickerUi(node)) return false;
      return normalizeText(getTextPreview(node)) === normalizedTarget;
    }).length;
  }

  function isLikelyGeneratedIdentifier(value) {
    const id = String(value || '');
    if (!id) return false;

    return (
      /^:[a-z0-9_-]+:$/i.test(id) ||
      /^[a-z]+[-_][a-f0-9]{8,}$/i.test(id) ||
      (/^[a-z0-9_-]{12,}$/i.test(id) && /\d/.test(id) && !/[-_]/.test(id))
    );
  }

  function roleNameMatchCount(role, accessibleName) {
    if (!role) return null;

    const nodes = Array.from(document.querySelectorAll('*')).filter((node) => inferRole(node) === role);
    if (!accessibleName) return nodes.length;

    const target = normalizeText(accessibleName);
    return nodes.filter((node) => normalizeText(getAccessibleName(node)) === target).length;
  }

  function scoreLocator(locator) {
    const baseByStrategy = {
      'data-testid': 95,
      'data-test-id': 94,
      'data-test': 92,
      'data-cy': 92,
      'data-qa': 91,
      id: 90,
      'role-name': 88,
      'alt-text': 86,
      placeholder: 86,
      label: 84,
      'aria-label': 82,
      title: 78,
      role: 76,
      css: 70,
      xpath: 56,
      text: 52,
      'id-fallback': 50,
    };

    let score = baseByStrategy[locator.strategy] ?? 50;

    if (locator.uniqueCount === 1) {
      score += 10;
    } else if (typeof locator.uniqueCount === 'number' && locator.uniqueCount > 1) {
      score -= Math.min(28, (locator.uniqueCount - 1) * 4);
    } else if (locator.uniqueCount === 0) {
      score -= 20;
    }

    if (locator.selector && locator.selector.includes(':nth-of-type')) {
      score -= 8;
    }

    if (locator.selector && locator.selector.length > 120) {
      score -= 8;
    }

    return Math.max(0, Math.min(100, score));
  }

  function getAssociatedLabelText(element) {
    if (!('labels' in element) || !element.labels || element.labels.length === 0) return '';

    return truncate(
      Array.from(element.labels)
        .map((label) => normalizeWhitespace(label.innerText || label.textContent || ''))
        .filter(Boolean)
        .join(' '),
      120
    );
  }

  function labelMatchCount(labelText) {
    const normalizedTarget = normalizeText(labelText);
    if (!normalizedTarget) return 0;

    return Array.from(document.querySelectorAll('input,textarea,select')).filter((control) => (
      normalizeText(getAssociatedLabelText(control)) === normalizedTarget
    )).length;
  }

  function shouldUseRoleNameLocator(role, accessibleNameInfo) {
    if (!role || !accessibleNameInfo?.name) return false;
    if (accessibleNameInfo.name.length > 90) return false;
    if (accessibleNameInfo.source !== 'visible-text') return true;

    return [
      'button',
      'link',
      'checkbox',
      'radio',
      'switch',
      'tab',
      'menuitem',
      'option',
      'textbox',
      'combobox',
    ].includes(role);
  }

  function buildLocatorCandidates(element, cssSelector, xpath, text) {
    const candidates = [];

    for (const attribute of TEST_ID_ATTRIBUTES) {
      const value = element.getAttribute(attribute);
      if (!value) continue;

      const selector = `[${attribute}="${escapeCssAttributeValue(value)}"]`;
      const uniqueCount = cssMatchCount(selector);

      candidates.push({
        strategy: attribute,
        selector,
        playwright:
          attribute === 'data-testid'
            ? `page.getByTestId(${JSON.stringify(value)})`
            : `page.locator(${JSON.stringify(selector)})`,
        uniqueCount,
      });
    }

    if (element.id) {
      const selector = `#${cssEscape(element.id)}`;
      const uniqueCount = cssMatchCount(selector);
      const generated = isLikelyGeneratedIdentifier(element.id);

      candidates.push({
        strategy: generated ? 'id-fallback' : 'id',
        selector,
        playwright: `page.locator(${JSON.stringify(selector)})`,
        uniqueCount,
        note: generated ? 'id looks generated; keep as a fallback only' : null,
      });
    }

    const role = inferRole(element);
    const accessibleNameInfo = getAccessibleNameInfo(element);
    const accessibleName = accessibleNameInfo?.name || '';

    if (shouldUseRoleNameLocator(role, accessibleNameInfo)) {
      const uniqueCount = roleNameMatchCount(role, accessibleName);
      candidates.push({
        strategy: 'role-name',
        selector: `${role} + ${accessibleName}`,
        playwright: `page.getByRole(${JSON.stringify(role)}, { name: ${JSON.stringify(accessibleName)} })`,
        uniqueCount,
      });
    } else if (role) {
      const uniqueCount = roleNameMatchCount(role, null);
      candidates.push({
        strategy: 'role',
        selector: role,
        playwright: `page.getByRole(${JSON.stringify(role)})`,
        uniqueCount,
      });
    }

    const ariaLabel = element.getAttribute('aria-label');
    if (ariaLabel) {
      const selector = `[aria-label="${escapeCssAttributeValue(ariaLabel)}"]`;
      candidates.push({
        strategy: 'aria-label',
        selector,
        playwright: `page.locator(${JSON.stringify(selector)})`,
        uniqueCount: cssMatchCount(selector),
      });
    }

    if (element.alt) {
      candidates.push({
        strategy: 'alt-text',
        selector: `img[alt="${escapeCssAttributeValue(element.alt)}"]`,
        playwright: `page.getByAltText(${JSON.stringify(element.alt)})`,
        uniqueCount: attributeMatchCount('alt', element.alt, 'img'),
      });
    }

    const placeholder = element.getAttribute('placeholder');
    if (placeholder) {
      candidates.push({
        strategy: 'placeholder',
        selector: `[placeholder="${escapeCssAttributeValue(placeholder)}"]`,
        playwright: `page.getByPlaceholder(${JSON.stringify(placeholder)})`,
        uniqueCount: cssMatchCount(`[placeholder="${escapeCssAttributeValue(placeholder)}"]`),
      });
    }

    const labelText = getAssociatedLabelText(element);
    if (labelText) {
      candidates.push({
        strategy: 'label',
        selector: labelText,
        playwright: `page.getByLabel(${JSON.stringify(labelText)})`,
        uniqueCount: labelMatchCount(labelText),
      });
    }

    const title = element.getAttribute('title');
    if (title) {
      candidates.push({
        strategy: 'title',
        selector: `[title="${escapeCssAttributeValue(title)}"]`,
        playwright: `page.getByTitle(${JSON.stringify(title)})`,
        uniqueCount: cssMatchCount(`[title="${escapeCssAttributeValue(title)}"]`),
      });
    }

    if (cssSelector) {
      const uniqueCount = cssMatchCount(cssSelector);
      candidates.push({
        strategy: 'css',
        selector: cssSelector,
        playwright: `page.locator(${JSON.stringify(cssSelector)})`,
        uniqueCount,
      });
    }

    if (xpath) {
      const uniqueCount = xpathMatchCount(xpath);
      candidates.push({
        strategy: 'xpath',
        selector: xpath,
        playwright: `page.locator(${JSON.stringify(`xpath=${xpath}`)})`,
        uniqueCount,
      });
    }

    if (text) {
      const uniqueCount = exactVisibleTextMatchCount(text);

      if (uniqueCount === 1 && text.length <= 90) {
        candidates.push({
          strategy: 'text',
          selector: text,
          playwright: `page.getByText(${JSON.stringify(text)})`,
          uniqueCount,
        });
      }
    }

    return candidates
      .map((candidate) => ({ ...candidate, score: scoreLocator(candidate) }))
      .sort((a, b) => b.score - a.score);
  }

  function buildElementInfo(element, index) {
    const rect = element.getBoundingClientRect();
    const selector = getCssSelector(element);
    const xpath = getXPath(element);
    const text = getTextPreview(element);
    const classDiagnostics = getClassDiagnostics(element);
    const accessibleNameInfo = getAccessibleNameInfo(element);

    const info = {
      index,
      selectedAt: new Date().toISOString(),
      tag: element.tagName.toLowerCase(),
      id: element.id || null,
      classes: classDiagnostics?.meaningful.join(' ') || null,
      classDiagnostics,
      text,
      accessibleName: accessibleNameInfo?.name || null,
      accessibleNameSource: accessibleNameInfo?.source || null,
      dimensions: `${Math.round(rect.width)}x${Math.round(rect.height)}`,
      viewportRect: toRectObject(rect),
      selector,
      xpath,
      url: window.location.href,
    };

    const locatorCandidates = buildLocatorCandidates(element, selector, xpath, text);
    info.locators = locatorCandidates;
    info.primaryLocator = locatorCandidates[0] || null;

    const reactComponents = getReactInfo(element);
    if (reactComponents) info.reactComponents = reactComponents;

    const reactState = getReactState(element);
    if (reactState) info.reactState = reactState;

    const reactNativeWebProps = getReactNativeWebProps(element);
    if (reactNativeWebProps) info.reactNativeWebProps = reactNativeWebProps;

    const styles = getDebugStyles(element);
    if (styles) info.styles = styles;

    const ancestorContext = getAncestorContext(element);
    if (ancestorContext) info.ancestorContext = ancestorContext;

    const scrollDiagnostics = getScrollDiagnostics(element);
    if (scrollDiagnostics) info.scrollDiagnostics = scrollDiagnostics;

    const formState = getFormState(element);
    if (formState) info.formState = formState;

    const accessibility = getA11yInfo(element);
    if (accessibility) info.accessibility = accessibility;

    const dataAttributes = {};
    for (const attribute of Array.from(element.attributes)) {
      if (attribute.name.startsWith('data-')) {
        dataAttributes[attribute.name] = attribute.value;
      }
    }
    if (Object.keys(dataAttributes).length > 0) {
      info.dataAttributes = dataAttributes;
    }

    const htmlSnippet = getHtmlSnippet(element);
    if (htmlSnippet) info.html = htmlSnippet;

    return info;
  }

  function getTraceAttributesSnapshot(element) {
    const attributes = {};
    const importantNames = new Set([
      'id',
      'class',
      'style',
      'hidden',
      'disabled',
      'aria-hidden',
      'aria-disabled',
      'aria-expanded',
      'aria-selected',
      'aria-busy',
      'role',
      'type',
      'name',
      'value',
      'title',
    ]);

    for (const attribute of Array.from(element.attributes || [])) {
      if (
        importantNames.has(attribute.name) ||
        attribute.name.startsWith('data-') ||
        attribute.name.startsWith('aria-')
      ) {
        attributes[attribute.name] = sanitizeTraceValue(attribute.value, 0, new WeakSet(), attribute.name);
      }
    }

    return attributes;
  }

  function getHiddenAncestorSnapshot(element) {
    let current = element;
    let depth = 0;

    while (current && current !== document.documentElement && depth < 12) {
      if (!isElementNode(current) || isPickerUi(current)) {
        current = current?.parentElement || null;
        depth += 1;
        continue;
      }

      const computed = window.getComputedStyle(current);
      const reason = [];

      if (current.hasAttribute('hidden')) reason.push('hidden attribute');
      if (current.getAttribute('aria-hidden') === 'true') reason.push('aria-hidden=true');
      if (computed.display === 'none') reason.push('display=none');
      if (computed.visibility === 'hidden') reason.push('visibility=hidden');
      if (Number.parseFloat(computed.opacity || '1') === 0) reason.push('opacity=0');

      if (reason.length > 0) {
        return {
          depth,
          reason,
          element: describeElementBrief(current, depth),
          selector: getCssSelector(current),
        };
      }

      current = current.parentElement;
      depth += 1;
    }

    return null;
  }

  function getElementVisibilitySnapshot(element) {
    if (!isElementNode(element) || !element.isConnected) {
      return {
        connected: false,
        visible: false,
        reason: 'disconnected',
      };
    }

    const rect = element.getBoundingClientRect();
    const computed = window.getComputedStyle(element);
    const hiddenAncestor = getHiddenAncestorSnapshot(element);
    const visible = (
      rect.width > 0 &&
      rect.height > 0 &&
      computed.display !== 'none' &&
      computed.visibility !== 'hidden' &&
      Number.parseFloat(computed.opacity || '1') > 0 &&
      !hiddenAncestor
    );

    return {
      connected: true,
      visible,
      inViewport: isVisibleInViewport(rect),
      display: computed.display,
      visibility: computed.visibility,
      opacity: computed.opacity,
      pointerEvents: computed.pointerEvents,
      hidden: element.hasAttribute('hidden'),
      ariaHidden: element.getAttribute('aria-hidden') || null,
      hiddenAncestor,
    };
  }

  function getElementDomSnapshot(element) {
    const text = getTextPreview(element);
    return {
      tag: element.tagName.toLowerCase(),
      id: element.id || null,
      text,
      textLength: normalizeWhitespace(element.innerText || element.textContent || '').length,
      attributes: getTraceAttributesSnapshot(element),
      className: truncate(element.className || '', 240) || null,
    };
  }

  function getElementLayoutSnapshot(element) {
    const rect = toRectObject(element.getBoundingClientRect());
    return {
      viewportRect: rect,
      scroll: {
        left: Math.round(element.scrollLeft || 0),
        top: Math.round(element.scrollTop || 0),
        width: Math.round(element.scrollWidth || 0),
        height: Math.round(element.scrollHeight || 0),
        clientWidth: Math.round(element.clientWidth || 0),
        clientHeight: Math.round(element.clientHeight || 0),
      },
    };
  }

  function getElementReactSnapshot(element) {
    const components = getReactInfo(element);
    const state = getReactState(element);
    const nativeProps = getReactNativeWebProps(element);

    if (!components && !state && !nativeProps) return null;

    return {
      components,
      props: state?.props || null,
      state: state?.state || null,
      nativeProps,
    };
  }

  function getElementFormSnapshot(element) {
    if (!isElementNode(element)) return null;
    const formState = getFormState(element);
    if (!formState) return null;

    const type = String(element.getAttribute('type') || '').toLowerCase();
    const name = element.getAttribute('name') || element.id || '';
    const sanitized = { ...formState };

    if (type === 'password' || shouldRedactTraceKey(name)) {
      if ('value' in sanitized) sanitized.value = '[redacted]';
      if ('validationMessage' in sanitized) sanitized.validationMessage = '[redacted]';
    }

    return sanitized;
  }

  function buildWatchSnapshot(element) {
    if (!isElementNode(element)) {
      return {
        connected: false,
        disconnectedReason: 'not-an-element',
        url: window.location.href,
        capturedAt: new Date().toISOString(),
      };
    }

    if (!element.isConnected) {
      return {
        connected: false,
        disconnectedReason: 'element-disconnected',
        url: window.location.href,
        capturedAt: new Date().toISOString(),
      };
    }

    const snapshot = {
      connected: true,
      url: window.location.href,
      capturedAt: new Date().toISOString(),
      dom: getElementDomSnapshot(element),
      visibility: getElementVisibilitySnapshot(element),
      layout: getElementLayoutSnapshot(element),
    };

    const form = getElementFormSnapshot(element);
    if (form) snapshot.form = form;

    const react = getElementReactSnapshot(element);
    if (react) snapshot.react = react;

    const styles = getDebugStyles(element);
    if (styles) snapshot.styles = styles;

    const scroll = getScrollDiagnostics(element);
    if (scroll?.containers?.length || scroll?.nearestHorizontalContainer || scroll?.nearestVerticalContainer) {
      snapshot.scrollDiagnostics = scroll;
    }

    return cloneForTrace(snapshot);
  }

  function isTraceObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
  }

  function traceValuesEqual(a, b, path = '') {
    if (path.startsWith('layout.viewportRect.') && typeof a === 'number' && typeof b === 'number') {
      return Math.abs(a - b) < 1;
    }

    return JSON.stringify(a) === JSON.stringify(b);
  }

  function diffTraceValues(before, after, path = '', diffs = []) {
    if (diffs.length >= TRACE_MAX_DIFFS_PER_SAMPLE) return diffs;

    if (traceValuesEqual(before, after, path)) return diffs;

    if (Array.isArray(before) || Array.isArray(after)) {
      diffs.push({
        path: path || 'value',
        before: cloneForTrace(before),
        after: cloneForTrace(after),
      });
      return diffs;
    }

    if (isTraceObject(before) && isTraceObject(after)) {
      const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
      for (const key of keys) {
        if (key === 'capturedAt') continue;
        diffTraceValues(before[key], after[key], path ? `${path}.${key}` : key, diffs);
        if (diffs.length >= TRACE_MAX_DIFFS_PER_SAMPLE) break;
      }
      return diffs;
    }

    diffs.push({
      path: path || 'value',
      before: cloneForTrace(before),
      after: cloneForTrace(after),
    });
    return diffs;
  }

  function clearSelections() {
    selections = [];
    updateBadges();
    updateToolbarState();
    updateTraceUi();
  }

  function addSelection(element, options = {}) {
    const { silent = false } = options;
    if (!isElementNode(element) || isPickerUi(element)) return;

    if (selections.some((selection) => selection.element === element)) {
      if (!silent) {
        showToast('Element already added. Press Enter to export or keep selecting.');
      }
      return;
    }

    if (selections.length >= MAX_SELECTIONS) {
      if (!silent) {
        showToast(`Selection limit reached (${MAX_SELECTIONS}). Press Enter to export.`);
      }
      return;
    }

    const info = buildElementInfo(element, selections.length + 1);
    selections.push({ element, info });
    updateBadges();
    updateToolbarState();
    updateTraceUi();

    const count = selections.length;
    if (!silent) {
      showToast(
        `Added ${count} ${pluralize(count, 'element', 'elements')}. Send to Codex, Copy, or keep selecting.`,
        1600
      );
    }
  }

  function removeLastSelection() {
    if (selections.length === 0) {
      showToast('No selected elements to remove.');
      return;
    }

    const removed = selections.pop();
    updateBadges();
    updateToolbarState();
    updateTraceUi();

    const label = `${removed.info.tag}${removed.info.id ? `#${removed.info.id}` : ''}`;
    showToast(`Removed ${label}. ${selections.length} selected.`);
  }

  function getWatchTargetLabel(element) {
    const accessibleName = getAccessibleName(element);
    const text = getTextPreview(element);
    const role = inferRole(element);
    const tag = element.tagName.toLowerCase();

    if (accessibleName) return truncate(accessibleName, 64);
    if (text) return truncate(text, 64);
    if (role) return `${role} ${tag}`;
    if (element.id) return `${tag}#${element.id}`;
    return tag;
  }

  function getWatchTargetLocator(element) {
    const selector = getCssSelector(element);
    const xpath = getXPath(element);
    const text = getTextPreview(element);
    const locatorCandidates = buildLocatorCandidates(element, selector, xpath, text);
    const primary = locatorCandidates[0] || null;

    return {
      selector,
      xpath,
      primary,
      candidates: locatorCandidates.slice(0, 6),
    };
  }

  function getSerializableWatchTargets() {
    return watchTargets.map((target) => ({
      watchId: target.watchId,
      kind: target.kind,
      label: target.label,
      createdAt: target.createdAt,
      selector: target.selector || null,
      locator: target.locator || null,
      source: target.source || null,
      latestSampleAt: target.latestSampleAt || null,
      latestSnapshot: target.latestSnapshot || null,
    }));
  }

  function addElementWatchTarget(element, source = {}) {
    if (!isElementNode(element) || isPickerUi(element)) return null;

    const existing = watchTargets.find((target) => target.kind === 'element' && target.element === element);
    if (existing) {
      showToast(`Already watching ${existing.label}.`, 1500);
      return existing;
    }

    const locator = getWatchTargetLocator(element);
    const watchId = `watch-${watchTargetCounter++}`;
    const snapshot = buildWatchSnapshot(element);
    const target = {
      watchId,
      kind: 'element',
      label: getWatchTargetLabel(element),
      createdAt: new Date().toISOString(),
      element,
      selector: locator.selector,
      locator: {
        type: locator.primary?.strategy || 'css',
        value: locator.primary?.playwright || locator.selector,
        selector: locator.primary?.selector || locator.selector,
      },
      locatorCandidates: locator.candidates,
      source,
      latestSnapshot: snapshot,
      latestSampleAt: null,
    };

    watchTargets.push(target);
    if (isTraceRecording) {
      sampleWatchTarget(target, { force: true, reason: 'watch.added' });
    }
    updateTraceUi();
    return target;
  }

  function addAppWatchTarget(name, value, options = {}) {
    const safeName = normalizeWhitespace(name || 'App value') || 'App value';
    const watchId = `app-${slugifyTracePart(safeName)}`;
    let target = watchTargets.find((item) => item.watchId === watchId);

    if (!target) {
      target = {
        watchId,
        kind: 'app',
        label: safeName,
        createdAt: new Date().toISOString(),
        source: { selectedBy: 'vibe-debugger-app-probe', options: sanitizeTraceValue(options) },
        latestSnapshot: null,
        latestSampleAt: null,
      };
      watchTargets.push(target);
    }

    const snapshot = {
      connected: true,
      capturedAt: new Date().toISOString(),
      app: {
        name: safeName,
        value: sanitizeTraceValue(value),
        options: sanitizeTraceValue(options),
      },
    };
    const previous = target.latestSnapshot;
    const diffs = previous ? diffTraceValues(previous, snapshot) : [];
    target.latestSnapshot = snapshot;

    if (isTraceRecording && (!previous || diffs.length > 0)) {
      const cause = getTraceCause() || {
        eventId: null,
        kind: 'app.watch',
        label: safeName,
        confidence: 'direct',
      };
      const sample = {
        sampleId: `sample-${traceSampleCounter++}`,
        watchId,
        timeOffsetMs: getTraceTimeOffsetMs(),
        causeEventId: cause.eventId || null,
        cause,
        snapshot,
        diffs: previous ? diffs : [{
          path: 'app.value',
          before: undefined,
          after: snapshot.app.value,
        }],
        reason: 'app.watch',
        confidence: 'direct',
      };
      pushBoundedTraceItem(traceSamples, sample, TRACE_MAX_SAMPLES, 'samples');
    }

    updateTraceUi();
    return target;
  }

  function watchCurrentSelection() {
    const elements = selections.length > 0
      ? selections.map((selection) => selection.element).filter((element) => isElementNode(element))
      : currentElement
        ? [currentElement]
        : [];

    if (elements.length === 0) {
      showToast('Hover or select an element before adding a watch.', 2200);
      return;
    }

    const before = watchTargets.length;
    elements.forEach((element, index) => {
      addElementWatchTarget(element, {
        selectionIndex: index + 1,
        selectedBy: selections.length > 0 ? 'qa-bridge-selection' : 'qa-bridge-hover',
      });
    });

    const added = watchTargets.length - before;
    tracePanelOpen = true;
    ensureTracePanel();
    updateTraceUi();
    showToast(
      added > 0
        ? `Watching ${watchTargets.length} ${pluralize(watchTargets.length, 'target', 'targets')}.`
        : 'No new watch targets were added.',
      2200
    );
  }

  function clearTraceData(options = {}) {
    const { keepWatchTargets = true } = options;
    isTraceRecording = false;
    traceStartedAt = null;
    traceStartedAtMs = 0;
    traceEndedAt = null;
    traceEndedAtMs = 0;
    traceEvents = [];
    traceSamples = [];
    traceMutations = [];
    traceNetwork = [];
    traceConsole = [];
    traceTrimmed = {};
    activeTraceCause = null;
    latestTraceManifest = null;
    traceEventCounter = 1;
    traceSampleCounter = 1;

    stopMutationRecording();
    if (watchSampleTimer) {
      window.clearTimeout(watchSampleTimer);
      watchSampleTimer = null;
    }

    if (!keepWatchTargets) {
      watchTargets = [];
    }

    updateTraceUi();
  }

  function recordTraceEvent(kind, label, details = {}, options = {}) {
    if (!isTraceRecording && !options.always) return null;

    const event = {
      eventId: `evt-${traceEventCounter++}`,
      timeOffsetMs: getTraceTimeOffsetMs(),
      kind,
      label: label || kind,
      details: sanitizeTraceValue(details),
      url: window.location.href,
    };

    if (details?.target) event.target = details.target;
    pushBoundedTraceItem(traceEvents, event, TRACE_MAX_EVENTS, 'events');

    if (options.cause !== false) {
      setTraceCause(event, options.confidence || 'strong', options.causeWindowMs || TRACE_CAUSE_WINDOW_MS);
    }

    if (options.sample !== false) {
      scheduleWatchSample(kind, options.sampleDelayMs ?? TRACE_SAMPLE_DELAY_MS);
    }

    updateTraceUi();
    return event;
  }

  function sampleWatchTarget(target, options = {}) {
    if (!target) return null;

    let snapshot;
    if (target.kind === 'element') {
      snapshot = buildWatchSnapshot(target.element);
    } else {
      snapshot = target.latestSnapshot || {
        connected: true,
        capturedAt: new Date().toISOString(),
        app: {
          name: target.label,
          value: null,
        },
      };
    }

    const previous = target.latestSnapshot;
    const diffs = previous ? diffTraceValues(previous, snapshot) : [];
    const hasDiffs = diffs.length > 0;

    target.latestSnapshot = snapshot;

    if (!isTraceRecording && !options.force) {
      updateTraceUi();
      return null;
    }

    if (!options.force && !hasDiffs) {
      updateTraceUi();
      return null;
    }

    const cause = getTraceCause();
    const sample = {
      sampleId: `sample-${traceSampleCounter++}`,
      watchId: target.watchId,
      timeOffsetMs: getTraceTimeOffsetMs(),
      causeEventId: cause?.eventId || null,
      cause,
      snapshot,
      diffs: previous ? diffs : [{
        path: 'snapshot',
        before: undefined,
        after: snapshot,
      }],
      reason: options.reason || 'watch.sample',
      confidence: cause?.confidence || (options.force ? 'direct' : 'inferred'),
    };

    target.latestSampleAt = new Date().toISOString();
    pushBoundedTraceItem(traceSamples, sample, TRACE_MAX_SAMPLES, 'samples');
    updateTraceUi();
    return sample;
  }

  function sampleAllWatchTargets(reason = 'watch.sample') {
    if (watchTargets.length === 0) return;
    watchTargets.forEach((target) => sampleWatchTarget(target, { reason }));
  }

  function scheduleWatchSample(reason = 'event', delay = TRACE_SAMPLE_DELAY_MS) {
    if (watchTargets.length === 0) return;
    if (watchSampleTimer) {
      window.clearTimeout(watchSampleTimer);
    }
    watchSampleTimer = window.setTimeout(() => {
      watchSampleTimer = null;
      sampleAllWatchTargets(reason);
    }, delay);
  }

  function startMutationRecording() {
    if (mutationObserver || !document.documentElement) return;

    mutationObserver = new MutationObserver((mutations) => {
      if (!isTraceRecording) return;

      queuedMutations.push(...mutations.map(summarizeMutation).filter(Boolean));
      if (queuedMutations.length > 80) {
        queuedMutations = queuedMutations.slice(-80);
      }

      if (!mutationFlushTimer) {
        mutationFlushTimer = window.setTimeout(flushMutationQueue, TRACE_MUTATION_FLUSH_MS);
      }
    });

    mutationObserver.observe(document.documentElement, {
      attributes: true,
      childList: true,
      subtree: true,
      characterData: true,
      attributeOldValue: true,
      characterDataOldValue: false,
    });
  }

  function stopMutationRecording() {
    if (mutationObserver) {
      mutationObserver.disconnect();
      mutationObserver = null;
    }

    if (mutationFlushTimer) {
      window.clearTimeout(mutationFlushTimer);
      mutationFlushTimer = null;
    }
    queuedMutations = [];
  }

  function isMutationRelatedToWatchTarget(node, target) {
    if (!node || target.kind !== 'element' || !target.element) return false;
    if (!isElementNode(node)) {
      node = node.parentElement || null;
    }
    if (!node || !isElementNode(node)) return false;
    return node === target.element || node.contains(target.element) || target.element.contains(node);
  }

  function summarizeMutation(mutation) {
    const targetNode = mutation.target?.nodeType === Node.TEXT_NODE
      ? mutation.target.parentElement
      : mutation.target;

    if (!isElementNode(targetNode) || isPickerUi(targetNode)) return null;

    const relatedWatchIds = watchTargets
      .filter((target) => isMutationRelatedToWatchTarget(targetNode, target))
      .map((target) => target.watchId);

    return {
      type: mutation.type,
      attributeName: mutation.attributeName || null,
      oldValue: mutation.attributeName ? sanitizeTraceValue(mutation.oldValue, 0, new WeakSet(), mutation.attributeName) : null,
      target: describeElementBrief(targetNode),
      selector: getCssSelector(targetNode),
      addedNodes: mutation.addedNodes?.length || 0,
      removedNodes: mutation.removedNodes?.length || 0,
      relatedWatchIds,
    };
  }

  function flushMutationQueue() {
    mutationFlushTimer = null;
    if (!isTraceRecording || queuedMutations.length === 0) {
      queuedMutations = [];
      return;
    }

    const mutations = queuedMutations.splice(0, queuedMutations.length);
    const relatedWatchIds = Array.from(new Set(mutations.flatMap((mutation) => mutation.relatedWatchIds || [])));
    const summary = {
      mutationId: `mut-${traceMutations.length + 1}`,
      timeOffsetMs: getTraceTimeOffsetMs(),
      count: mutations.length,
      relatedWatchIds,
      items: mutations.slice(0, 20),
    };

    pushBoundedTraceItem(traceMutations, summary, TRACE_MAX_MUTATIONS, 'mutations');
    recordTraceEvent(
      'dom.mutation',
      relatedWatchIds.length
        ? `DOM changed near ${relatedWatchIds.join(', ')}`
        : `${mutations.length} DOM ${pluralize(mutations.length, 'mutation', 'mutations')}`,
      {
        count: mutations.length,
        relatedWatchIds,
        first: mutations[0],
      },
      { confidence: 'inferred', causeWindowMs: 500, sampleDelayMs: 40 }
    );
  }

  function resetTraceBuffers() {
    traceEvents = [];
    traceSamples = [];
    traceMutations = [];
    traceNetwork = [];
    traceConsole = [];
    traceTrimmed = {};
    activeTraceCause = null;
    traceEventCounter = 1;
    traceSampleCounter = 1;
  }

  function startTraceRecording() {
    if (isTraceRecording) return;

    if (watchTargets.length === 0 && selections.length > 0) {
      selections.forEach((selection, index) => {
        addElementWatchTarget(selection.element, {
          selectionIndex: index + 1,
          selectedBy: 'qa-bridge-selection',
        });
      });
    } else if (watchTargets.length === 0 && currentElement) {
      addElementWatchTarget(currentElement, {
        selectedBy: 'qa-bridge-hover',
      });
    }

    resetTraceBuffers();
    isTraceRecording = true;
    traceStartedAt = new Date().toISOString();
    traceStartedAtMs = performance.now();
    traceEndedAt = null;
    traceEndedAtMs = 0;
    latestTraceManifest = null;
    startMutationRecording();
    recordTraceEvent('trace.start', 'Trace recording started', {
      watchTargets: watchTargets.length,
    }, { always: true, cause: false, sample: false });
    watchTargets.forEach((target) => sampleWatchTarget(target, { force: true, reason: 'trace.start' }));
    tracePanelOpen = true;
    ensureTracePanel();
    updateTraceUi();
    showToast(`Vibe trace recording. Watching ${watchTargets.length} ${pluralize(watchTargets.length, 'target', 'targets')}.`, 2600);
  }

  function stopTraceRecording(options = {}) {
    if (!isTraceRecording) return;

    sampleAllWatchTargets('trace.stop');
    recordTraceEvent('trace.stop', 'Trace recording stopped', {}, { always: true, cause: false, sample: false });
    isTraceRecording = false;
    traceEndedAt = new Date().toISOString();
    traceEndedAtMs = performance.now();
    stopMutationRecording();
    updateTraceUi();

    if (!options.silent) {
      showToast('Vibe trace stopped. Use Send Trace to hand it to Codex.', 2400);
    }
  }

  function toggleTraceRecording() {
    if (isTraceRecording) {
      stopTraceRecording();
    } else {
      startTraceRecording();
    }
  }

  function formatTraceValue(value) {
    if (value === null) return 'null';
    if (value === undefined) return 'undefined';
    if (typeof value === 'string') return truncate(value, 120);
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);

    try {
      const json = JSON.stringify(value);
      return truncate(json, 160);
    } catch {
      return '[unserializable]';
    }
  }

  function formatTraceDiff(diff) {
    return `${diff.path || 'value'}: ${formatTraceValue(diff.before)} -> ${formatTraceValue(diff.after)}`;
  }

  function getRecentDiffSamples(limit = 20) {
    return traceSamples
      .filter((sample) => Array.isArray(sample.diffs) && sample.diffs.length > 0)
      .slice(-limit);
  }

  function buildTraceSummaries() {
    const summaries = [];

    for (const target of watchTargets) {
      const snapshot = target.latestSnapshot;
      if (!snapshot) continue;

      if (snapshot.connected === false) {
        summaries.push({
          kind: 'stale',
          watchId: target.watchId,
          title: `${target.label} is stale`,
          body: 'The watched element disconnected from the DOM.',
          confidence: 'direct',
        });
        continue;
      }

      const visibility = snapshot.visibility;
      if (visibility && !visibility.visible) {
        const hiddenAncestor = visibility.hiddenAncestor;
        const reason = hiddenAncestor
          ? `${hiddenAncestor.reason.join(', ')} on ${formatBriefElement(hiddenAncestor.element)}`
          : `display=${visibility.display}, visibility=${visibility.visibility}, opacity=${visibility.opacity}`;
        summaries.push({
          kind: 'hidden',
          watchId: target.watchId,
          title: `${target.label} is hidden`,
          body: reason,
          confidence: hiddenAncestor ? 'strong' : 'direct',
        });
      }

      const disabledAttr = snapshot.dom?.attributes?.disabled !== undefined ||
        snapshot.dom?.attributes?.['aria-disabled'] === 'true' ||
        snapshot.form?.disabled === true ||
        snapshot.react?.props?.disabled === true;

      if (disabledAttr) {
        summaries.push({
          kind: 'disabled',
          watchId: target.watchId,
          title: `${target.label} is disabled`,
          body: snapshot.react?.props?.disabled === true
            ? 'React props include disabled=true.'
            : 'The DOM or form state marks the target disabled.',
          confidence: snapshot.react?.props?.disabled === true ? 'strong' : 'direct',
        });
      }

      if (snapshot.dom && snapshot.dom.textLength === 0 && visibility?.visible) {
        summaries.push({
          kind: 'empty',
          watchId: target.watchId,
          title: `${target.label} has no visible text`,
          body: 'The target is visible but its text snapshot is empty.',
          confidence: 'direct',
        });
      }
    }

    return summaries.slice(0, 40);
  }

  function buildTracePayload() {
    const endedAt = traceEndedAt || new Date().toISOString();
    const endMs = isTraceRecording ? performance.now() : (traceEndedAtMs || performance.now());
    const durationMs = traceStartedAtMs
      ? Math.round(endMs - traceStartedAtMs)
      : 0;

    return {
      schemaVersion: TRACE_SCHEMA_VERSION,
      traceId: `${new Date().toISOString()
        .replace(/\.\d+Z$/, 'Z')
        .replace(/[:]/g, '')
        .replace(/[TZ]/g, '-')
        .replace(/-$/, '')}-${slugifyTracePart(window.location.hostname || 'page')}`,
      page: {
        title: document.title,
        url: window.location.href,
        referrer: document.referrer || null,
      },
      startedAt: traceStartedAt || new Date().toISOString(),
      endedAt,
      durationMs,
      browserContext: getBrowserContextSnapshot(),
      userComment: getUserComment(),
      watchTargets: getSerializableWatchTargets(),
      events: traceEvents,
      samples: traceSamples,
      mutations: traceMutations,
      network: traceNetwork,
      console: traceConsole,
      summaries: buildTraceSummaries(),
      trimmed: Object.keys(traceTrimmed).length > 0 ? traceTrimmed : null,
    };
  }

  function formatTraceMarkdown(trace) {
    const lines = [
      '# Vibe Debugger Trace',
      '',
      `Captured at: ${trace.endedAt}`,
      `URL: ${trace.page.url}`,
      `Title: ${trace.page.title}`,
      `Duration: ${trace.durationMs} ms`,
      `Recording active at export: ${isTraceRecording ? 'yes' : 'no'}`,
      `Watch targets: ${trace.watchTargets.length}`,
      `Events: ${trace.events.length}`,
      `Samples: ${trace.samples.length}`,
      `Mutations: ${trace.mutations.length}`,
      '',
    ];

    if (trace.userComment) {
      lines.push('## User Comment', '', trace.userComment, '');
    }

    if (trace.watchTargets.length > 0) {
      lines.push('## Watch Targets', '');
      trace.watchTargets.forEach((target) => {
        lines.push(`- ${target.watchId}: ${target.label} (${target.kind})`);
      });
      lines.push('');
    }

    if (trace.summaries.length > 0) {
      lines.push('## Current Explanations', '');
      trace.summaries.forEach((summary) => {
        lines.push(`- ${summary.title}: ${summary.body} (${summary.confidence || 'inferred'})`);
      });
      lines.push('');
    }

    const recentDiffs = getRecentDiffSamples(30);
    if (recentDiffs.length > 0) {
      lines.push('## Recent Diffs', '');
      recentDiffs.forEach((sample) => {
        const target = watchTargets.find((item) => item.watchId === sample.watchId);
        const cause = sample.cause?.label || sample.causeEventId || 'unknown cause';
        lines.push(`### +${sample.timeOffsetMs} ms - ${target?.label || sample.watchId} (${cause})`);
        sample.diffs.slice(0, 10).forEach((diff) => {
          lines.push(`- ${formatTraceDiff(diff)}`);
        });
        lines.push('');
      });
    }

    if (trace.events.length > 0) {
      lines.push('## Timeline', '');
      trace.events.slice(-80).forEach((event) => {
        lines.push(`- +${event.timeOffsetMs} ms ${event.kind}: ${event.label}`);
      });
      lines.push('');
    }

    lines.push('## JSON Trace');
    lines.push('```json');
    lines.push(JSON.stringify(trace, null, 2));
    lines.push('```');

    return lines.join('\n');
  }

  async function sendTraceToCodex() {
    if (watchTargets.length === 0 && traceEvents.length === 0) {
      showToast('No trace yet. Add a watch or start recording first.', 2600);
      return;
    }

    if (isTraceRecording) {
      sampleAllWatchTargets('trace.export');
    }

    const trace = buildTracePayload();
    const markdown = formatTraceMarkdown(trace);
    showToast('Sending vibe trace to Codex QA inbox...', 2400);

    try {
      const response = await chrome.runtime.sendMessage({
        type: 'ELEMENT_PICKER_SEND_TRACE_TO_CODEX',
        traceUrl: CODEX_TRACE_URL,
        trace,
        markdown,
      });

      if (!response?.ok) {
        throw new Error(response?.error || 'Codex QA inbox did not accept the trace');
      }

      latestTraceManifest = {
        traceId: response.traceId || null,
        traceDir: response.traceDir || null,
        latestDir: response.latestDir || null,
      };
      updateTraceUi();
      setInboxHealth('online');
      showToast(`Saved vibe trace ${response.traceId || ''}. Tell Codex: "look at latest trace."`, 4200);
    } catch (error) {
      console.error('Failed to send vibe trace:', error);
      setInboxHealth('offline');
      showToast(`Trace send failed: ${error?.message || 'start the Codex QA inbox server'}`, 4200);
    }
  }

  function getEventTargetSummary(target) {
    if (!isElementNode(target) || isPickerUi(target)) return null;
    const summary = describeElementBrief(target);

    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) {
      const key = target.getAttribute('name') || target.id || target.getAttribute('autocomplete') || '';
      if (target.type === 'password' || shouldRedactTraceKey(key)) {
        summary.value = '[redacted]';
      } else if (target.type === 'checkbox' || target.type === 'radio') {
        summary.checked = target.checked;
      } else {
        summary.value = truncate(target.value || '', 120);
      }
    }

    summary.selector = getCssSelector(target);
    return summary;
  }

  function onRecordedUserEvent(event) {
    if (!isTraceRecording || isPickerUi(event.target)) return;

    const target = getEventTargetSummary(event.target);
    if (!target) return;

    const details = {
      eventType: event.type,
      target,
      key: event.type === 'keydown' ? event.key : null,
      inputType: event.inputType || null,
    };

    recordTraceEvent(`user.${event.type}`, `${event.type} ${target.text || target.role || target.tag}`, details, {
      confidence: 'strong',
      sampleDelayMs: event.type === 'input' ? 120 : TRACE_SAMPLE_DELAY_MS,
    });
  }

  function recordExternalProbeEvent(data) {
    if (!data || data.source !== 'element-picker-vibe-probe') return;

    const kind = data.kind || 'probe.event';
    const details = sanitizeTraceValue(data.details || {});

    if (kind.startsWith('route.')) {
      pauseForBreakOnLoad('route change');
    }

    if (kind === 'app.watch') {
      addAppWatchTarget(details.name, details.value, details.options || {});
      recordTraceEvent(kind, `watch ${details.name || 'app value'}`, details, {
        confidence: 'direct',
        causeWindowMs: TRACE_CAUSE_WINDOW_MS,
        sample: false,
      });
      return;
    }

    if (!isTraceRecording) return;

    if (kind.startsWith('network.')) {
      const networkEvent = {
        networkId: data.eventId || `network-${traceNetwork.length + 1}`,
        timeOffsetMs: getTraceTimeOffsetMs(),
        kind,
        details,
      };
      pushBoundedTraceItem(traceNetwork, networkEvent, TRACE_MAX_NETWORK, 'network');
    } else if (kind.startsWith('console.')) {
      const consoleEvent = {
        consoleId: data.eventId || `console-${traceConsole.length + 1}`,
        timeOffsetMs: getTraceTimeOffsetMs(),
        kind,
        details,
      };
      pushBoundedTraceItem(traceConsole, consoleEvent, TRACE_MAX_CONSOLE, 'console');
    }

    const label = details.name ||
      details.url ||
      details.to ||
      details.key ||
      kind.replace(/\./g, ' ');
    const confidence = kind.startsWith('app.') ? 'direct' : kind.startsWith('network.') ? 'strong' : 'inferred';
    recordTraceEvent(kind, `${kind}: ${truncate(label, 80)}`, details, {
      confidence,
      sampleDelayMs: kind.endsWith('.end') || kind.endsWith('.fire') ? 80 : 20,
      causeWindowMs: kind.startsWith('network.') ? 1200 : TRACE_CAUSE_WINDOW_MS,
    });
  }

  function onVibeProbeMessage(event) {
    if (event.source !== window) return;
    recordExternalProbeEvent(event.data);
  }

  function createTracePanelButton(label, onClick, variant = 'secondary', title = '') {
    const button = document.createElement('button');
    markPickerUi(button);
    button.type = 'button';
    button.textContent = label;
    button.title = title || label;
    button.setAttribute('aria-label', title || label);
    button.className = `element-picker-trace-button element-picker-trace-button-${variant}`;
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      onClick();
    });
    return button;
  }

  function ensureTracePanel() {
    if (tracePanel) return tracePanel;

    tracePanel = document.createElement('div');
    tracePanel.id = TRACE_PANEL_ID;
    markPickerUi(tracePanel);
    document.body.appendChild(tracePanel);
    return tracePanel;
  }

  function toggleTracePanel() {
    tracePanelOpen = !tracePanelOpen;
    if (tracePanelOpen) {
      ensureTracePanel();
    }
    updateTraceUi();
  }

  function getTraceStatusText() {
    if (isTraceRecording) {
      return `Recording +${getTraceTimeOffsetMs()} ms`;
    }
    if (traceEndedAt) {
      return `Stopped at ${new Date(traceEndedAt).toLocaleTimeString()}`;
    }
    return 'Ready';
  }

  function renderTracePanel() {
    if (!tracePanelOpen) {
      if (tracePanel) tracePanel.style.display = 'none';
      return;
    }

    const panel = ensureTracePanel();
    panel.style.display = 'block';
    panel.textContent = '';

    const header = document.createElement('div');
    header.className = 'element-picker-trace-header';

    const title = document.createElement('div');
    title.className = 'element-picker-trace-title';
    title.textContent = 'Vibe Debugger';

    const status = document.createElement('div');
    status.className = 'element-picker-trace-status';
    status.textContent = getTraceStatusText();

    header.append(title, status);

    const metrics = document.createElement('div');
    metrics.className = 'element-picker-trace-metrics';
    metrics.textContent = `${watchTargets.length} watched | ${traceEvents.length} events | ${getRecentDiffSamples(999).length} diffs`;

    const controls = document.createElement('div');
    controls.className = 'element-picker-trace-controls';
    controls.append(
      createTracePanelButton('Watch selected', watchCurrentSelection, 'secondary', TRACE_ACTION_HELP.watch),
      createTracePanelButton(isTraceRecording ? 'Stop' : 'Record', toggleTraceRecording, isTraceRecording ? 'danger' : 'primary', TRACE_ACTION_HELP.record),
      createTracePanelButton('Send Trace', sendTraceToCodex, 'primary', TRACE_ACTION_HELP.send),
      createTracePanelButton('Clear', () => {
        clearTraceData({ keepWatchTargets: true });
        showToast('Trace timeline cleared. Watch targets kept.', 1800);
      }, 'secondary', 'Clear the trace timeline while keeping watched targets.'),
      createTracePanelButton('Close', () => {
        tracePanelOpen = false;
        updateTraceUi();
      }, 'secondary', 'Close the Vibe Debugger panel.')
    );

    const watchSection = document.createElement('div');
    watchSection.className = 'element-picker-trace-section';
    const watchHeading = document.createElement('div');
    watchHeading.className = 'element-picker-trace-section-title';
    watchHeading.textContent = 'Watch Window';
    watchSection.appendChild(watchHeading);

    if (watchTargets.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'element-picker-trace-empty';
      empty.textContent = 'Select or hover a page element, then click Watch selected.';
      watchSection.appendChild(empty);
    } else {
      watchTargets.slice(-8).forEach((target) => {
        const row = document.createElement('div');
        row.className = 'element-picker-trace-watch-row';

        const name = document.createElement('div');
        name.className = 'element-picker-trace-watch-name';
        name.textContent = `${target.label} (${target.watchId})`;

        const snapshot = target.latestSnapshot;
        const state = document.createElement('div');
        state.className = 'element-picker-trace-watch-state';
        if (!snapshot) {
          state.textContent = 'No sample yet';
        } else if (snapshot.connected === false) {
          state.textContent = 'stale / disconnected';
        } else if (target.kind === 'app') {
          state.textContent = formatTraceValue(snapshot.app?.value);
        } else {
          const visibleText = snapshot.visibility?.visible ? 'visible' : 'hidden';
          const domText = snapshot.dom?.text ? ` | "${truncate(snapshot.dom.text, 54)}"` : '';
          state.textContent = `${visibleText}${domText}`;
        }

        row.append(name, state);
        watchSection.appendChild(row);
      });
    }

    const summarySection = document.createElement('div');
    summarySection.className = 'element-picker-trace-section';
    const summaryHeading = document.createElement('div');
    summaryHeading.className = 'element-picker-trace-section-title';
    summaryHeading.textContent = 'Why';
    summarySection.appendChild(summaryHeading);
    const summaries = buildTraceSummaries();
    if (summaries.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'element-picker-trace-empty';
      empty.textContent = 'No hidden, disabled, empty, or stale explanation yet.';
      summarySection.appendChild(empty);
    } else {
      summaries.slice(0, 6).forEach((summary) => {
        const row = document.createElement('div');
        row.className = 'element-picker-trace-summary-row';
        row.textContent = `${summary.title}: ${summary.body}`;
        summarySection.appendChild(row);
      });
    }

    const diffSection = document.createElement('div');
    diffSection.className = 'element-picker-trace-section';
    const diffHeading = document.createElement('div');
    diffHeading.className = 'element-picker-trace-section-title';
    diffHeading.textContent = 'Recent Diffs';
    diffSection.appendChild(diffHeading);
    const recentDiffs = getRecentDiffSamples(8);
    if (recentDiffs.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'element-picker-trace-empty';
      empty.textContent = 'No watched value changes recorded yet.';
      diffSection.appendChild(empty);
    } else {
      recentDiffs.reverse().forEach((sample) => {
        const target = watchTargets.find((item) => item.watchId === sample.watchId);
        const row = document.createElement('div');
        row.className = 'element-picker-trace-diff-row';

        const label = document.createElement('div');
        label.className = 'element-picker-trace-diff-label';
        label.textContent = `+${sample.timeOffsetMs} ms ${target?.label || sample.watchId}`;

        const body = document.createElement('div');
        body.className = 'element-picker-trace-diff-body';
        body.textContent = sample.diffs.slice(0, 3).map(formatTraceDiff).join(' | ');

        const cause = document.createElement('div');
        cause.className = 'element-picker-trace-diff-cause';
        cause.textContent = `Cause: ${sample.cause?.label || 'unknown'} (${sample.confidence || 'inferred'})`;

        row.append(label, body, cause);
        diffSection.appendChild(row);
      });
    }

    const eventSection = document.createElement('div');
    eventSection.className = 'element-picker-trace-section';
    const eventHeading = document.createElement('div');
    eventHeading.className = 'element-picker-trace-section-title';
    eventHeading.textContent = 'Timeline';
    eventSection.appendChild(eventHeading);
    const recentEvents = traceEvents.slice(-10).reverse();
    if (recentEvents.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'element-picker-trace-empty';
      empty.textContent = 'Record user actions, route changes, network calls, timers, and app probes.';
      eventSection.appendChild(empty);
    } else {
      recentEvents.forEach((traceEvent) => {
        const row = document.createElement('div');
        row.className = 'element-picker-trace-event-row';
        row.textContent = `+${traceEvent.timeOffsetMs} ms ${traceEvent.kind}: ${truncate(traceEvent.label, 86)}`;
        eventSection.appendChild(row);
      });
    }

    const footer = document.createElement('div');
    footer.className = 'element-picker-trace-footer';
    footer.textContent = latestTraceManifest?.latestDir
      ? `Latest sent: ${latestTraceManifest.latestDir}`
      : 'Trace exports write to ~/CodexInbox/web-qa/traces/latest.';

    panel.append(header, metrics, controls, watchSection, summarySection, diffSection, eventSection, footer);
  }

  function updateTraceUi() {
    if (vibeToggleButton) {
      const caret = vibeGroupOpen ? '▴' : '▾';
      const activitySuffix = isTraceRecording
        ? ' ●'
        : watchTargets.length
          ? ` ${watchTargets.length}`
          : '';
      vibeToggleButton.textContent = `Vibe${activitySuffix} ${caret}`;
      vibeToggleButton.classList.toggle('element-picker-toolbar-button-danger', isTraceRecording);
      vibeToggleButton.title = isTraceRecording
        ? 'Recording a Vibe trace. Click to show or hide the controls.'
        : watchTargets.length
          ? `${watchTargets.length} Vibe watch ${pluralize(watchTargets.length, 'target', 'targets')}. Click to show or hide the controls.`
          : 'Show or hide the Vibe Debugger controls (Watch, Record, Trace)';
    }

    if (watchButton) {
      watchButton.textContent = watchTargets.length ? `Watch ${watchTargets.length}` : 'Watch';
      watchButton.title = watchTargets.length
        ? `${watchTargets.length} Vibe Debugger watch ${pluralize(watchTargets.length, 'target', 'targets')}. ${TRACE_ACTION_HELP.watch}`
        : TRACE_ACTION_HELP.watch;
      watchButton.setAttribute('aria-label', watchButton.title);
    }

    if (recordButton) {
      recordButton.textContent = isTraceRecording ? 'Stop' : 'Record';
      recordButton.title = isTraceRecording ? `Stop recording. ${TRACE_ACTION_HELP.record}` : TRACE_ACTION_HELP.record;
      recordButton.setAttribute('aria-label', recordButton.title);
      recordButton.classList.toggle('element-picker-toolbar-button-danger', isTraceRecording);
    }

    if (traceButton) {
      traceButton.textContent = tracePanelOpen ? 'Hide Trace' : 'Trace';
      traceButton.title = tracePanelOpen ? 'Hide the Vibe Debugger panel.' : TRACE_ACTION_HELP.trace;
      traceButton.setAttribute('aria-label', traceButton.title);
    }

    if (sendTraceButton) {
      sendTraceButton.disabled = watchTargets.length === 0 && traceEvents.length === 0;
      sendTraceButton.title = TRACE_ACTION_HELP.send;
      sendTraceButton.setAttribute('aria-label', TRACE_ACTION_HELP.send);
    }

    renderTracePanel();
  }

  function getElementRect(selection) {
    if (selection.element && selection.element.isConnected) {
      return toRectObject(selection.element.getBoundingClientRect());
    }

    return selection.info.viewportRect || null;
  }

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  function computeRectPixels(rect, dpr, imageWidth, imageHeight, paddingCssPx = 0) {
    if (!rect) return null;

    const padding = paddingCssPx * dpr;
    const left = clamp(Math.round(rect.left * dpr - padding), 0, imageWidth);
    const top = clamp(Math.round(rect.top * dpr - padding), 0, imageHeight);
    const right = clamp(Math.round(rect.right * dpr + padding), 0, imageWidth);
    const bottom = clamp(Math.round(rect.bottom * dpr + padding), 0, imageHeight);

    const width = right - left;
    const height = bottom - top;
    if (width <= 0 || height <= 0) return null;

    return { x: left, y: top, width, height };
  }

  function computeCropRectPixels(rect, dpr, imageWidth, imageHeight) {
    return computeRectPixels(rect, dpr, imageWidth, imageHeight, CROP_PADDING_CSS_PX);
  }

  function computeElementRectPixels(rect, dpr, imageWidth, imageHeight) {
    return computeRectPixels(rect, dpr, imageWidth, imageHeight, 0);
  }

  function loadImage(dataUrl) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Unable to decode captured viewport image'));
      img.src = dataUrl;
    });
  }

  function drawHighlight(context, rect, scale, label = null) {
    if (!rect) return;

    const x = Math.round(rect.x * scale) + 1.5;
    const y = Math.round(rect.y * scale) + 1.5;
    const width = Math.max(1, Math.round(rect.width * scale) - 3);
    const height = Math.max(1, Math.round(rect.height * scale) - 3);

    context.save();
    context.strokeStyle = HIGHLIGHT_COLOR;
    context.lineWidth = Math.max(2, Math.round(3 * scale));
    context.strokeRect(x, y, width, height);

    if (label) {
      const badgeSize = Math.max(18, Math.round(24 * scale));
      context.fillStyle = HIGHLIGHT_COLOR;
      context.fillRect(x, y, badgeSize, badgeSize);
      context.fillStyle = '#ffffff';
      context.font = `700 ${Math.max(11, Math.round(13 * scale))}px ui-sans-serif, system-ui, sans-serif`;
      context.textAlign = 'center';
      context.textBaseline = 'middle';
      context.fillText(String(label), x + badgeSize / 2, y + badgeSize / 2 + 0.5);
    }

    context.restore();
  }

  function createCropPreviewDataUrl(image, cropRect, elementRect) {
    const maxSide = 360;
    const scale = Math.min(1, maxSide / Math.max(cropRect.width, cropRect.height));

    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(cropRect.width * scale));
    canvas.height = Math.max(1, Math.round(cropRect.height * scale));

    const context = canvas.getContext('2d');
    if (!context) return null;

    context.drawImage(
      image,
      cropRect.x,
      cropRect.y,
      cropRect.width,
      cropRect.height,
      0,
      0,
      canvas.width,
      canvas.height
    );

    if (elementRect) {
      drawHighlight(
        context,
        {
          x: elementRect.x - cropRect.x,
          y: elementRect.y - cropRect.y,
          width: elementRect.width,
          height: elementRect.height,
        },
        scale
      );
    }

    return canvas.toDataURL('image/jpeg', 0.82);
  }

  function createHighlightedViewportDataUrl(image, crops) {
    const maxSide = 900;
    const scale = Math.min(1, maxSide / Math.max(image.width, image.height));

    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.width * scale));
    canvas.height = Math.max(1, Math.round(image.height * scale));

    const context = canvas.getContext('2d');
    if (!context) return null;

    context.drawImage(image, 0, 0, canvas.width, canvas.height);

    crops.forEach((crop) => {
      if (!crop.elementRectPixels) return;
      drawHighlight(context, crop.elementRectPixels, scale, crop.index);
    });

    return canvas.toDataURL('image/jpeg', 0.72);
  }

  function slugifyFilenamePart(value, fallback = 'page') {
    const slug = normalizeWhitespace(value)
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60);

    return slug || fallback;
  }

  function getCaptureFilenamePrefix() {
    const timestamp = new Date().toISOString()
      .replace(/\.\d+Z$/, 'Z')
      .replace(/[:]/g, '')
      .replace(/[TZ]/g, '-')
      .replace(/-$/, '');

    let host = 'page';
    try {
      host = new URL(window.location.href).hostname;
    } catch {
      // Ignore URL parsing failures and keep the fallback host.
    }

    return `elements/element-picker-${timestamp}-${slugifyFilenamePart(host)}`;
  }

  function formatDownloadFilename(prefix, name) {
    return `${prefix}-${name}.jpg`;
  }

  async function requestImageSave(dataUrl, filename) {
    if (!dataUrl || !filename) return null;

    try {
      const response = await chrome.runtime.sendMessage({
        type: 'ELEMENT_PICKER_SAVE_IMAGE',
        dataUrl,
        filename,
      });

      if (response?.ok) {
        return {
          filename: response.filename || filename,
          requestedFilename: response.requestedFilename || filename,
          downloadId: response.downloadId || null,
        };
      }

      return {
        error: response?.error || 'Unable to save screenshot',
        requestedFilename: filename,
      };
    } catch (error) {
      console.warn('Element picker screenshot save failed:', error);
      return {
        error: error?.message || 'Unable to save screenshot',
        requestedFilename: filename,
      };
    }
  }

  async function requestViewportCapture() {
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'ELEMENT_PICKER_CAPTURE_VISIBLE',
      });

      if (response && response.ok && response.dataUrl) {
        return response.dataUrl;
      }

      return null;
    } catch (error) {
      console.warn('Element picker capture request failed:', error);
      return null;
    }
  }

  function setPickerVisualsHidden(hidden) {
    if (hidden) {
      const nodes = Array.from(document.querySelectorAll(`[${UI_ATTR}="true"]`));
      hiddenPickerUiSnapshot = nodes.map((node) => ({
        node,
        visibility: node.style.visibility,
      }));
      nodes.forEach((node) => {
        node.style.visibility = 'hidden';
      });
      return;
    }

    hiddenPickerUiSnapshot.forEach(({ node, visibility }) => {
      if (node.isConnected) {
        node.style.visibility = visibility;
      }
    });
    hiddenPickerUiSnapshot = [];
  }

  function waitForPaint() {
    return new Promise((resolve) => {
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(resolve);
      });
    });
  }

  async function requestCleanViewportCapture() {
    setPickerVisualsHidden(true);

    try {
      await waitForPaint();
      return await requestViewportCapture();
    } finally {
      setPickerVisualsHidden(false);
    }
  }

  async function buildScreenshotData() {
    const captureDataUrl = await requestCleanViewportCapture();
    if (!captureDataUrl) {
      return {
        status: 'unavailable',
        reason: 'capture-failed',
        inlineImages: false,
        crops: [],
      };
    }

    let image;
    try {
      image = await loadImage(captureDataUrl);
    } catch {
      return {
        status: 'unavailable',
        reason: 'capture-decode-failed',
        inlineImages: false,
        crops: [],
      };
    }

    const dpr = window.devicePixelRatio || 1;
    const includeInlineImages = selections.length <= MAX_INLINE_CROPS;
    const filenamePrefix = getCaptureFilenamePrefix();
    const imageDownloads = [];

    const crops = selections.map((selection) => {
      const rect = getElementRect(selection);
      const visibleInViewport = isVisibleInViewport(rect);

      const cropData = {
        index: selection.info.index,
        visibleInViewport,
        viewportRect: rect,
      };

      if (!visibleInViewport || !rect) {
        return cropData;
      }

      const cropRectPixels = computeCropRectPixels(rect, dpr, image.width, image.height);
      const elementRectPixels = computeElementRectPixels(rect, dpr, image.width, image.height);
      if (!cropRectPixels || !elementRectPixels) {
        return cropData;
      }

      cropData.captureRectPixels = cropRectPixels;
      cropData.elementRectPixels = elementRectPixels;
      cropData.cropPaddingCssPx = CROP_PADDING_CSS_PX;
      cropData.previewHasHighlight = includeInlineImages;

      const imageDataUrl = createCropPreviewDataUrl(image, cropRectPixels, elementRectPixels);
      cropData.previewHasHighlight = !!imageDataUrl;

      if (imageDataUrl) {
        imageDownloads.push({
          kind: 'element-crop',
          index: selection.info.index,
          dataUrl: imageDataUrl,
          filename: formatDownloadFilename(
            filenamePrefix,
            `element-${String(selection.info.index).padStart(2, '0')}`
          ),
        });
      }

      if (includeInlineImages && imageDataUrl) {
        cropData.imageDataUrl = imageDataUrl;
      }

      return cropData;
    });

    const highlightedViewportSaveDataUrl = createHighlightedViewportDataUrl(image, crops);
    const highlightedViewportImageDataUrl = includeInlineImages
      ? highlightedViewportSaveDataUrl
      : null;

    if (highlightedViewportSaveDataUrl) {
      imageDownloads.unshift({
        kind: 'highlighted-viewport',
        dataUrl: highlightedViewportSaveDataUrl,
        filename: formatDownloadFilename(filenamePrefix, 'viewport'),
      });
    }

    const downloadResults = await Promise.all(
      imageDownloads.map(async (item) => ({
        kind: item.kind,
        index: item.index || null,
        ...(await requestImageSave(item.dataUrl, item.filename)),
      }))
    );

    const viewportDownload = downloadResults.find((item) => item.kind === 'highlighted-viewport') || null;
    const cropDownloadsByIndex = new Map(
      downloadResults
        .filter((item) => item.kind === 'element-crop' && item.index)
        .map((item) => [item.index, item])
    );

    crops.forEach((crop) => {
      const cropDownload = cropDownloadsByIndex.get(crop.index);
      if (cropDownload) {
        crop.imageFile = cropDownload;
      }
    });

    return {
      status: 'ok',
      captureScope: 'visible-viewport',
      fullPageCapture: false,
      fullPageCaptureReason: 'The extension uses non-invasive visible-tab capture to avoid scrolling or mutating page state.',
      dpr: round(dpr, 3),
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
      },
      captureImageSize: {
        width: image.width,
        height: image.height,
      },
      inlineImages: includeInlineImages,
      highlightedViewportImageDataUrl,
      highlightedViewportImageFile: viewportDownload,
      imageDirectory: 'Downloads/elements',
      imageFiles: downloadResults,
      note: includeInlineImages
        ? null
        : `Inline crop images omitted because ${selections.length} elements were selected (limit: ${MAX_INLINE_CROPS}).`,
      crops,
    };
  }

  function buildPlaywrightSkeleton(bundle) {
    const lines = [
      "import { test, expect } from '@playwright/test';",
      '',
      "test('repro from element picker bundle', async ({ page }) => {",
      `  await page.goto(${JSON.stringify(bundle.page.url)});`,
      '',
    ];

    bundle.elements.forEach((elementInfo) => {
      const locator =
        elementInfo.primaryLocator?.playwright ||
        `page.locator(${JSON.stringify(elementInfo.selector || elementInfo.xpath || elementInfo.tag)})`;
      const label = truncate(`${elementInfo.tag}${elementInfo.id ? `#${elementInfo.id}` : ''} ${elementInfo.text || ''}`, 72);

      lines.push(`  // Element ${elementInfo.index}: ${label}`);
      lines.push(`  const target${elementInfo.index} = ${locator};`);
      lines.push(`  await expect(target${elementInfo.index}).toBeVisible();`);
      lines.push(`  // TODO: add action/assertion for target${elementInfo.index}`);
      lines.push('');
    });

    lines.push('});');

    return lines.join('\n');
  }

  function getBrowserContextSnapshot() {
    const activeElement = document.activeElement && !isPickerUi(document.activeElement)
      ? describeElementBrief(document.activeElement)
      : null;

    return {
      paused: isPaused,
      documentReadyState: document.readyState,
      visibilityState: document.visibilityState,
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        devicePixelRatio: round(window.devicePixelRatio || 1, 3),
      },
      scroll: {
        x: Math.round(window.scrollX),
        y: Math.round(window.scrollY),
        maxX: Math.max(0, Math.round(document.documentElement.scrollWidth - window.innerWidth)),
        maxY: Math.max(0, Math.round(document.documentElement.scrollHeight - window.innerHeight)),
      },
      activeElement,
      selectedText: truncate(window.getSelection ? window.getSelection().toString() : '', 240) || null,
    };
  }

  function getActiveTraceContext() {
    if (
      watchTargets.length === 0 &&
      traceEvents.length === 0 &&
      traceSamples.length === 0 &&
      !latestTraceManifest
    ) {
      return null;
    }

    return {
      schemaVersion: TRACE_SCHEMA_VERSION,
      recording: isTraceRecording,
      startedAt: traceStartedAt,
      endedAt: traceEndedAt,
      watchTargetCount: watchTargets.length,
      eventCount: traceEvents.length,
      sampleCount: traceSamples.length,
      mutationCount: traceMutations.length,
      latestTrace: latestTraceManifest,
      watchTargets: getSerializableWatchTargets().map((target) => ({
        watchId: target.watchId,
        kind: target.kind,
        label: target.label,
        selector: target.selector,
        locator: target.locator,
      })),
      activeCause: getTraceCause(),
    };
  }

  function buildBundle(screenshotData, options = {}) {
    const elements = selections.map((selection) => {
      const crop = screenshotData.crops.find((item) => item.index === selection.info.index) || null;
      return {
        ...selection.info,
        screenshotCrop: crop,
      };
    });

    const bundle = {
      bundleVersion: '2.2.0',
      generatedAt: new Date().toISOString(),
      page: {
        title: document.title,
        url: window.location.href,
        referrer: document.referrer || null,
      },
      browserContext: getBrowserContextSnapshot(),
      userComment: getUserComment(),
      tourContext: options.tourContext || getActiveTourContext(),
      traceContext: getActiveTraceContext(),
      totalElements: elements.length,
      screenshot: {
        status: screenshotData.status,
        reason: screenshotData.reason || null,
        captureScope: screenshotData.captureScope || null,
        fullPageCapture: screenshotData.fullPageCapture || false,
        fullPageCaptureReason: screenshotData.fullPageCaptureReason || null,
        dpr: screenshotData.dpr || null,
        viewport: screenshotData.viewport || null,
        captureImageSize: screenshotData.captureImageSize || null,
        inlineImages: screenshotData.inlineImages,
        highlightedViewportImageDataUrl: screenshotData.highlightedViewportImageDataUrl || null,
        highlightedViewportImageFile: screenshotData.highlightedViewportImageFile || null,
        imageDirectory: screenshotData.imageDirectory || null,
        imageFiles: screenshotData.imageFiles || [],
        note: screenshotData.note || null,
      },
      elements,
    };

    bundle.playwrightSkeleton = buildPlaywrightSkeleton(bundle);
    return bundle;
  }

  function formatLocatorLine(locator) {
    const matchText =
      typeof locator.uniqueCount === 'number'
        ? `${locator.uniqueCount} ${pluralize(locator.uniqueCount, 'match', 'matches')}`
        : 'match count unknown';
    const note = locator.note ? ` (${locator.note})` : '';
    return `- ${locator.strategy}: score ${locator.score}, ${matchText}, ${locator.playwright}${note}`;
  }

  function formatHook(hook) {
    if (!hook) return '';
    if (hook.type === 'role-name') {
      return `role=${JSON.stringify(hook.role)} name=${JSON.stringify(hook.accessibleName)}`;
    }
    return `${hook.type}=${JSON.stringify(hook.value)}`;
  }

  function formatBriefElement(description) {
    if (!description) return '';

    const parts = [description.tag];
    if (description.id) parts.push(`#${description.id}`);
    if (description.hook) parts.push(`[${formatHook(description.hook)}]`);
    if (description.text) parts.push(`"${description.text}"`);
    return parts.join(' ');
  }

  function formatAncestorContextLines(context) {
    if (!context) return [];

    const lines = [];

    if (context.sectionHeading?.text) {
      lines.push(`Nearest section heading: "${context.sectionHeading.text}"`);
    }

    if (context.nearestStableAncestor) {
      lines.push(`Nearest stable ancestor: ${formatBriefElement(context.nearestStableAncestor)}`);
    }

    if (context.nearestSection) {
      lines.push(`Nearest section-like ancestor: ${formatBriefElement(context.nearestSection)}`);
    }

    return lines;
  }

  function formatScrollNode(info) {
    if (!info) return '';

    const label = formatBriefElement(info.element);
    const flags = [];

    if (info.canScrollHorizontally) flags.push('can scroll horizontally');
    if (info.clipsHorizontal) flags.push('clips horizontal overflow');
    if (info.hiddenOverflowRight) flags.push('hidden overflow to the right');
    if (info.canScrollVertically) flags.push('can scroll vertically');
    if (info.clipsVertical) flags.push('clips vertical overflow');
    if (info.hiddenOverflowBottom) flags.push('hidden overflow below');
    if (info.scrollSnapType) flags.push(`scroll-snap-type=${info.scrollSnapType}`);
    if (info.scrollSnapAlign) flags.push(`scroll-snap-align=${info.scrollSnapAlign}`);

    const metrics = `scrollWidth=${info.scrollWidth}, clientWidth=${info.clientWidth}, scrollLeft=${info.scrollLeft}, overflowX=${info.overflowX}`;
    const suffix = flags.length ? `; ${flags.join(', ')}` : '';
    return `${label || 'element'} (${metrics}${suffix})`;
  }

  function formatScrollDiagnosticsLines(scrollDiagnostics) {
    if (!scrollDiagnostics) return [];

    const lines = [];
    const selected = scrollDiagnostics.selected;

    if (selected) {
      const selectedFlags = [];
      if (selected.canScrollHorizontally) selectedFlags.push('can scroll horizontally');
      if (selected.clipsHorizontal) selectedFlags.push('clips horizontal overflow');
      if (selected.hiddenOverflowRight) selectedFlags.push('hidden overflow to the right');
      if (selected.scrollSnapType) selectedFlags.push(`scroll-snap-type=${selected.scrollSnapType}`);

      if (selectedFlags.length) {
        lines.push(`Selected element scroll: ${selectedFlags.join(', ')}`);
      }
    }

    if (scrollDiagnostics.nearestHorizontalContainer) {
      lines.push(`Nearest horizontal scroll context: ${formatScrollNode(scrollDiagnostics.nearestHorizontalContainer)}`);
    }

    return lines;
  }

  function formatReactNativeProps(props) {
    if (!props) return '';

    return Object.entries(props)
      .map(([name, details]) => `${name}=${JSON.stringify(details.value)}`)
      .join(', ');
  }

  function formatImageFile(imageFile) {
    if (!imageFile) return '';
    if (imageFile.error) {
      return `save failed (${imageFile.error}; requested ${imageFile.requestedFilename || 'unknown filename'})`;
    }
    return imageFile.filename || imageFile.requestedFilename || '';
  }

  function formatElementSection(elementInfo) {
    const lines = [];

    const heading = `${elementInfo.index}. ${elementInfo.tag}${elementInfo.id ? `#${elementInfo.id}` : ''}`;
    lines.push(`### ${heading}`);

    if (elementInfo.text) {
      lines.push(`Text: "${elementInfo.text}"`);
    }

    if (elementInfo.primaryLocator) {
      lines.push(`Primary locator: ${elementInfo.primaryLocator.playwright}`);
    }

    if (elementInfo.accessibleName && elementInfo.accessibleNameSource !== 'visible-text') {
      lines.push(`Accessible name: "${elementInfo.accessibleName}" (${elementInfo.accessibleNameSource})`);
    }

    lines.push(`Size: ${elementInfo.dimensions}`);

    lines.push(...formatAncestorContextLines(elementInfo.ancestorContext));
    lines.push(...formatScrollDiagnosticsLines(elementInfo.scrollDiagnostics));

    if (elementInfo.reactComponents) {
      lines.push(`React chain: ${elementInfo.reactComponents.join(' -> ')}`);
    }

    if (elementInfo.reactNativeWebProps) {
      lines.push(`RN-web props: ${formatReactNativeProps(elementInfo.reactNativeWebProps)}`);
    }

    if (elementInfo.classDiagnostics?.totalCount) {
      const classParts = [];
      if (elementInfo.classDiagnostics.meaningful?.length) {
        classParts.push(`meaningful: ${elementInfo.classDiagnostics.meaningful.join(' ')}`);
      }
      if (elementInfo.classDiagnostics.generatedCount) {
        classParts.push(`${elementInfo.classDiagnostics.generatedCount} generated omitted`);
      }
      if (elementInfo.classDiagnostics.utilityCount) {
        classParts.push(`${elementInfo.classDiagnostics.utilityCount} utility omitted`);
      }
      if (classParts.length) {
        lines.push(`Class summary: ${classParts.join('; ')}`);
      }
    }

    if (elementInfo.locators?.length) {
      const stableLocators = elementInfo.locators
        .filter((locator) => !['css', 'xpath', 'id-fallback'].includes(locator.strategy))
        .slice(0, 5);
      const backupLocators = elementInfo.locators
        .filter((locator) => ['css', 'xpath', 'id-fallback'].includes(locator.strategy))
        .slice(0, 4);

      if (stableLocators.length) {
        lines.push('Stable locator candidates:');
      }
      stableLocators.forEach((locator) => {
        lines.push(formatLocatorLine(locator));
      });

      if (backupLocators.length) {
        lines.push('Backup locator candidates:');
      }
      backupLocators.forEach((locator) => {
        lines.push(formatLocatorLine(locator));
      });
    }

    if (elementInfo.screenshotCrop) {
      const crop = elementInfo.screenshotCrop;
      lines.push(
        `Screenshot crop: ${crop.visibleInViewport ? 'visible in viewport' : 'not visible in viewport at export time'}`
      );
      if (crop.captureRectPixels) {
        const rect = crop.captureRectPixels;
        const padding = crop.cropPaddingCssPx ?? 0;
        lines.push(`Capture pixels: x=${rect.x}, y=${rect.y}, w=${rect.width}, h=${rect.height}, padding=${padding} CSS px`);
      }
      if (crop.imageDataUrl) {
        lines.push('Crop preview image: embedded in JSON under `screenshotCrop.imageDataUrl` with selected element outlined.');
      }
      if (crop.imageFile) {
        lines.push(`Crop image file: ${formatImageFile(crop.imageFile)}`);
      }
    }

    if (elementInfo.accessibility) {
      lines.push(`A11y: ${JSON.stringify(elementInfo.accessibility)}`);
    }

    if (elementInfo.formState) {
      lines.push(`Form state: ${JSON.stringify(elementInfo.formState)}`);
    }

    if (elementInfo.styles) {
      lines.push(`Styles: ${JSON.stringify(elementInfo.styles)}`);
    }

    if (elementInfo.dataAttributes) {
      lines.push(`Data attrs: ${JSON.stringify(elementInfo.dataAttributes)}`);
    }

    if (elementInfo.html) {
      lines.push('HTML snippet:');
      lines.push('```html');
      lines.push(elementInfo.html);
      lines.push('```');
    }

    lines.push('');
    return lines;
  }

  function formatTourContextLines(tourContext) {
    if (!tourContext) return [];

    const stepTitle = tourContext.step?.title || `Step ${tourContext.stepIndex}`;
    const lines = [
      '## Tour Context',
      `Tour: ${tourContext.tourTitle || 'Untitled tour'}`,
      `Step: ${tourContext.stepIndex}/${tourContext.totalSteps} - ${stepTitle}`,
    ];

    if (tourContext.tourSummary) {
      lines.push(`Tour summary: ${tourContext.tourSummary}`);
    }

    if (tourContext.step?.body) {
      lines.push(`Step note: ${tourContext.step.body}`);
    }

    if (tourContext.step?.notes && tourContext.step.notes !== tourContext.step.body) {
      lines.push(`Step notes: ${tourContext.step.notes}`);
    }

    if (tourContext.step?.url) {
      lines.push(`Step URL: ${tourContext.step.url}`);
    }

    if (tourContext.step?.selector) {
      lines.push(`Step selector: ${tourContext.step.selector}`);
    } else if (tourContext.step?.text) {
      lines.push(`Step text match: ${tourContext.step.text}`);
    }

    lines.push(`Current URL matched step: ${tourContext.currentUrlMatches ? 'yes' : 'no'}`);
    lines.push(`Tour target found: ${tourContext.targetFound ? 'yes' : 'no'}`);

    if (tourContext.askText) {
      lines.push('', '### Ask Codex', tourContext.askText);
    }

    lines.push('');
    return lines;
  }

  function formatTraceContextLines(traceContext) {
    if (!traceContext) return [];

    const lines = [
      '## Vibe Trace Context',
      `Recording: ${traceContext.recording ? 'yes' : 'no'}`,
      `Watch targets: ${traceContext.watchTargetCount}`,
      `Events: ${traceContext.eventCount}`,
      `Samples: ${traceContext.sampleCount}`,
    ];

    if (traceContext.latestTrace?.latestDir) {
      lines.push(`Latest trace directory: ${traceContext.latestTrace.latestDir}`);
    }

    if (traceContext.activeCause) {
      lines.push(`Active cause: ${traceContext.activeCause.label} (${traceContext.activeCause.confidence})`);
    }

    if (traceContext.watchTargets?.length) {
      lines.push('Watched targets:');
      traceContext.watchTargets.slice(0, 8).forEach((target) => {
        lines.push(`- ${target.watchId}: ${target.label}`);
      });
    }

    lines.push('');
    return lines;
  }

  function formatSessionControlLines(bundle) {
    if (bundle.tourContext) {
      return [
        '## Session Controls',
        '- Tour mode: normal page selection was locked during this capture',
        '- Ask Codex: captured only the highlighted tour step target',
        '- Next / Back: move through the guided review',
        '- Close / Escape: exit the guided review',
        '',
      ];
    }

    return [
      '## Session Controls',
      '- Click: add element to bundle',
      '- Send to Codex: save bundle to the local QA inbox',
      '- Copy / Enter: export bundle to clipboard',
      '- Backspace/Delete/Ctrl+Z: remove latest selection',
      '- Resume / Escape: resume or cancel picker',
      '',
    ];
  }

  function formatBundleForClipboard(bundle, includeJson = true) {
    const lines = [
      '# Element Debug Bundle',
      '',
      `Captured at: ${bundle.generatedAt}`,
      `URL: ${bundle.page.url}`,
      `Title: ${bundle.page.title}`,
      `Elements: ${bundle.totalElements}`,
      '',
      bundle.userComment ? '## User Comment' : null,
      bundle.userComment || null,
      bundle.userComment ? '' : null,
      ...formatTourContextLines(bundle.tourContext),
      ...formatTraceContextLines(bundle.traceContext),
      ...formatSessionControlLines(bundle),
      '## Visual Capture',
      `Status: ${bundle.screenshot.status}`,
      `Scope: ${bundle.screenshot.captureScope || 'unavailable'}`,
      `Viewport: ${bundle.screenshot.viewport ? `${bundle.screenshot.viewport.width}x${bundle.screenshot.viewport.height}` : 'unknown'}`,
      `Device pixel ratio: ${bundle.screenshot.dpr || 'unknown'}`,
      bundle.screenshot.highlightedViewportImageDataUrl
        ? 'Highlighted viewport image: embedded in JSON under `screenshot.highlightedViewportImageDataUrl`.'
        : 'Highlighted viewport image: unavailable or omitted.',
      bundle.screenshot.highlightedViewportImageFile
        ? `Highlighted viewport file: ${formatImageFile(bundle.screenshot.highlightedViewportImageFile)}`
        : 'Highlighted viewport file: unavailable.',
      bundle.screenshot.imageDirectory
        ? `Screenshot directory: ${bundle.screenshot.imageDirectory}`
        : 'Screenshot directory: unavailable.',
      bundle.screenshot.fullPageCapture
        ? 'Full-page capture: included.'
        : `Full-page capture: not included${bundle.screenshot.fullPageCaptureReason ? ` (${bundle.screenshot.fullPageCaptureReason})` : ''}.`,
      '',
      '## Elements',
      '',
    ].filter((line) => line !== null);

    bundle.elements.forEach((elementInfo) => {
      lines.push(...formatElementSection(elementInfo));
    });

    lines.push('## Playwright Repro Skeleton');
    lines.push('```ts');
    lines.push(bundle.playwrightSkeleton);
    lines.push('```');

    if (bundle.screenshot.note) {
      lines.push('');
      lines.push(`Screenshot note: ${bundle.screenshot.note}`);
    }

    if (includeJson) {
      lines.push('');
      lines.push('## JSON Bundle');
      lines.push('```json');
      lines.push(JSON.stringify(bundle, null, 2));
      lines.push('```');
    }

    return lines.join('\n');
  }

  function stripInlineImages(bundle) {
    return {
      ...bundle,
      screenshot: {
        ...bundle.screenshot,
        inlineImages: false,
        highlightedViewportImageDataUrl: null,
        note: bundle.screenshot.note || 'Inline crop images removed to keep clipboard payload manageable.',
      },
      elements: bundle.elements.map((elementInfo) => {
        const copy = {
          ...elementInfo,
          html: elementInfo.html ? truncate(elementInfo.html, 240) : elementInfo.html,
        };

        if (copy.screenshotCrop?.imageDataUrl) {
          copy.screenshotCrop = {
            ...copy.screenshotCrop,
          };
          delete copy.screenshotCrop.imageDataUrl;
        }

        return copy;
      }),
    };
  }

  async function copyBundleToClipboard(bundle) {
    const fullText = formatBundleForClipboard(bundle, true);

    try {
      await navigator.clipboard.writeText(fullText);
      return 'full';
    } catch (error) {
      console.warn('Full bundle copy failed, retrying with lighter payload.', error);
    }

    const slimBundle = stripInlineImages(bundle);
    const slimText = formatBundleForClipboard(slimBundle, true);

    try {
      await navigator.clipboard.writeText(slimText);
      return 'slim';
    } catch (error) {
      console.warn('Slim bundle copy failed, retrying with summary payload.', error);
    }

    const summaryText = formatBundleForClipboard(slimBundle, false);
    await navigator.clipboard.writeText(summaryText);
    return 'summary';
  }

  function ensureSelectionForExport() {
    if (selections.length > 0) return true;

    if (currentElement && !isPickerUi(currentElement)) {
      addSelection(currentElement);
      return true;
    }

    showToast('No elements selected. Click or hover an element first.');
    return false;
  }

  async function buildCurrentBundle(options = {}) {
    const screenshotData = await buildScreenshotData();
    return buildBundle(screenshotData, options);
  }

  async function exportBundle(options = {}) {
    const { cleanupAfter = false } = options;
    if (isExporting) return;

    if (!ensureSelectionForExport()) {
      return;
    }

    isExporting = true;
    const count = selections.length;
    showToast(`Building bundle for ${count} ${pluralize(count, 'element', 'elements')}...`, 2500);

    const bundle = await buildCurrentBundle();

    try {
      const copyMode = await copyBundleToClipboard(bundle);
      if (copyMode === 'full') {
        showToast(`Copied full debug bundle (${count} ${pluralize(count, 'element', 'elements')}). Press ESC or Close when done.`, 2600);
      } else if (copyMode === 'slim') {
        showToast('Copied bundle without inline crop images.', 2600);
      } else {
        showToast('Copied summary bundle (payload was too large).', 2600);
      }
      if (cleanupAfter) {
        cleanup();
      } else {
        isExporting = false;
      }
    } catch (error) {
      console.error('Failed to copy debug bundle:', error);
      isExporting = false;
      showToast('Failed to copy bundle. Check console for details.', 2600);
    }
  }

  async function sendBundleToCodex(options = {}) {
    if (isExporting) return;

    if (!ensureSelectionForExport()) {
      return;
    }

    isExporting = true;
    const count = selections.length;
    showToast(`Sending ${count} ${pluralize(count, 'element', 'elements')} to Codex QA inbox...`, 2600);

    try {
      const bundle = await buildCurrentBundle(options);
      const markdownBundle = stripInlineImages(bundle);
      const markdown = formatBundleForClipboard(markdownBundle, true);
      const response = await chrome.runtime.sendMessage({
        type: 'ELEMENT_PICKER_SEND_TO_CODEX',
        inboxUrl: CODEX_INBOX_URL,
        bundle,
        markdown,
      });

      if (!response?.ok) {
        throw new Error(response?.error || 'Codex QA inbox did not accept the capture');
      }

      setInboxHealth('online');
      showToast(`Saved QA capture ${response.captureId || ''}. Tell Codex: "look at latest QA capture."`, 4200);
      isExporting = false;
    } catch (error) {
      console.error('Failed to send bundle to Codex QA inbox:', error);
      setInboxHealth('offline');
      isExporting = false;
      showToast(`Send failed: ${error?.message || 'start the Codex QA inbox server'}`, 4200);
    }
  }

  function onMouseMove(event) {
    if (!isPaused) return;
    if (isTourActive()) return;

    const element = document.elementFromPoint(event.clientX, event.clientY);
    if (!isElementNode(element) || isPickerUi(element)) return;

    if (element !== currentElement) {
      currentElement = element;
      updateOverlay(element);
    }
  }

  function onClick(event) {
    if (isPickerUi(event.target)) return;
    if (!isPaused) return;

    if (clickThroughArmed) {
      const clickedElement = document.elementFromPoint(event.clientX, event.clientY);
      if (isElementNode(clickedElement) && !isPickerUi(clickedElement)) {
        currentElement = clickedElement;
        updateOverlay(clickedElement);
      }
      clickThroughArmed = false;
      updateToolbarState();
      showToast('Click passed through to the page.', 1400);
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();

    if (isExporting) return;

    if (isTourActive()) {
      showToast('Tour mode is focused on the highlighted step. Use Ask Codex, Next, or Close.', 2200);
      return;
    }

    const clickedElement = document.elementFromPoint(event.clientX, event.clientY);
    if (isElementNode(clickedElement) && !isPickerUi(clickedElement)) {
      currentElement = clickedElement;
      updateOverlay(clickedElement);
    }

    if (!currentElement || isPickerUi(currentElement)) return;

    addSelection(currentElement);
  }

  function onViewportChange() {
    if (currentElement) {
      updateOverlay(currentElement);
    }
    if (activeTourElement) {
      updateTourHighlight(activeTourElement);
      queueTourPanelPlacement();
    }
    updateBadges();
    if (isTraceRecording) {
      scheduleWatchSample('viewport.change', 120);
    }
  }

  function onKeyDown(event) {
    if (isTextEntryElement(event.target)) {
      return;
    }

    if (event.key === 'Escape') {
      event.preventDefault();
      if (isTourActive()) {
        clearTour();
        showToast('Guided review closed.', 1500);
        return;
      }
      cleanup();
      return;
    }

    if (event.key === 'Enter') {
      event.preventDefault();
      if (isTourActive()) {
        askCodexAboutTourStep();
        return;
      }
      exportBundle();
      return;
    }

    const isUndoKey =
      event.key === 'Backspace' ||
      event.key === 'Delete' ||
      ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z');

    if (isUndoKey) {
      event.preventDefault();
      removeLastSelection();
    }
  }

  function cleanup() {
    setBreakOnLoadEnabled(false);
    stopTraceRecording({ silent: true });
    window.postMessage({ source: 'element-picker-vibe-probe-control', command: 'stop' }, '*');
    document.removeEventListener('mousemove', onMouseMove, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKeyDown, true);
    document.removeEventListener('click', onRecordedUserEvent, true);
    document.removeEventListener('input', onRecordedUserEvent, true);
    document.removeEventListener('change', onRecordedUserEvent, true);
    document.removeEventListener('submit', onRecordedUserEvent, true);
    document.removeEventListener('keydown', onRecordedUserEvent, true);
    document.removeEventListener('pointerdown', onRecordedUserEvent, true);
    window.removeEventListener('message', onVibeProbeMessage);
    window.removeEventListener('scroll', onViewportChange, true);
    window.removeEventListener('resize', onViewportChange, true);
    chrome.runtime.onMessage.removeListener(onRuntimeMessage);
    stopMutationRecording();

    if (overlay) overlay.remove();
    if (badgeLayer) badgeLayer.remove();
    if (toolbar) toolbar.remove();
    if (tracePanel) tracePanel.remove();
    if (toastLayer) toastLayer.remove();
    clearTour();

    overlay = null;
    badgeLayer = null;
    toolbar = null;
    pauseButton = null;
    breakOnLoadButton = null;
    clickThroughButton = null;
    watchButton = null;
    recordButton = null;
    traceButton = null;
    sendTraceButton = null;
    countBadge = null;
    commentInput = null;
    toastLayer = null;
    statusPill = null;
    inboxHealth = 'unknown';
    vibeToggleButton = null;
    vibeGroup = null;
    vibeGroupOpen = false;
    tracePanel = null;
    tracePanelOpen = false;
    currentElement = null;
    selections = [];
    watchTargets = [];
    isExporting = false;
    isPaused = true;
    breakOnLoadEnabled = false;
    clickThroughArmed = false;
    window.__elementPickerActive = false;
  }

  createOverlay();
  createBadgeLayer();
  createToolbar();

  document.addEventListener('mousemove', onMouseMove, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', onKeyDown, true);
  document.addEventListener('click', onRecordedUserEvent, true);
  document.addEventListener('input', onRecordedUserEvent, true);
  document.addEventListener('change', onRecordedUserEvent, true);
  document.addEventListener('submit', onRecordedUserEvent, true);
  document.addEventListener('keydown', onRecordedUserEvent, true);
  document.addEventListener('pointerdown', onRecordedUserEvent, true);
  window.addEventListener('message', onVibeProbeMessage);
  window.addEventListener('scroll', onViewportChange, true);
  window.addEventListener('resize', onViewportChange, true);
  chrome.runtime.onMessage.addListener(onRuntimeMessage);

  showToast('QA Bridge paused: click elements, watch them, then record or send captures to Codex.', 3600);
})();
