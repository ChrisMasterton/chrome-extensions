import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = resolve(TEST_DIR, '..');
const SERVER_PATH = join(PROJECT_DIR, 'scripts', 'codex-qa-inbox-server.mjs');

async function getFreePort() {
  const server = createServer();
  await new Promise((resolveListen) => {
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const port = server.address().port;
  await new Promise((resolveClose) => {
    server.close(resolveClose);
  });
  return port;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function waitForHealth(baseUrl, child) {
  let lastError = null;

  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`Inbox server exited early with code ${child.exitCode}`);
    }

    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
      lastError = new Error(`Health returned HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }

    await new Promise((resolveDelay) => {
      setTimeout(resolveDelay, 50);
    });
  }

  throw lastError || new Error('Inbox server did not become healthy');
}

async function stopServer(child) {
  if (child.exitCode !== null) return;

  const waitForExit = async (timeoutMs) => {
    if (child.exitCode !== null || child.signalCode !== null) return true;

    let timeout = null;
    const timeoutPromise = new Promise((resolveTimeout) => {
      timeout = setTimeout(() => resolveTimeout(false), timeoutMs);
    });
    const exitPromise = once(child, 'exit').then(() => true);
    const exited = await Promise.race([exitPromise, timeoutPromise]);
    if (timeout) clearTimeout(timeout);
    return exited;
  };

  const gracefulExit = waitForExit(1500);
  child.kill('SIGTERM');
  await gracefulExit;

  if (child.exitCode === null) {
    const forcedExit = waitForExit(1500);
    child.kill('SIGKILL');
    await forcedExit;
  }
}

async function withInboxServer(callback) {
  const root = await mkdtemp(join(tmpdir(), 'codex-qa-inbox-test-'));
  await mkdir(root, { recursive: true });
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const output = [];

  const launchServer = () => {
    const child = spawn(process.execPath, [SERVER_PATH], {
      cwd: PROJECT_DIR,
      env: {
        ...process.env,
        CODEX_QA_INBOX_PORT: String(port),
        CODEX_QA_INBOX_DIR: root,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (chunk) => output.push(chunk.toString()));
    child.stderr.on('data', (chunk) => output.push(chunk.toString()));
    return child;
  };
  let child = launchServer();

  try {
    await waitForHealth(baseUrl, child);
    return await callback({ baseUrl, root, restart: async (prepare) => {
      await stopServer(child);
      if (prepare) await prepare();
      child = launchServer();
      await waitForHealth(baseUrl, child);
    } });
  } catch (error) {
    error.message = `${error.message}\nServer output:\n${output.join('')}`;
    throw error;
  } finally {
    await stopServer(child);
    await rm(root, { recursive: true, force: true });
  }
}

async function postJson(url, payload) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });

  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }

  return { response, body };
}

test('health exposes the configured inbox root', async () => {
  await withInboxServer(async ({ baseUrl, root }) => {
    const response = await fetch(`${baseUrl}/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ok: true,
      root,
    });
  });
});

test('POST /captures persists history and latest artifacts', async () => {
  await withInboxServer(async ({ baseUrl, root }) => {
    const { response, body } = await postJson(`${baseUrl}/captures`, {
      source: { test: 'capture' },
      bundle: {
        page: {
          url: 'http://localhost:5173/tasks',
          title: 'Tasks',
        },
        totalElements: 1,
        elements: [
          {
            index: 1,
            tag: 'button',
            text: 'Save',
          },
        ],
      },
      markdown: '# Test Capture\n',
    });

    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.match(body.captureId, /localhost/);

    const latestManifest = await readJson(join(root, 'latest', 'manifest.json'));
    const latestBundle = await readJson(join(root, 'latest', 'bundle.json'));
    const latestMarkdown = await readFile(join(root, 'latest', 'bundle.md'), 'utf8');

    assert.equal(latestManifest.captureId, body.captureId);
    assert.equal(latestManifest.totalElements, 1);
    assert.equal(latestBundle.page.title, 'Tasks');
    assert.match(latestMarkdown, /Test Capture/);
  });
});

