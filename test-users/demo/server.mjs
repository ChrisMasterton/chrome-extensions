#!/usr/bin/env node

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.TEST_USERS_DEMO_PORT || 4173);
const accountsByKey = new Map();

function contentType(pathname) {
  const types = {
    '.css': 'text/css; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
  };
  return types[extname(pathname)] || 'application/octet-stream';
}

function sendJson(response, status, value) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(value));
}

async function readJson(request) {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 65536) throw new Error('Request is too large');
  }
  return JSON.parse(body);
}

async function handleAdapter(request, response) {
  if (request.method === 'GET') {
    sendJson(response, 200, {
      schemaVersion: 1,
      label: 'HikeStrong demo fixtures',
      roles: [
        { id: 'member', label: 'Member' },
        { id: 'org-admin', label: 'Admin' },
        { id: 'invited', label: 'Invited' },
      ],
      scenarios: [
        { id: 'standard', label: 'Standard account' },
        { id: 'empty-org', label: 'Empty organization' },
        { id: 'pending-onboarding', label: 'Pending onboarding' },
      ],
      capabilities: { provision: true, reset: true },
    });
    return;
  }

  if (request.method !== 'POST') {
    sendJson(response, 405, { error: 'Method not allowed' });
    return;
  }

  const payload = await readJson(request);
  const stateLabel = `${payload.role?.label || 'User'} · ${
    payload.scenario?.label || 'Default state'
  }`;

  if (payload.operation === 'provision') {
    const email = String(payload.identity?.email || '');
    if (!email.endsWith('@example.test') || !payload.identity?.password) {
      sendJson(response, 400, { error: 'Only generated @example.test identities are accepted' });
      return;
    }

    const accountRef =
      accountsByKey.get(payload.idempotencyKey) || `demo_account_${accountsByKey.size + 1}`;
    accountsByKey.set(payload.idempotencyKey, accountRef);
    sendJson(response, 200, { status: 'ready', accountRef, stateLabel });
    return;
  }

  if (payload.operation === 'reset' && [...accountsByKey.values()].includes(payload.accountRef)) {
    sendJson(response, 200, {
      status: 'ready',
      accountRef: payload.accountRef,
      stateLabel,
    });
    return;
  }

  sendJson(response, 400, { error: 'Unknown account or adapter operation' });
}

const server = createServer(async (request, response) => {
  try {
    const requestUrl = new URL(request.url || '/', `http://127.0.0.1:${PORT}`);
    if (requestUrl.pathname === '/__test-users') {
      await handleAdapter(request, response);
      return;
    }

    const pathname = requestUrl.pathname === '/' ? '/demo/login.html' : requestUrl.pathname;
    const filePath = resolve(PROJECT_DIR, `.${decodeURIComponent(pathname)}`);
    if (!filePath.startsWith(`${PROJECT_DIR}/`)) {
      response.writeHead(403);
      response.end('Forbidden');
      return;
    }

    const body = await readFile(filePath);
    response.writeHead(200, { 'content-type': contentType(pathname) });
    response.end(body);
  } catch (error) {
    response.writeHead(500);
    response.end(error?.message || 'Demo server error');
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Test Users demo listening on http://127.0.0.1:${PORT}/demo/login.html`);
  console.log(`Provisioning adapter available at http://127.0.0.1:${PORT}/__test-users`);
});
