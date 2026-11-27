/**
 * DaiLo Wedding — Render Persistent Storage Adapters (v15)
 * Triển khai cùng interface với @netlify/blobs (get, getWithMetadata, set, setJSON, delete, list)
 * Hỗ trợ 2 chế độ bền vững:
 *   1. PostgreSQL (DATABASE_URL — khuyên dùng trên Render Free kèm Neon / Supabase Postgres 0đ vĩnh viễn)
 *   2. Atomic Disk Store (DATA_DIR=/var/data trên Render Persistent Disk hoặc local dev)
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const STORE_NAMES = {
  dataStore: 'lamour_data_v11',
  chatStore: 'lamour_chat_v11',
  bookingStore: 'lamour_bookings_v13',
  paymentStore: 'lamour_payments_v14',
  mediaStore: 'lamour_media_v11',
};

function toNodeBuffer(val) {
  if (Buffer.isBuffer(val)) return val;
  if (val instanceof ArrayBuffer) return Buffer.from(new Uint8Array(val));
  if (ArrayBuffer.isView(val)) return Buffer.from(val.buffer, val.byteOffset, val.byteLength);
  return Buffer.from(String(val ?? ''), 'utf8');
}

function toExactArrayBuffer(buf) {
  const b = Buffer.isBuffer(buf) ? buf : toNodeBuffer(buf);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
}

function encodeKey(key) {
  return Buffer.from(String(key), 'utf8').toString('base64url');
}

function decodeKey(stem) {
  return Buffer.from(String(stem), 'base64url').toString('utf8');
}

async function atomicWriteFile(targetPath, data) {
  const dir = path.dirname(targetPath);
  await fs.mkdir(dir, { recursive: true });
  const tmpPath = `${targetPath}.tmp.${process.pid}.${crypto.randomBytes(6).toString('hex')}`;
  await fs.writeFile(tmpPath, data);
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await fs.rename(tmpPath, targetPath);
      return;
    } catch (err) {
      if ((err?.code === 'EPERM' || err?.code === 'EBUSY') && attempt < 4) {
        await new Promise(r => setTimeout(r, 15 * (attempt + 1)));
        continue;
      }
      await fs.unlink(tmpPath).catch(() => {});
      throw err;
    }
  }
}

export function createDiskStore(rootDir, namespace) {
  const nsDir = path.join(rootDir, namespace);
  const queues = new Map();

  function enqueue(key, fn) {
    const prev = queues.get(key) || Promise.resolve();
    const next = prev.then(fn, fn);
    const cleanup = next.finally(() => {
      if (queues.get(key) === cleanup) queues.delete(key);
    });
    queues.set(key, cleanup);
    return next;
  }

  return {
    async get(key, opts = {}) {
      const stem = encodeKey(key);
      if (opts.type === 'json') {
        try {
          const raw = await fs.readFile(path.join(nsDir, `${stem}.json`), 'utf8');
          return JSON.parse(raw);
        } catch (err) {
          if (err?.code === 'ENOENT') return null;
          throw err;
        }
      }
      if (opts.type === 'arrayBuffer') {
        try {
          const buf = await fs.readFile(path.join(nsDir, `${stem}.bin`));
          return toExactArrayBuffer(buf);
        } catch (err) {
          if (err?.code === 'ENOENT') return null;
          throw err;
        }
      }
      try {
        return await fs.readFile(path.join(nsDir, `${stem}.json`), 'utf8');
      } catch (err) {
        if (err?.code !== 'ENOENT') throw err;
      }
      try {
        return await fs.readFile(path.join(nsDir, `${stem}.bin`), 'utf8');
      } catch (err) {
        if (err?.code === 'ENOENT') return null;
        throw err;
      }
    },

    async getWithMetadata(key, opts = {}) {
      const stem = encodeKey(key);
      let buf = null;
      try {
        buf = await fs.readFile(path.join(nsDir, `${stem}.bin`));
      } catch (err) {
        if (err?.code === 'ENOENT') return null;
        throw err;
      }
      let metadata = {};
      try {
        const metaRaw = await fs.readFile(path.join(nsDir, `${stem}.meta.json`), 'utf8');
        metadata = JSON.parse(metaRaw) || {};
      } catch (_) {}
      const data = opts.type === 'text' ? buf.toString('utf8') : toExactArrayBuffer(buf);
      return { data, metadata };
    },

    async set(key, val, opts = {}) {
      const stem = encodeKey(key);
      return await enqueue(stem, async () => {
        const buf = toNodeBuffer(val);
        await atomicWriteFile(path.join(nsDir, `${stem}.bin`), buf);
        await atomicWriteFile(
          path.join(nsDir, `${stem}.meta.json`),
          JSON.stringify(opts.metadata || {})
        );
        return { modified: true };
      });
    },

    async setJSON(key, val) {
      const stem = encodeKey(key);
      return await enqueue(stem, async () => {
        await atomicWriteFile(path.join(nsDir, `${stem}.json`), JSON.stringify(val));
        return { modified: true };
      });
    },

    async delete(key) {
      const stem = encodeKey(key);
      return await enqueue(stem, async () => {
        await Promise.all([
          fs.unlink(path.join(nsDir, `${stem}.json`)).catch(() => {}),
          fs.unlink(path.join(nsDir, `${stem}.bin`)).catch(() => {}),
          fs.unlink(path.join(nsDir, `${stem}.meta.json`)).catch(() => {}),
        ]);
      });
    },

    async list({ prefix = '' } = {}) {
      let entries = [];
      try {
        entries = await fs.readdir(nsDir);
      } catch (err) {
        if (err?.code === 'ENOENT') return { blobs: [] };
        throw err;
      }
      const seen = new Set();
      const blobs = [];
      for (const name of entries) {
        if (name.includes('.tmp.') || name.endsWith('.meta.json')) continue;
        let stem = '';
        if (name.endsWith('.json')) stem = name.slice(0, -5);
        else if (name.endsWith('.bin')) stem = name.slice(0, -4);
        else continue;
        if (!stem || seen.has(stem)) continue;
        seen.add(stem);
        let decoded = '';
        try {
          decoded = decodeKey(stem);
        } catch (_) {
          continue;
        }
        if (decoded.startsWith(prefix)) {
          blobs.push({ key: decoded, etag: 'disk' });
        }
      }
      return { blobs };
    },
  };
}

export function createDiskStores(rootDir) {
  const stores = {};
  for (const [prop, ns] of Object.entries(STORE_NAMES)) {
    stores[prop] = createDiskStore(rootDir, ns);
  }
  return {
    stores,
    async close() {},
  };
}

function escapeLikePrefix(prefix) {
  return String(prefix || '').replace(/[\\%_]/g, ch => '\\' + ch);
}

export function buildPgPoolConfig(connectionString) {
  const raw = String(connectionString || '').trim();
  let effectiveUrl = raw;
  let ssl = { rejectUnauthorized: false };
  const forceStrict = String(process.env.PG_SSL_REJECT_UNAUTHORIZED || '').toLowerCase() === 'true';

  try {
    const u = new URL(raw);
    const host = (u.hostname || '').toLowerCase();
    const sslMode = (u.searchParams.get('sslmode') || '').toLowerCase();

    if (sslMode === 'disable' || host === 'localhost' || host === '127.0.0.1' || host === '::1') {
      ssl = false;
    } else if (sslMode === 'no-verify') {
      u.searchParams.delete('sslmode');
      effectiveUrl = u.toString();
      ssl = { rejectUnauthorized: false };
    } else if (
      forceStrict
      || sslMode === 'verify-full'
      || sslMode === 'verify-ca'
      || host.endsWith('.neon.tech')
    ) {
      // Neon uses publicly trusted CA certificates; full verification prevents MITM and pg SSL warnings.
      ssl = { rejectUnauthorized: true };
    } else {
      // Render Postgres / Supabase PgBouncer pooler often use custom/intermediate CAs.
      // Strip sslmode so pg-connection-string does not override rejectUnauthorized: false.
      if (u.searchParams.has('sslmode')) {
        u.searchParams.delete('sslmode');
        effectiveUrl = u.toString();
      }
      ssl = { rejectUnauthorized: false };
    }
  } catch (_) {}

  return {
    connectionString: effectiveUrl,
    max: 10,
    idleTimeoutMillis: 20000,
    connectionTimeoutMillis: 20000,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10000,
    ssl,
  };
}

async function runWithRetry(fn, { attempts = 3, baseDelayMs = 400 } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1 && baseDelayMs > 0) {
        await new Promise(r => setTimeout(r, baseDelayMs * (i + 1)));
      }
    }
  }
  throw lastErr;
}

export async function createPostgresStores(
  databaseUrl,
  { pool: injectedPool = null, initRetryDelayMs = 400 } = {}
) {
  let pool = injectedPool;
  if (!pool) {
    const pgMod = await import('pg');
    const Pool = pgMod.Pool || pgMod.default?.Pool;
    if (!Pool) throw new Error('Không tải được thư viện PostgreSQL (pg). Hãy chạy npm install.');
    pool = new Pool(buildPgPoolConfig(databaseUrl));
  }

  // Prevent unhandled EventEmitter 'error' crashes when serverless Postgres (Neon/Supabase)
  // suspends idle compute or resets an idle pooled TCP socket.
  if (typeof pool.on === 'function') {
    pool.on('error', err => {
      console.error('[DaiLo Wedding Postgres Pool] Idle client error (auto-recovering):', err?.message || err);
    });
  }

  await runWithRetry(
    async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS lamour_kv_store (
          store_name TEXT NOT NULL,
          item_key TEXT NOT NULL,
          json_data JSONB,
          binary_data BYTEA,
          metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (store_name, item_key)
        );
      `);
      await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_lamour_kv_store_lookup
        ON lamour_kv_store (store_name, item_key);
      `);
    },
    { attempts: 3, baseDelayMs: initRetryDelayMs }
  );

  function makePgStore(storeName) {
    return {
      async get(key, opts = {}) {
        const res = await pool.query(
          'SELECT json_data, binary_data FROM lamour_kv_store WHERE store_name = $1 AND item_key = $2',
          [storeName, String(key)]
        );
        const row = res.rows?.[0];
        if (!row) return null;
        if (opts.type === 'json') {
          if (row.json_data === null || row.json_data === undefined) return null;
          return JSON.parse(JSON.stringify(row.json_data));
        }
        if (opts.type === 'arrayBuffer') {
          if (row.binary_data === null || row.binary_data === undefined) return null;
          return toExactArrayBuffer(row.binary_data);
        }
        if (row.json_data !== null && row.json_data !== undefined) {
          return typeof row.json_data === 'string' ? row.json_data : JSON.stringify(row.json_data);
        }
        if (row.binary_data !== null && row.binary_data !== undefined) {
          return toNodeBuffer(row.binary_data).toString('utf8');
        }
        return null;
      },

      async getWithMetadata(key, opts = {}) {
        const res = await pool.query(
          'SELECT binary_data, metadata FROM lamour_kv_store WHERE store_name = $1 AND item_key = $2',
          [storeName, String(key)]
        );
        const row = res.rows?.[0];
        if (!row || row.binary_data === null || row.binary_data === undefined) return null;
        const buf = toNodeBuffer(row.binary_data);
        const data = opts.type === 'text' ? buf.toString('utf8') : toExactArrayBuffer(buf);
        return { data, metadata: row.metadata || {} };
      },

      async set(key, val, opts = {}) {
        const buf = toNodeBuffer(val);
        await pool.query(
          `INSERT INTO lamour_kv_store (store_name, item_key, binary_data, metadata, updated_at)
           VALUES ($1, $2, $3, $4::jsonb, NOW())
           ON CONFLICT (store_name, item_key)
           DO UPDATE SET binary_data = EXCLUDED.binary_data, metadata = EXCLUDED.metadata, updated_at = NOW()`,
          [storeName, String(key), buf, JSON.stringify(opts.metadata || {})]
        );
        return { modified: true };
      },

      async setJSON(key, val) {
        await pool.query(
          `INSERT INTO lamour_kv_store (store_name, item_key, json_data, updated_at)
           VALUES ($1, $2, $3::jsonb, NOW())
           ON CONFLICT (store_name, item_key)
           DO UPDATE SET json_data = EXCLUDED.json_data, updated_at = NOW()`,
          [storeName, String(key), JSON.stringify(val)]
        );
        return { modified: true };
      },

      async delete(key) {
        await pool.query(
          'DELETE FROM lamour_kv_store WHERE store_name = $1 AND item_key = $2',
          [storeName, String(key)]
        );
      },

      async list({ prefix = '' } = {}) {
        const pattern = `${escapeLikePrefix(prefix)}%`;
        const res = await pool.query(
          `SELECT item_key, updated_at FROM lamour_kv_store
           WHERE store_name = $1 AND item_key LIKE $2 ESCAPE '\\'`,
          [storeName, pattern]
        );
        return {
          blobs: (res.rows || []).map(r => ({
            key: r.item_key,
            etag: r.updated_at ? String(r.updated_at) : 'pg',
          })),
        };
      },
    };
  }

  const stores = {};
  for (const [prop, ns] of Object.entries(STORE_NAMES)) {
    stores[prop] = makePgStore(ns);
  }

  return {
    stores,
    async close() {
      if (typeof pool.end === 'function') await pool.end();
    },
  };
}

export async function createRuntimeStores({
  databaseUrl = process.env.DATABASE_URL || '',
  dataDir = process.env.DATA_DIR || '',
  isRender = Boolean(process.env.RENDER || process.env.RENDER_SERVICE_ID),
  pool = null,
} = {}) {
  const cleanDbUrl = String(databaseUrl || '').trim();
  if (cleanDbUrl || pool) {
    const { stores, close } = await createPostgresStores(cleanDbUrl, { pool });
    return {
      stores,
      engine: 'render-postgres-v14',
      persistent: true,
      storageWarning: '',
      close,
    };
  }

  const cleanDir = String(dataDir || '').trim();
  const resolvedDir = cleanDir || path.resolve(process.cwd(), 'data', 'render-store');
  await fs.mkdir(resolvedDir, { recursive: true });
  const { stores, close } = createDiskStores(resolvedDir);

  if (isRender && !cleanDir) {
    return {
      stores,
      engine: 'render-ephemeral-v14',
      persistent: false,
      storageWarning:
        'Render Free đang dùng ổ đĩa tạm (dữ liệu sẽ mất sau khi ngủ đông hoặc redeploy). Hãy gắn biến DATABASE_URL (PostgreSQL miễn phí từ Neon/Supabase) hoặc nâng cấp Render Persistent Disk (DATA_DIR=/var/data).',
      close,
    };
  }

  return {
    stores,
    engine: 'render-disk-v14',
    persistent: true,
    storageWarning: '',
    close,
  };
}