test('POST /tours persists normalized tour and latest endpoint returns it', async () => {
  await withInboxServer(async ({ baseUrl, root }) => {
    const { response, body } = await postJson(`${baseUrl}/tours`, {
      tour: {
        title: 'Smoke Tour',
        summary: 'Walk the smoke page.',
        steps: [
          {
            selector: '[data-testid="save-button"]',
            title: 'Save button',
            body: 'Watch this button change text and disabled state.',
          },
        ],
      },
    });

    assert.equal(response.status, 200);
    assert.equal(body.ok, true);

    const latestResponse = await fetch(`${baseUrl}/tours/latest`);
    assert.equal(latestResponse.status, 200);
    const latest = await latestResponse.json();

    assert.equal(latest.ok, true);
    assert.equal(latest.manifest.tourId, body.tourId);
    assert.equal(latest.tour.title, 'Smoke Tour');
    assert.equal(latest.tour.steps[0].index, 1);
    assert.equal(latest.tour.steps[0].selector, '[data-testid="save-button"]');

    const latestTour = await readJson(join(root, 'tours', 'latest', 'tour.json'));
    assert.equal(latestTour.steps[0].id, 'step-1');
  });
});

test('POST /traces persists trace JSON, Markdown, and latest endpoint', async () => {
  await withInboxServer(async ({ baseUrl, root }) => {
    const tracePayload = {
      trace: {
        page: {
          url: 'http://localhost:5173/smoke',
          title: 'Vibe Smoke',
        },
        startedAt: '2026-05-22T19:00:00.000Z',
        endedAt: '2026-05-22T19:00:01.000Z',
        durationMs: 1000,
        watchTargets: [
          {
            watchId: 'watch-1',
            kind: 'element',
            label: 'Save button',
            locator: {
              value: 'page.getByTestId("save-button")',
            },
          },
        ],
        events: [
          {
            eventId: 'evt-1',
            timeOffsetMs: 10,
            kind: 'user.click',
            label: 'click Save',
          },
        ],
        samples: [
          {
            sampleId: 'sample-1',
            watchId: 'watch-1',
            timeOffsetMs: 30,
            cause: {
              label: 'click Save',
              confidence: 'strong',
            },
            diffs: [
              {
                path: 'dom.text',
                before: 'Save',
                after: 'Saving...',
              },
            ],
          },
        ],
        mutations: [],
        network: [],
        console: [],
        summaries: [
          {
            title: 'Save button is disabled',
            body: 'The DOM marks the target disabled.',
          },
        ],
      },
    };

    const { response, body } = await postJson(`${baseUrl}/traces`, tracePayload);
    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.match(body.traceId, /localhost/);

    const latestResponse = await fetch(`${baseUrl}/traces/latest`);
    assert.equal(latestResponse.status, 200);
    const latest = await latestResponse.json();

    assert.equal(latest.ok, true);
    assert.equal(latest.manifest.traceId, body.traceId);
    assert.equal(latest.trace.watchTargets[0].label, 'Save button');
    assert.equal(latest.trace.samples[0].diffs[0].after, 'Saving...');
    assert.match(latest.markdown, /dom.text: Save -> Saving\.\.\./);

    const latestTrace = await readJson(join(root, 'traces', 'latest', 'trace.json'));
    const latestMarkdown = await readFile(join(root, 'traces', 'latest', 'trace.md'), 'utf8');
    assert.equal(latestTrace.page.title, 'Vibe Smoke');
    assert.match(latestMarkdown, /Save button is disabled/);
  });
});

test('POST /traces trims oversized event and sample arrays', async () => {
  await withInboxServer(async ({ baseUrl, root }) => {
    const events = Array.from({ length: 605 }, (_, index) => ({
      eventId: `evt-${index}`,
      timeOffsetMs: index,
      kind: 'user.click',
      label: `event ${index}`,
    }));
    const samples = Array.from({ length: 605 }, (_, index) => ({
      sampleId: `sample-${index}`,
      watchId: 'watch-1',
      timeOffsetMs: index,
      diffs: [],
    }));

    const { response, body } = await postJson(`${baseUrl}/traces`, {
      trace: {
        page: {
          url: 'http://localhost:5173/large',
          title: 'Large Trace',
        },
        watchTargets: [],
        events,
        samples,
        mutations: [],
        network: [],
        console: [],
      },
    });

    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.trimmed.events.omittedCount, 5);
    assert.equal(body.trimmed.samples.omittedCount, 5);

    const latestTrace = await readJson(join(root, 'traces', 'latest', 'trace.json'));
    assert.equal(latestTrace.events.length, 600);
    assert.equal(latestTrace.events[0].eventId, 'evt-5');
    assert.equal(latestTrace.samples.length, 600);
    assert.equal(latestTrace.samples[0].sampleId, 'sample-5');
  });
});

