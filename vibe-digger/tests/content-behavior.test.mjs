import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

async function loadContentScript() {
  return readFile(join(ROOT, 'content.js'), 'utf8');
}

async function loadPageAgent() {
  return readFile(join(ROOT, 'page-agent.js'), 'utf8');
}

test('network row expansion is model state that survives live redraws', async () => {
  const content = await loadContentScript();

  assert.match(content, /expandedNetworkIds:\s*new Set\(\)/);
  assert.match(content, /model\.expandedNetworkIds\.has\(entry\.id\)/);
  assert.match(content, /model\.expandedNetworkIds\.add\(entry\.id\)/);
  assert.match(content, /model\.expandedNetworkIds\.delete\(entry\.id\)/);
});

test('live network redraws preserve the current scroll position', async () => {
  const content = await loadContentScript();

  assert.match(content, /function renderNetworkView\(scrollState/);
  assert.match(content, /scrollState\.stickToBottom/);
  assert.doesNotMatch(content, /ui\.body\.scrollTop = ui\.body\.scrollHeight;\s*\n\s*}/);
});

test('panel can minimize to a bottom-left restore control', async () => {
  const content = await loadContentScript();

  assert.match(content, /\.vd-minimized\s*{[^}]*position:\s*fixed;/s);
  assert.match(content, /\.vd-minimized\s*{[^}]*left:\s*16px;/s);
  assert.match(content, /\.vd-minimized\s*{[^}]*bottom:\s*16px;/s);
  assert.match(content, /function minimizePanel\(\)/);
  assert.match(content, /function restorePanel\(\)/);
  assert.match(content, /button\('−',\s*\(\) => minimizePanel\(\)/);
});

test('panel header drags and clamps the window inside the viewport', async () => {
  const content = await loadContentScript();

  assert.match(content, /\.vd-header\s*{[^}]*cursor:\s*grab;/s);
  assert.match(content, /panelPosition:\s*null/);
  assert.match(content, /function startPanelDrag\(event\)/);
  assert.match(content, /function movePanelDrag\(event\)/);
  assert.match(content, /function constrainPanelToViewport\(\)/);
  assert.match(content, /addEventListener\('pointerdown', startPanelDrag\)/);
  assert.match(content, /addEventListener\('pointermove', movePanelDrag, true\)/);
  assert.match(content, /addEventListener\('resize', constrainPanelToViewport\)/);
});

test('minimize and close controls live in the draggable header without starting a drag', async () => {
  const content = await loadContentScript();

  assert.match(content, /header\.append\(dot, title, statusText, minimizeButton, closeButton\)/);
  assert.match(content, /event\.target\.closest\('button'\)/);
  assert.doesNotMatch(content, /toolbar\.append\([^)]*minimizeButton/s);
  assert.doesNotMatch(content, /toolbar\.append\([^)]*closeButton/s);
});

test('Net rows show measured request and response payload sizes', async () => {
  const [content, agent] = await Promise.all([loadContentScript(), loadPageAgent()]);

  assert.match(agent, /function bodyByteLength\(body\)/);
  assert.match(agent, /requestSizeBytes/);
  assert.match(agent, /responseSizeBytes/);
  assert.match(agent, /entry\.requestSizeBytes \+= frameSize/);
  assert.match(agent, /entry\.responseSizeBytes \+= frameSize/);
  assert.match(content, /function formatByteSize\(bytes\)/);
  assert.match(content, /class="vd-net-size"/);
  assert.match(content, /↑\$\{formatByteSize\(entry\.requestSizeBytes\)\}/);
  assert.match(content, /↓\$\{formatByteSize\(entry\.responseSizeBytes\)\}/);
});
