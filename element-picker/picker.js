// Element Picker for Claude Code
(function() {
  // Prevent multiple injections
  if (window.__elementPickerActive) return;
  window.__elementPickerActive = true;

  const OVERLAY_ID = '__element-picker-overlay';
  const BADGE_LAYER_ID = '__element-picker-badges';
  const UI_ATTR = 'data-element-picker-ui';
  const MAX_SELECTIONS = 25;
  const MAX_INLINE_CROPS = 6;

  const TEST_ID_ATTRIBUTES = [
    'data-testid',
    'data-test-id',
    'data-test',
    'data-cy',
    'data-qa',
  ];

  let overlay = null;
  let badgeLayer = null;
  let currentElement = null;
  let selections = [];
  let isExporting = false;

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

  function normalizeText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
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
      'bottom: 20px',
      'left: 50%',
      'transform: translateX(-50%)',
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
      'max-width: calc(100vw - 24px)',
      'text-align: center',
    ].join(';');

    document.body.appendChild(toast);
    window.setTimeout(() => toast.remove(), duration);
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

  function getMeaningfulClasses(element) {
    return Array.from(element.classList)
      .filter((className) => !className.match(/^(p-|m-|w-|h-|flex|grid|text-|bg-|border-|rounded)/))
      .slice(0, 3);
  }

  function getCssSelector(element) {
    if (element.id) {
      return `#${cssEscape(element.id)}`;
    }

    const path = [];
    let current = element;

    while (current && current.nodeType === Node.ELEMENT_NODE) {
      let selector = current.tagName.toLowerCase();

      if (current.id) {
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
    const text = normalizeText(element.innerText || element.textContent || '');
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

  function getAccessibleName(element) {
    const ariaLabel = element.getAttribute('aria-label');
    if (ariaLabel) return truncate(ariaLabel, 120);

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
      if (text) return truncate(text, 120);
    }

    const title = element.getAttribute('title');
    if (title) return truncate(title, 120);

    if (element.alt) return truncate(element.alt, 120);

    const tag = element.tagName.toLowerCase();
    if (tag === 'input' || tag === 'textarea') {
      const placeholder = element.getAttribute('placeholder');
      if (placeholder) return truncate(placeholder, 120);
      if (element.value) return truncate(element.value, 120);
    }

    return getTextPreview(element);
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
      'role-name': 88,
      role: 76,
      css: 70,
      xpath: 56,
      text: 52,
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
        playwright: `page.locator(${JSON.stringify(selector)})`,
        uniqueCount,
      });
    }

    const role = inferRole(element);
    const accessibleName = getAccessibleName(element);

    if (role && accessibleName) {
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
      const textNodes = Array.from(document.querySelectorAll('*'));
      const normalizedTarget = normalizeText(text);
      const uniqueCount = textNodes.filter((node) => normalizeText(getTextPreview(node)) === normalizedTarget).length;

      candidates.push({
        strategy: 'text',
        selector: text,
        playwright: `page.getByText(${JSON.stringify(text)})`,
        uniqueCount,
      });
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

    const info = {
      index,
      selectedAt: new Date().toISOString(),
      tag: element.tagName.toLowerCase(),
      id: element.id || null,
      classes: Array.from(element.classList).join(' '),
      text,
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

    const styles = getDebugStyles(element);
    if (styles) info.styles = styles;

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

  function addSelection(element) {
    if (!isElementNode(element) || isPickerUi(element)) return;

    if (selections.some((selection) => selection.element === element)) {
      showToast('Element already added. Press Enter to export or keep selecting.');
      return;
    }

    if (selections.length >= MAX_SELECTIONS) {
      showToast(`Selection limit reached (${MAX_SELECTIONS}). Press Enter to export.`);
      return;
    }

    const info = buildElementInfo(element, selections.length + 1);
    selections.push({ element, info });
    updateBadges();

    const count = selections.length;
    showToast(
      `Added ${count} ${pluralize(count, 'element', 'elements')}. Enter exports, Backspace undoes.`,
      1600
    );
  }

  function removeLastSelection() {
    if (selections.length === 0) {
      showToast('No selected elements to remove.');
      return;
    }

    const removed = selections.pop();
    updateBadges();

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

  function computeCropRectPixels(rect, dpr, imageWidth, imageHeight) {
    if (!rect) return null;

    const left = clamp(Math.round(rect.left * dpr), 0, imageWidth);
    const top = clamp(Math.round(rect.top * dpr), 0, imageHeight);
    const right = clamp(Math.round(rect.right * dpr), 0, imageWidth);
    const bottom = clamp(Math.round(rect.bottom * dpr), 0, imageHeight);

    const width = right - left;
    const height = bottom - top;
    if (width <= 0 || height <= 0) return null;

    return { x: left, y: top, width, height };
  }

  function loadImage(dataUrl) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Unable to decode captured viewport image'));
      img.src = dataUrl;
    });
  }

  function createCropPreviewDataUrl(image, cropRect) {
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

    return canvas.toDataURL('image/jpeg', 0.82);
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

  async function buildScreenshotData() {
    const captureDataUrl = await requestViewportCapture();
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
      if (!cropRectPixels) {
        return cropData;
      }

      cropData.captureRectPixels = cropRectPixels;

      if (includeInlineImages) {
        cropData.imageDataUrl = createCropPreviewDataUrl(image, cropRectPixels);
      }

      return cropData;
    });

    return {
      status: 'ok',
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

  function buildBundle(screenshotData) {
    const elements = selections.map((selection) => {
      const crop = screenshotData.crops.find((item) => item.index === selection.info.index) || null;
      return {
        ...selection.info,
        screenshotCrop: crop,
      };
    });

    const bundle = {
      bundleVersion: '2.0.0',
      generatedAt: new Date().toISOString(),
      page: {
        title: document.title,
        url: window.location.href,
      },
      totalElements: elements.length,
      screenshot: {
        status: screenshotData.status,
        reason: screenshotData.reason || null,
        dpr: screenshotData.dpr || null,
        viewport: screenshotData.viewport || null,
        captureImageSize: screenshotData.captureImageSize || null,
        inlineImages: screenshotData.inlineImages,
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
    return `- ${locator.strategy}: score ${locator.score}, ${matchText}, ${locator.playwright}`;
  }

  function formatElementSection(elementInfo) {
    const lines = [];

    const heading = `${elementInfo.index}. ${elementInfo.tag}${elementInfo.id ? `#${elementInfo.id}` : ''}`;
    lines.push(`### ${heading}`);

    if (elementInfo.text) {
      lines.push(`Text: "${elementInfo.text}"`);
    }

    lines.push(`CSS selector: ${elementInfo.selector}`);
    if (elementInfo.xpath) {
      lines.push(`XPath: ${elementInfo.xpath}`);
    }

    if (elementInfo.primaryLocator) {
      lines.push(`Primary locator: ${elementInfo.primaryLocator.playwright}`);
    }

    lines.push(`Size: ${elementInfo.dimensions}`);

    if (elementInfo.reactComponents) {
      lines.push(`React chain: ${elementInfo.reactComponents.join(' -> ')}`);
    }

    if (elementInfo.locators?.length) {
      lines.push('Locator ranking:');
      elementInfo.locators.slice(0, 5).forEach((locator) => {
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
        lines.push(`Capture pixels: x=${rect.x}, y=${rect.y}, w=${rect.width}, h=${rect.height}`);
      }
      if (crop.imageDataUrl) {
        lines.push('Crop preview image: embedded in JSON under `screenshotCrop.imageDataUrl`.');
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

  function formatBundleForClipboard(bundle, includeJson = true) {
    const lines = [
      '# Element Debug Bundle',
      '',
      `Captured at: ${bundle.generatedAt}`,
      `URL: ${bundle.page.url}`,
      `Title: ${bundle.page.title}`,
      `Elements: ${bundle.totalElements}`,
      '',
      '## Session Controls',
      '- Click: add element to bundle',
      '- Enter: export bundle to clipboard',
      '- Backspace/Delete/Ctrl+Z: remove latest selection',
      '- Escape: cancel picker',
      '',
      '## Elements',
      '',
    ];

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

  async function exportBundle() {
    if (isExporting) return;

    if (selections.length === 0) {
      showToast('No elements selected. Click elements first.');
      return;
    }

    isExporting = true;
    const count = selections.length;
    showToast(`Building bundle for ${count} ${pluralize(count, 'element', 'elements')}...`, 2500);

    const screenshotData = await buildScreenshotData();
    const bundle = buildBundle(screenshotData);

    try {
      const copyMode = await copyBundleToClipboard(bundle);
      if (copyMode === 'full') {
        showToast(`Copied full debug bundle (${count} ${pluralize(count, 'element', 'elements')}).`, 2400);
      } else if (copyMode === 'slim') {
        showToast('Copied bundle without inline crop images.', 2600);
      } else {
        showToast('Copied summary bundle (payload was too large).', 2600);
      }
      cleanup();
    } catch (error) {
      console.error('Failed to copy debug bundle:', error);
      isExporting = false;
      showToast('Failed to copy bundle. Check console for details.', 2600);
    }
  }

  function onMouseMove(event) {
    const element = document.elementFromPoint(event.clientX, event.clientY);
    if (!isElementNode(element) || isPickerUi(element)) return;

    if (element !== currentElement) {
      currentElement = element;
      updateOverlay(element);
    }
  }

  function onClick(event) {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();

    if (isExporting) return;
    if (!currentElement || isPickerUi(currentElement)) return;

    addSelection(currentElement);
  }

  function onViewportChange() {
    if (currentElement) {
      updateOverlay(currentElement);
    }
    updateBadges();
  }

  function onKeyDown(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      cleanup();
      return;
    }

    if (event.key === 'Enter') {
      event.preventDefault();
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

    if (overlay) overlay.remove();
    if (badgeLayer) badgeLayer.remove();

    overlay = null;
    badgeLayer = null;
    currentElement = null;
    selections = [];
    isExporting = false;
    window.__elementPickerActive = false;
  }

  createOverlay();
  createBadgeLayer();

  document.addEventListener('mousemove', onMouseMove, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('scroll', onViewportChange, true);
  window.addEventListener('resize', onViewportChange, true);

  showToast('Bundle mode active: click elements, Enter exports, Backspace undoes, ESC cancels.', 3200);
})();