test('invalid payloads return useful HTTP errors', async () => {
  await withInboxServer(async ({ baseUrl }) => {
    const missingBundle = await postJson(`${baseUrl}/captures`, {});
    assert.equal(missingBundle.response.status, 400);
    assert.match(missingBundle.body.error, /Missing JSON object field: bundle/);

    const missingTourSteps = await postJson(`${baseUrl}/tours`, {
      tour: {
        title: 'No steps',
        steps: [],
      },
    });
    assert.equal(missingTourSteps.response.status, 500);
    assert.match(missingTourSteps.body.error, /non-empty steps array/);

    const missingTrace = await postJson(`${baseUrl}/traces`, []);
    assert.equal(missingTrace.response.status, 400);
    assert.match(missingTrace.body.error, /Missing JSON object field: trace/);
  });
});

function submission(kind, marker) {
  const source = { testMarker: marker };
  const page = { url: 'http://localhost:5173/concurrent', title: marker };
  if (kind === 'captures') {
    return {
      source, markdown: `# ${marker}\n`,
      bundle: {
        page, totalElements: 1,
        elements: [{ index: 1, text: 'x'.repeat(100000), screenshotCrop: {
          imageDataUrl: `data:image/png;base64,${Buffer.from(marker).toString('base64')}`,
        } }],
      },
    };
  }
  if (kind === 'tours') {
    return { source, tour: {
      id: 'shared-tour', title: marker,
      steps: [{ selector: '#target', title: marker, body: 'x'.repeat(100000) }],
    } };
  }
  return { source, markdown: `# ${marker}\n`, trace: {
    traceId: 'shared-trace', page,
    events: [{ kind: 'test', label: marker, details: 'x'.repeat(100000) }],
  } };
}

async function assertArtifactSet(kind, manifest, marker = kind === 'tours' ? manifest.title : manifest.page.title) {
  if (kind === 'captures') {
    const bundle = await readJson(manifest.files.bundle);
    assert.equal(manifest.page.title, marker);
    assert.equal(bundle.page.title, marker);
    assert.equal((await readFile(manifest.files.markdown, 'utf8')).trimEnd(), `# ${marker}`);
    assert.equal(await readFile(bundle.elements[0].screenshotCrop.imageLocalFile, 'utf8'), marker);
  } else if (kind === 'tours') {
    const tour = await readJson(manifest.files.tour);
    assert.equal(manifest.title, marker);
    assert.equal(tour.title, marker);
    assert.equal(tour.id, manifest.tourId);
  } else {
    const trace = await readJson(manifest.files.trace);
    assert.equal(manifest.page.title, marker);
    assert.equal(trace.page.title, marker);
    assert.equal(trace.traceId, manifest.traceId);
    assert.equal(await readFile(manifest.files.markdown, 'utf8'), `# ${marker}\n`);
  }
}

for (const kind of ['captures', 'tours', 'traces']) {
  test(`${kind}: concurrent submissions keep latest and acknowledged history consistent`, { timeout: 15000 }, async () => {
    await withInboxServer(async ({ baseUrl, root }) => {
      const latestDir = kind === 'captures' ? join(root, 'latest') : join(root, kind, 'latest');
      const seed = await postJson(`${baseUrl}/${kind}`, submission(kind, 'seed'));
      assert.equal(seed.response.status, 200);

      async function checkLatest() {
        // File consumers pin the manifest, then follow its immutable artifact paths.
        const manifest = await readJson(join(await realpath(latestDir), 'manifest.json'));
        await assertArtifactSet(kind, manifest);
        if (kind !== 'captures') {
          const response = await fetch(`${baseUrl}/${kind}/latest`);
          assert.equal(response.status, 200, 'published latest must remain available');
          const snapshot = await response.json();
          const marker = kind === 'tours' ? snapshot.manifest.title : snapshot.manifest.page.title;
          if (kind === 'tours') {
            assert.equal(snapshot.tour.title, marker);
            assert.equal(snapshot.tour.id, snapshot.manifest.tourId);
          } else {
            assert.equal(snapshot.trace.page.title, marker);
            assert.equal(snapshot.markdown, `# ${marker}\n`);
          }
        }
      }

      const readErrors = [];
      let pending = true;
      const markers = Array.from({ length: 12 }, (_, index) => `${kind}-${index}`);
      const sending = Promise.all(markers.map(marker => postJson(`${baseUrl}/${kind}`, submission(kind, marker))))
        .finally(() => { pending = false; });
      while (pending) {
        try { await checkLatest(); } catch (error) { readErrors.push(error.message); }
      }
      const results = await sending;
      assert.deepEqual(results.map(result => result.response.status), markers.map(() => 200),
        'every concurrent submission must succeed');
      assert.deepEqual(readErrors, [], 'readers must never see missing, partial, or mixed artifacts');
      const directoryKey = kind === 'captures' ? 'captureDir' : kind === 'tours' ? 'tourDir' : 'traceDir';
      assert.equal(new Set(results.map(result => result.body[directoryKey])).size, markers.length,
        'each submission needs immutable history even when IDs repeat');
      for (const [index, result] of results.entries()) {
        await assertArtifactSet(kind, await readJson(join(result.body[directoryKey], 'manifest.json')), markers[index]);
      }
      await checkLatest();
    });
  });
}

