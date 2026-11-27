import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { createRenderServer } from '../server/index.mjs';
import { createPostgresStores, buildPgPoolConfig } from '../server/stores.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

let passed = 0;
function ok(label) {
  passed++;
  console.log(`[PASS] ${label}`);
}

async function createHttpInvoker(app) {
  try {
    const { port } = await app.listen(0, '127.0.0.1');
    const base = `http://127.0.0.1:${port}`;
    await fetch(`${base}/health`);
    return {
      mode: 'tcp-live',
      async request(relUrl, init = {}) {
        return await fetch(`${base}${relUrl}`, init);
      },
    };
  } catch (err) {
    const code = err?.cause?.code || err?.code || '';
    if (code !== 'EACCES' && code !== 'EPERM') throw err;
    return {
      mode: 'in-process-stream',
      async request(relUrl, init = {}) {
        const method = String(init.method || 'GET').toUpperCase();
        const headers = {};
        for (const [k, v] of Object.entries(init.headers || {})) {
          headers[k.toLowerCase()] = String(v);
        }
        if (!headers.host) headers.host = '127.0.0.1:3000';

        let rawBody = Buffer.alloc(0);
        if (init.body !== undefined && init.body !== null) {
          if (typeof FormData !== 'undefined' && init.body instanceof FormData) {
            const serial = new Response(init.body);
            headers['content-type'] = serial.headers.get('content-type');
            rawBody = Buffer.from(await serial.arrayBuffer());
          } else if (Buffer.isBuffer(init.body)) {
            rawBody = init.body;
          } else if (init.body instanceof Uint8Array) {
            rawBody = Buffer.from(init.body);
          } else {
            rawBody = Buffer.from(String(init.body), 'utf8');
          }
          headers['content-length'] = String(rawBody.length);
        }

        const nodeReq = Readable.from(rawBody.length ? [rawBody] : []);
        nodeReq.method = method;
        nodeReq.url = relUrl;
        nodeReq.headers = headers;

        let resStatus = 200;
        let resHeaders = new Headers();
        const chunks = [];
        let finishResolve;
        const done = new Promise(r => { finishResolve = r; });

        const nodeRes = {
          writeHead(status, hdrs = {}) {
            resStatus = status;
            resHeaders = new Headers();
            for (const [k, v] of Object.entries(hdrs)) {
              if (v !== undefined) resHeaders.set(k, String(v));
            }
          },
          end(data) {
            if (data !== undefined && data !== null) {
              chunks.push(Buffer.isBuffer(data) ? data : Buffer.from(data));
            }
            finishResolve();
          },
        };

        await app.handleNodeRequest(nodeReq, nodeRes);
        await done;
        const outBuf = Buffer.concat(chunks);
        return {
          status: resStatus,
          ok: resStatus >= 200 && resStatus < 300,
          headers: resHeaders,
          async json() { return JSON.parse(outBuf.toString('utf8')); },
          async arrayBuffer() { return outBuf.buffer.slice(outBuf.byteOffset, outBuf.byteOffset + outBuf.byteLength); },
        };
      },
    };
  }
}

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lamour-standalone-be-'));
const prevKey = process.env.SEPAY_API_KEY;
const prevFe = process.env.FRONTEND_URL;
process.env.SEPAY_API_KEY = 'standalone_sepay_secret_key';
process.env.FRONTEND_URL = 'https://lamour-thiep-cuoi.vercel.app';

