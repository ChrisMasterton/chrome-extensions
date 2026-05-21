#!/usr/bin/env node

import { createServer } from 'node:http';
import { copyFile, mkdir, readFile, rm, writeFile, cp } from 'node:fs/promises';
import { basename, extname, isAbsolute, join } from 'node:path';
import { homedir } from 'node:os';

const PORT = Number.parseInt(process.env.CODEX_QA_INBOX_PORT || '43117', 10);
const ROOT = process.env.CODEX_QA_INBOX_DIR || join(homedir(), 'CodexInbox', 'web-qa');
const MAX_BODY_BYTES = Number.parseInt(process.env.CODEX_QA_MAX_BODY_BYTES || String(80 * 1024 * 1024), 10);
const TOUR_SCHEMA_VERSION = '1.0';

function sendJson(response, status, body) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type',
  });
  response.end(JSON.stringify(body, null, 2));
}

function sendText(response, status, body) {
  response.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type',
  });
  response.end(body);
}

function slugify(value, fallback = 'capture') {
  const slug = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 72);
  return slug || fallback;
}

function timestampId(date = new Date()) {
  return date.toISOString()
    .replace(/\.\d+Z$/, 'Z')
    .replace(/[:]/g, '')
    .replace(/[TZ]/g, '-')
    .replace(/-$/, '');
}

function parseDataUrl(dataUrl) {
  const match = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(String(dataUrl || ''));
  if (!match) return null;

  const mime = match[1];
  const isBase64 = Boolean(match[2]);
  const raw = match[3];
  const buffer = isBase64 ? Buffer.from(raw, 'base64') : Buffer.from(decodeURIComponent(raw), 'utf8');
  const extension = mime.includes('png') ? 'png' : mime.includes('webp') ? 'webp' : 'jpg';

  return { mime, buffer, extension };
}

async function saveImage(dataUrl, directory, filenameBase) {
  const parsed = parseDataUrl(dataUrl);
  if (!parsed) return null;

  await mkdir(directory, { recursive: true });
  const filename = `${filenameBase}.${parsed.extension}`;
  const path = join(directory, filename);
  await writeFile(path, parsed.buffer);
  return {
    path,
    relativePath: `images/${filename}`,
    mime: parsed.mime,
    bytes: parsed.buffer.length,
  };
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function copyFileWhenReady(sourcePath, destinationPath) {
  let lastError = null;

  for (let attempt = 0; attempt < 12; attempt += 1) {
    try {
      await copyFile(sourcePath, destinationPath);
      return;
    } catch (error) {
      lastError = error;
      if (error?.code !== 'ENOENT') {
        throw error;
      }
      await sleep(150);
    }
  }

  throw lastError;
}

async function copyExistingImage(sourcePath, directory, filenameBase) {
  if (!sourcePath || typeof sourcePath !== 'string') return null;

  await mkdir(directory, { recursive: true });
  const resolvedSourcePath = isAbsolute(sourcePath)
    ? sourcePath
    : join(homedir(), 'Downloads', sourcePath);
  const extension = extname(resolvedSourcePath) || extname(basename(resolvedSourcePath)) || '.jpg';
  const filename = `${filenameBase}${extension}`;
  const path = join(directory, filename);
  await copyFileWhenReady(resolvedSourcePath, path);
  return {
    path,
    relativePath: `images/${filename}`,
    sourcePath: resolvedSourcePath,
  };
}

async function materializeImages(bundle, captureDir) {
  const imagesDir = join(captureDir, 'images');
  const saved = [];

  if (bundle?.screenshot?.highlightedViewportImageDataUrl) {
    const image = await saveImage(
      bundle.screenshot.highlightedViewportImageDataUrl,
      imagesDir,
      'highlighted-viewport'
    );
    if (image) {
      saved.push({ kind: 'highlighted-viewport', ...image });
      bundle.screenshot.highlightedViewportImageLocalFile = image.path;
      delete bundle.screenshot.highlightedViewportImageDataUrl;
    }
  } else if (bundle?.screenshot?.highlightedViewportImageFile?.filename) {
    try {
      const image = await copyExistingImage(
        bundle.screenshot.highlightedViewportImageFile.filename,
        imagesDir,
        'highlighted-viewport'
      );
      if (image) {
        saved.push({ kind: 'highlighted-viewport', ...image });
        bundle.screenshot.highlightedViewportImageLocalFile = image.path;
      }
    } catch (error) {
      bundle.screenshot.highlightedViewportImageCopyError = error?.message || 'Unable to copy highlighted viewport image';
    }
  }

  for (const element of bundle?.elements || []) {
    const crop = element.screenshotCrop;
    if (!crop) continue;

    if (crop.imageDataUrl) {
      const image = await saveImage(
        crop.imageDataUrl,
        imagesDir,
        `element-${String(element.index || saved.length + 1).padStart(2, '0')}`
      );
      if (image) {
        saved.push({ kind: 'element-crop', elementIndex: element.index || null, ...image });
        crop.imageLocalFile = image.path;
        delete crop.imageDataUrl;
      }
      continue;
    }

    if (crop.imageFile?.filename) {
      try {
        const image = await copyExistingImage(
          crop.imageFile.filename,
          imagesDir,
          `element-${String(element.index || saved.length + 1).padStart(2, '0')}`
        );
        if (image) {
          saved.push({ kind: 'element-crop', elementIndex: element.index || null, ...image });
          crop.imageLocalFile = image.path;
        }
      } catch (error) {
        crop.imageCopyError = error?.message || 'Unable to copy crop image';
      }
    }
  }

  return saved;
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;

    request.on('data', (chunk) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error(`Request body exceeds ${MAX_BODY_BYTES} bytes`));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });

    request.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf8'));
    });

    request.on('error', reject);
  });
}

