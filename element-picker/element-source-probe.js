// Element Picker source probe (page world).
//
// picker.js runs in the extension's isolated world, where framework internals
// such as React fibers are invisible. picker.js dispatches a request event on the
// selected element; this probe answers synchronously with where that element
// comes from in source: component chain, creation sites, and nearest props.
(function () {
  if (window.__elementPickerSourceProbe) return;
  Object.defineProperty(window, '__elementPickerSourceProbe', { value: true });

  const REQUEST_EVENT = 'element-picker:source-request';
  const RESPONSE_EVENT = 'element-picker:source-response';
  const MAX_COMPONENTS = 8;
  const MAX_PROPS = 12;

  // React work tags for user components.
  const COMPONENT_TAGS = new Set([0, 1, 11, 14, 15]);
  const FRAMEWORK_FRAME = /node_modules|\/\.vite\/deps\/|react-dom|react-jsx|jsx-runtime|jsx-dev-runtime|\/_next\/static\/chunks\/(?:framework|main|webpack)/;

  function truncate(value, maxLength) {
    const text = String(value);
    return text.length <= maxLength ? text : `${text.slice(0, maxLength - 3)}...`;
  }

  function cleanFile(file) {
    const text = String(file || '');
    try {
      const url = new URL(text);
      if (url.protocol === 'http:' || url.protocol === 'https:') return decodeURIComponent(url.pathname);
    } catch {
      // Not a URL: absolute or relative file path.
    }
    return text.replace(/^webpack-internal:\/\/\/(?:\([^)]*\)\/)?/, '').replace(/^file:\/\//, '').replace(/\?.*$/, '');
  }

  function parseStackSource(stack) {
    const lines = String(stack || '').split('\n').slice(1);
    for (const line of lines) {
      const match = line.match(/\(?((?:https?|file|webpack-internal|webpack):\/\/[^\s)]+?):(\d+):(\d+)\)?\s*$/);
      if (!match || FRAMEWORK_FRAME.test(match[1])) continue;
      // Error stacks are not source-mapped, so the line is approximate after transpilation.
      return { file: cleanFile(match[1]), line: Number(match[2]), approximate: true };
    }
    return null;
  }

  function readFiberSource(fiber) {
    const source = fiber?._debugSource;
    if (source?.fileName) {
      return { file: cleanFile(source.fileName), line: source.lineNumber || null };
    }
    const debugStack = fiber?._debugStack;
    if (debugStack) return parseStackSource(typeof debugStack === 'string' ? debugStack : debugStack.stack);
    return null;
  }

  function sanitizeProps(props) {
    if (!props || typeof props !== 'object') return null;

    const result = {};
    let count = 0;
    for (const [key, value] of Object.entries(props)) {
      if (key === 'children' || key.startsWith('__')) continue;
      if (count >= MAX_PROPS) break;
      if (/(password|secret|token|auth|cookie|session|credential|api[-_]?key)/i.test(key)) {
        result[key] = '[redacted]';
      } else if (typeof value === 'function') {
        result[key] = '[function]';
      } else if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
        result[key] = typeof value === 'string' ? truncate(value, 120) : value;
      } else if (value === undefined) {
        continue;
      } else {
        try {
          result[key] = truncate(JSON.stringify(value), 80);
        } catch {
          result[key] = '[object]';
        }
      }
      count += 1;
    }
    return Object.keys(result).length ? result : null;
  }

  function getReactFiber(element) {
    let current = element;
    for (let depth = 0; current && depth < 12; depth += 1) {
      const key = Object.keys(current).find((name) => (
        name.startsWith('__reactFiber$') || name.startsWith('__reactInternalInstance$')
      ));
      if (key) return { fiber: current[key], fromAncestor: depth > 0 };
      current = current.parentElement;
    }
    return null;
  }

  function getReactName(fiber) {
    const type = fiber.type || fiber.elementType;
    if (!type) return null;
    if (typeof type === 'function') return type.displayName || type.name || 'Anonymous';
    if (typeof type === 'object') {
      const inner = type.type || type.render;
      return type.displayName || inner?.displayName || inner?.name || 'Anonymous';
    }
    return null;
  }

  function describeReact(element) {
    const found = getReactFiber(element);
    if (!found) return null;

    const { fiber: hostFiber, fromAncestor } = found;
    const components = [];
    let props = null;
    let fiber = hostFiber.return;
    for (let guard = 0; fiber && guard < 80 && components.length < MAX_COMPONENTS; guard += 1) {
      if (COMPONENT_TAGS.has(fiber.tag)) {
        const name = getReactName(fiber);
        if (name) {
          if (!props) props = sanitizeProps(fiber.memoizedProps);
          components.push({
            name,
            key: fiber.key != null ? String(fiber.key) : null,
            usedAt: readFiberSource(fiber),
          });
        }
      }
      fiber = fiber.return;
    }

    return {
      framework: 'react',
      elementSource: fromAncestor ? null : readFiberSource(hostFiber),
      components,
      props,
    };
  }

  function describeVue(element) {
    let current = element;
    for (let depth = 0; current && depth < 12; depth += 1) {
      const instance = current.__vueParentComponent;
      if (instance) {
        const components = [];
        for (let node = instance; node && components.length < MAX_COMPONENTS; node = node.parent) {
          const type = node.type || {};
          const file = type.__file ? cleanFile(type.__file) : null;
          components.push({
            name: type.name || type.__name || (file ? file.split('/').pop().replace(/\.vue$/, '') : 'Anonymous'),
            key: node.vnode?.key != null ? String(node.vnode.key) : null,
            file,
          });
        }
        return { framework: 'vue', components, props: sanitizeProps(instance.props) };
      }

      const legacy = current.__vue__;
      if (legacy) {
        const components = [];
        for (let node = legacy; node && components.length < MAX_COMPONENTS; node = node.$parent) {
          const options = node.$options || {};
          components.push({
            name: options.name || options._componentTag || 'Anonymous',
            file: options.__file ? cleanFile(options.__file) : null,
          });
        }
        return { framework: 'vue', components, props: sanitizeProps(legacy.$props) };
      }
      current = current.parentElement;
    }
    return null;
  }

  function describeSvelte(element) {
    let current = element;
    for (let depth = 0; current && depth < 12; depth += 1) {
      const loc = current.__svelte_meta?.loc;
      if (loc?.file) {
        return {
          framework: 'svelte',
          // Svelte versions disagree on 0- or 1-based lines.
          elementSource: depth === 0 ? { file: cleanFile(loc.file), line: loc.line ?? null, approximate: true } : null,
          components: [{ name: cleanFile(loc.file).split('/').pop(), file: cleanFile(loc.file) }],
        };
      }
      current = current.parentElement;
    }
    return null;
  }

  document.addEventListener(REQUEST_EVENT, (event) => {
    const element = event.composedPath?.()[0] || event.target;
    let result = null;
    try {
      if (element instanceof Element) {
        result = describeReact(element) || describeVue(element) || describeSvelte(element);
      }
    } catch (error) {
      result = { error: truncate(error?.message || error, 160) };
    }
    document.dispatchEvent(new CustomEvent(RESPONSE_EVENT, { detail: JSON.stringify(result) }));
  }, true);
})();
