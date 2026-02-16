// Element Picker for Claude Code
(function() {
  // Prevent multiple injections
  if (window.__elementPickerActive) return;
  window.__elementPickerActive = true;

  let overlay = null;
  let currentElement = null;

  // Create highlight overlay
  function createOverlay() {
    overlay = document.createElement('div');
    overlay.id = '__element-picker-overlay';
    document.body.appendChild(overlay);
  }

  // Get React component info if available
  function getReactInfo(element) {
    const fiberKey = Object.keys(element).find(key => 
      key.startsWith('__reactFiber$') || key.startsWith('__reactInternalInstance$')
    );
    
    if (!fiberKey) return null;
    
    let fiber = element[fiberKey];
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

  // Generate a unique CSS selector for the element
  function getSelector(element) {
    if (element.id) {
      return `#${element.id}`;
    }
    
    const path = [];
    while (element && element.nodeType === Node.ELEMENT_NODE) {
      let selector = element.tagName.toLowerCase();
      
      if (element.id) {
        selector = `#${element.id}`;
        path.unshift(selector);
        break;
      }
      
      const meaningfulClasses = Array.from(element.classList)
        .filter(c => !c.match(/^(p-|m-|w-|h-|flex|grid|text-|bg-|border-|rounded)/))
        .slice(0, 2);
      
      if (meaningfulClasses.length > 0) {
        selector += '.' + meaningfulClasses.join('.');
      } else if (element.parentElement) {
        const siblings = Array.from(element.parentElement.children)
          .filter(e => e.tagName === element.tagName);
        if (siblings.length > 1) {
          const index = siblings.indexOf(element) + 1;
          selector += `:nth-of-type(${index})`;
        }
      }
      
      path.unshift(selector);
      element = element.parentElement;
      
      if (path.length >= 4) break;
    }
    
    return path.join(' > ');
  }

  // Get element's text content preview
  function getTextPreview(element) {
    const text = element.textContent?.trim() || '';
    if (text.length > 50) {
      return text.substring(0, 50) + '...';
    }
    return text;
  }

  // Get truncated HTML snippet
  function getHtmlSnippet(element, maxLength = 500) {
    const html = element.outerHTML;
    if (html.length <= maxLength) {
      return html;
    }
    // Try to cut at a reasonable point
    const truncated = html.substring(0, maxLength);
    // Find last complete tag or space
    const lastSpace = truncated.lastIndexOf(' ');
    const lastClose = truncated.lastIndexOf('>');
    const cutPoint = Math.max(lastSpace, lastClose, maxLength - 50);
    return truncated.substring(0, cutPoint) + '...';
  }

  // Get key computed styles for debugging
  function getDebugStyles(element) {
    const computed = window.getComputedStyle(element);
    const styles = {};
    
    // Visibility issues
    if (computed.display === 'none') styles.display = 'none';
    if (computed.visibility === 'hidden') styles.visibility = 'hidden';
    if (parseFloat(computed.opacity) < 1) styles.opacity = computed.opacity;
    
    // Position/layout
    if (computed.position !== 'static') {
      styles.position = computed.position;
      if (computed.zIndex !== 'auto') styles.zIndex = computed.zIndex;
    }
    
    // Overflow (clipping issues)
    if (computed.overflow !== 'visible') styles.overflow = computed.overflow;
    
    // Flex/grid context
    if (computed.display.includes('flex')) {
      styles.display = computed.display;
      styles.flexDirection = computed.flexDirection;
      styles.justifyContent = computed.justifyContent;
      styles.alignItems = computed.alignItems;
    }
    if (computed.display.includes('grid')) {
      styles.display = computed.display;
    }
    
    // Pointer events (click issues)
    if (computed.pointerEvents === 'none') styles.pointerEvents = 'none';
    
    return Object.keys(styles).length > 0 ? styles : null;
  }

  // Get React props/state if available
  function getReactState(element) {
    const fiberKey = Object.keys(element).find(key => 
      key.startsWith('__reactFiber$') || key.startsWith('__reactInternalInstance$')
    );
    
    if (!fiberKey) return null;
    
    let fiber = element[fiberKey];
    
    while (fiber) {
      if (fiber.type && typeof fiber.type === 'function') {
        const result = {};
        
        // Get props (filter out children and functions)
        if (fiber.memoizedProps) {
          const props = {};
          for (const [key, value] of Object.entries(fiber.memoizedProps)) {
            if (key === 'children') continue;
            if (typeof value === 'function') {
              props[key] = '[function]';
            } else if (typeof value === 'object' && value !== null) {
              try {
                props[key] = JSON.stringify(value).substring(0, 100);
              } catch {
                props[key] = '[object]';
              }
            } else {
              props[key] = value;
            }
          }
          if (Object.keys(props).length > 0) result.props = props;
        }
        
        // Get state from hooks
        if (fiber.memoizedState && typeof fiber.memoizedState === 'object') {
          try {
            let state = fiber.memoizedState;
            let stateValues = [];
            let count = 0;
            while (state && count < 3) {
              if (state.memoizedState !== undefined && 
                  typeof state.memoizedState !== 'function' &&
                  state.memoizedState !== null) {
                stateValues.push(state.memoizedState);
              }
              state = state.next;
              count++;
            }
            if (stateValues.length > 0) result.state = stateValues;
          } catch {
            // State extraction can be finicky
          }
        }
        
        if (Object.keys(result).length > 0) return result;
      }
      fiber = fiber.return;
    }
    
    return null;
  }

  // Get form-specific state
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

  // Get accessibility info
  function getA11yInfo(element) {
    const info = {};
    
    const role = element.getAttribute('role');
    if (role) info.role = role;
    
    for (const attr of element.attributes) {
      if (attr.name.startsWith('aria-')) {
        info[attr.name] = attr.value;
      }
    }
    
    if (element.tabIndex !== -1 && element.tabIndex !== 0) {
      info.tabIndex = element.tabIndex;
    }
    
    return Object.keys(info).length > 0 ? info : null;
  }

  // Build the info object for clipboard
  function buildElementInfo(element) {
    const rect = element.getBoundingClientRect();
    const info = {
      selector: getSelector(element),
      tag: element.tagName.toLowerCase(),
      classes: Array.from(element.classList).join(' '),
      id: element.id || null,
      text: getTextPreview(element),
      dimensions: `${Math.round(rect.width)}x${Math.round(rect.height)}`,
    };
    
    const reactComponents = getReactInfo(element);
    if (reactComponents) {
      info.reactComponents = reactComponents;
    }
    
    const reactState = getReactState(element);
    if (reactState) {
      info.reactState = reactState;
    }
    
    const debugStyles = getDebugStyles(element);
    if (debugStyles) {
      info.styles = debugStyles;
    }
    
    const formState = getFormState(element);
    if (formState) {
      info.formState = formState;
    }
    
    const a11y = getA11yInfo(element);
    if (a11y) {
      info.accessibility = a11y;
    }
    
    // Get data attributes
    const dataAttrs = {};
    for (const attr of element.attributes) {
      if (attr.name.startsWith('data-')) {
        dataAttrs[attr.name] = attr.value;
      }
    }
    if (Object.keys(dataAttrs).length > 0) {
      info.dataAttributes = dataAttrs;
    }
    
    // HTML snippet
    info.html = getHtmlSnippet(element);
    
    return info;
  }

  // Format info for clipboard (Claude-friendly)
  function formatForClipboard(info) {
    let output = `URL: ${window.location.href}\n`;
    output += `Element: ${info.tag}`;
    if (info.id) output += `#${info.id}`;
    output += '\n';
    output += `Selector: ${info.selector}\n`;
    
    if (info.classes) {
      output += `Classes: ${info.classes}\n`;
    }
    
    if (info.reactComponents) {
      output += `React: ${info.reactComponents.join(' → ')}\n`;
    }
    
    if (info.reactState) {
      if (info.reactState.props) {
        output += `Props: ${JSON.stringify(info.reactState.props)}\n`;
      }
      if (info.reactState.state) {
        output += `State: ${JSON.stringify(info.reactState.state)}\n`;
      }
    }
    
    if (info.styles) {
      output += `Styles: ${JSON.stringify(info.styles)}\n`;
    }
    
    if (info.formState) {
      output += `Form: ${JSON.stringify(info.formState)}\n`;
    }
    
    if (info.accessibility) {
      output += `A11y: ${JSON.stringify(info.accessibility)}\n`;
    }
    
    if (info.text) {
      output += `Text: "${info.text}"\n`;
    }
    
    output += `Size: ${info.dimensions}\n`;
    
    if (info.dataAttributes) {
      output += `Data attrs: ${JSON.stringify(info.dataAttributes)}\n`;
    }
    
    if (info.html) {
      output += `\nHTML:\n${info.html}\n`;
    }
    
    return output;
  }

  // Update overlay position
  function updateOverlay(element) {
    if (!element || !overlay) return;
    
    const rect = element.getBoundingClientRect();
    overlay.style.cssText = `
      position: fixed;
      top: ${rect.top}px;
      left: ${rect.left}px;
      width: ${rect.width}px;
      height: ${rect.height}px;
      pointer-events: none;
      z-index: 2147483647;
    `;
  }

  // Mouse move handler
  function onMouseMove(e) {
    const element = document.elementFromPoint(e.clientX, e.clientY);
    if (element && element !== overlay && element !== currentElement) {
      currentElement = element;
      updateOverlay(element);
    }
  }

  // Click handler
  async function onClick(e) {
    e.preventDefault();
    e.stopPropagation();
    
    if (currentElement) {
      const info = buildElementInfo(currentElement);
      const text = formatForClipboard(info);
      
      try {
        await navigator.clipboard.writeText(text);
        showToast('Copied to clipboard!');
      } catch (err) {
        console.error('Failed to copy:', err);
        showToast('Failed to copy - check console');
      }
    }
    
    cleanup();
  }

  // Show toast notification
  function showToast(message) {
    const toast = document.createElement('div');
    toast.textContent = message;
    toast.style.cssText = `
      position: fixed;
      bottom: 20px;
      left: 50%;
      transform: translateX(-50%);
      background: #1a1a2e;
      color: #fff;
      padding: 12px 24px;
      border-radius: 8px;
      font-family: system-ui, sans-serif;
      font-size: 14px;
      z-index: 2147483647;
      box-shadow: 0 4px 12px rgba(0,0,0,0.3);
    `;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 2000);
  }

  // Escape key handler
  function onKeyDown(e) {
    if (e.key === 'Escape') {
      cleanup();
    }
  }

  // Cleanup
  function cleanup() {
    document.removeEventListener('mousemove', onMouseMove, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKeyDown, true);
    if (overlay) overlay.remove();
    window.__elementPickerActive = false;
  }

  // Initialize
  createOverlay();
  document.addEventListener('mousemove', onMouseMove, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', onKeyDown, true);
  
  showToast('Click an element to copy info (ESC to cancel)');
})();
