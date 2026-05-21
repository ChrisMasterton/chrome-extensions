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
  const CODEX_TOUR_URL = 'http://127.0.0.1:43117/tours/latest';
  const TOUR_PANEL_ID = '__element-picker-tour-panel';
  const TOUR_HIGHLIGHT_ID = '__element-picker-tour-highlight';
  const TOUR_PANEL_POSITIONS = ['top-right', 'bottom-right', 'bottom-left', 'top-left'];
  const TOUR_PANEL_OVERLAP_PADDING = 12;

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
  let countBadge = null;
  let commentInput = null;
  let currentElement = null;
  let selections = [];
  let isExporting = false;
  let isPaused = true;
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

  function showToast(message, duration = 2000) {
    const toast = document.createElement('div');
    markPickerUi(toast);
    toast.textContent = message;
    toast.style.cssText = [
      'position: fixed',
      'top: 16px',
      'left: 16px',
      'background: #111827',
      'color: #fff',
      'padding: 12px 18px',
      'border-radius: 8px',
      'font-family: ui-sans-serif, system-ui, sans-serif',
      'font-size: 13px',
      'line-height: 1.25',
      'z-index: 2147483647',
      'box-shadow: 0 10px 20px rgba(0,0,0,0.35)',
      'pointer-events: none',
      'max-width: min(460px, calc(100vw - 32px))',
      'text-align: left',
    ].join(';');

    document.body.appendChild(toast);
    window.setTimeout(() => toast.remove(), duration);
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
      showToast(`Loaded guided review: ${activeTour.title}`, 2400);
    } catch (error) {
      console.error('Failed to load Codex guided review:', error);
      showToast(`Tour load failed: ${error?.message || 'start the Codex QA inbox server'}`, 4200);
    }
  }

  function onRuntimeMessage(message) {
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

    if (countBadge) {
      countBadge.textContent = `${selections.length} selected`;
    }

    if (overlay) {
      overlay.style.display = isPaused && !tourActive && currentElement ? overlay.style.display : 'none';
    }
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

    commentInput = createCommentInput();

    pauseButton = createToolbarButton('Resume', 'Resume normal page interaction', () => {
      isPaused = !isPaused;
      updateToolbarState();
      showToast(isPaused ? 'Page paused. Click elements to inspect.' : 'Page interaction resumed. Toolbar remains available.', 1800);
    });

    const undoButton = createToolbarButton('Undo', 'Remove latest selected element', () => {
      removeLastSelection();
      updateToolbarState();
    });

    const copyButton = createToolbarButton('Copy', 'Copy selected element bundle to clipboard', () => {
      exportBundle({ cleanupAfter: true });
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

    toolbar.append(title, countBadge, commentInput, pauseButton, undoButton, copyButton, sendButton, tourButton, closeButton);
    document.body.appendChild(toolbar);
    updateToolbarState();
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

  function clearSelections() {
    selections = [];
    updateBadges();
    updateToolbarState();
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

    const label = `${removed.info.tag}${removed.info.id ? `#${removed.info.id}` : ''}`;
    showToast(`Removed ${label}. ${selections.length} selected.`);
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
    const { cleanupAfter = true } = options;
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
        showToast(`Copied full debug bundle (${count} ${pluralize(count, 'element', 'elements')}).`, 2400);
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

      showToast(`Saved QA capture ${response.captureId || ''}. Tell Codex: "look at latest QA capture."`, 4200);
      isExporting = false;
    } catch (error) {
      console.error('Failed to send bundle to Codex QA inbox:', error);
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
    document.removeEventListener('mousemove', onMouseMove, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('scroll', onViewportChange, true);
    window.removeEventListener('resize', onViewportChange, true);
    chrome.runtime.onMessage.removeListener(onRuntimeMessage);

    if (overlay) overlay.remove();
    if (badgeLayer) badgeLayer.remove();
    if (toolbar) toolbar.remove();
    clearTour();

    overlay = null;
    badgeLayer = null;
    toolbar = null;
    pauseButton = null;
    countBadge = null;
    commentInput = null;
    currentElement = null;
    selections = [];
    isExporting = false;
    isPaused = true;
    window.__elementPickerActive = false;
  }

  createOverlay();
  createBadgeLayer();
  createToolbar();

  document.addEventListener('mousemove', onMouseMove, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('scroll', onViewportChange, true);
  window.addEventListener('resize', onViewportChange, true);
  chrome.runtime.onMessage.addListener(onRuntimeMessage);

  showToast('QA Bridge paused: click elements, then Send to Codex or Copy. Resume restores page interaction.', 3600);
})();