test('failed submissions preserve the previous publication and allow retry for every stream', async () => {
  await withInboxServer(async ({ baseUrl, root }) => {
    for (const kind of ['captures', 'tours', 'traces']) {
      await postJson(`${baseUrl}/${kind}`, submission(kind, 'previous'));
      const latestDir = kind === 'captures' ? join(root, 'latest') : join(root, kind, 'latest');
      const previous = await realpath(latestDir);
      const historyDir = join(kind === 'captures' ? root : join(root, kind), 'history');
      const history = await readdir(historyDir);
      const invalid = submission(kind, 'failed');
      if (kind === 'captures') {
        invalid.bundle.screenshot = { highlightedViewportImageDataUrl: 'data:image/png,%invalid' };
      } else if (kind === 'tours') {
        invalid.tour.steps = [];
      } else {
        invalid.markdown = { invalid: true };
      }
      assert.equal((await postJson(`${baseUrl}/${kind}`, invalid)).response.status, 500);
      assert.equal(await realpath(latestDir), previous);
      assert.deepEqual(await readdir(historyDir), history, 'failed preparation must clean its unpublished directory');
      await assertArtifactSet(kind, await readJson(join(previous, 'manifest.json')), 'previous');

      const retried = await postJson(`${baseUrl}/${kind}`, submission(kind, 'retry'));
      assert.equal(retried.response.status, 200);
      await assertArtifactSet(kind, await readJson(join(latestDir, 'manifest.json')), 'retry');
      await assertArtifactSet(kind, await readJson(join(previous, 'manifest.json')), 'previous');
    }
  });
});

test('startup preserves legacy latest directories and published snapshots survive restart', async () => {
  await withInboxServer(async ({ baseUrl, root, restart }) => {
    const directories = ['captures', 'tours', 'traces'].map(kind => ({
      kind, latestDir: kind === 'captures' ? join(root, 'latest') : join(root, kind, 'latest'),
    }));
    for (const { kind } of directories) {
      assert.equal((await postJson(`${baseUrl}/${kind}`, submission(kind, 'legacy'))).response.status, 200);
    }
    await restart(async () => {
      for (const { latestDir } of directories) {
        const directory = await realpath(latestDir);
        await unlink(latestDir);
        await cp(directory, latestDir, { recursive: true });
      }
    });
    const publications = [];
    for (const { kind, latestDir } of directories) {
      assert.equal((await lstat(latestDir)).isSymbolicLink(), true);
      const legacy = await realpath(latestDir);
      await assertArtifactSet(kind, await readJson(join(legacy, 'manifest.json')), 'legacy');
      if (kind !== 'captures') {
        assert.equal((await fetch(`${baseUrl}/${kind}/latest`)).status, 200);
      }
      assert.equal((await postJson(`${baseUrl}/${kind}`, submission(kind, 'new'))).response.status, 200);
      publications.push(await realpath(latestDir));
      await assertArtifactSet(kind, await readJson(join(legacy, 'manifest.json')), 'legacy');
    }
    await restart();
    for (const [index, { kind, latestDir }] of directories.entries()) {
      assert.equal(await realpath(latestDir), publications[index]);
      await assertArtifactSet(kind, await readJson(join(latestDir, 'manifest.json')), 'new');
    }
  });
});
