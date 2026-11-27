/**
 * L'Amour Atelier — Standalone Render Cloud Backend Server (v14)
 * Chạy trực tiếp trên Render Web Service (Node.js 20/22+), VPS, Docker, Railway hoặc Localhost.
 * - Hỗ trợ PostgreSQL (DATABASE_URL) và Persistent Disk (DATA_DIR)
 * - Nhận diện chuẩn reverse proxy HTTPS của Render (X-Forwarded-Proto / RENDER_EXTERNAL_URL)
 * - Endpoint /health & /healthz cho Render Health Check & Uptime Monitor
 * - Endpoint /api tương thích 100% với Frontend trên Vercel / GitHub Pages / Custom Domain
 */

import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { handleApiRequest, isAllowedOrigin } from './api-core.mjs';
import { createRuntimeStores } from './stores.mjs';

const MAX_BODY_BYTES = 6 * 1024 * 1024; // 6 MB (covers 4.2 MB media upload + multipart overhead)

function readBodyBuffer(nodeReq, maxBytes = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let rejected = false;

    nodeReq.on('data', chunk => {
      if (rejected) return;
      total += chunk.length;
      if (total > maxBytes) {
        rejected = true;
        const err = new Error('Payload Too Large');
        err.statusCode = 413;
        reject(err);
        nodeReq.resume();
        return;
      }
      chunks.push(chunk);
    });
    nodeReq.on('end', () => {
      if (!rejected) resolve(Buffer.concat(chunks));
    });
    nodeReq.on('error', err => {
      if (!rejected) {
        rejected = true;
        reject(err);
      }
    });
  });
}

function sanitizeHostHeader(rawHost) {
  const clean = String(rawHost || '').split(',')[0].trim();
  if (!clean || /[\s/\\@?]/.test(clean)) return '';
  try {
    const u = new URL(`http://${clean}`);
    if (u.username || u.password || u.pathname !== '/' || u.search || u.hash) return '';
    return u.host;
  } catch (_) {
    return '';
  }
}

function buildPublicOrigin(nodeReq) {
  const fwdProto = String(nodeReq.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  const fwdHost = sanitizeHostHeader(nodeReq.headers['x-forwarded-host']);
  const reqHost = sanitizeHostHeader(nodeReq.headers.host);
  const configuredExternal = String(process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || '').trim();
  let extUrl = null;
  if (configuredExternal) {
    try {
      extUrl = new URL(configuredExternal);
    } catch (_) {
      extUrl = null;
    }
  }
  const host = fwdHost || reqHost || extUrl?.host || 'localhost:3000';

  if (fwdProto === 'https' || fwdProto === 'http') {
    return `${fwdProto}://${host}`;
  }

  if (extUrl && (extUrl.host === host || host.endsWith('.onrender.com'))) {
    return extUrl.origin;
  }

  const proto = host.endsWith('.onrender.com') ? 'https' : 'http';
  return `${proto}://${host}`;
}

function buildCorsHeaderMap(nodeReq) {
  const reqOrigin = String(nodeReq.headers.origin || '').trim();
  const allowOrigin = reqOrigin && isAllowedOrigin(reqOrigin) ? reqOrigin : '*';
  return {
    'access-control-allow-origin': allowOrigin,
    'access-control-allow-methods': 'GET, POST, OPTIONS, HEAD',
    'access-control-allow-headers': 'Content-Type, X-Auth-Token, X-Client-Token, Authorization',
    'vary': 'Origin',
  };
}

function writeJson(nodeReq, nodeRes, status, payload, { headOnly = false } = {}) {
  const body = JSON.stringify(payload);
  nodeRes.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...buildCorsHeaderMap(nodeReq),
  });
  nodeRes.end(headOnly ? undefined : body);
}

async function toWebRequest(nodeReq, fullUrl) {
  const method = String(nodeReq.method || 'GET').toUpperCase();
  const headers = new Headers();
  for (const [k, v] of Object.entries(nodeReq.headers || {})) {
    if (v === undefined) continue;
    if (Array.isArray(v)) {
      for (const item of v) headers.append(k, item);
    } else {
      headers.set(k, String(v));
    }
  }
  const hasBody = method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS';
  const body = hasBody ? await readBodyBuffer(nodeReq) : undefined;
  return new Request(fullUrl, {
    method,
    headers,
    body: hasBody && body && body.length > 0 ? body : undefined,
  });
}

async function sendWebResponse(webRes, nodeRes, { headOnly = false } = {}) {
  const headersObj = {};
  webRes.headers.forEach((value, key) => {
    headersObj[key] = value;
  });
  nodeRes.writeHead(webRes.status, headersObj);
  if (headOnly || webRes.status === 204 || webRes.status === 304 || !webRes.body) {
    nodeRes.end();
    return;
  }
  const ab = await webRes.arrayBuffer();
  nodeRes.end(Buffer.from(ab));
}

