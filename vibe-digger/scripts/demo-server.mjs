// Dependency-free static server for the demo app, so the extension's
// localhost content script matches. Usage: npm run demo (then open
// http://localhost:5183).
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.PORT) || 5183;
const ROOT = fileURLToPath(new URL('../demo', import.meta.url));

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

function json(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

async function handleApi(req, res, pathname) {
  if (pathname === '/api/items') {
    json(res, 200, {
      items: [
        { id: 1, name: 'Amber vibes', mood: 'warm' },
        { id: 2, name: 'Fiber flow', mood: 'chill' },
        { id: 3, name: 'Groove render', mood: 'hype' },
      ],
      fetchedAt: new Date().toISOString(),
    });
    return true;
  }
  if (pathname === '/api/echo' && req.method === 'POST') {
    let body = '';
    for await (const chunk of req) body += chunk;
    let parsed = null;
    try {
      parsed = JSON.parse(body);
    } catch {
      json(res, 400, { error: 'echo expects JSON', received: body.slice(0, 200) });
      return true;
    }
    json(res, 200, { echoed: parsed, receivedAt: new Date().toISOString() });
    return true;
  }
  if (pathname === '/api/slow') {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    json(res, 200, { finally: 'worth the wait' });
    return true;
  }
  return false;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = '/index.html';

  if (await handleApi(req, res, pathname)) return;

  const filePath = normalize(join(ROOT, pathname));
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  try {
    const body = await readFile(filePath);
    res.writeHead(200, { 'Content-Type': TYPES[extname(filePath)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found (the demo app 404s on purpose for /api/* fetches)');
  }
});

server.listen(PORT, () => {
  console.log(`Vibe Digger demo app: http://localhost:${PORT}`);
});
