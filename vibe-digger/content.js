// Vibe Digger overlay UI. Runs in the isolated world and talks to the
// MAIN-world page agent over window.postMessage.
(function () {
  if (window.__vibeDiggerContentLoaded) {
    window.__vibeDiggerOpenPanel?.();
    return;
  }
  window.__vibeDiggerContentLoaded = true;

  const AGENT_SOURCE = 'vibe-digger-agent';
  const CONTROL_SOURCE = 'vibe-digger-control';
  const MAX_VISIBLE_FLASHES = 80;
  const PANEL_VIEWPORT_MARGIN = 8;
  const COPY_ICON = `
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <rect x="5.5" y="5.5" width="7" height="7" rx="1"></rect>
      <path d="M3.5 10.5h-1v-7a1 1 0 0 1 1-1h7v1"></path>
    </svg>`;

  const ui = {
    host: null,
    shadow: null,
    panel: null,
    header: null,
    body: null,
    tooltip: null,
    hoverBox: null,
    flashLayer: null,
    minimizedButton: null,
    issuesButton: null,
    inspectButton: null,
    heatmapButton: null,
  };

  const model = {
    open: false,
    minimized: false,
    panelPosition: null,
    view: 'home', // 'home' | 'issues' | 'network'
    inspectMode: false,
    heatmapOn: false,
    status: null,
    pinned: null,
    issues: [],
    network: [],
    expandedNetworkIds: new Set(),
    copyPending: false,
    lastHover: null,
  };

  function sendControl(command, extra = {}) {
    window.postMessage({ source: CONTROL_SOURCE, command, ...extra }, '*');
  }

  // ---------------------------------------------------------------------------
  // Shadow DOM shell
  // ---------------------------------------------------------------------------

  const STYLE = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .vd-panel {
      position: fixed; right: 16px; bottom: 16px; width: min(360px, calc(100vw - 32px));
      max-height: min(64vh, 560px); display: flex; flex-direction: column;
      background: #16142a; color: #e8e6f5; border: 1px solid #3d3866;
      border-radius: 12px; box-shadow: 0 12px 32px rgba(0,0,0,.45);
      font: 12px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      z-index: 2147483647; overflow: hidden;
    }
    .vd-minimized {
      appearance: none; position: fixed; left: 16px; bottom: 16px;
      display: none; align-items: center; gap: 7px; z-index: 2147483647;
      border: 1px solid #4c4585; border-radius: 999px; padding: 7px 11px;
      background: #201c3d; color: #e8e6f5; box-shadow: 0 8px 22px rgba(0,0,0,.4);
      font: 700 11px/1.2 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      cursor: pointer;
    }
    .vd-minimized.visible { display: inline-flex; }
    .vd-minimized:hover { background: #302a5c; border-color: #8b5cf6; }
    .vd-minimized-dot { width: 7px; height: 7px; border-radius: 50%; background: #a78bfa; }
    .vd-header {
      display: flex; align-items: center; gap: 8px; padding: 8px 10px;
      background: #201c3d; border-bottom: 1px solid #3d3866; cursor: grab;
      user-select: none; touch-action: none;
    }
    .vd-header.dragging { cursor: grabbing; }
    .vd-header .vd-btn { flex: none; padding: 2px 7px; font-size: 13px; line-height: 1.2; }
    .vd-title { font-weight: 700; font-size: 12px; letter-spacing: .02em; }
    .vd-dot { width: 8px; height: 8px; border-radius: 50%; background: #6b7280; flex: none; }
    .vd-dot.on { background: #34d399; }
    .vd-status-text { color: #a5a0c8; font-size: 11px; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .vd-toolbar { display: flex; gap: 6px; padding: 8px 10px; border-bottom: 1px solid #2c2850; flex-wrap: wrap; }
    .vd-btn {
      appearance: none; border: 1px solid #4c4585; background: #262149; color: #dcd9f0;
      border-radius: 7px; padding: 4px 9px; font: inherit; font-size: 11px; cursor: pointer;
    }
    .vd-btn:hover { background: #302a5c; }
    .vd-btn.active { background: #7c3aed; border-color: #8b5cf6; color: #fff; }
    .vd-btn.ghost { border-color: transparent; background: transparent; color: #a5a0c8; }
    .vd-btn.ghost:hover { color: #fff; background: #262149; }
    .vd-view-actions { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 6px; }
    .vd-icon-btn {
      appearance: none; flex: none; display: inline-flex; align-items: center; justify-content: center;
      width: 22px; height: 22px; padding: 3px; border: 1px solid transparent;
      border-radius: 6px; background: transparent; color: #8d87b8; cursor: pointer;
    }
    .vd-icon-btn:hover { color: #fff; border-color: #4c4585; background: #262149; }
    .vd-icon-btn.copied { color: #34d399; }
    .vd-icon-btn svg { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 1.4; }
    .vd-badge {
      display: inline-block; min-width: 16px; padding: 0 4px; margin-left: 4px;
      background: #dc2626; color: #fff; border-radius: 8px; font-size: 10px;
      text-align: center; line-height: 15px;
    }
    .vd-badge.zero { background: #3d3866; }
    .vd-body { overflow-y: auto; padding: 10px; flex: 1; }
    .vd-hint { color: #a5a0c8; }
    .vd-hint code { background: #262149; padding: 1px 4px; border-radius: 4px; font-family: ui-monospace, monospace; }
    .vd-section-title { font-weight: 700; margin: 10px 0 4px; color: #c4b5fd; font-size: 11px; text-transform: uppercase; letter-spacing: .05em; }
    .vd-section-title:first-child { margin-top: 0; }
    .vd-chain { color: #a5a0c8; font-family: ui-monospace, monospace; font-size: 11px; word-break: break-word; }
    .vd-chain b { color: #f0abfc; font-weight: 700; }
    .vd-kv { font-family: ui-monospace, monospace; font-size: 11px; white-space: pre-wrap; word-break: break-word; background: #1c1936; border: 1px solid #2c2850; border-radius: 6px; padding: 6px 8px; margin: 4px 0; max-height: 150px; overflow-y: auto; }
    .vd-meta { color: #8d87b8; font-size: 11px; margin-top: 2px; }
    .vd-issue { border: 1px solid #2c2850; border-radius: 8px; padding: 6px 8px; margin-bottom: 6px; cursor: pointer; }
    .vd-issue:hover { border-color: #4c4585; }
    .vd-issue-head { display: flex; align-items: baseline; gap: 6px; }
    .vd-kind { flex: none; font-size: 10px; font-weight: 700; padding: 1px 6px; border-radius: 6px; background: #3d3866; color: #dcd9f0; }
    .vd-kind.console-error, .vd-kind.uncaught-error, .vd-kind.unhandled-rejection { background: #7f1d1d; color: #fecaca; }
    .vd-kind.console-warn, .vd-kind.react-warning { background: #78350f; color: #fde68a; }
    .vd-kind.network { background: #1e3a8a; color: #bfdbfe; }
    .vd-issue-msg { flex: 1; word-break: break-word; }
    .vd-issue-count { flex: none; color: #a5a0c8; font-size: 10px; }
    .vd-issue-detail { display: none; margin-top: 5px; font-family: ui-monospace, monospace; font-size: 10px; white-space: pre-wrap; word-break: break-word; color: #a5a0c8; max-height: 140px; overflow-y: auto; }
    .vd-issue.expanded .vd-issue-detail { display: block; }
    .vd-empty { color: #6b6598; text-align: center; padding: 18px 0; }
    .vd-net { border: 1px solid #2c2850; border-radius: 8px; padding: 5px 8px; margin-bottom: 5px; cursor: pointer; }
    .vd-net:hover { border-color: #4c4585; }
    .vd-net-head { display: flex; align-items: baseline; gap: 6px; font-family: ui-monospace, monospace; font-size: 11px; }
    .vd-net-seq { flex: none; color: #6b6598; font-size: 10px; }
    .vd-net-method { flex: none; font-weight: 700; color: #c4b5fd; }
    .vd-net-path { flex: 1; word-break: break-all; }
    .vd-net-status { flex: none; font-weight: 700; }
    .vd-net-status.ok { color: #34d399; }
    .vd-net-status.bad { color: #f87171; }
    .vd-net-status.pending { color: #a5a0c8; }
    .vd-net-size { flex: none; color: #8d87b8; font-size: 10px; white-space: nowrap; }
    .vd-net-ms { flex: none; color: #6b6598; font-size: 10px; }
    .vd-net-detail { display: none; margin-top: 5px; }
    .vd-net.expanded .vd-net-detail { display: block; }
    .vd-net-label { color: #c4b5fd; font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .05em; margin-top: 5px; }
    .vd-net-pre { font-family: ui-monospace, monospace; font-size: 10px; white-space: pre-wrap; word-break: break-word; color: #dcd9f0; background: #1c1936; border: 1px solid #2c2850; border-radius: 6px; padding: 5px 7px; margin: 3px 0 0; max-height: 160px; overflow-y: auto; }
    .vd-render-row { display: flex; justify-content: space-between; gap: 8px; font-family: ui-monospace, monospace; font-size: 11px; padding: 2px 0; }
    .vd-render-row .n { color: #f0abfc; }

    .vd-tooltip {
      position: fixed; z-index: 2147483647; pointer-events: none;
      background: #16142a; color: #e8e6f5; border: 1px solid #8b5cf6;
      border-radius: 7px; padding: 5px 8px; font: 11px/1.4 ui-monospace, monospace;
      max-width: 340px; box-shadow: 0 6px 18px rgba(0,0,0,.4); display: none;
      word-break: break-word;
    }
    .vd-tooltip b { color: #f0abfc; }
    .vd-hoverbox {
      position: fixed; z-index: 2147483645; pointer-events: none; display: none;
      border: 1.5px solid #a78bfa; background: rgba(139, 92, 246, .12); border-radius: 2px;
    }
    .vd-flash-layer { position: fixed; inset: 0; pointer-events: none; z-index: 2147483644; }
    .vd-flash {
      position: fixed; pointer-events: none; border-radius: 2px;
      animation: vd-fade .8s ease-out forwards;
    }
    .vd-flash-label {
      position: absolute; top: -16px; left: -1px; font: 700 9px/1.4 ui-monospace, monospace;
      color: #fff; background: inherit-color; padding: 0 4px; border-radius: 3px; white-space: nowrap;
    }
    @keyframes vd-fade { from { opacity: 1; } to { opacity: 0; } }
  `;

  function ensureShell() {
    if (ui.host) return;
    ui.host = document.createElement('div');
    ui.host.id = '__vibe_digger_host';
    ui.shadow = ui.host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = STYLE;
    ui.shadow.appendChild(style);

    ui.flashLayer = document.createElement('div');
    ui.flashLayer.className = 'vd-flash-layer';
    ui.shadow.appendChild(ui.flashLayer);

    ui.hoverBox = document.createElement('div');
    ui.hoverBox.className = 'vd-hoverbox';
    ui.shadow.appendChild(ui.hoverBox);

    ui.tooltip = document.createElement('div');
    ui.tooltip.className = 'vd-tooltip';
    ui.shadow.appendChild(ui.tooltip);

    document.documentElement.appendChild(ui.host);
  }

  // ---------------------------------------------------------------------------
  // Panel
  // ---------------------------------------------------------------------------

  function button(label, onClick, className = 'vd-btn') {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = className;
    el.innerHTML = label;
    el.addEventListener('click', onClick);
    return el;
  }

  function copyIconButton(textFactory, label) {
    const control = button(
      COPY_ICON,
      async (event) => {
        event.stopPropagation();
        const text = typeof textFactory === 'function' ? textFactory() : textFactory;
        if (!text || !(await writeClipboardText(text))) return;
        control.classList.add('copied');
        control.textContent = '✓';
        setTimeout(() => {
          control.classList.remove('copied');
          control.innerHTML = COPY_ICON;
        }, 1200);
      },
      'vd-icon-btn'
    );
    control.title = label;
    control.setAttribute('aria-label', label);
    return control;
  }

  let panelDrag = null;

  function clamp(value, minimum, maximum) {
    return Math.min(Math.max(value, minimum), maximum);
  }

  function constrainPanelToViewport() {
    if (!ui.panel || !model.panelPosition || model.minimized) return;
    const rect = ui.panel.getBoundingClientRect();
    const maxLeft = Math.max(PANEL_VIEWPORT_MARGIN, innerWidth - rect.width - PANEL_VIEWPORT_MARGIN);
    const maxTop = Math.max(PANEL_VIEWPORT_MARGIN, innerHeight - rect.height - PANEL_VIEWPORT_MARGIN);
    model.panelPosition = {
      left: clamp(model.panelPosition.left, PANEL_VIEWPORT_MARGIN, maxLeft),
      top: clamp(model.panelPosition.top, PANEL_VIEWPORT_MARGIN, maxTop),
    };
    Object.assign(ui.panel.style, {
      left: `${model.panelPosition.left}px`,
      top: `${model.panelPosition.top}px`,
      right: 'auto',
      bottom: 'auto',
    });
  }

  function startPanelDrag(event) {
    if (event.target.closest('button')) return;
    if (!ui.panel || model.minimized || event.button !== 0) return;
    const rect = ui.panel.getBoundingClientRect();
    panelDrag = {
      pointerId: event.pointerId,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
    };
    model.panelPosition = { left: rect.left, top: rect.top };
    ui.header?.classList.add('dragging');
    event.currentTarget.setPointerCapture?.(event.pointerId);
    event.preventDefault();
    window.addEventListener('pointermove', movePanelDrag, true);
    window.addEventListener('pointerup', stopPanelDrag, true);
    window.addEventListener('pointercancel', stopPanelDrag, true);
  }

  function movePanelDrag(event) {
    if (!panelDrag || event.pointerId !== panelDrag.pointerId) return;
    model.panelPosition = {
      left: event.clientX - panelDrag.offsetX,
      top: event.clientY - panelDrag.offsetY,
    };
    constrainPanelToViewport();
    event.preventDefault();
  }

  function stopPanelDrag(event) {
    if (!panelDrag || (event && event.pointerId !== panelDrag.pointerId)) return;
    ui.header?.classList.remove('dragging');
    panelDrag = null;
    window.removeEventListener('pointermove', movePanelDrag, true);
    window.removeEventListener('pointerup', stopPanelDrag, true);
    window.removeEventListener('pointercancel', stopPanelDrag, true);
  }

  function openPanel() {
    ensureShell();
    if (ui.panel) {
      restorePanel();
      return;
    }
    model.open = true;
    model.minimized = false;

    ui.panel = document.createElement('div');
    ui.panel.className = 'vd-panel';

    const header = document.createElement('div');
    header.className = 'vd-header';
    header.title = 'Drag to move Vibe Digger';
    header.addEventListener('pointerdown', startPanelDrag);
    ui.header = header;
    const dot = document.createElement('span');
    dot.className = 'vd-dot';
    const title = document.createElement('span');
    title.className = 'vd-title';
    title.textContent = 'Vibe Digger';
    const statusText = document.createElement('span');
    statusText.className = 'vd-status-text';
    statusText.textContent = 'digging…';
    const minimizeButton = button('−', () => minimizePanel(), 'vd-btn ghost');
    minimizeButton.title = 'Minimize to bottom left';
    minimizeButton.setAttribute('aria-label', 'Minimize Vibe Digger to bottom left');
    const closeButton = button('✕', () => closePanel(), 'vd-btn ghost');
    closeButton.title = 'Close Vibe Digger';
    closeButton.setAttribute('aria-label', 'Close Vibe Digger');
    header.append(dot, title, statusText, minimizeButton, closeButton);
    ui.statusDot = dot;
    ui.statusText = statusText;

    const toolbar = document.createElement('div');
    toolbar.className = 'vd-toolbar';
    ui.inspectButton = button('Inspect', () => setInspectMode(!model.inspectMode));
    ui.heatmapButton = button('Heatmap', () => setHeatmap(!model.heatmapOn));
    ui.issuesButton = button('Issues<span class="vd-badge zero">0</span>', () => {
      model.view = model.view === 'issues' ? 'home' : 'issues';
      sendControl('get-issues');
      renderBody();
    });
    ui.networkButton = button('Net<span class="vd-badge zero">0</span>', () => {
      model.view = model.view === 'network' ? 'home' : 'network';
      sendControl('get-network');
      renderBody();
    });
    const copyButton = button('Copy', () => {
      model.copyPending = true;
      sendControl('get-network');
      sendControl('get-issues');
      copyButton.textContent = 'Copied ✓';
      setTimeout(() => {
        copyButton.textContent = 'Copy';
      }, 1500);
    });
    toolbar.append(
      ui.inspectButton,
      ui.heatmapButton,
      ui.networkButton,
      ui.issuesButton,
      copyButton
    );

    ui.body = document.createElement('div');
    ui.body.className = 'vd-body';

    ui.panel.append(header, toolbar, ui.body);
    ui.minimizedButton = button(
      '<span class="vd-minimized-dot"></span>Vibe Digger',
      () => restorePanel(),
      'vd-minimized'
    );
    ui.minimizedButton.title = 'Restore Vibe Digger';
    ui.minimizedButton.setAttribute('aria-label', 'Restore Vibe Digger');
    ui.shadow.append(ui.panel, ui.minimizedButton);
    if (model.panelPosition) requestAnimationFrame(constrainPanelToViewport);

    renderBody();
    sendControl('hello');
    sendControl('get-issues');
    sendControl('get-network');
  }

  function minimizePanel() {
    if (!ui.panel || model.minimized) return;
    setInspectMode(false);
    model.minimized = true;
    ui.panel.style.display = 'none';
    ui.minimizedButton?.classList.add('visible');
  }

  function restorePanel() {
    if (!ui.panel || !model.minimized) return;
    model.minimized = false;
    ui.panel.style.display = '';
    ui.minimizedButton?.classList.remove('visible');
    if (model.panelPosition) requestAnimationFrame(constrainPanelToViewport);
  }

  function closePanel() {
    stopPanelDrag();
    setInspectMode(false);
    setHeatmap(false);
    model.open = false;
    model.minimized = false;
    model.view = 'home';
    ui.panel?.remove();
    ui.minimizedButton?.remove();
    ui.panel = null;
    ui.header = null;
    ui.minimizedButton = null;
    ui.tooltip.style.display = 'none';
    ui.hoverBox.style.display = 'none';
  }

  function updateStatusHeader() {
    if (!ui.panel || !model.status) return;
    const s = model.status;
    ui.statusDot.className = `vd-dot${s.reactDetected ? ' on' : ''}`;
    if (!s.reactDetected) {
      ui.statusText.textContent = 'no React detected on this page (yet)';
    } else if (s.hookMode === 'none') {
      ui.statusText.textContent = 'React found · heatmap needs a reload';
    } else {
      ui.statusText.textContent = `React · ${s.commitCount} commits observed`;
    }
    const badge = ui.issuesButton.querySelector('.vd-badge');
    const count = model.issues.length;
    badge.textContent = String(count);
    badge.className = `vd-badge${count === 0 ? ' zero' : ''}`;

    const netBadge = ui.networkButton.querySelector('.vd-badge');
    netBadge.textContent = String(model.network.length);
    netBadge.className = 'vd-badge zero';
  }

  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function formatValue(value) {
    try {
      return JSON.stringify(value, null, 1) ?? 'undefined';
    } catch {
      return String(value);
    }
  }

  function renderBody() {
    if (!ui.body) return;
    if (model.panelPosition) requestAnimationFrame(constrainPanelToViewport);
    const existingNetworkRows =
      model.view === 'network' ? ui.body.querySelectorAll('.vd-net') : [];
    const networkScrollState = existingNetworkRows.length
      ? {
          top: ui.body.scrollTop,
          stickToBottom:
            ui.body.scrollHeight - ui.body.clientHeight - ui.body.scrollTop < 16,
        }
      : null;
    ui.body.textContent = '';

    if (model.view === 'issues') {
      renderIssuesView();
      return;
    }

    if (model.view === 'network') {
      renderNetworkView(networkScrollState);
      return;
    }

    if (model.pinned) {
      renderPinnedView();
      return;
    }

    const hint = document.createElement('div');
    hint.className = 'vd-hint';
    hint.innerHTML = `
      <p><b>Inspect</b> — hover any element to see its React component; click to pin props, hooks, and state here. <code>Esc</code> exits.</p>
      <p><b>Heatmap</b> — flashes components as they re-render, with cumulative counts.</p>
      <p><b>Net</b> — the page's whole network lifecycle in order: every request and response body, plus the code that sent it.</p>
      <p><b>Issues</b> — errors, React warnings, rejections, and failed requests dug from the page.</p>
      <p><b>Copy</b> — puts an agent-ready markdown bundle on the clipboard for Claude/Codex.</p>`;
    ui.body.appendChild(hint);

    if (model.status?.renderCounts?.length) {
      const title = document.createElement('div');
      title.className = 'vd-section-title';
      title.textContent = 'Render counts';
      ui.body.appendChild(title);
      for (const row of model.status.renderCounts) {
        const el = document.createElement('div');
        el.className = 'vd-render-row';
        el.innerHTML = `<span class="n">${escapeHtml(row.name)}</span><span>×${row.count}</span>`;
        ui.body.appendChild(el);
      }
      const reset = button('Reset counts', () => sendControl('reset-render-counts'), 'vd-btn ghost');
      reset.style.marginTop = '6px';
      ui.body.appendChild(reset);
    }
  }

  function renderPinnedView() {
    const pinned = model.pinned;
    const back = button('← Unpin', () => {
      model.pinned = null;
      renderBody();
    }, 'vd-btn ghost');
    const actions = document.createElement('div');
    actions.className = 'vd-view-actions';
    actions.append(back, copyIconButton(() => buildInspectViewCopy(), 'Copy Inspect view'));
    ui.body.appendChild(actions);

    if (!pinned.react) {
      const note = document.createElement('div');
      note.className = 'vd-hint';
      note.innerHTML = `<p><code>${escapeHtml(pinned.dom?.summary || '?')}</code> has no React fiber attached.</p>`;
      ui.body.appendChild(note);
      return;
    }

    const d = pinned.details || {};
    const title = document.createElement('div');
    title.className = 'vd-section-title';
    title.textContent = d.name || 'Component';
    ui.body.appendChild(title);

    if (pinned.chain?.length) {
      const chain = document.createElement('div');
      chain.className = 'vd-chain';
      chain.innerHTML = pinned.chain
        .map((c, i) => (i === 0 ? `<b>${escapeHtml(c.name)}</b>` : escapeHtml(c.name)))
        .join(' ← ');
      ui.body.appendChild(chain);
    }

    const meta = document.createElement('div');
    meta.className = 'vd-meta';
    const bits = [];
    if (pinned.dom?.summary) bits.push(pinned.dom.summary);
    if (d.source) bits.push(d.source);
    if (d.renderCount) bits.push(`rendered ×${d.renderCount}`);
    meta.textContent = bits.join(' · ');
    ui.body.appendChild(meta);

    const sections = [
      ['Props', d.props],
      ['Hooks', d.hooks],
      ['State', d.classState],
    ];
    for (const [label, value] of sections) {
      if (value == null) continue;
      const t = document.createElement('div');
      t.className = 'vd-section-title';
      t.textContent = label;
      const v = document.createElement('div');
      v.className = 'vd-kv';
      if (label === 'Hooks') {
        v.textContent = value
          .map((h) => `#${h.index} ${h.type}: ${formatValue(h.value)}`)
          .join('\n');
      } else {
        v.textContent = formatValue(value);
      }
      ui.body.append(t, v);
    }
  }

  function renderIssuesView() {
    if (model.issues.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'vd-empty';
      empty.textContent = 'No issues dug up yet. Nice vibes.';
      ui.body.appendChild(empty);
      return;
    }

    const actions = document.createElement('div');
    actions.className = 'vd-view-actions';
    const clear = button('Clear all', () => sendControl('clear-issues'), 'vd-btn ghost');
    actions.append(clear, copyIconButton(() => buildIssuesViewCopy(), 'Copy Issues view'));
    ui.body.appendChild(actions);

    const issues = model.issues.slice().reverse();
    for (const issue of issues) {
      const row = document.createElement('div');
      row.className = 'vd-issue';
      const head = document.createElement('div');
      head.className = 'vd-issue-head';
      head.innerHTML = `
        <span class="vd-kind ${escapeHtml(issue.kind)}">${escapeHtml(issue.kind)}</span>
        <span class="vd-issue-msg">${escapeHtml(issue.message)}</span>
        <span class="vd-issue-count">×${issue.count}</span>`;
      head.appendChild(copyIconButton(() => buildIssueCopy(issue), 'Copy this issue'));
      row.appendChild(head);
      if (issue.detail && issue.detail !== issue.message) {
        const detail = document.createElement('div');
        detail.className = 'vd-issue-detail';
        detail.textContent = issue.detail;
        row.appendChild(detail);
        row.addEventListener('click', (event) => {
          if (event.target.closest('button')) return;
          row.classList.toggle('expanded');
        });
      }
      ui.body.appendChild(row);
    }
  }

  function shortPath(url) {
    try {
      const parsed = new URL(url, location.href);
      const path = parsed.pathname + parsed.search;
      return parsed.origin === location.origin ? path : `${parsed.host}${path}`;
    } catch {
      return url;
    }
  }

  function statusClass(entry) {
    if (entry.error || (typeof entry.status === 'number' && entry.status >= 400)) return 'bad';
    if (entry.kind === 'ws') {
      if (entry.wsState === 'open') return 'ok';
      if (entry.wsState === 'closed') return entry.ok ? 'pending' : 'bad';
      return 'pending';
    }
    if (entry.status == null && !entry.ok) return 'pending';
    return 'ok';
  }

  function statusLabel(entry) {
    if (entry.error && entry.kind !== 'ws') return 'ERR';
    if (entry.kind === 'ws') {
      if (entry.wsState === 'closed') return `closed ${entry.closeCode ?? ''}`.trim();
      return entry.wsState || '…';
    }
    if (typeof entry.status === 'number') return String(entry.status);
    if (entry.kind === 'beacon') return entry.ok ? 'queued' : 'dropped';
    return '…';
  }

  function formatByteSize(bytes) {
    if (!Number.isFinite(bytes) || bytes < 0) return '?';
    if (bytes < 1024) return `${bytes} B`;
    const units = ['KB', 'MB', 'GB'];
    let value = bytes / 1024;
    let unitIndex = 0;
    while (value >= 1024 && unitIndex < units.length - 1) {
      value /= 1024;
      unitIndex += 1;
    }
    const digits = value >= 10 ? 0 : 1;
    return `${value.toFixed(digits).replace(/\.0$/, '')} ${units[unitIndex]}`;
  }

  function formatFrames(entry, limit = Infinity) {
    const frames = entry.frames || [];
    const shown = frames.slice(-limit);
    return shown
      .map((f) => `${f.dir === 'send' ? '→' : '←'} +${(f.at / 1000).toFixed(2)}s ${f.data}`)
      .join('\n');
  }

  function renderNetworkView(scrollState = null) {
    if (model.network.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'vd-empty';
      empty.textContent = 'No requests dug up yet. Interact with the page (or reload it).';
      ui.body.appendChild(empty);
      return;
    }

    const actions = document.createElement('div');
    actions.className = 'vd-view-actions';
    const clear = button('Clear all', () => sendControl('clear-network'), 'vd-btn ghost');
    actions.append(clear, copyIconButton(() => buildNetworkViewCopy(), 'Copy Net view'));
    ui.body.appendChild(actions);

    // Chronological: the order IS the story.
    for (const entry of model.network) {
      const row = document.createElement('div');
      row.className = 'vd-net';
      if (model.expandedNetworkIds.has(entry.id)) row.classList.add('expanded');
      row.dataset.id = entry.id;
      const head = document.createElement('div');
      head.className = 'vd-net-head';
      head.innerHTML = `
        <span class="vd-net-seq">#${entry.seq}</span>
        <span class="vd-net-method">${escapeHtml(entry.method)}</span>
        <span class="vd-net-path">${escapeHtml(shortPath(entry.url))}</span>
        <span class="vd-net-status ${statusClass(entry)}">${escapeHtml(statusLabel(entry))}</span>
        <span class="vd-net-size" title="Request / response payload bytes">↑${formatByteSize(entry.requestSizeBytes)} ↓${formatByteSize(entry.responseSizeBytes)}</span>
        <span class="vd-net-ms">${
          entry.kind === 'ws'
            ? `${entry.frameCount || 0}⇅`
            : entry.durationMs != null ? `${entry.durationMs}ms` : ''
        }</span>`;
      head.appendChild(copyIconButton(() => buildNetworkEntryCopy(entry), 'Copy this network entry'));
      row.appendChild(head);

      const detail = document.createElement('div');
      detail.className = 'vd-net-detail';
      const sections = [
        ['URL', `${entry.method} ${entry.url}\n+${(entry.sinceLoadMs / 1000).toFixed(2)}s after load (${entry.kind})`],
        ['Request body', entry.requestBody],
        ['Response body', entry.responseBody],
        [
          entry.droppedFrames
            ? `Frames (${entry.droppedFrames} older dropped)`
            : 'Frames',
          entry.kind === 'ws' && entry.frames?.length ? formatFrames(entry) : null,
        ],
        [
          'Close',
          entry.kind === 'ws' && entry.wsState === 'closed'
            ? `code ${entry.closeCode}${entry.closeReason ? ` — ${entry.closeReason}` : ''}${entry.ok ? ' (clean)' : ' (unclean)'}`
            : null,
        ],
        ['Error', entry.error],
        ['Sent from', entry.initiator],
      ];
      for (const [label, value] of sections) {
        if (!value) continue;
        const t = document.createElement('div');
        t.className = 'vd-net-label';
        t.textContent = label;
        const pre = document.createElement('pre');
        pre.className = 'vd-net-pre';
        pre.textContent = value;
        detail.append(t, pre);
      }
      row.appendChild(detail);
      row.addEventListener('click', (event) => {
        if (event.target.closest('button, .vd-net-pre')) return; // copy or select text
        const expanded = row.classList.toggle('expanded');
        if (expanded) model.expandedNetworkIds.add(entry.id);
        else model.expandedNetworkIds.delete(entry.id);
      });
      ui.body.appendChild(row);
    }
    ui.body.scrollTop =
      !scrollState || scrollState.stickToBottom ? ui.body.scrollHeight : scrollState.top;
  }

  // ---------------------------------------------------------------------------
  // Inspect mode
  // ---------------------------------------------------------------------------

  let hoverThrottle = 0;

  function isOverOwnUi(event) {
    return event.composedPath?.().includes(ui.host);
  }

  function onInspectMove(event) {
    if (isOverOwnUi(event)) {
      ui.tooltip.style.display = 'none';
      ui.hoverBox.style.display = 'none';
      return;
    }
    const now = performance.now();
    if (now - hoverThrottle < 60) return;
    hoverThrottle = now;
    model.lastHover = { x: event.clientX, y: event.clientY };
    sendControl('inspect-point', { x: event.clientX, y: event.clientY, pin: false });
  }

  function onInspectClick(event) {
    if (isOverOwnUi(event)) return;
    event.preventDefault();
    event.stopPropagation();
    sendControl('inspect-point', { x: event.clientX, y: event.clientY, pin: true });
  }

  function onInspectKey(event) {
    if (event.key === 'Escape') setInspectMode(false);
  }

  function setInspectMode(enabled) {
    if (model.inspectMode === enabled) return;
    model.inspectMode = enabled;
    ui.inspectButton?.classList.toggle('active', enabled);
    if (enabled) {
      window.addEventListener('mousemove', onInspectMove, true);
      window.addEventListener('click', onInspectClick, true);
      window.addEventListener('keydown', onInspectKey, true);
    } else {
      window.removeEventListener('mousemove', onInspectMove, true);
      window.removeEventListener('click', onInspectClick, true);
      window.removeEventListener('keydown', onInspectKey, true);
      ui.tooltip.style.display = 'none';
      ui.hoverBox.style.display = 'none';
    }
  }

  function setHeatmap(enabled) {
    if (model.heatmapOn === enabled) return;
    model.heatmapOn = enabled;
    ui.heatmapButton?.classList.toggle('active', enabled);
    sendControl('heatmap', { enabled });
    if (!enabled) ui.flashLayer.textContent = '';
  }

  function showHoverResult(result) {
    if (!model.inspectMode || !model.lastHover) return;

    if (result.rect) {
      const { x, y, w, h } = result.rect;
      Object.assign(ui.hoverBox.style, {
        display: 'block',
        left: `${x}px`,
        top: `${y}px`,
        width: `${w}px`,
        height: `${h}px`,
      });
    }

    const parts = [];
    if (result.react && result.details?.name) {
      parts.push(`<b>&lt;${escapeHtml(result.details.name)}&gt;</b>`);
      const rest = (result.chain || []).slice(1, 4).map((c) => escapeHtml(c.name));
      if (rest.length) parts.push(`← ${rest.join(' ← ')}`);
    } else {
      parts.push(escapeHtml(result.dom?.summary || 'not React'));
      if (result.found && !result.react) parts.push('<i>(no fiber)</i>');
    }
    ui.tooltip.innerHTML = parts.join(' ');
    ui.tooltip.style.display = 'block';
    const pad = 14;
    const tx = Math.min(model.lastHover.x + pad, window.innerWidth - ui.tooltip.offsetWidth - 8);
    const ty = Math.min(model.lastHover.y + pad, window.innerHeight - ui.tooltip.offsetHeight - 8);
    ui.tooltip.style.left = `${Math.max(0, tx)}px`;
    ui.tooltip.style.top = `${Math.max(0, ty)}px`;
  }

  // ---------------------------------------------------------------------------
  // Heatmap flashes
  // ---------------------------------------------------------------------------

  function heatColor(count) {
    if (count >= 50) return '#ef4444';
    if (count >= 20) return '#f97316';
    if (count >= 8) return '#eab308';
    return '#8b5cf6';
  }

  function drawFlashes(entries) {
    if (!model.heatmapOn) return;
    while (ui.flashLayer.childElementCount > MAX_VISIBLE_FLASHES) {
      ui.flashLayer.firstElementChild.remove();
    }
    for (const entry of entries) {
      const color = heatColor(entry.count);
      const flash = document.createElement('div');
      flash.className = 'vd-flash';
      Object.assign(flash.style, {
        left: `${entry.x}px`,
        top: `${entry.y}px`,
        width: `${entry.w}px`,
        height: `${entry.h}px`,
        border: `1.5px solid ${color}`,
        background: `${color}14`,
      });
      const label = document.createElement('span');
      label.className = 'vd-flash-label';
      label.style.background = color;
      label.textContent = `${entry.name} ×${entry.count}`;
      flash.appendChild(label);
      ui.flashLayer.appendChild(flash);
      setTimeout(() => flash.remove(), 850);
    }
  }

  // ---------------------------------------------------------------------------
  // Agent-ready copy bundle
  // ---------------------------------------------------------------------------

  function truncateForBundle(text, max = 1500) {
    const value = String(text);
    return value.length <= max ? value : `${value.slice(0, max)}\n…[truncated]`;
  }

  function captureHeading(title) {
    return [
      `# ${title}`,
      '',
      `- URL: ${location.href}`,
      `- Title: ${document.title}`,
      `- Captured: ${new Date().toISOString()}`,
      '',
    ];
  }

  function buildInspectViewCopy() {
    const lines = captureHeading('Vibe Digger Inspect capture');
    const pinned = model.pinned;
    if (!pinned) return [...lines, 'No element is pinned.'].join('\n');
    if (!pinned.react) {
      return [
        ...lines,
        '## Pinned element',
        '',
        `- DOM: \`${pinned.dom?.summary || '?'}\``,
        '- React fiber: not found',
      ].join('\n');
    }

    const details = pinned.details || {};
    lines.push(`## ${details.name || 'Component'}`);
    if (pinned.chain?.length) lines.push(`- Owner chain: ${pinned.chain.map((item) => item.name).join(' ← ')}`);
    if (pinned.dom?.summary) lines.push(`- DOM: \`${pinned.dom.summary}\``);
    if (details.source) lines.push(`- Source: ${details.source}`);
    if (details.renderCount) lines.push(`- Render count: ×${details.renderCount}`);
    if (details.props != null) lines.push('', '### Props', '```json', formatValue(details.props), '```');
    if (details.hooks != null) {
      lines.push('', '### Hooks');
      for (const hook of details.hooks) {
        lines.push(`- #${hook.index} ${hook.type}: \`${formatValue(hook.value).replace(/\n\s*/g, ' ')}\``);
      }
    }
    if (details.classState != null) {
      lines.push('', '### State', '```json', formatValue(details.classState), '```');
    }
    return lines.join('\n');
  }

  function buildIssueCopy(issue) {
    const lines = [
      `## [${issue.kind}] ${issue.message}`,
      '',
      `- Count: ×${issue.count}`,
    ];
    if (issue.firstAt) lines.push(`- First seen: ${new Date(issue.firstAt).toISOString()}`);
    if (issue.lastAt) lines.push(`- Last seen: ${new Date(issue.lastAt).toISOString()}`);
    if (issue.detail && issue.detail !== issue.message) {
      lines.push('', '```', issue.detail, '```');
    }
    return lines.join('\n');
  }

  function buildIssuesViewCopy() {
    const lines = captureHeading(`Vibe Digger Issues (${model.issues.length})`);
    if (!model.issues.length) return [...lines, 'No issues captured.'].join('\n');
    for (const issue of model.issues) lines.push(buildIssueCopy(issue), '');
    return lines.join('\n').trimEnd();
  }

  function networkCopyStatus(entry) {
    if (entry.kind === 'ws') {
      if (entry.wsState === 'closed') {
        return `closed ${entry.closeCode ?? ''}${entry.ok ? ' clean' : ' UNCLEAN'}`.trim();
      }
      return entry.wsState || 'pending';
    }
    if (entry.error) return `FAILED: ${entry.error}`;
    if (entry.status != null) return String(entry.status);
    if (entry.kind === 'beacon') return entry.ok ? 'queued' : 'dropped';
    return 'pending';
  }

  function buildNetworkEntryCopy(entry) {
    const lines = [
      `## #${entry.seq} ${entry.method} ${entry.url}`,
      '',
      `- Status: ${networkCopyStatus(entry)}`,
      `- Started: +${(entry.sinceLoadMs / 1000).toFixed(2)}s after load`,
      `- Payload: ↑${formatByteSize(entry.requestSizeBytes)} ↓${formatByteSize(entry.responseSizeBytes)}`,
    ];
    if (entry.durationMs != null) lines.push(`- Duration: ${entry.durationMs}ms`);
    if (entry.requestBody) lines.push('', '### Request body', '```', entry.requestBody, '```');
    if (entry.responseBody) lines.push('', '### Response body', '```', entry.responseBody, '```');
    if (entry.kind === 'ws' && entry.frames?.length) {
      lines.push('', '### Frames', '```', formatFrames(entry), '```');
    }
    if (entry.error) lines.push('', '### Error', '```', entry.error, '```');
    if (entry.initiator) lines.push('', '### Sent from', '```', entry.initiator, '```');
    return lines.join('\n');
  }

  function buildNetworkViewCopy() {
    const lines = captureHeading(`Vibe Digger Net (${model.network.length})`);
    if (!model.network.length) return [...lines, 'No network entries captured.'].join('\n');
    for (const entry of model.network) lines.push(buildNetworkEntryCopy(entry), '');
    return lines.join('\n').trimEnd();
  }

  function buildBundle() {
    const lines = [];
    lines.push('# Vibe Digger capture');
    lines.push('');
    lines.push(`- URL: ${location.href}`);
    lines.push(`- Title: ${document.title}`);
    lines.push(`- Captured: ${new Date().toISOString()}`);
    const s = model.status;
    if (s) {
      lines.push(
        `- React: ${s.reactDetected ? 'detected' : 'not detected'} (hook: ${s.hookMode}, commits observed: ${s.commitCount})`
      );
    }
    lines.push('');

    if (model.pinned?.react) {
      const d = model.pinned.details || {};
      lines.push(`## Pinned component: ${d.name || '?'}`);
      if (model.pinned.chain?.length) {
        lines.push(`- Owner chain: ${model.pinned.chain.map((c) => c.name).join(' ← ')}`);
      }
      if (model.pinned.dom?.summary) lines.push(`- DOM: \`${model.pinned.dom.summary}\``);
      if (d.source) lines.push(`- Source: ${d.source}`);
      if (d.renderCount) lines.push(`- Render count this session: ${d.renderCount}`);
      if (d.props) {
        lines.push('', '### Props', '```json', formatValue(d.props), '```');
      }
      if (d.hooks) {
        lines.push('', '### Hooks');
        for (const h of d.hooks) {
          lines.push(`- #${h.index} ${h.type}: \`${formatValue(h.value).replace(/\n\s*/g, ' ')}\``);
        }
      }
      if (d.classState) {
        lines.push('', '### Class state', '```json', formatValue(d.classState), '```');
      }
      lines.push('');
    }

    if (s?.renderCounts?.length) {
      lines.push('## Render counts (top components)');
      for (const row of s.renderCounts) lines.push(`- ${row.name}: ×${row.count}`);
      lines.push('');
    }

    if (model.network.length) {
      const entries = model.network.slice(-25);
      lines.push(`## Network lifecycle (last ${entries.length} of ${model.network.length}, in order)`);
      lines.push('');
      for (const entry of entries) {
        const status = entry.kind === 'ws'
          ? entry.wsState === 'closed'
            ? `closed ${entry.closeCode ?? ''}${entry.ok ? ' clean' : ' UNCLEAN'}`
            : entry.wsState
          : entry.error
            ? `FAILED: ${entry.error}`
            : entry.status != null
              ? entry.status
              : entry.kind === 'beacon'
                ? 'queued'
                : 'pending';
        const timing = entry.durationMs != null ? `, ${entry.durationMs}ms` : '';
        const sizes = `, ↑${formatByteSize(entry.requestSizeBytes)} ↓${formatByteSize(entry.responseSizeBytes)}`;
        lines.push(
          `### #${entry.seq} ${entry.method} ${entry.url} → ${status} (+${(entry.sinceLoadMs / 1000).toFixed(2)}s${timing}${sizes})`
        );
        if (entry.requestBody) {
          lines.push('Request body:', '```', truncateForBundle(entry.requestBody), '```');
        }
        if (entry.responseBody) {
          lines.push('Response body:', '```', truncateForBundle(entry.responseBody), '```');
        }
        if (entry.kind === 'ws' && entry.frames?.length) {
          const dropped = (entry.frameCount || 0) - entry.frames.length;
          lines.push(
            `Frames (last ${Math.min(entry.frames.length, 20)}${dropped > 0 ? `, ${dropped} earlier not shown` : ''}):`,
            '```',
            truncateForBundle(formatFrames(entry, 20), 2500),
            '```'
          );
        }
        if (entry.initiator) {
          lines.push('Sent from:', '```', entry.initiator.split('\n').slice(0, 3).join('\n'), '```');
        }
        lines.push('');
      }
    }

    if (model.issues.length) {
      lines.push(`## Issues (${model.issues.length})`);
      for (const issue of model.issues.slice(-30)) {
        lines.push(`- **[${issue.kind}]** ${issue.message} (×${issue.count})`);
        if (issue.detail && issue.detail !== issue.message) {
          const detail = issue.detail.split('\n').slice(0, 8).join('\n  ');
          lines.push(`  \`\`\`\n  ${detail}\n  \`\`\``);
        }
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  async function writeClipboardText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      (document.body || document.documentElement).appendChild(textarea);
      textarea.select();
      const copied = document.execCommand('copy');
      textarea.remove();
      return copied;
    }
  }

  async function copyBundle() {
    await writeClipboardText(buildBundle());
  }

  // ---------------------------------------------------------------------------
  // Agent event handling
  // ---------------------------------------------------------------------------

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== AGENT_SOURCE) return;

    switch (data.kind) {
      case 'status':
        model.status = data.details;
        updateStatusHeader();
        if (model.view === 'home' && !model.pinned) renderBody();
        break;
      case 'inspect-result':
        if (data.details.pin) {
          model.pinned = data.details;
          model.view = 'home';
          renderBody();
        } else {
          showHoverResult(data.details);
        }
        break;
      case 'renders':
        drawFlashes(data.details.entries || []);
        break;
      case 'network': {
        const entry = data.details.entry;
        const index = model.network.findIndex((e) => e.id === entry.id);
        if (index >= 0) model.network[index] = entry;
        else model.network.push(entry);
        if (model.network.length > 300) {
          const removed = model.network.shift();
          if (removed) model.expandedNetworkIds.delete(removed.id);
        }
        updateStatusHeader();
        if (model.view === 'network') renderBody();
        break;
      }
      case 'network-list':
        model.network = data.details.entries || [];
        {
          const currentIds = new Set(model.network.map((entry) => entry.id));
          for (const id of model.expandedNetworkIds) {
            if (!currentIds.has(id)) model.expandedNetworkIds.delete(id);
          }
        }
        updateStatusHeader();
        if (model.view === 'network') renderBody();
        break;
      case 'issue': {
        const issue = data.details.issue;
        const index = model.issues.findIndex((i) => i.id === issue.id);
        if (index >= 0) model.issues[index] = issue;
        else model.issues.push(issue);
        updateStatusHeader();
        if (model.view === 'issues') renderBody();
        break;
      }
      case 'issues':
        model.issues = data.details.issues || [];
        if (model.status && data.details.renderCounts) {
          model.status.renderCounts = data.details.renderCounts;
        }
        updateStatusHeader();
        if (model.open) renderBody();
        if (model.copyPending) {
          model.copyPending = false;
          copyBundle();
        }
        break;
      default:
        break;
    }
  });

  // ---------------------------------------------------------------------------
  // Extension messaging (toolbar toggle)
  // ---------------------------------------------------------------------------

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === 'VIBE_DIGGER_TOGGLE') {
      if (model.open) closePanel();
      else openPanel();
      sendResponse({ ok: true });
    }
    return false;
  });

  window.__vibeDiggerOpenPanel = openPanel;
  window.addEventListener('resize', constrainPanelToViewport);
  openPanel();
})();