export async function createRenderServer({
  databaseUrl = process.env.DATABASE_URL || '',
  dataDir = process.env.DATA_DIR || '',
  isRender = Boolean(process.env.RENDER || process.env.RENDER_SERVICE_ID),
  pool = null,
  storesOverride = null,
  engineOverride = '',
  persistentOverride = undefined,
  storageWarningOverride = undefined,
  aiClient = null,
} = {}) {
  const startedAt = Date.now();
  const runtime = storesOverride
    ? {
        stores: storesOverride,
        engine: engineOverride || 'render-custom-v14',
        persistent: persistentOverride ?? true,
        storageWarning: storageWarningOverride || '',
        async close() {},
      }
    : await createRuntimeStores({ databaseUrl, dataDir, isRender, pool });

  const handleNodeRequest = async (nodeReq, nodeRes) => {
    const method = String(nodeReq.method || 'GET').toUpperCase();
    const headOnly = method === 'HEAD';

    try {
      const origin = buildPublicOrigin(nodeReq);
      const rawReqUrl = String(nodeReq.url || '/');
      const safeReqUrl = rawReqUrl.startsWith('/')
        ? rawReqUrl.replace(/^[/\\]+/, '/')
        : `/${rawReqUrl.replace(/^[/\\]+/, '')}`;
      let reqUrl;
      try {
        reqUrl = new URL(safeReqUrl, origin);
      } catch (_) {
        writeJson(nodeReq, nodeRes, 400, { ok: false, error: 'Invalid request URL.' }, { headOnly });
        return;
      }
      const pathname = reqUrl.pathname;

      if ((pathname === '/health' || pathname === '/healthz' || pathname === '/') && method === 'OPTIONS') {
        nodeRes.writeHead(204, buildCorsHeaderMap(nodeReq));
        nodeRes.end();
        return;
      }

      if (pathname === '/health' || pathname === '/healthz') {
        writeJson(
          nodeReq,
          nodeRes,
          200,
          {
            ok: true,
            service: 'lamour-atelier-backend',
            engine: runtime.engine,
            persistent: runtime.persistent,
            storageWarning: runtime.storageWarning || '',
            uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
            timestamp: new Date().toISOString(),
          },
          { headOnly }
        );
        return;
      }

      if (pathname === '/' && (method === 'GET' || method === 'HEAD')) {
        writeJson(
          nodeReq,
          nodeRes,
          200,
          {
            ok: true,
            service: "L'Amour Atelier Cloud Backend (Render)",
            engine: runtime.engine,
            persistent: runtime.persistent,
            api: `${origin}/api?action=ping`,
            health: `${origin}/health`,
            webhook: `${origin}/api?action=payment_webhook`,
          },
          { headOnly }
        );
        return;
      }

      if (pathname === '/api' || pathname === '/api/') {
        const webReq = await toWebRequest(nodeReq, reqUrl.toString());
        const webRes = await handleApiRequest(webReq, {
          stores: runtime.stores,
          engine: runtime.engine,
          persistent: runtime.persistent,
          storageWarning: runtime.storageWarning,
          aiClient,
        });
        await sendWebResponse(webRes, nodeRes, { headOnly });
        return;
      }

      writeJson(nodeReq, nodeRes, 404, { ok: false, error: 'Route not found. Use /api or /health.' }, { headOnly });
    } catch (err) {
      const status = Number(err?.statusCode) || 500;
      if (!nodeRes.headersSent) {
        writeJson(
          nodeReq,
          nodeRes,
          status,
          {
            ok: false,
            error: status === 413 ? 'Dữ liệu gửi lên vượt quá giới hạn 6MB.' : (err?.message || 'Internal Server Error'),
          },
          { headOnly }
        );
      } else {
        nodeRes.end();
      }
    }
  };

  const server = http.createServer((nodeReq, nodeRes) => {
    Promise.resolve(handleNodeRequest(nodeReq, nodeRes)).catch(err => {
      console.error("[L'Amour Atelier Backend] Unexpected request error:", err?.message || err);
      try {
        if (!nodeRes.headersSent) {
          writeJson(nodeReq, nodeRes, 500, { ok: false, error: 'Internal Server Error' });
        } else {
          nodeRes.end();
        }
      } catch (_) {}
    });
  });

  server.requestTimeout = 30000;
  server.headersTimeout = 35000;
  server.keepAliveTimeout = 65000;

  return {
    server,
    runtime,
    handleNodeRequest,
    async listen(port = Number(process.env.PORT || 3000), host = '0.0.0.0') {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.removeListener('error', reject);
          resolve();
        });
      });
      const addr = server.address();
      return { port: typeof addr === 'object' && addr ? addr.port : port, host };
    },
    async close() {
      await new Promise(resolve => server.close(() => resolve()));
      await runtime.close();
    },
  };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  const port = Number(process.env.PORT || 3000);
  createRenderServer()
    .then(async app => {
      const bound = await app.listen(port, '0.0.0.0');
      console.log(`[L'Amour Atelier Backend] Listening on http://${bound.host}:${bound.port}`);
      console.log(`[L'Amour Atelier Backend] Storage engine: ${app.runtime.engine} (persistent=${app.runtime.persistent})`);
      if (app.runtime.storageWarning) {
        console.warn(`[L'Amour Atelier Backend] WARNING: ${app.runtime.storageWarning}`);
      }

      const shutdown = async sig => {
        console.log(`[L'Amour Atelier Backend] Received ${sig}, shutting down cleanly...`);
        await app.close();
        process.exit(0);
      };
      process.on('SIGTERM', () => shutdown('SIGTERM'));
      process.on('SIGINT', () => shutdown('SIGINT'));
    })
    .catch(err => {
      console.error('[L\'Amour Atelier Backend] Fatal startup error:', err);
      process.exit(1);
    });
}
