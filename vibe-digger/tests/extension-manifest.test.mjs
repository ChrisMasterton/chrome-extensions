import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

async function loadManifest() {
  return JSON.parse(await readFile(join(ROOT, 'manifest.json'), 'utf8'));
}

test('manifest is valid MV3', async () => {
  const manifest = await loadManifest();
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.name, 'Vibe Digger');
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
});

test('manifest permissions stay minimal', async () => {
  const manifest = await loadManifest();
  assert.deepEqual(
    [...manifest.permissions].sort(),
    ['activeTab', 'clipboardWrite', 'scripting']
  );
  assert.equal(manifest.host_permissions, undefined);
});

test('page agent is registered in the MAIN world at document_start on localhost only', async () => {
  const manifest = await loadManifest();
  const [script] = manifest.content_scripts;
  assert.equal(script.world, 'MAIN');
  assert.equal(script.run_at, 'document_start');
  assert.deepEqual(script.js, ['page-agent.js']);
  for (const match of script.matches) {
    assert.match(match, /^https?:\/\/(localhost|127\.0\.0\.1)\/\*$/);
  }
});

test('all files referenced by the manifest exist', async () => {
  const manifest = await loadManifest();
  const files = new Set([
    manifest.background.service_worker,
    ...manifest.content_scripts.flatMap((script) => script.js || []),
    ...Object.values(manifest.icons),
    ...Object.values(manifest.action.default_icon),
  ]);
  for (const file of files) {
    await assert.doesNotReject(access(join(ROOT, file)), `missing ${file}`);
  }
});

test('page agent and content script agree on message channel names', async () => {
  const agent = await readFile(join(ROOT, 'page-agent.js'), 'utf8');
  const content = await readFile(join(ROOT, 'content.js'), 'utf8');
  for (const source of ["'vibe-digger-agent'", "'vibe-digger-control'"]) {
    assert.ok(agent.includes(source), `page-agent.js missing ${source}`);
    assert.ok(content.includes(source), `content.js missing ${source}`);
  }
});
