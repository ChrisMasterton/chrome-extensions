// Dependency-free static server for the demo app, so the extension's
// localhost content script matches. Usage: npm run demo (then open
// http://localhost:5183).
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
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

// Minimal WebSocket echo at /ws/echo (text frames only) so the Net tab has
// a socket story to record. Enough of RFC 6455 for a same-origin demo page.
function wsFrame(opcode, payload) {
  const length = payload.length;
  const header =
    length < 126
      ? Buffer.from([0x80 | opcode, length])
      : Buffer.concat([Buffer.from([0x80 | opcode, 126]), Buffer.from([length >> 8, length & 0xff])]);
  return Buffer.concat([header, payload]);
}

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (req.url !== '/ws/echo' || !key) {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    return;
  }
  const accept = createHash('sha1')
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );

  let buffer = Buffer.alloc(0);
  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 2) {
      const opcode = buffer[0] & 0x0f;
      const masked = (buffer[1] & 0x80) !== 0;
      let length = buffer[1] & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buffer.length < 4) return;
        length = buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        socket.end(); // demo frames are small; refuse 64-bit lengths
        return;
      }
      const total = offset + (masked ? 4 : 0) + length;
      if (buffer.length < total) return;
      let payload = buffer.subarray(offset + (masked ? 4 : 0), total);
      if (masked) {
        const mask = buffer.subarray(offset, offset + 4);
        const unmasked = Buffer.alloc(length);
        for (let i = 0; i < length; i += 1) unmasked[i] = payload[i] ^ mask[i % 4];
        payload = unmasked;
      }
      buffer = buffer.subarray(total);

      if (opcode === 0x8) {
        socket.write(wsFrame(0x8, payload)); // echo code + reason back
        socket.end();
        return;
      }
      if (opcode === 0x9) {
        socket.write(wsFrame(0xa, payload));
      } else if (opcode === 0x1) {
        const reply = JSON.stringify({
          echoed: payload.toString('utf8').slice(0, 500),
          at: new Date().toISOString(),
        });
        socket.write(wsFrame(0x1, Buffer.from(reply)));
      }
    }
  });
  socket.on('error', () => socket.destroy());
});

server.listen(PORT, () => {
  console.log(`Vibe Digger demo app: http://localhost:${PORT}`);
});
