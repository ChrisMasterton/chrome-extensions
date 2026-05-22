import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = resolve(TEST_DIR, '..');

async function fileExists(relativePath) {
  await access(join(PROJECT_DIR, relativePath));
}

async function readJson(relativePath) {
  return JSON.parse(await readFile(join(PROJECT_DIR, relativePath), 'utf8'));
}

test('manifest and package versions stay aligned', async () => {
  const manifest = await readJson('manifest.json');
  const packageJson = await readJson('package.json');

  assert.equal(packageJson.version.startsWith(`${manifest.version}.`), true);
});

test('manifest references files that exist', async () => {
  const manifest = await readJson('manifest.json');

  await fileExists(manifest.background.service_worker);

  for (const iconPath of Object.values(manifest.icons)) {
    await fileExists(iconPath);
  }

  for (const iconPath of Object.values(manifest.action.default_icon)) {
    await fileExists(iconPath);
  }
});

test('background injection files and local inbox permission are present', async () => {
  const manifest = await readJson('manifest.json');
  const background = await readFile(join(PROJECT_DIR, 'background.js'), 'utf8');

  assert.equal(manifest.host_permissions.includes('http://127.0.0.1:43117/*'), true);

  for (const injectedFile of ['vibe-page-probe.js', 'picker.js', 'picker.css']) {
    assert.match(background, new RegExp(injectedFile.replace('.', '\\.')));
    await fileExists(injectedFile);
  }
});

test('check script covers extension runtime files and test app snippets', async () => {
  const packageJson = await readJson('package.json');
  const check = packageJson.scripts.check;

  for (const checkedFile of [
    'background.js',
    'picker.js',
    'vibe-page-probe.js',
    'snippets/vibe-debugger-app-probes.js',
    'scripts/codex-qa-inbox-server.mjs',
  ]) {
    assert.match(check, new RegExp(checkedFile.replace(/[./]/g, '\\$&')));
  }
});