async function writeCapture(payload) {
  const receivedAt = new Date();
  const bundle = JSON.parse(JSON.stringify(payload.bundle || {}));
  const pageUrl = bundle?.page?.url || payload?.source?.tabUrl || '';
  let host = 'page';
  try {
    host = pageUrl ? new URL(pageUrl).hostname : 'page';
  } catch {
    host = 'page';
  }
  const captureId = `${timestampId(receivedAt)}-${slugify(host, 'page')}`;
  const captureDir = join(ROOT, 'history', captureId);
  const latestDir = join(ROOT, 'latest');

  await mkdir(captureDir, { recursive: true });

  const savedImages = await materializeImages(bundle, captureDir);
  const manifest = {
    captureId,
    receivedAt: receivedAt.toISOString(),
    page: bundle.page || null,
    totalElements: bundle.totalElements || 0,
    rootDir: ROOT,
    captureDir,
    latestDir,
    files: {
      manifest: join(captureDir, 'manifest.json'),
      bundle: join(captureDir, 'bundle.json'),
      markdown: join(captureDir, 'bundle.md'),
      images: savedImages.map((image) => image.path),
    },
    source: payload.source || null,
  };

  await writeFile(join(captureDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(join(captureDir, 'bundle.json'), `${JSON.stringify(bundle, null, 2)}\n`);
  await writeFile(join(captureDir, 'bundle.md'), `${payload.markdown || '# Element Debug Bundle\n\nNo Markdown payload was provided.'}\n`);

  await rm(latestDir, { recursive: true, force: true });
  await mkdir(latestDir, { recursive: true });
  await cp(captureDir, latestDir, { recursive: true });

  return manifest;
}

function normalizeTourStep(step, index) {
  if (!step || typeof step !== 'object' || Array.isArray(step)) {
    throw new Error(`Tour step ${index + 1} must be a JSON object`);
  }

  const title = String(step.title || `Step ${index + 1}`).trim();
  const body = String(step.body || step.description || '').trim();
  const selector = step.selector ? String(step.selector).trim() : null;
  const text = step.text ? String(step.text).trim() : null;
  const url = step.url ? String(step.url).trim() : null;

  if (!selector && !text && !url) {
    throw new Error(`Tour step ${index + 1} needs at least one of selector, text, or url`);
  }

  return {
    index: index + 1,
    id: step.id ? String(step.id).trim() : `step-${index + 1}`,
    title: title || `Step ${index + 1}`,
    body,
    url,
    selector,
    text,
    action: step.action ? String(step.action).trim() : null,
    notes: step.notes ? String(step.notes).trim() : null,
  };
}

function normalizeTour(payload, receivedAt) {
  const source = payload?.tour && typeof payload.tour === 'object'
    ? payload.tour
    : payload;

  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw new Error('Tour payload must be a JSON object');
  }

  if (!Array.isArray(source.steps) || source.steps.length === 0) {
    throw new Error('Tour requires a non-empty steps array');
  }

  const title = String(source.title || 'Codex guided review').trim();
  const tourId = source.id
    ? slugify(source.id, 'tour')
    : `${timestampId(receivedAt)}-${slugify(title, 'tour')}`;

  return {
    tourVersion: TOUR_SCHEMA_VERSION,
    id: tourId,
    title,
    summary: source.summary ? String(source.summary).trim() : null,
    createdAt: source.createdAt || receivedAt.toISOString(),
    source: payload?.source || source.source || null,
    steps: source.steps.map(normalizeTourStep),
  };
}

async function writeTour(payload) {
  const receivedAt = new Date();
  const tour = normalizeTour(payload, receivedAt);
  const tourDir = join(ROOT, 'tours', 'history', tour.id);
  const latestDir = join(ROOT, 'tours', 'latest');

  await mkdir(tourDir, { recursive: true });

  const manifest = {
    tourId: tour.id,
    receivedAt: receivedAt.toISOString(),
    title: tour.title,
    totalSteps: tour.steps.length,
    rootDir: ROOT,
    tourDir,
    latestDir,
    files: {
      manifest: join(tourDir, 'manifest.json'),
      tour: join(tourDir, 'tour.json'),
    },
  };

  await writeFile(join(tourDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(join(tourDir, 'tour.json'), `${JSON.stringify(tour, null, 2)}\n`);

  await rm(latestDir, { recursive: true, force: true });
  await mkdir(latestDir, { recursive: true });
  await cp(tourDir, latestDir, { recursive: true });

  return manifest;
}

async function readLatestTour() {
  const latestDir = join(ROOT, 'tours', 'latest');

  try {
    const [manifestJson, tourJson] = await Promise.all([
      readFile(join(latestDir, 'manifest.json'), 'utf8'),
      readFile(join(latestDir, 'tour.json'), 'utf8'),
    ]);

    return {
      manifest: JSON.parse(manifestJson),
      tour: JSON.parse(tourJson),
    };
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return null;
    }

    throw error;
  }
}

const server = createServer(async (request, response) => {
  if (request.method === 'OPTIONS') {
    sendText(response, 204, '');
    return;
  }

  const requestUrl = new URL(request.url || '/', 'http://127.0.0.1');

  if (request.method === 'GET' && requestUrl.pathname === '/health') {
    sendJson(response, 200, { ok: true, root: ROOT });
    return;
  }

  if (request.method === 'GET' && requestUrl.pathname === '/tours/latest') {
    try {
      const latest = await readLatestTour();
      if (!latest) {
        sendJson(response, 404, { ok: false, error: 'No guided review tour has been posted yet' });
        return;
      }

      sendJson(response, 200, { ok: true, ...latest });
    } catch (error) {
      sendJson(response, 500, {
        ok: false,
        error: error?.message || 'Unable to read latest tour',
      });
    }
    return;
  }

  if (request.method === 'POST' && requestUrl.pathname === '/tours') {
    try {
      const rawBody = await readBody(request);
      const payload = JSON.parse(rawBody);
      const manifest = await writeTour(payload);
      sendJson(response, 200, {
        ok: true,
        tourId: manifest.tourId,
        tourDir: manifest.tourDir,
        latestDir: manifest.latestDir,
      });
    } catch (error) {
      sendJson(response, 500, {
        ok: false,
        error: error?.message || 'Unable to save tour',
      });
    }
    return;
  }

  if (request.method !== 'POST' || requestUrl.pathname !== '/captures') {
    sendJson(response, 404, { ok: false, error: 'Use POST /captures, POST /tours, GET /tours/latest, or GET /health' });
    return;
  }

  try {
    const rawBody = await readBody(request);
    const payload = JSON.parse(rawBody);
    if (!payload.bundle || typeof payload.bundle !== 'object') {
      sendJson(response, 400, { ok: false, error: 'Missing JSON object field: bundle' });
      return;
    }

    const manifest = await writeCapture(payload);
    sendJson(response, 200, {
      ok: true,
      captureId: manifest.captureId,
      captureDir: manifest.captureDir,
      latestDir: manifest.latestDir,
    });
  } catch (error) {
    sendJson(response, 500, {
      ok: false,
      error: error?.message || 'Unable to save capture',
    });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Codex QA inbox listening on http://127.0.0.1:${PORT}`);
  console.log(`Writing captures and guided review tours to ${ROOT}`);
});