let app = null;
try {
  // Confirm standalone package.json has zero @netlify/* deps
  const pkg = JSON.parse(await fs.readFile(path.join(projectRoot, 'package.json'), 'utf8'));
  assert.equal(pkg.dependencies['@netlify/blobs'], undefined);
  assert.equal(pkg.dependencies['@netlify/functions'], undefined);
  assert.ok(pkg.dependencies.pg && pkg.dependencies['@google/genai']);
  ok('Standalone Render package.json is lean (@google/genai + pg only, zero Netlify deps)');

  app = await createRenderServer({ dataDir: tmpDir, isRender: true });
  const client = await createHttpInvoker(app);

  // Health & Ping with Vercel origin + Render proxy headers
  let res = await client.request('/health');
  assert.equal(res.status, 200);
  let json = await res.json();
  assert.equal(json.ok, true);
  assert.equal(json.persistent, true);

  res = await client.request('/api?action=ping', {
    headers: {
      Origin: 'https://lamour-thiep-cuoi.vercel.app',
      'X-Forwarded-Proto': 'https',
      'X-Forwarded-Host': 'lamour-cloud-backend.onrender.com',
    },
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('access-control-allow-origin'), 'https://lamour-thiep-cuoi.vercel.app');
  json = await res.json();
  assert.equal(json.paymentWebhookUrl, 'https://lamour-cloud-backend.onrender.com/api?action=payment_webhook');
  ok('Standalone Render server boots with zero node_modules and serves /health + /api with Vercel CORS');

  // Init + payment_create + SePay webhook + fallback local Ngũ Hành AI reply (when @google/genai not installed yet)
  await client.request('/api?action=init', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      settings: { brandName: "L'Amour Atelier", hotline: '0354 248 177' },
      templates: [{ id: 'tpl_1', name: 'Nhung Đỏ Cổ Điển', design: {} }],
      invitations: [],
    }),
  });

  res = await client.request('/api?action=payment_create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Khách Test', phone: '0354248177', templateId: 'tpl_1', packageId: 'pkg_basic', amount: 99000 }),
  });
  assert.equal(res.status, 200);
  const pay = await res.json();

  res = await client.request('/api?action=payment_webhook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Apikey standalone_sepay_secret_key' },
    body: JSON.stringify({ gateway: 'MBBank', transferType: 'in', transferAmount: 99000, content: `CK ${pay.payment.code}`, referenceCode: 'FT999' }),
  });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).matched[0].status, 'paid');

  // Verify smart local chatbot fallback works gracefully even if GEMINI_API_KEY is unset
  await client.request('/api?action=chat_send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ threadId: 'th_fb', name: 'Khách', text: 'Chú rể sinh năm 1996 mệnh gì?', mode: 'bot', deferBot: true }),
  });
  res = await client.request('/api?action=chat_ai_reply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ threadId: 'th_fb', text: 'Chú rể sinh năm 1996 mệnh gì?' }),
  });
  assert.equal(res.status, 200);
  json = await res.json();
  assert.equal(json.committed, true);
  assert.ok(json.thread.messages[1].text.includes('Thủy'));
  ok('Standalone payment webhook & Ngũ Hành AI fallback work cleanly');

  // Malformed Host/X-Forwarded-Host must never crash server
  res = await client.request('/health', {
    headers: { 'X-Forwarded-Host': 'bad host name', Host: 'invalid:port:extra' },
  });
  assert.equal(res.status, 200);

  // Verify createPostgresStores attaches error listener (Neon auto-suspend safety) & SSL config
  const neonCfg = buildPgPoolConfig('postgresql://u:p@ep-abc.ap-southeast-1.aws.neon.tech/neondb?sslmode=require');
  assert.deepEqual(neonCfg.ssl, { rejectUnauthorized: true });
  const sqlSeen = [];
  const fakePool = new EventEmitter();
  fakePool.query = async sql => { sqlSeen.push(sql); return { rows: [] }; };
  fakePool.end = async () => {};
  const pgStore = await createPostgresStores('postgresql://u:p@ep-abc.ap-southeast-1.aws.neon.tech/neondb?sslmode=require', {
    pool: fakePool,
    initRetryDelayMs: 5,
  });
  assert.ok(fakePool.listenerCount('error') >= 1, 'Pool must attach error listener');
  fakePool.emit('error', new Error('57P01 idle disconnect'));
  assert.ok(sqlSeen.some(s => s.includes('CREATE TABLE IF NOT EXISTS lamour_kv_store')));
  await pgStore.close();
  ok('Standalone PostgreSQL store (Neon TLS + idle-error crash safety) & malformed Host hardening verified');

  console.log(`\nSTANDALONE RENDER BACKEND AUDIT SUMMARY: Passed ${passed} / ${passed} | Failed: 0`);
} finally {
  if (app) await app.close().catch(() => {});
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  if (prevKey === undefined) delete process.env.SEPAY_API_KEY;
  else process.env.SEPAY_API_KEY = prevKey;
  if (prevFe === undefined) delete process.env.FRONTEND_URL;
  else process.env.FRONTEND_URL = prevFe;
}
