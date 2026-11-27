/**
 * L'Amour Atelier — Platform-Agnostic Cloud Backend API Core (v14)
 * - Chạy độc lập trên Render (Node.js Web Service + PostgreSQL / Persistent Disk) và Netlify Functions
 * - Tách riêng mỗi hội thoại Live Chat, Đặt Lịch, Đơn Thanh Toán thành key độc lập để 0 xung đột đồng thời
 * - Xác thực Gmail nghiêm ngặt (@gmail.com + xác nhận + OTP Gmail qua Resend)
 * - Đăng nhập nhanh liên kết thẳng Facebook OAuth 2.0 & Google OAuth 2.0 (hỗ trợ cross-origin Vercel <-> Render)
 * - Nhận Webhook ngân hàng SePay / Casso / PayOS tự động bàn giao thiệp tức thì
 */

import crypto from 'node:crypto';
import { DEFAULT_CHATBOT_CONFIG, runLocalChatbot, inferNguHanhFromText } from '../js/chatbot.js';

const DEFAULT_PACKAGES_FALLBACK = [
  { id: 'pkg_basic', name: 'Gói Cơ Bản', price: 99000, capabilities: { maxPhotos: 8, hasMap: true, hasGuestbook: false, hasGiftQr: false, hasRsvp: false, hasGuestLinks: false, hasCustomMusic: false } },
  { id: 'pkg_standard', name: 'Gói Tiêu Chuẩn', price: 189000, capabilities: { maxPhotos: 20, hasMap: true, hasGuestbook: true, hasGiftQr: true, hasRsvp: false, hasGuestLinks: false, hasCustomMusic: false } },
  { id: 'pkg_pro', name: 'Gói Cao Cấp', price: 299000, capabilities: { maxPhotos: 45, hasMap: true, hasGuestbook: true, hasGiftQr: true, hasRsvp: true, hasGuestLinks: true, hasCustomMusic: true } },
  { id: 'pkg_bespoke', name: 'Gói Thiết Kế Riêng', price: 499000, capabilities: { maxPhotos: 999, hasMap: true, hasGuestbook: true, hasGiftQr: true, hasRsvp: true, hasGuestLinks: true, hasCustomMusic: true } },
];

function buildTrialConfigServer(days = 1) {
  const safeDays = Math.min(3, Math.max(1, Number(days) || 1));
  const now = Date.now();
  return {
    enabled: true,
    days: safeDays,
    startedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + safeDays * 86400000).toISOString(),
    limits: {
      maxPhotos: safeDays === 1 ? 3 : safeDays === 2 ? 5 : 6,
      allowGiftQr: false,
      allowMusicChange: false,
      allowGuestLinks: false,
      allowCustomQuestions: false,
    },
  };
}

const ADMIN_EMAIL = 'lochoipes@gmail.com';
const ADMIN_PASS_SHA256 = 'd54ddb187125b418d32c2e86b7706ffe729d53d6ef56222411145e583e7f75bd';

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store, no-cache, must-revalidate, max-age=0',
};

const EXTRA_ALLOWED_ORIGINS = [
  'https://lochoipes-hue.github.io',
  'https://frabjous-stardust-68eadc.netlify.app',
  'https://lamour-thiep-cuoi.vercel.app',
  'https://lamour-cloud-backend.onrender.com',
  'http://localhost:8888',
  'http://localhost:8080',
  'http://localhost:3000',
  'http://127.0.0.1:8080',
  'http://127.0.0.1:3000',
];

function parseOriginSafe(rawUrl) {
  try {
    const u = new URL(String(rawUrl || '').trim());
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    return u.origin;
  } catch (_) {
    return '';
  }
}

function getConfiguredAllowedOrigins() {
  const list = [...EXTRA_ALLOWED_ORIGINS];
  const feOrigin = parseOriginSafe(getEnv('FRONTEND_URL'));
  if (feOrigin) list.push(feOrigin);
  const rawList = String(getEnv('ALLOWED_ORIGINS') || '').split(',');
  for (const item of rawList) {
    const parsed = parseOriginSafe(item);
    if (parsed) list.push(parsed);
  }
  return list;
}

export function isAllowedOrigin(reqOrigin) {
  const clean = String(reqOrigin || '').trim();
  if (!clean) return false;
  if (getConfiguredAllowedOrigins().includes(clean)) return true;
  return /^https:\/\/[a-z0-9-]+\.vercel\.app$/i.test(clean)
    || /^https:\/\/[a-z0-9-]+\.onrender\.com$/i.test(clean)
    || /^https:\/\/[a-z0-9-]+\.github\.io$/i.test(clean)
    || /^https:\/\/[a-z0-9-]+\.netlify\.app$/i.test(clean)
    || /^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/i.test(clean);
}

function resolveFrontendRedirectUrl(returnToRaw, fallbackOrigin, queryParams = {}) {
  let baseStr = '';
  const candidate = String(returnToRaw || '').trim();
  if (candidate) {
    try {
      const parsed = new URL(candidate);
      if ((parsed.protocol === 'http:' || parsed.protocol === 'https:') && isAllowedOrigin(parsed.origin)) {
        baseStr = `${parsed.origin}${parsed.pathname || '/'}`;
      }
    } catch (_) {}
  }
  if (!baseStr) {
    const envFe = String(getEnv('FRONTEND_URL') || '').trim();
    if (envFe) {
      try {
        const parsed = new URL(envFe);
        if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
          baseStr = `${parsed.origin}${parsed.pathname || '/'}`;
        }
      } catch (_) {}
    }
  }
  if (!baseStr) {
    baseStr = `${fallbackOrigin}/`;
  }
  const finalUrl = new URL(baseStr);
  for (const [k, v] of Object.entries(queryParams)) {
    if (v !== undefined && v !== null) finalUrl.searchParams.set(k, String(v));
  }
  return finalUrl.toString();
}

function buildCorsHeaders(req) {
  const reqOrigin = (req?.headers?.get?.('origin') || '').trim();
  let allowOrigin = '*';
  if (reqOrigin && isAllowedOrigin(reqOrigin)) {
    allowOrigin = reqOrigin;
  }
  return {
    'access-control-allow-origin': allowOrigin,
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'Content-Type, X-Auth-Token, X-Client-Token, Authorization',
    'access-control-max-age': '86400',
    'vary': 'Origin',
  };
}

function jsonRes(payload, status = 200, cors = {}) {
  return new Response(JSON.stringify(payload), { status, headers: { ...JSON_HEADERS, ...cors } });
}

function redirectRes(location) {
  return new Response(null, {
    status: 302,
    headers: {
      location,
      'cache-control': 'no-store',
    },
  });
}

function getEnv(key) {
  try {
    if (typeof Netlify !== 'undefined' && Netlify?.env?.get) {
      return Netlify.env.get(key) || '';
    }
  } catch (_) {}
  return process.env[key] || '';
}

function sanitizeId(str) {
  return String(str || '').replace(/[^a-zA-Z0-9_-]/g, '');
}

function normalizeEmail(str) {
  return String(str || '').trim().toLowerCase();
}

function isStrictGmail(email) {
  const e = normalizeEmail(email);
  if (!e || e.includes('..')) return false;
  return /^[a-z0-9](?:[a-z0-9._+-]{1,62}[a-z0-9])?@gmail\.com$/i.test(e);
}

function sanitizePhone(str) {
  return String(str || '').replace(/\D/g, '').slice(0, 10);
}

function validateVnPhone10(raw) {
  const s = String(raw || '').trim();
  if (!s) return { ok: false, digits: '', error: 'Vui lòng nhập số điện thoại (bắt buộc đủ 10 chữ số).' };
  if (/[^0-9\s]/.test(s)) return { ok: false, digits: sanitizePhone(s), error: 'Số điện thoại chỉ được nhập chữ số (0–9).' };
  const digits = s.replace(/\D/g, '');
  if (digits.length !== 10) return { ok: false, digits, error: `Số điện thoại phải đủ đúng 10 chữ số (hiện có ${digits.length}/10).` };
  if (!/^0(?:3[2-9]|5[25689]|7[06-9]|8[1-9]|9[0-9])\d{7}$/.test(digits)) {
    return { ok: false, digits, error: 'Đầu số điện thoại Việt Nam không hợp lệ (hợp lệ: 03x, 05x, 07x, 08x, 09x đủ 10 số).' };
  }
  if (/^0\d(\d)\1{7}$/.test(digits) || /(\d)\1{7}$/.test(digits)) {
    return { ok: false, digits, error: 'Số điện thoại không hợp lệ (số lặp giả). Vui lòng nhập số thật.' };
  }
  return { ok: true, digits, error: '' };
}

function isValidNumericPhone(raw) {
  return validateVnPhone10(raw).ok;
}

function sha256Hex(str) {
  return crypto.createHash('sha256').update(String(str)).digest('hex');
}

function hashPassword(password, salt = '') {
  const s = salt || crypto.randomBytes(12).toString('hex');
  const dk = crypto.scryptSync(String(password), s, 32).toString('hex');
  return `scrypt:${s}:${dk}`;
}

function verifyPassword(user, password) {
  if (!user || !password) return false;
  const stored = String(user.passwordHash || '');
  if (stored.startsWith('scrypt:')) {
    const [, salt, hash] = stored.split(':');
    if (!salt || !hash) return false;
    const check = crypto.scryptSync(String(password), salt, 32).toString('hex');
    const bufHash = Buffer.from(hash, 'hex');
    const bufCheck = Buffer.from(check, 'hex');
    if (bufHash.length !== bufCheck.length || bufHash.length === 0) return false;
    return crypto.timingSafeEqual(bufHash, bufCheck);
  }
  const sha = sha256Hex('lamour_v6:' + String(password));
  if (user.passwordSha256 && user.passwordSha256 === sha) return true;
  return false;
}

function safeUser(u) {
  if (!u) return null;
  const copy = { ...u };
  delete copy.passwordHash;
  delete copy.passwordSha256;
  return copy;
}

function getStores(overrideStores = null) {
  if (!overrideStores || !overrideStores.dataStore) {
    throw new Error('Backend storage adapter is not configured (pass opts.stores from Render or Netlify runtime).');
  }
  return {
    ...overrideStores,
    chatStore: overrideStores.chatStore || overrideStores.dataStore,
    bookingStore: overrideStores.bookingStore || overrideStores.chatStore || overrideStores.dataStore,
    paymentStore: overrideStores.paymentStore || overrideStores.bookingStore || overrideStores.chatStore || overrideStores.dataStore,
    mediaStore: overrideStores.mediaStore || overrideStores.dataStore,
  };
}

function ensureAdminAndDefaults(core, auth) {
  const nextCore = core || {
    version: 11,
    settings: {
      brandName: "L'Amour Atelier",
      hotline: '0354 248 177',
      phoneRaw: '0354248177',
      zaloUrl: 'https://zalo.me/0354248177',
      paymentBankCode: 'MB',
      paymentBankName: 'MB Bank — Ngân hàng Quân Đội',
      paymentAccountNo: '0354248177',
      packages: JSON.parse(JSON.stringify(DEFAULT_PACKAGES_FALLBACK)),
    },
    templates: [],
    invitations: [],
    bookings: [],
    consultations: [],
    chatbotConfig: JSON.parse(JSON.stringify(DEFAULT_CHATBOT_CONFIG)),
  };
  nextCore.settings = nextCore.settings || {};
  if (!Array.isArray(nextCore.settings.packages) || !nextCore.settings.packages.length) {
    nextCore.settings.packages = JSON.parse(JSON.stringify(DEFAULT_PACKAGES_FALLBACK));
  }
  if (!Array.isArray(nextCore.templates)) nextCore.templates = [];
  if (!Array.isArray(nextCore.invitations)) nextCore.invitations = [];
  if (!Array.isArray(nextCore.bookings)) nextCore.bookings = [];
  if (!Array.isArray(nextCore.consultations)) nextCore.consultations = [];
  if (!nextCore.chatbotConfig) nextCore.chatbotConfig = JSON.parse(JSON.stringify(DEFAULT_CHATBOT_CONFIG));
  nextCore.version = Math.max(Number(nextCore.version || 0), 11);

  const nextAuth = auth || { users: [], sessions: {}, oauthStates: {}, gmailOtps: {} };
  if (!Array.isArray(nextAuth.users)) nextAuth.users = [];
  if (!nextAuth.sessions || typeof nextAuth.sessions !== 'object') nextAuth.sessions = {};
  if (!nextAuth.oauthStates || typeof nextAuth.oauthStates !== 'object') nextAuth.oauthStates = {};
  if (!nextAuth.gmailOtps || typeof nextAuth.gmailOtps !== 'object') nextAuth.gmailOtps = {};

  let admin = nextAuth.users.find(u => normalizeEmail(u.email) === ADMIN_EMAIL);
  if (!admin) {
    admin = {
      id: 'usr_admin_master',
      role: 'admin',
      provider: 'gmail',
      name: 'Quản Trị Viên Studio',
      email: ADMIN_EMAIL,
      phone: '0354248177',
      emailVerified: true,
      passwordSha256: ADMIN_PASS_SHA256,
      createdAt: new Date().toISOString(),
    };
    nextAuth.users.unshift(admin);
  } else {
    admin.role = 'admin';
    admin.emailVerified = true;
    if (!admin.passwordHash && !admin.passwordSha256) {
      admin.passwordSha256 = ADMIN_PASS_SHA256;
    }
  }
  return { core: nextCore, auth: nextAuth };
}

async function loadState(stores) {
  const [rawCore, rawAuth] = await Promise.all([
    stores.dataStore.get('core', { type: 'json' }),
    stores.dataStore.get('auth', { type: 'json' }),
  ]);
  const initialized = Boolean(rawCore);
  const { core, auth } = ensureAdminAndDefaults(rawCore, rawAuth);
  if (!initialized) {
    await Promise.all([
      stores.dataStore.setJSON('core', core),
      stores.dataStore.setJSON('auth', auth),
    ]);
  }
  return { core, auth };
}

async function saveCore(stores, core) {
  await stores.dataStore.setJSON('core', core);
}

async function saveAuth(stores, auth) {
  // Keep sessions bounded
  const keys = Object.keys(auth.sessions || {});
  if (keys.length > 200) {
    const trimmed = {};
    for (const k of keys.slice(-200)) trimmed[k] = auth.sessions[k];
    auth.sessions = trimmed;
  }
  // Prune expired OAuth states & OTPs
  const now = Date.now();
  for (const [k, v] of Object.entries(auth.oauthStates || {})) {
    if (!v || (now - (v.at || 0)) > 15 * 60 * 1000) delete auth.oauthStates[k];
  }
  for (const [k, v] of Object.entries(auth.gmailOtps || {})) {
    if (!v || (v.expiresAt || 0) < now) delete auth.gmailOtps[k];
  }
  await stores.dataStore.setJSON('auth', auth);
}

async function listAllChatThreads(stores) {
  const { blobs } = await stores.chatStore.list({ prefix: 'chat/' });
  if (!blobs || !blobs.length) return [];
  const loaded = await Promise.all(
    blobs.map(b => stores.chatStore.get(b.key, { type: 'json' }).catch(() => null))
  );
  return loaded
    .filter(Boolean)
    .sort((a, b) => {
      const waitDiff = (b.waitingForAdmin ? 1 : 0) - (a.waitingForAdmin ? 1 : 0);
      if (waitDiff !== 0) return waitDiff;
      return new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime();
    });
}

async function getSingleChatThread(stores, threadId) {
  const tid = sanitizeId(threadId);
  if (!tid) return null;
  return await stores.chatStore.get(`chat/${tid}`, { type: 'json' }).catch(() => null);
}

async function saveSingleChatThread(stores, thread) {
  const tid = sanitizeId(thread.id);
  await stores.chatStore.setJSON(`chat/${tid}`, thread);
}

async function deleteSingleChatThread(stores, threadId) {
  const tid = sanitizeId(threadId);
  if (tid) await stores.chatStore.delete(`chat/${tid}`);
}

async function listAllBookings(stores, legacyBookings = []) {
  const bStore = stores.bookingStore || stores.chatStore;
  const { blobs } = await bStore.list({ prefix: 'booking/' });
  const loaded = blobs && blobs.length
    ? await Promise.all(blobs.map(b => bStore.get(b.key, { type: 'json' }).catch(() => null)))
    : [];
  const byId = new Map();
  for (const bk of (Array.isArray(legacyBookings) ? legacyBookings : [])) {
    if (bk && bk.id) byId.set(bk.id, bk);
  }
  for (const bk of loaded) {
    if (bk && bk.id) byId.set(bk.id, bk);
  }
  return Array.from(byId.values()).sort(
    (a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime()
  );
}

async function saveSingleBooking(stores, booking) {
  const bid = sanitizeId(booking.id);
  if (!bid) return;
  const bStore = stores.bookingStore || stores.chatStore;
  await bStore.setJSON(`booking/${bid}`, booking);
}

async function deleteSingleBooking(stores, bookingId) {
  const bid = sanitizeId(bookingId);
  if (!bid) return;
  const bStore = stores.bookingStore || stores.chatStore;
  await bStore.delete(`booking/${bid}`).catch(() => {});
}

function getPaymentWebhookSecrets(core) {
  return [
    getEnv('SEPAY_API_KEY'),
    getEnv('CASSO_SECURE_TOKEN'),
    getEnv('PAYOS_CHECKSUM_KEY'),
    getEnv('PAYMENT_WEBHOOK_SECRET'),
    String(core?.settings?.paymentWebhookSecret || '').trim(),
  ].filter(Boolean);
}

function isBankWebhookConfigured(core) {
  return getPaymentWebhookSecrets(core).length > 0;
}

function extractPaymentCodeFromText(text) {
  const m = String(text || '').toUpperCase().match(/LAMOUR[A-Z0-9]{6,10}/);
  return m ? m[0] : '';
}

async function getSinglePaymentOrder(stores, code) {
  const c = sanitizeId(String(code || '').toUpperCase());
  if (!c) return null;
  const pStore = stores.paymentStore || stores.bookingStore || stores.chatStore;
  return await pStore.get(`pay/${c}`, { type: 'json' }).catch(() => null);
}

async function saveSinglePaymentOrder(stores, payment) {
  const c = sanitizeId(String(payment?.code || '').toUpperCase());
  if (!c) return;
  const pStore = stores.paymentStore || stores.bookingStore || stores.chatStore;
  await pStore.setJSON(`pay/${c}`, payment);
}

function finalizeInvitationDelivery(core, inv, payload = {}) {
  const pkgs = core.settings?.packages || DEFAULT_PACKAGES_FALLBACK;
  const matchedPkg = pkgs.find(p => p.id === payload.packageId || p.name === payload.packageName);
  const caps = matchedPkg?.capabilities || null;
  const now = new Date().toISOString();
  const transferCode = String(payload.transferCode || `LAMOUR${String(inv.id || '').replace(/[^A-Z0-9]/gi, '').toUpperCase().slice(0, 6)}`);

  const existingOrder = (core.consultations || []).find(
    c => c.kind === 'qr_order' && c.transferCode === transferCode && c.status === 'paid'
  );
  let orderEntry = existingOrder;
  if (!orderEntry) {
    orderEntry = {
      id: 'cs_' + crypto.randomBytes(5).toString('hex'),
      userId: payload.userId || inv.order?.userId || '',
      email: normalizeEmail(payload.email || inv.order?.customerEmail || ''),
      kind: 'qr_order',
      invitationId: inv.id,
      autoDelivered: true,
      name: String(payload.name || inv.order?.customerName || 'Khách hàng').slice(0, 100),
      phone: sanitizePhone(payload.phone || inv.order?.customerPhone || ''),
      templateId: inv.templateId || '',
      templateName: inv.templateName || inv.title || '',
      packageName: payload.packageName || matchedPkg?.name || 'Gói Tiêu Chuẩn',
      amount: Number(payload.amount || matchedPkg?.price || 189000),
      transferCode,
      bankRef: String(payload.bankRef || '').slice(0, 80),
      paymentGateway: String(payload.gateway || '').slice(0, 40),
      message: String(payload.message || 'Thanh toán VietQR tự động & bàn giao thiệp ngay').slice(0, 600),
      status: 'paid',
      createdAt: now,
    };
    core.consultations = core.consultations || [];
    core.consultations.unshift(orderEntry);
  }

  inv.order = {
    ...(inv.order || {}),
    customerName: orderEntry.name,
    customerPhone: orderEntry.phone,
    customerEmail: orderEntry.email || inv.order?.customerEmail || '',
    packageId: matchedPkg?.id || payload.packageId || '',
    packageName: orderEntry.packageName,
    price: orderEntry.amount,
    transferCode: orderEntry.transferCode,
    bankRef: orderEntry.bankRef || inv.order?.bankRef || '',
    paymentGateway: orderEntry.paymentGateway || inv.order?.paymentGateway || '',
    status: 'paid',
    showWatermark: false,
    paidAt: inv.order?.paidAt || now,
    lastOrderId: orderEntry.id,
  };
  inv.trial = null;
  inv.permissions = {
    ...(inv.permissions || {}),
    allowMusicChange: caps ? Boolean(caps.hasCustomMusic) : true,
    locked: false,
  };
  if (caps && Array.isArray(inv.sections)) {
    inv.sections = inv.sections.map(sec => {
      if (sec.type === 'guestbook') return { ...sec, enabled: Boolean(caps.hasGuestbook) };
      if (sec.type === 'gift') return { ...sec, enabled: Boolean(caps.hasGiftQr) };
      if (sec.type === 'rsvp') return { ...sec, enabled: Boolean(caps.hasRsvp) };
      return sec;
    });
  }
  inv.updatedAt = now;
  return { inv, orderEntry };
}

function verifyWebhookAuth(req, url, body, core) {
  const secrets = getPaymentWebhookSecrets(core);
  if (!secrets.length) return { ok: false, reason: 'Chưa cấu hình khóa bí mật Webhook (SEPAY_API_KEY / PAYMENT_WEBHOOK_SECRET).' };

  const authHeader = (req.headers.get('authorization') || '').trim();
  const secureToken = (req.headers.get('secure-token') || '').trim();
  const apiKeyHeader = (req.headers.get('x-api-key') || '').trim();
  const querySecret = (url.searchParams.get('secret') || url.searchParams.get('apikey') || '').trim();

  const bearerOrApikey = authHeader.replace(/^(?:Apikey|Bearer)\s+/i, '').trim();
  const candidates = [bearerOrApikey, authHeader, secureToken, apiKeyHeader, querySecret].filter(Boolean);
  for (const cand of candidates) {
    const bCand = Buffer.from(cand, 'utf8');
    for (const sec of secrets) {
      const bSec = Buffer.from(sec, 'utf8');
      if (bCand.length === bSec.length && bCand.length > 0 && crypto.timingSafeEqual(bCand, bSec)) {
        return { ok: true, mode: 'secret' };
      }
    }
  }

  // PayOS HMAC-SHA256 signature verification
  const payosKey = getEnv('PAYOS_CHECKSUM_KEY');
  if (payosKey && body?.signature && body?.data && typeof body.data === 'object') {
    const sorted = Object.keys(body.data).sort().map(k => `${k}=${body.data[k] ?? ''}`).join('&');
    const expected = crypto.createHmac('sha256', payosKey).update(sorted).digest('hex');
    const got = String(body.signature || '').toLowerCase();
    const bGot = Buffer.from(got, 'utf8');
    const bExp = Buffer.from(expected, 'utf8');
    if (bGot.length === bExp.length && bGot.length > 0 && crypto.timingSafeEqual(bGot, bExp)) {
      return { ok: true, mode: 'payos-hmac' };
    }
  }

  return { ok: false, reason: 'Sai mã xác thực Webhook (Authorization / Secure-Token không khớp).' };
}

function parseIncomingBankTransactions(body) {
  if (!body || typeof body !== 'object') return [];
  // 1. Casso format: { error: 0, data: [{ amount, description, tid, when }] }
  if (Array.isArray(body.data)) {
    return body.data
      .filter(tx => Number(tx?.amount || 0) > 0)
      .map(tx => ({
        amount: Number(tx.amount || 0),
        content: String(tx.description || tx.content || ''),
        ref: String(tx.tid || tx.id || ''),
        gateway: 'Casso',
        accountNumber: String(tx.subAccId || tx.bankSubAccId || ''),
        txDate: String(tx.when || new Date().toISOString()),
      }));
  }
  // 2. PayOS format: { code: "00", data: { orderCode, amount, description, reference } }
  if (body.data && typeof body.data === 'object' && (body.data.amount || body.data.description)) {
    const amt = Number(body.data.amount || 0);
    if (amt <= 0) return [];
    return [{
      amount: amt,
      content: String(body.data.description || body.data.orderCode || ''),
      ref: String(body.data.reference || body.data.orderCode || ''),
      gateway: 'PayOS',
      accountNumber: String(body.data.accountNumber || ''),
      txDate: String(body.data.transactionDateTime || new Date().toISOString()),
    }];
  }
  // 3. SePay / Generic format: { transferType: "in", transferAmount, content, referenceCode, gateway }
  const transferType = String(body.transferType || 'in').toLowerCase();
  if (transferType === 'out') return [];
  const amt = Number(body.transferAmount ?? body.amount ?? 0);
  if (amt <= 0) return [];
  return [{
    amount: amt,
    content: String(body.content || body.description || body.code || ''),
    ref: String(body.referenceCode || body.id || body.tid || ''),
    gateway: String(body.gateway || 'SePay'),
    accountNumber: String(body.accountNumber || ''),
    txDate: String(body.transactionDate || new Date().toISOString()),
  }];
}

function withCorsHeaders(res, cors) {
  if (!res || !cors) return res;
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(cors)) {
    headers.set(k, v);
  }
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}

function getAuthUser(req, url, auth) {
  const token = req.headers.get('x-auth-token') || url.searchParams.get('authToken') || '';
  if (!token) return null;
  const sess = (auth.sessions || {})[token];
  if (!sess) return null;
  return (auth.users || []).find(u => u.id === sess.userId) || null;
}

function createSession(auth, userId) {
  const token = 'st_' + crypto.randomBytes(18).toString('hex');
  auth.sessions = auth.sessions || {};
  auth.sessions[token] = { userId, createdAt: new Date().toISOString() };
  return token;
}

function getOAuthInfo(core, origin) {
  const fbAppId = getEnv('FACEBOOK_APP_ID') || String(core?.settings?.facebookAppId || '').trim();
  const fbSecret = getEnv('FACEBOOK_APP_SECRET');
  const gClientId = getEnv('GOOGLE_CLIENT_ID') || String(core?.settings?.googleClientId || '').trim();
  const gSecret = getEnv('GOOGLE_CLIENT_SECRET');
  const hasResend = Boolean(getEnv('RESEND_API_KEY'));
  return {
    facebookAppId: fbAppId,
    facebookServerOAuth: Boolean(fbAppId && fbSecret),
    facebookConfigured: Boolean(fbAppId),
    googleClientId: gClientId,
    googleServerOAuth: Boolean(gClientId && gSecret),
    googleConfigured: Boolean(gClientId && gSecret),
    gmailOtpEnabled: hasResend,
    facebookCallbackUrl: `${origin}/api?action=oauth_facebook_callback`,
    googleCallbackUrl: `${origin}/api?action=oauth_google_callback`,
  };
}

async function parseJson(req) {
  try {
    const data = await req.json();
    return data && typeof data === 'object' ? data : {};
  } catch (_) {
    return {};
  }
}

function buildAiAgentSystemPrompt(core, userText) {
  const s = core?.settings || {};
  const pkgs = (s.packages || DEFAULT_PACKAGES_FALLBACK)
    .map(p => `- ${p.name}: ${Number(p.price || 0).toLocaleString('vi-VN')}đ (${p.photoLimit || ''}${p.duration ? ', ' + p.duration : ''})`)
    .join('\n');
  const tpls = (core?.templates || []).slice(0, 14)
    .map(t => `- ${t.name} [${t.category || ''}${t.isTrialTemplate ? ` - Dùng thử ${t.trialDays} ngày` : ''}] hợp mệnh: ${(t.elements || []).join(', ')}`)
    .join('\n');
  const fs = inferNguHanhFromText(userText);
  const fsHint = fs && fs.length
    ? `\nPHÂN TÍCH NGŨ HÀNH ĐÃ TÍNH CHÍNH XÁC CHO KHÁCH:\n${fs.map(x => `- Sinh năm ${x.year}: mệnh ${x.element} -> gợi ý màu: ${x.tip}`).join('\n')}`
    : '';
  const customTone = core?.chatbotConfig?.aiSystemPrompt || DEFAULT_CHATBOT_CONFIG.aiSystemPrompt;

  return `${customTone}

THÔNG TIN CHÍNH THỨC CỦA STUDIO (${s.brandName || "L'Amour Atelier"}):
- Hotline / Zalo Quản Lý: ${s.hotline || '0354 248 177'} (${s.zaloUrl || 'https://zalo.me/0354248177'})
- Thanh toán VietQR: ${s.paymentBankName || 'MB Bank — Ngân hàng Quân Đội'}, STK: ${s.paymentAccountNo || '0354248177'}
- Quy trình: Chọn mẫu -> Tự chỉnh ảnh, chữ, ngày giờ -> Sang trang chuyển tiền VietQR -> Xác nhận xong nhận Link Thiệp chính thức + Mã QR ngay lập tức.

4 GÓI DỊCH VỤ HIỆN TẠI:
${pkgs}

DANH SÁCH MẪU THIỆP HIỆN CÓ:
${tpls || '- Nhung Đỏ Cổ Điển, Song Hỷ Lục Bảo, Hồng Phấn Sakura, Hoàng Gia Ánh Kim, 3 mẫu Dùng Thử Miễn Phí 1–3 ngày'}
${fsHint}

QUY TẮC BẮT BUỘC:
1. Trả lời bằng tiếng Việt tự nhiên, ấm áp, chuyên nghiệp, NGẮN GỌN 2–4 câu (tối đa ~90 từ), KHÔNG dùng emoji.
2. Chỉ báo đúng giá và đúng tính năng của 4 gói trên, không bịa thông tin.
3. Nếu khách muốn thỏa thuận riêng, kiểm tra chuyển khoản hoặc gặp người thật, nhắc khách bấm nút "Nhắn trực tiếp Quản Lý" (nhập SĐT) ngay trong khung chat để gặp trực tiếp Quản Lý.`;
}

async function generateAiAgentReply(core, thread, userText, aiClientOverride = null) {
  const cfg = core?.chatbotConfig || DEFAULT_CHATBOT_CONFIG;
  const fallback = runLocalChatbot(cfg, userText);
  if (cfg.aiAgentEnabled === false) {
    return { reply: fallback, aiPowered: false, model: 'rules-only' };
  }

  const hasGatewayOrKey = Boolean(
    aiClientOverride
    || getEnv('GEMINI_API_KEY')
    || getEnv('GOOGLE_GEMINI_BASE_URL')
    || getEnv('GOOGLE_API_KEY')
  );
  if (!hasGatewayOrKey) {
    return { reply: fallback, aiPowered: false, model: 'smart-local-fallback' };
  }

  const systemInstruction = buildAiAgentSystemPrompt(core, userText);
  const recent = (thread?.messages || []).slice(-10).map(m => ({
    role: m.sender === 'customer' ? 'user' : 'model',
    parts: [{ text: String(m.text || '').slice(0, 600) }],
  }));
  if (!recent.length || recent[recent.length - 1].role !== 'user') {
    recent.push({ role: 'user', parts: [{ text: String(userText || '').slice(0, 600) }] });
  }

  const preferredModels = [
    getEnv('GEMINI_MODEL'),
    'gemini-3.5-flash-lite',
    'gemini-3.5-flash',
    'gemini-3.1-flash-lite',
    'gemini-2.5-flash',
    'gemini-2.5-flash-lite',
    'gemini-4-hydrogen',
  ].filter((m, idx, arr) => Boolean(m) && arr.indexOf(m) === idx);

  try {
    // Works automatically with GEMINI_API_KEY / GOOGLE_API_KEY on Render & GOOGLE_GEMINI_BASE_URL on Netlify AI Gateway
    let ai = aiClientOverride;
    if (!ai) {
      const { GoogleGenAI } = await import('@google/genai');
      ai = new GoogleGenAI({});
    }
    for (const model of preferredModels) {
      try {
        const result = await ai.models.generateContent({
          model,
          contents: recent,
          config: {
            systemInstruction,
            temperature: 0.65,
            maxOutputTokens: 320,
          },
        });
        const rawText = String(result?.text || '').trim();
        if (rawText) {
          // Strip any stray emoji characters to honor strict luxury zero-emoji UI
          const cleanText = rawText.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, '').trim();
          return { reply: cleanText || fallback, aiPowered: true, model };
        }
      } catch (_) {
        // Try next available Gemini model
      }
    }
  } catch (_) {}

  return { reply: fallback, aiPowered: false, model: 'smart-local-fallback' };
}

async function routeApiRequest(
  req,
  {
    stores: overrideStores = null,
    aiClient: aiClientOverride = null,
    engine = 'netlify-blobs-v14',
    persistent = true,
    storageWarning = '',
  } = {}
) {
  const stores = getStores(overrideStores);
  const url = new URL(req.url);
  const origin = `${url.protocol}//${url.host}`;
  const action = url.searchParams.get('action') || 'ping';
  const method = req.method.toUpperCase();

  if (method === 'OPTIONS') {
    return new Response(null, { status: 204 });
  }

  // 1. Ping
  if (action === 'ping') {
    const rawCore = await stores.dataStore.get('core', { type: 'json' });
    const hasSeededTemplates = Boolean(rawCore && Array.isArray(rawCore.templates) && rawCore.templates.length > 0);
    const aiGatewayReady = Boolean(getEnv('GEMINI_API_KEY') || getEnv('GOOGLE_GEMINI_BASE_URL') || getEnv('GOOGLE_API_KEY'));
    return jsonRes({
      ok: true,
      engine,
      persistent: Boolean(persistent),
      storageWarning: String(storageWarning || ''),
      corsEnabled: true,
      bookingsReady: true,
      paymentWebhookActive: isBankWebhookConfigured(rawCore),
      paymentWebhookUrl: `${origin}/api?action=payment_webhook`,
      hasDb: hasSeededTemplates,
      aiAgentReady: aiGatewayReady,
      oauth: getOAuthInfo(rawCore || {}, origin),
    });
  }

  // 2. Serve stored media blob (supports GET & HEAD with CORP + nosniff)
  if (action === 'media' && (method === 'GET' || method === 'HEAD')) {
    const key = sanitizeId(url.searchParams.get('key') || '');
    if (!key) return new Response('Not found', { status: 404 });
    const entry = await stores.mediaStore.getWithMetadata(key, { type: 'arrayBuffer' });
    if (!entry) return new Response('Not found', { status: 404 });
    const mime = entry.metadata?.mime || 'image/jpeg';
    return new Response(method === 'HEAD' ? null : entry.data, {
      status: 200,
      headers: {
        'content-type': mime,
        'cache-control': 'public, max-age=31536000, immutable',
        'cross-origin-resource-policy': 'cross-origin',
        'x-content-type-options': 'nosniff',
      },
    });
  }

  // 3. Init
  if (action === 'init' && method === 'POST') {
    const existing = await stores.dataStore.get('core', { type: 'json' });
    if (existing && Array.isArray(existing.templates) && existing.templates.length > 0) {
      return jsonRes({ ok: true, seeded: false });
    }
    const body = await parseJson(req);
    const existingAuth = await stores.dataStore.get('auth', { type: 'json' });
    const { core, auth } = ensureAdminAndDefaults(body.settings ? body : null, existingAuth);
    await Promise.all([saveCore(stores, core), saveAuth(stores, auth)]);
    if (Array.isArray(body.chatThreads)) {
      await Promise.all(body.chatThreads.map(th => saveSingleChatThread(stores, th)));
    }
    return jsonRes({ ok: true, seeded: true });
  }

  const { core, auth } = await loadState(stores);

  // 4. Public storefront data
  if (action === 'public_store' && method === 'GET') {
    const safeSettings = { ...(core.settings || {}) };
    delete safeSettings.adminPin;
    delete safeSettings.paymentWebhookSecret;
    return jsonRes({
      ok: true,
      initialized: true,
      settings: safeSettings,
      templates: core.templates || [],
      chatbotConfig: core.chatbotConfig || DEFAULT_CHATBOT_CONFIG,
      oauth: getOAuthInfo(core, origin),
      paymentWebhookActive: isBankWebhookConfigured(core),
      paymentWebhookUrl: `${origin}/api?action=payment_webhook`,
    });
  }

  // 5. Gmail OTP verification request (real email via Resend when RESEND_API_KEY is configured)
  if (action === 'auth_gmail_otp_send' && method === 'POST') {
    const body = await parseJson(req);
    const email = normalizeEmail(body.email);
    if (!isStrictGmail(email)) {
      return jsonRes({ ok: false, error: 'Vui lòng nhập đúng địa chỉ Gmail hợp lệ (kết thúc bằng @gmail.com)' }, 400);
    }
    if ((auth.users || []).some(u => normalizeEmail(u.email) === email)) {
      return jsonRes({ ok: false, error: 'Gmail này đã được đăng ký tài khoản, vui lòng đăng nhập' }, 409);
    }
    const resendKey = getEnv('RESEND_API_KEY');
    if (!resendKey) {
      return jsonRes({ ok: false, otpSupported: false, error: 'Hệ thống chưa bật gửi mã OTP tự động (cần RESEND_API_KEY)' }, 400);
    }
    const code = String(crypto.randomInt(100000, 999999));
    auth.gmailOtps[email] = { code, expiresAt: Date.now() + 10 * 60 * 1000 };
    await saveAuth(stores, auth);

    const fromAddr = getEnv('MAIL_FROM') || 'L\'Amour Atelier <onboarding@resend.dev>';
    const mailRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${resendKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        from: fromAddr,
        to: [email],
        subject: `Mã xác thực đăng ký L'Amour Atelier: ${code}`,
        html: `<p>Xin chào,</p><p>Mã xác thực Gmail đăng ký tài khoản tại <strong>L'Amour Atelier</strong> của bạn là:</p><h2 style="letter-spacing:4px;color:#8f1d32;">${code}</h2><p>Mã có hiệu lực trong 10 phút.</p>`,
      }),
    });
    if (!mailRes.ok) {
      return jsonRes({ ok: false, error: 'Không gửi được email xác thực. Hãy kiểm tra lại địa chỉ Gmail của bạn.' }, 502);
    }
    return jsonRes({ ok: true, sent: true });
  }

  // 6. Auth Register (Strict Gmail + Confirmation / Optional OTP + Strict Numeric Phone)
  if (action === 'auth_register' && method === 'POST') {
    const body = await parseJson(req);
    const provider = String(body.provider || 'gmail').trim();
    const name = String(body.name || '').trim().slice(0, 100);
    const email = normalizeEmail(body.email);
    const confirmEmail = normalizeEmail(body.confirmEmail);
    const rawPhone = String(body.phone || '').trim();
    const phone = sanitizePhone(rawPhone);
    const password = String(body.password || '');
    const otpCode = String(body.otpCode || '').trim();

    if (!name) return jsonRes({ ok: false, error: 'Vui lòng nhập họ và tên' }, 400);

    if (provider === 'gmail') {
      if (!isStrictGmail(email)) {
        return jsonRes({ ok: false, error: 'Vui lòng nhập đúng địa chỉ Gmail thật đã tạo (định dạng tenban@gmail.com)' }, 400);
      }
      if (confirmEmail && confirmEmail !== email) {
        return jsonRes({ ok: false, error: 'Gmail xác nhận không khớp với Gmail bạn đã nhập' }, 400);
      }
      if (getEnv('RESEND_API_KEY')) {
        const rec = (auth.gmailOtps || {})[email];
        if (!rec || rec.expiresAt < Date.now() || rec.code !== otpCode) {
          return jsonRes({ ok: false, error: 'Mã xác thực 6 số gửi tới Gmail không đúng hoặc đã hết hạn' }, 400);
        }
        delete auth.gmailOtps[email];
      }
    }

    if (provider === 'phone') {
      const phoneCheck = validateVnPhone10(rawPhone);
      if (!phoneCheck.ok) {
        return jsonRes({ ok: false, error: phoneCheck.error }, 400);
      }
      if (email && !isStrictGmail(email)) {
        return jsonRes({ ok: false, error: 'Gmail bổ sung phải đúng định dạng @gmail.com' }, 400);
      }
    } else if (rawPhone) {
      const phoneCheck = validateVnPhone10(rawPhone);
      if (!phoneCheck.ok) {
        return jsonRes({ ok: false, error: phoneCheck.error }, 400);
      }
    }

    if (password.length < 6) {
      return jsonRes({ ok: false, error: 'Mật khẩu tối thiểu 6 ký tự' }, 400);
    }

    for (const u of auth.users || []) {
      if (email && normalizeEmail(u.email) === email) {
        return jsonRes({ ok: false, error: 'Gmail này đã được đăng ký, vui lòng đăng nhập' }, 409);
      }
      if (phone && sanitizePhone(u.phone) === phone) {
        return jsonRes({ ok: false, error: 'Số điện thoại này đã được đăng ký, vui lòng đăng nhập' }, 409);
      }
    }

    const user = {
      id: 'usr_' + crypto.randomBytes(5).toString('hex'),
      role: 'customer',
      provider,
      name,
      email,
      phone,
      emailVerified: Boolean(email && getEnv('RESEND_API_KEY')),
      passwordHash: hashPassword(password),
      createdAt: new Date().toISOString(),
    };
    auth.users.push(user);
    const token = createSession(auth, user.id);
    await saveAuth(stores, auth);
    return jsonRes({ ok: true, token, user: safeUser(user) });
  }

  // 7. Auth Login (Gmail / Phone numeric / Facebook SDK verified token)
  if (action === 'auth_login' && method === 'POST') {
    const body = await parseJson(req);
    const provider = String(body.provider || 'password').trim();
    const loginMethod = String(body.loginMethod || 'auto').trim();
    const identifier = String(body.identifier || '').trim();
    const password = String(body.password || '');

    // Direct Facebook JS SDK access token login (verifies token directly against Facebook Graph API!)
    if (provider === 'facebook_token') {
      const fbToken = String(body.accessToken || '').trim();
      if (!fbToken) return jsonRes({ ok: false, error: 'Thiếu mã đăng nhập từ Facebook' }, 400);
      const fbRes = await fetch(`https://graph.facebook.com/me?fields=id,name,email&access_token=${encodeURIComponent(fbToken)}`);
      if (!fbRes.ok) return jsonRes({ ok: false, error: 'Không xác thực được phiên đăng nhập Facebook' }, 401);
      const profile = await fbRes.json();
      if (!profile?.id) return jsonRes({ ok: false, error: 'Tài khoản Facebook không hợp lệ' }, 401);
      const fbEmail = normalizeEmail(profile.email || '');
      if (fbEmail === ADMIN_EMAIL) {
        return jsonRes({ ok: false, error: 'Tài khoản Quản trị bắt buộc đăng nhập bằng Gmail và Mật khẩu' }, 403);
      }
      let found = auth.users.find(u => u.facebookId === profile.id || (fbEmail && normalizeEmail(u.email) === fbEmail));
      if (!found) {
        found = {
          id: 'usr_' + crypto.randomBytes(5).toString('hex'),
          role: 'customer',
          provider: 'facebook',
          facebookId: profile.id,
          name: String(profile.name || 'Khách Facebook').slice(0, 100),
          email: fbEmail,
          phone: '',
          emailVerified: Boolean(fbEmail),
          passwordHash: hashPassword(crypto.randomBytes(12).toString('hex')),
          createdAt: new Date().toISOString(),
        };
        auth.users.push(found);
      } else {
        found.facebookId = profile.id;
        if (profile.name) found.name = String(profile.name).slice(0, 100);
      }
      const token = createSession(auth, found.id);
      await saveAuth(stores, auth);
      return jsonRes({ ok: true, token, user: safeUser(found) });
    }

    if (loginMethod === 'phone') {
      const phoneCheck = validateVnPhone10(identifier);
      if (!phoneCheck.ok) {
        return jsonRes({ ok: false, error: phoneCheck.error }, 400);
      }
    } else if (loginMethod === 'gmail') {
      if (!isStrictGmail(identifier)) {
        return jsonRes({ ok: false, error: 'Vui lòng nhập đúng địa chỉ Gmail đã đăng ký (@gmail.com)' }, 400);
      }
    }

    const norm = normalizeEmail(identifier);
    const cleanPhone = sanitizePhone(identifier);
    const found = (auth.users || []).find(u => {
      const uEmail = normalizeEmail(u.email);
      const uPhone = sanitizePhone(u.phone);
      if (loginMethod === 'phone') return cleanPhone.length >= 9 && uPhone === cleanPhone;
      if (loginMethod === 'gmail') return norm !== '' && uEmail === norm;
      return (norm !== '' && uEmail === norm) || (cleanPhone.length >= 9 && uPhone === cleanPhone);
    });

    if (!found) {
      return jsonRes({
        ok: false,
        error: loginMethod === 'gmail'
          ? 'Gmail này chưa được đăng ký tài khoản — Vui lòng nhập đúng Gmail bạn đã tạo hoặc bấm Đăng Ký Mới'
          : 'Không tìm thấy tài khoản phù hợp',
      }, 401);
    }

    if (!verifyPassword(found, password)) {
      return jsonRes({ ok: false, error: 'Mật khẩu không chính xác' }, 401);
    }

    const token = createSession(auth, found.id);
    await saveAuth(stores, auth);
    return jsonRes({ ok: true, token, user: safeUser(found) });
  }

  // 8. Real OAuth 2.0 Direct Redirect — Facebook
  if (action === 'oauth_facebook_start' && method === 'GET') {
    const returnTo = url.searchParams.get('returnTo') || req.headers.get('referer') || '';
    const fbAppId = getEnv('FACEBOOK_APP_ID') || String(core?.settings?.facebookAppId || '').trim();
    const fbSecret = getEnv('FACEBOOK_APP_SECRET');
    if (!fbAppId || !fbSecret) {
      return redirectRes(resolveFrontendRedirectUrl(returnTo, origin, {
        oauth_error: 'Facebook OAuth chưa cấu hình FACEBOOK_APP_ID và FACEBOOK_APP_SECRET trên Backend (Render / Netlify Environment Variables)',
      }));
    }
    const state = crypto.randomBytes(16).toString('hex');
    auth.oauthStates[state] = { provider: 'facebook', at: Date.now(), returnTo };
    await saveAuth(stores, auth);
    const callback = `${origin}/api?action=oauth_facebook_callback`;
    const fbUrl = new URL('https://www.facebook.com/v21.0/dialog/oauth');
    fbUrl.searchParams.set('client_id', fbAppId);
    fbUrl.searchParams.set('redirect_uri', callback);
    fbUrl.searchParams.set('state', state);
    fbUrl.searchParams.set('scope', 'public_profile,email');
    fbUrl.searchParams.set('response_type', 'code');
    return redirectRes(fbUrl.toString());
  }

  if (action === 'oauth_facebook_callback' && method === 'GET') {
    const code = url.searchParams.get('code') || '';
    const state = url.searchParams.get('state') || '';
    const errParam = url.searchParams.get('error_message') || url.searchParams.get('error') || '';
    const savedState = (auth.oauthStates || {})[state];
    const returnTo = savedState?.returnTo || '';
    if (errParam) {
      if (savedState) {
        delete auth.oauthStates[state];
        await saveAuth(stores, auth);
      }
      return redirectRes(resolveFrontendRedirectUrl(returnTo, origin, { oauth_error: 'Bạn đã hủy đăng nhập Facebook' }));
    }
    if (!code || !savedState || savedState.provider !== 'facebook') {
      return redirectRes(resolveFrontendRedirectUrl(returnTo, origin, { oauth_error: 'Phiên đăng nhập Facebook hết hạn, vui lòng thử lại' }));
    }
    delete auth.oauthStates[state];

    const fbAppId = getEnv('FACEBOOK_APP_ID') || String(core?.settings?.facebookAppId || '').trim();
    const fbSecret = getEnv('FACEBOOK_APP_SECRET');
    const callback = `${origin}/api?action=oauth_facebook_callback`;

    const tokUrl = new URL('https://graph.facebook.com/v21.0/oauth/access_token');
    tokUrl.searchParams.set('client_id', fbAppId);
    tokUrl.searchParams.set('client_secret', fbSecret);
    tokUrl.searchParams.set('redirect_uri', callback);
    tokUrl.searchParams.set('code', code);

    const tokRes = await fetch(tokUrl.toString());
    const tokData = await tokRes.json().catch(() => ({}));
    if (!tokRes.ok || !tokData.access_token) {
      await saveAuth(stores, auth);
      return redirectRes(resolveFrontendRedirectUrl(returnTo, origin, { oauth_error: 'Không lấy được mã xác thực từ Facebook' }));
    }

    const profRes = await fetch(`https://graph.facebook.com/me?fields=id,name,email&access_token=${encodeURIComponent(tokData.access_token)}`);
    const profile = await profRes.json().catch(() => ({}));
    if (!profRes.ok || !profile.id) {
      await saveAuth(stores, auth);
      return redirectRes(resolveFrontendRedirectUrl(returnTo, origin, { oauth_error: 'Không đọc được hồ sơ Facebook' }));
    }

    const fbEmail = normalizeEmail(profile.email || '');
    if (fbEmail === ADMIN_EMAIL) {
      await saveAuth(stores, auth);
      return redirectRes(resolveFrontendRedirectUrl(returnTo, origin, { oauth_error: 'Tài khoản Quản trị cần đăng nhập bằng Gmail và Mật khẩu' }));
    }

    let found = auth.users.find(u => u.facebookId === profile.id || (fbEmail && normalizeEmail(u.email) === fbEmail));
    if (!found) {
      found = {
        id: 'usr_' + crypto.randomBytes(5).toString('hex'),
        role: 'customer',
        provider: 'facebook',
        facebookId: profile.id,
        name: String(profile.name || 'Khách Facebook').slice(0, 100),
        email: fbEmail,
        phone: '',
        emailVerified: Boolean(fbEmail),
        passwordHash: hashPassword(crypto.randomBytes(12).toString('hex')),
        createdAt: new Date().toISOString(),
      };
      auth.users.push(found);
    } else {
      found.facebookId = profile.id;
      if (profile.name) found.name = String(profile.name).slice(0, 100);
    }

    const token = createSession(auth, found.id);
    await saveAuth(stores, auth);
    return redirectRes(resolveFrontendRedirectUrl(returnTo, origin, { oauth_token: token, oauth_provider: 'facebook' }));
  }

  // 9. Real OAuth 2.0 Direct Redirect — Google (verifies authentic Gmail directly from Google!)
  if (action === 'oauth_google_start' && method === 'GET') {
    const returnTo = url.searchParams.get('returnTo') || req.headers.get('referer') || '';
    const gClientId = getEnv('GOOGLE_CLIENT_ID') || String(core?.settings?.googleClientId || '').trim();
    const gSecret = getEnv('GOOGLE_CLIENT_SECRET');
    if (!gClientId || !gSecret) {
      return redirectRes(resolveFrontendRedirectUrl(returnTo, origin, {
        oauth_error: 'Google OAuth chưa cấu hình GOOGLE_CLIENT_ID và GOOGLE_CLIENT_SECRET trên Backend (Render / Netlify Environment Variables)',
      }));
    }
    const state = crypto.randomBytes(16).toString('hex');
    auth.oauthStates[state] = { provider: 'google', at: Date.now(), returnTo };
    await saveAuth(stores, auth);
    const callback = `${origin}/api?action=oauth_google_callback`;
    const gUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    gUrl.searchParams.set('client_id', gClientId);
    gUrl.searchParams.set('redirect_uri', callback);
    gUrl.searchParams.set('response_type', 'code');
    gUrl.searchParams.set('scope', 'openid email profile');
    gUrl.searchParams.set('state', state);
    gUrl.searchParams.set('prompt', 'select_account');
    return redirectRes(gUrl.toString());
  }

  if (action === 'oauth_google_callback' && method === 'GET') {
    const code = url.searchParams.get('code') || '';
    const state = url.searchParams.get('state') || '';
    const errParam = url.searchParams.get('error_description') || url.searchParams.get('error') || '';
    const savedState = (auth.oauthStates || {})[state];
    const returnTo = savedState?.returnTo || '';
    if (errParam) {
      if (savedState) {
        delete auth.oauthStates[state];
        await saveAuth(stores, auth);
      }
      return redirectRes(resolveFrontendRedirectUrl(returnTo, origin, { oauth_error: 'Bạn đã hủy đăng nhập Google' }));
    }
    if (!code || !savedState || savedState.provider !== 'google') {
      return redirectRes(resolveFrontendRedirectUrl(returnTo, origin, { oauth_error: 'Phiên đăng nhập Google hết hạn, vui lòng thử lại' }));
    }
    delete auth.oauthStates[state];

    const gClientId = getEnv('GOOGLE_CLIENT_ID') || String(core?.settings?.googleClientId || '').trim();
    const gSecret = getEnv('GOOGLE_CLIENT_SECRET');
    const callback = `${origin}/api?action=oauth_google_callback`;

    const tokRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: gClientId,
        client_secret: gSecret,
        redirect_uri: callback,
        grant_type: 'authorization_code',
      }),
    });
    const tokData = await tokRes.json().catch(() => ({}));
    if (!tokRes.ok || !tokData.access_token) {
      await saveAuth(stores, auth);
      return redirectRes(resolveFrontendRedirectUrl(returnTo, origin, { oauth_error: 'Không xác thực được tài khoản Google' }));
    }

    const profRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { authorization: `Bearer ${tokData.access_token}` },
    });
    const profile = await profRes.json().catch(() => ({}));
    const gEmail = normalizeEmail(profile.email || '');
    if (!profRes.ok || !gEmail || !profile.email_verified) {
      await saveAuth(stores, auth);
      return redirectRes(resolveFrontendRedirectUrl(returnTo, origin, { oauth_error: 'Google chưa xác minh địa chỉ Gmail này' }));
    }
    if (gEmail === ADMIN_EMAIL) {
      await saveAuth(stores, auth);
      return redirectRes(resolveFrontendRedirectUrl(returnTo, origin, { oauth_error: 'Tài khoản Quản trị cần đăng nhập bằng Gmail và Mật khẩu' }));
    }

    let found = auth.users.find(u => normalizeEmail(u.email) === gEmail);
    if (!found) {
      found = {
        id: 'usr_' + crypto.randomBytes(5).toString('hex'),
        role: 'customer',
        provider: 'gmail',
        googleId: profile.sub || '',
        name: String(profile.name || gEmail.split('@')[0]).slice(0, 100),
        email: gEmail,
        phone: '',
        emailVerified: true,
        passwordHash: hashPassword(crypto.randomBytes(12).toString('hex')),
        createdAt: new Date().toISOString(),
      };
      auth.users.push(found);
    } else {
      found.emailVerified = true;
      if (profile.name && !found.name) found.name = String(profile.name).slice(0, 100);
    }

    const token = createSession(auth, found.id);
    await saveAuth(stores, auth);
    return redirectRes(resolveFrontendRedirectUrl(returnTo, origin, { oauth_token: token, oauth_provider: 'google' }));
  }

  // 10. Auth Me & Logout
  if (action === 'auth_me' && method === 'GET') {
    const user = getAuthUser(req, url, auth);
    if (!user) return jsonRes({ ok: false, user: null }, 401);
    return jsonRes({ ok: true, user: safeUser(user) });
  }

  if (action === 'auth_logout' && method === 'POST') {
    const token = req.headers.get('x-auth-token') || '';
    if (token && auth.sessions?.[token]) {
      delete auth.sessions[token];
      await saveAuth(stores, auth);
    }
    return jsonRes({ ok: true });
  }

  // 11. Customer Portal Data
  if (action === 'customer_portal_data' && method === 'GET') {
    const user = getAuthUser(req, url, auth);
    if (!user) return jsonRes({ ok: false, error: 'Vui lòng đăng nhập' }, 401);
    const uEmail = normalizeEmail(user.email);
    const uPhone = sanitizePhone(user.phone);
    const match = (uid, em, ph) =>
      (uid && uid === user.id)
      || (uEmail && normalizeEmail(em) === uEmail)
      || (uPhone.length >= 9 && sanitizePhone(ph) === uPhone);

    const allBookings = await listAllBookings(stores, core.bookings);
    return jsonRes({
      ok: true,
      user: safeUser(user),
      invitations: (core.invitations || []).filter(i => match(i.order?.userId, i.order?.customerEmail, i.order?.customerPhone)),
      orders: (core.consultations || []).filter(c => c.kind === 'qr_order' && match(c.userId, c.email, c.phone)),
      bookings: allBookings.filter(b => match(b.userId, b.email, b.phone)),
    });
  }

  // 12. Admin DB Read & Save (merges live per-thread Chat Blobs & per-booking Consultation Blobs!)
  if (action === 'admin_db' && method === 'GET') {
    const user = getAuthUser(req, url, auth);
    if (!user || user.role !== 'admin') return jsonRes({ ok: false, error: 'Cần đăng nhập tài khoản Quản trị' }, 401);
    const [chatThreads, bookings] = await Promise.all([
      listAllChatThreads(stores),
      listAllBookings(stores, core.bookings),
    ]);
    return jsonRes({
      ok: true,
      db: {
        ...core,
        bookings,
        users: (auth.users || []).map(safeUser),
        chatThreads,
      },
    });
  }

  if (action === 'admin_save' && method === 'POST') {
    const user = getAuthUser(req, url, auth);
    if (!user || user.role !== 'admin') return jsonRes({ ok: false, error: 'Cần đăng nhập tài khoản Quản trị' }, 401);
    const body = await parseJson(req);
    const nextCore = {
      ...core,
      version: Math.max(Number(body.version || 0), 13),
      settings: body.settings || core.settings,
      templates: Array.isArray(body.templates) ? body.templates : core.templates,
      invitations: Array.isArray(body.invitations) ? body.invitations : core.invitations,
      bookings: [],
      consultations: Array.isArray(body.consultations) ? body.consultations : core.consultations,
      chatbotConfig: body.chatbotConfig || core.chatbotConfig,
    };
    await saveCore(stores, nextCore);

    // Sync any admin edits/deletions to chat threads (read flags, bot toggle, deleted threads)
    if (Array.isArray(body.chatThreads)) {
      const existingThreads = await listAllChatThreads(stores);
      const keepIds = new Set(body.chatThreads.map(t => sanitizeId(t.id)).filter(Boolean));
      await Promise.all([
        ...existingThreads
          .filter(t => !keepIds.has(sanitizeId(t.id)))
          .map(t => deleteSingleChatThread(stores, t.id)),
        ...body.chatThreads.map(t => saveSingleChatThread(stores, t)),
      ]);
    }
    // Sync any admin edits/deletions to consultation bookings
    if (Array.isArray(body.bookings)) {
      const existingBookings = await listAllBookings(stores, []);
      const keepBkIds = new Set(body.bookings.map(b => sanitizeId(b.id)).filter(Boolean));
      await Promise.all([
        ...existingBookings
          .filter(b => !keepBkIds.has(sanitizeId(b.id)))
          .map(b => deleteSingleBooking(stores, b.id)),
        ...body.bookings.map(b => saveSingleBooking(stores, b)),
      ]);
    }
    return jsonRes({ ok: true, savedAt: new Date().toISOString() });
  }

  // 13. Booking Submit (Isolated per-booking Blob + strict 10-digit VN phone validation!)
  if (action === 'booking_submit' && method === 'POST') {
    const user = getAuthUser(req, url, auth);
    const body = await parseJson(req);
    const name = String(body.name || '').trim();
    const rawPhone = String(body.phone || '').trim();
    const date = String(body.date || '').trim();
    if (!name || !date) {
      return jsonRes({ ok: false, error: 'Vui lòng nhập đầy đủ họ tên và ngày hẹn tư vấn.' }, 400);
    }
    const phoneCheck = validateVnPhone10(rawPhone);
    if (!phoneCheck.ok) {
      return jsonRes({ ok: false, error: phoneCheck.error }, 400);
    }
    const booking = {
      id: 'bk_' + crypto.randomBytes(5).toString('hex'),
      userId: user?.id || '',
      name: name.slice(0, 100),
      phone: phoneCheck.digits,
      email: normalizeEmail(body.email || user?.email || ''),
      date: date.slice(0, 20),
      timeSlot: String(body.timeSlot || '19:30').slice(0, 30),
      channel: String(body.channel || 'Zalo Call').slice(0, 40),
      service: String(body.service || 'Tư vấn chọn mẫu & màu hợp mệnh').slice(0, 180),
      note: String(body.note || '').trim().slice(0, 600),
      status: 'pending',
      createdAt: new Date().toISOString(),
    };
    await saveSingleBooking(stores, booking);
    return jsonRes({ ok: true, booking });
  }

  // 14. Live Chat: Get customer thread
  if (action === 'chat_thread' && method === 'GET') {
    const tid = sanitizeId(url.searchParams.get('threadId') || '');
    const thread = tid ? await getSingleChatThread(stores, tid) : null;
    return jsonRes({ ok: true, thread });
  }

  // 15. Live Chat: Customer sends message (isolated per-thread Blob — ZERO race conditions!)
  if (action === 'chat_send' && method === 'POST') {
    const user = getAuthUser(req, url, auth);
    const body = await parseJson(req);
    let tid = sanitizeId(body.threadId || '');
    if (!tid) tid = 'th_' + crypto.randomBytes(5).toString('hex');

    const mode = String(body.mode || 'bot'); // bot | direct
    const deferBot = Boolean(body.deferBot);
    const text = String(body.text || '').trim().slice(0, 1200);
    if (!text) return jsonRes({ ok: false, error: 'Vui lòng nhập nội dung tin nhắn' }, 400);

    let thread = await getSingleChatThread(stores, tid);
    const rawPhone = String(body.phone || user?.phone || '').trim();
    const cleanPhone = sanitizePhone(rawPhone);
    const existingPhone = thread ? sanitizePhone(thread.customerPhone) : '';
    const effectivePhone = cleanPhone || existingPhone;

    if (mode === 'direct') {
      const phoneCheck = validateVnPhone10(rawPhone || effectivePhone);
      if (!phoneCheck.ok) {
        return jsonRes({ ok: false, error: `Để nhắn trực tiếp cho Quản Lý: ${phoneCheck.error}` }, 400);
      }
    }

    const now = new Date().toISOString();
    const name = String(body.name || user?.name || '').trim().slice(0, 100);
    const email = normalizeEmail(body.email || user?.email || '');

    if (!thread) {
      thread = {
        id: tid,
        userId: user?.id || '',
        customerName: name || 'Khách tham quan',
        customerPhone: effectivePhone,
        customerEmail: email,
        botActive: mode !== 'direct',
        waitingForAdmin: mode === 'direct',
        directRequestedAt: mode === 'direct' ? now : '',
        unreadByAdmin: 0,
        updatedAt: now,
        messages: [],
      };
    } else {
      if (name && name !== 'Khách tham quan') thread.customerName = name;
      if (effectivePhone) thread.customerPhone = effectivePhone;
      if (email) thread.customerEmail = email;
      if (mode === 'direct') {
        thread.botActive = false;
        thread.waitingForAdmin = true;
        if (!thread.directRequestedAt) thread.directRequestedAt = now;
      }
    }

    thread.messages.push({
      id: 'm_' + crypto.randomBytes(4).toString('hex'),
      sender: 'customer',
      text,
      createdAt: now,
    });
    thread.unreadByAdmin = Number(thread.unreadByAdmin || 0) + 1;
    thread.updatedAt = now;

    let pendingBotReply = null;
    let botReplied = false;
    const shouldBot = mode !== 'direct' && thread.botActive !== false && !thread.waitingForAdmin;
    if (shouldBot) {
      const reply = runLocalChatbot(core.chatbotConfig || DEFAULT_CHATBOT_CONFIG, text);
      if (reply) {
        if (deferBot) {
          pendingBotReply = reply;
        } else {
          botReplied = true;
          thread.messages.push({
            id: 'm_b_' + crypto.randomBytes(4).toString('hex'),
            sender: 'bot',
            text: reply,
            createdAt: new Date().toISOString(),
          });
        }
      }
    }

    await saveSingleChatThread(stores, thread);
    return jsonRes({ ok: true, thread, botReplied, pendingBotReply });
  }

  // 16. Live Chat: Commit deferred bot reply after 3-5s thinking delay
  if (action === 'chat_bot_commit' && method === 'POST') {
    const body = await parseJson(req);
    const tid = sanitizeId(body.threadId || '');
    const text = String(body.text || '').trim().slice(0, 1200);
    if (!tid || !text) return jsonRes({ ok: false, error: 'Thiếu dữ liệu bot' }, 400);
    const thread = await getSingleChatThread(stores, tid);
    if (!thread) return jsonRes({ ok: false, error: 'Không tìm thấy hội thoại' }, 404);

    let committed = false;
    if (thread.botActive !== false && !thread.waitingForAdmin) {
      const now = new Date().toISOString();
      thread.messages.push({
        id: 'm_b_' + crypto.randomBytes(4).toString('hex'),
        sender: 'bot',
        text,
        createdAt: now,
      });
      thread.updatedAt = now;
      await saveSingleChatThread(stores, thread);
      committed = true;
    }
    return jsonRes({ ok: true, committed, thread });
  }

  // 16b. Live Chat: AI Agent Consultant Reply (Netlify AI Gateway + Gemini with smart fallback)
  if (action === 'chat_ai_reply' && method === 'POST') {
    const body = await parseJson(req);
    const tid = sanitizeId(body.threadId || '');
    const userText = String(body.text || '').trim().slice(0, 1200);
    if (!tid) return jsonRes({ ok: false, error: 'Thiếu mã hội thoại' }, 400);
    const thread = await getSingleChatThread(stores, tid);
    if (!thread) return jsonRes({ ok: false, error: 'Không tìm thấy hội thoại' }, 404);

    // Abort politely if Admin already took over or customer switched to Waiting for Manager
    if (thread.botActive === false || thread.waitingForAdmin) {
      return jsonRes({ ok: true, committed: false, aiPowered: false, thread });
    }

    const lastCustomerText = userText || [...(thread.messages || [])].reverse().find(m => m.sender === 'customer')?.text || '';
    if (!lastCustomerText) return jsonRes({ ok: true, committed: false, aiPowered: false, thread });

    const { reply, aiPowered, model } = await generateAiAgentReply(core, thread, lastCustomerText, aiClientOverride);

    // Re-read thread right before committing so Admin takeover during AI generation is NEVER overwritten
    const latestThread = await getSingleChatThread(stores, tid);
    if (!latestThread || latestThread.botActive === false || latestThread.waitingForAdmin || !reply) {
      return jsonRes({ ok: true, committed: false, aiPowered, model, thread: latestThread || thread });
    }

    const now = new Date().toISOString();
    latestThread.messages.push({
      id: 'm_ai_' + crypto.randomBytes(4).toString('hex'),
      sender: 'bot',
      aiPowered,
      model,
      text: reply.slice(0, 1400),
      createdAt: now,
    });
    latestThread.updatedAt = now;
    await saveSingleChatThread(stores, latestThread);
    return jsonRes({ ok: true, committed: true, aiPowered, model, thread: latestThread });
  }

  // 17. Live Chat: Admin replies directly to customer thread
  if (action === 'admin_chat_reply' && method === 'POST') {
    const user = getAuthUser(req, url, auth);
    if (!user || user.role !== 'admin') return jsonRes({ ok: false, error: 'Cần quyền Quản trị' }, 401);
    const body = await parseJson(req);
    const tid = sanitizeId(body.threadId || '');
    const text = String(body.text || '').trim().slice(0, 1200);
    if (!tid || !text) return jsonRes({ ok: false, error: 'Thiếu nội dung trả lời' }, 400);
    const thread = await getSingleChatThread(stores, tid);
    if (!thread) return jsonRes({ ok: false, error: 'Không tìm thấy hội thoại' }, 404);

    const now = new Date().toISOString();
    thread.messages.push({
      id: 'm_a_' + crypto.randomBytes(4).toString('hex'),
      sender: 'admin',
      text,
      createdAt: now,
    });
    thread.unreadByAdmin = 0;
    thread.botActive = false;
    thread.waitingForAdmin = false;
    thread.updatedAt = now;
    await saveSingleChatThread(stores, thread);
    return jsonRes({ ok: true, thread });
  }

  // 18. Consultation / VietQR order submit
  if (action === 'consultation_submit' && method === 'POST') {
    const user = getAuthUser(req, url, auth);
    const body = await parseJson(req);
    const name = String(body.name || '').trim();
    const rawPhone = String(body.phone || '').trim();
    if (!name) {
      return jsonRes({ ok: false, error: 'Vui lòng nhập họ tên của bạn.' }, 400);
    }
    const phoneCheck = validateVnPhone10(rawPhone);
    if (!phoneCheck.ok) {
      return jsonRes({ ok: false, error: phoneCheck.error }, 400);
    }
    const entry = {
      id: 'cs_' + crypto.randomBytes(5).toString('hex'),
      userId: user?.id || '',
      kind: String(body.kind || 'qr_order').slice(0, 30),
      invitationId: sanitizeId(body.invitationId || ''),
      name: name.slice(0, 100),
      phone: sanitizePhone(rawPhone),
      email: normalizeEmail(body.email || user?.email || ''),
      templateId: sanitizeId(body.templateId || ''),
      templateName: String(body.templateName || '').slice(0, 120),
      packageName: String(body.packageName || '').slice(0, 100),
      amount: Number(body.amount || 0),
      transferCode: String(body.transferCode || '').slice(0, 80),
      message: String(body.message || '').trim().slice(0, 1000),
      status: 'new',
      createdAt: new Date().toISOString(),
    };
    core.consultations.unshift(entry);
    if (entry.invitationId) {
      const inv = (core.invitations || []).find(i => i.id === entry.invitationId);
      if (inv) {
        inv.order = inv.order || {};
        if (entry.packageName) inv.order.packageName = entry.packageName;
        if (entry.amount) inv.order.price = entry.amount;
        inv.order.customerName = entry.name;
        inv.order.customerPhone = entry.phone;
        inv.order.transferCode = entry.transferCode;
        inv.order.paymentSubmittedAt = entry.createdAt;
        inv.order.lastOrderId = entry.id;
      }
    }
    await saveCore(stores, core);
    return jsonRes({ ok: true, entry });
  }

  // 19. Customer creates customizable invitation draft
  if (action === 'customer_create_invitation' && method === 'POST') {
    const user = getAuthUser(req, url, auth);
    if (!user) return jsonRes({ ok: false, error: 'Vui lòng đăng nhập để tự sửa và lưu mẫu thiệp' }, 401);
    const body = await parseJson(req);
    const tplId = sanitizeId(body.templateId || '');
    const tplObj = (core.templates || []).find(t => t.id === tplId);
    const trialDays = tplObj?.isTrialTemplate ? Number(tplObj.trialDays || 1) : (Number(body.trialDays || 0) || 0);
    const trialCfg = trialDays > 0 ? buildTrialConfigServer(trialDays) : null;
    const initContent = JSON.parse(JSON.stringify(body.content || {}));
    if (trialCfg && Array.isArray(initContent.gallery)) {
      initContent.gallery = initContent.gallery.slice(0, trialCfg.limits.maxPhotos);
    }
    const pkgs = core.settings?.packages || DEFAULT_PACKAGES_FALLBACK;
    const defaultPkg = pkgs[1] || pkgs[0];
    const now = new Date().toISOString();
    const newInv = {
      id: 'thiep-' + crypto.randomBytes(4).toString('hex'),
      clientToken: 'kh_' + crypto.randomBytes(6).toString('hex'),
      templateId: tplId || tplObj?.id || 'nhung-do-co-dien',
      templateName: tplObj?.name || String(body.templateName || 'Mẫu Thiệp Cưới').slice(0, 120),
      title: String(body.title || `${initContent.groomName || 'Chú Rể'} & ${initContent.brideName || 'Cô Dâu'}`).slice(0, 120),
      createdAt: now,
      updatedAt: now,
      trial: trialCfg,
      order: {
        userId: user.id,
        customerName: user.name || 'Khách hàng',
        customerPhone: user.phone || '',
        customerEmail: normalizeEmail(user.email),
        packageName: trialCfg ? `Dùng thử miễn phí ${trialDays} ngày` : defaultPkg.name,
        price: trialCfg ? 0 : Number(defaultPkg.price || 189000),
        status: 'trial',
        showWatermark: true,
        notes: trialCfg ? `Khách kích hoạt mẫu dùng thử ${trialDays} ngày` : 'Khách tự chọn mẫu và chỉnh sửa trực tuyến',
      },
      permissions: { allowMusicChange: !trialCfg, locked: false },
      design: tplObj?.design ? JSON.parse(JSON.stringify(tplObj.design)) : (body.design || {}),
      sections: Array.isArray(body.sections) ? body.sections : [],
      music: body.music || { trackId: 'canon-d', autoplay: true, volume: 0.65 },
      content: initContent,
      guestForm: body.guestForm || {},
      guests: [],
      rsvps: [],
      wishes: [],
    };
    core.invitations.unshift(newInv);
    await saveCore(stores, core);
    return jsonRes({ ok: true, invitation: newInv });
  }

  // 20. Get Invitation (guest / client)
  if (action === 'get_invitation' && method === 'GET') {
    const id = sanitizeId(url.searchParams.get('id') || '');
    const mode = url.searchParams.get('mode') || 'guest';
    const inv = (core.invitations || []).find(i => i.id === id);
    if (!inv) return jsonRes({ ok: false, error: 'Không tìm thấy thiệp cưới này' }, 404);

    if (mode === 'client') {
      const user = getAuthUser(req, url, auth);
      const token = req.headers.get('x-client-token') || url.searchParams.get('token') || '';
      const uEmail = normalizeEmail(user?.email);
      const uPhone = sanitizePhone(user?.phone);
      const ok = (inv.clientToken && inv.clientToken === token)
        || user?.role === 'admin'
        || (user && inv.order?.userId === user.id)
        || (uEmail && normalizeEmail(inv.order?.customerEmail) === uEmail)
        || (uPhone.length >= 9 && sanitizePhone(inv.order?.customerPhone) === uPhone);
      if (!ok) return jsonRes({ ok: false, error: 'Mã truy cập khách hàng không hợp lệ' }, 403);
      return jsonRes({ ok: true, invitation: inv, settings: core.settings || {}, templates: core.templates || [] });
    }

    const guestSafe = JSON.parse(JSON.stringify(inv));
    delete guestSafe.clientToken;
    delete guestSafe.guests;
    delete guestSafe.rsvps;
    guestSafe.order = { status: inv.order?.status || 'trial', showWatermark: Boolean(inv.order?.showWatermark) };
    guestSafe.wishes = (guestSafe.wishes || []).filter(w => !w.hidden);
    return jsonRes({ ok: true, invitation: guestSafe, settings: core.settings || {} });
  }

  // 21. Client Update Invitation
  if (action === 'client_update' && method === 'POST') {
    const id = sanitizeId(url.searchParams.get('id') || '');
    const idx = (core.invitations || []).findIndex(i => i.id === id);
    if (idx === -1) return jsonRes({ ok: false, error: 'Không tìm thấy thiệp cưới này' }, 404);
    const inv = core.invitations[idx];
    const user = getAuthUser(req, url, auth);
    const token = req.headers.get('x-client-token') || url.searchParams.get('token') || '';
    const isAdmin = user?.role === 'admin';
    const ok = isAdmin || (inv.clientToken && inv.clientToken === token) || (user && inv.order?.userId === user.id);
    if (!ok) return jsonRes({ ok: false, error: 'Không có quyền chỉnh sửa thiệp này' }, 403);

    const trialActive = !isAdmin && inv.order?.status !== 'paid' && Boolean(inv.trial?.enabled);
    const limits = trialActive ? (inv.trial?.limits || {}) : {};
    if (trialActive && inv.trial?.expiresAt && new Date(inv.trial.expiresAt).getTime() <= Date.now()) {
      return jsonRes({ ok: false, error: 'Bản dùng thử đã hết hạn — Vui lòng thanh toán mở khóa gói chính thức!' }, 403);
    }

    const body = await parseJson(req);
    if (body.title) inv.title = String(body.title).slice(0, 120);
    if (body.content && typeof body.content === 'object') {
      const nextContent = JSON.parse(JSON.stringify(body.content));
      if (trialActive) {
        const maxPhotos = Number(limits.maxPhotos || 3);
        if (Array.isArray(nextContent.gallery) && nextContent.gallery.length > maxPhotos) {
          return jsonRes({ ok: false, error: `Bản dùng thử giới hạn tối đa ${maxPhotos} ảnh Album` }, 400);
        }
        if (limits.allowGiftQr === false) nextContent.gift = inv.content?.gift;
      }
      inv.content = nextContent;
    }
    if (Array.isArray(body.sections)) inv.sections = body.sections;
    if (body.guestForm) inv.guestForm = body.guestForm;
    if (Array.isArray(body.guests) && (!trialActive || limits.allowGuestLinks !== false)) inv.guests = body.guests;
    if (Array.isArray(body.wishes)) inv.wishes = body.wishes;
    if (body.music && (!trialActive || limits.allowMusicChange)) inv.music = body.music;
    if (body.templateId) {
      const tplObj = (core.templates || []).find(t => t.id === body.templateId);
      if (tplObj) {
        inv.templateId = tplObj.id;
        inv.templateName = tplObj.name;
        inv.design = JSON.parse(JSON.stringify(tplObj.design));
      }
    }
    if (body.coverDesign && typeof body.coverDesign === 'object') {
      inv.design = inv.design || {};
      if (body.coverDesign.coverBackdrop !== undefined) inv.design.coverBackdrop = body.coverDesign.coverBackdrop;
      if (body.coverDesign.coverBlur !== undefined) inv.design.coverBlur = Number(body.coverDesign.coverBlur);
      if (body.coverDesign.coverOverlay !== undefined) inv.design.coverOverlay = Number(body.coverDesign.coverOverlay);
    }
    inv.updatedAt = new Date().toISOString();
    core.invitations[idx] = inv;
    await saveCore(stores, core);
    return jsonRes({ ok: true, invitation: inv });
  }

  // 22. Checkout Complete & Instant Product Delivery
  if (action === 'checkout_complete' && method === 'POST') {
    const id = sanitizeId(url.searchParams.get('id') || '');
    const idx = (core.invitations || []).findIndex(i => i.id === id);
    if (idx === -1) return jsonRes({ ok: false, error: 'Không tìm thấy thiệp cưới này' }, 404);
    const inv = core.invitations[idx];
    const user = getAuthUser(req, url, auth);
    const token = req.headers.get('x-client-token') || url.searchParams.get('token') || '';
    const ok = user?.role === 'admin' || (inv.clientToken && inv.clientToken === token) || (user && inv.order?.userId === user.id);
    if (!ok) return jsonRes({ ok: false, error: 'Không có quyền xác nhận đơn này' }, 403);

    const body = await parseJson(req);
    const name = String(body.name || user?.name || 'Khách hàng').trim();
    const rawPhone = String(body.phone || user?.phone || '').trim();
    const phoneCheck = validateVnPhone10(rawPhone);
    if (!phoneCheck.ok) {
      return jsonRes({ ok: false, error: phoneCheck.error }, 400);
    }

    const { orderEntry } = finalizeInvitationDelivery(core, inv, {
      userId: user?.id || inv.order?.userId || '',
      email: body.email || user?.email || inv.order?.customerEmail || '',
      name,
      phone: phoneCheck.digits,
      packageId: body.packageId || '',
      packageName: body.packageName || '',
      amount: body.amount || 0,
      transferCode: body.transferCode || `THIEP ${id.toUpperCase()}`,
      message: body.message || 'Khách đã chuyển tiền VietQR và nhận sản phẩm ngay',
      gateway: 'manual-direct',
    });
    core.invitations[idx] = inv;
    await saveCore(stores, core);
    return jsonRes({ ok: true, invitation: inv, order: orderEntry });
  }

  // 22b. Auto-Payment: Create VietQR Payment Order (supports existing invitation OR instant new draft from Showroom!)
  if (action === 'payment_create' && method === 'POST') {
    const user = getAuthUser(req, url, auth);
    const body = await parseJson(req);
    const name = String(body.name || user?.name || '').trim();
    const rawPhone = String(body.phone || user?.phone || '').trim();
    if (!name) return jsonRes({ ok: false, error: 'Vui lòng nhập họ và tên của bạn.' }, 400);
    const phoneCheck = validateVnPhone10(rawPhone);
    if (!phoneCheck.ok) return jsonRes({ ok: false, error: phoneCheck.error }, 400);

    const pkgs = core.settings?.packages || DEFAULT_PACKAGES_FALLBACK;
    const matchedPkg = pkgs.find(p => p.id === body.packageId || p.name === body.packageName) || pkgs[1] || pkgs[0];
    const amount = Number(matchedPkg?.price || body.amount || 189000);

    let inv = null;
    let invIdx = -1;
    const reqInvId = sanitizeId(body.invitationId || '');
    const clientToken = req.headers.get('x-client-token') || String(body.clientToken || '').trim();

    if (reqInvId) {
      invIdx = (core.invitations || []).findIndex(i => i.id === reqInvId);
      if (invIdx === -1) return jsonRes({ ok: false, error: 'Không tìm thấy thiệp cưới này.' }, 404);
      const cand = core.invitations[invIdx];
      const allowed = user?.role === 'admin'
        || (cand.clientToken && cand.clientToken === clientToken)
        || (user && cand.order?.userId === user.id);
      if (!allowed) return jsonRes({ ok: false, error: 'Không có quyền thanh toán cho mẫu thiệp này.' }, 403);
      inv = cand;
    } else {
      // Guest or logged-in customer paying directly from Showroom -> auto-create invitation draft!
      const tplId = sanitizeId(body.templateId || '');
      const tplObj = (core.templates || []).find(t => t.id === tplId) || (core.templates || [])[0] || null;
      const now = new Date().toISOString();
      inv = {
        id: 'thiep-' + crypto.randomBytes(4).toString('hex'),
        clientToken: 'kh_' + crypto.randomBytes(6).toString('hex'),
        templateId: tplObj?.id || tplId || 'nhung-do-co-dien',
        templateName: tplObj?.name || String(body.templateName || 'Mẫu Thiệp Cưới').slice(0, 120),
        title: String(body.title || `Thiệp Cưới — ${name}`).slice(0, 120),
        createdAt: now,
        updatedAt: now,
        trial: null,
        order: {
          userId: user?.id || '',
          customerName: name.slice(0, 100),
          customerPhone: phoneCheck.digits,
          customerEmail: normalizeEmail(body.email || user?.email || ''),
          packageId: matchedPkg?.id || '',
          packageName: matchedPkg?.name || 'Gói Tiêu Chuẩn',
          price: amount,
          status: 'pending_payment',
          showWatermark: true,
          notes: String(body.note || 'Đơn thanh toán VietQR tự động').slice(0, 400),
        },
        permissions: { allowMusicChange: true, locked: false },
        design: tplObj?.design ? JSON.parse(JSON.stringify(tplObj.design)) : (body.design || {}),
        sections: Array.isArray(body.sections) ? body.sections : [],
        music: body.music || { trackId: 'canon-d', autoplay: true, volume: 0.65 },
        content: body.content && typeof body.content === 'object' ? body.content : {},
        guestForm: body.guestForm && typeof body.guestForm === 'object' ? body.guestForm : {},
        guests: [],
        rsvps: [],
        wishes: [],
      };
      core.invitations.unshift(inv);
      invIdx = 0;
    }

    const nowMs = Date.now();
    const code = 'LAMOUR' + crypto.randomBytes(3).toString('hex').toUpperCase();
    const payment = {
      code,
      invitationId: inv.id,
      clientToken: inv.clientToken,
      userId: user?.id || inv.order?.userId || '',
      name: name.slice(0, 100),
      phone: phoneCheck.digits,
      email: normalizeEmail(body.email || user?.email || inv.order?.customerEmail || ''),
      templateId: inv.templateId || '',
      templateName: inv.templateName || inv.title || '',
      packageId: matchedPkg?.id || '',
      packageName: matchedPkg?.name || 'Gói Tiêu Chuẩn',
      amount,
      note: String(body.note || '').trim().slice(0, 400),
      bankCode: core.settings?.paymentBankCode || 'MB',
      bankName: core.settings?.paymentBankName || 'MB Bank — Ngân hàng Quân Đội',
      accountNo: String(core.settings?.paymentAccountNo || '0354248177').replace(/\s+/g, ''),
      accountName: String(core.settings?.paymentAccountName || '').trim(),
      status: inv.order?.status === 'paid' ? 'paid' : 'pending',
      createdAt: new Date(nowMs).toISOString(),
      expiresAt: new Date(nowMs + 15 * 60 * 1000).toISOString(),
      paidAt: inv.order?.paidAt || '',
      bankRef: inv.order?.bankRef || '',
      gateway: inv.order?.paymentGateway || '',
    };

    inv.order = {
      ...(inv.order || {}),
      customerName: payment.name,
      customerPhone: payment.phone,
      customerEmail: payment.email || inv.order?.customerEmail || '',
      packageId: payment.packageId,
      packageName: payment.packageName,
      price: payment.amount,
      transferCode: code,
    };
    core.invitations[invIdx] = inv;
    await Promise.all([saveCore(stores, core), saveSinglePaymentOrder(stores, payment)]);

    return jsonRes({
      ok: true,
      payment,
      invitationId: inv.id,
      clientToken: inv.clientToken,
      webhookActive: isBankWebhookConfigured(core),
    });
  }

  // 22c. Auto-Payment: Poll Payment Status (every 3s from QR Payment Page -> triggers automatic redirect to Handover Page!)
  if (action === 'payment_status' && method === 'GET') {
    const code = sanitizeId(String(url.searchParams.get('code') || '').toUpperCase());
    if (!code) return jsonRes({ ok: false, error: 'Thiếu mã đơn thanh toán' }, 400);
    const payment = await getSinglePaymentOrder(stores, code);
    if (!payment) return jsonRes({ ok: false, error: 'Không tìm thấy đơn thanh toán này' }, 404);

    const inv = (core.invitations || []).find(i => i.id === payment.invitationId) || null;
    let status = payment.status || 'pending';
    if (inv && inv.order?.status === 'paid' && status !== 'paid') {
      status = 'paid';
      payment.status = 'paid';
      payment.paidAt = inv.order.paidAt || new Date().toISOString();
      await saveSinglePaymentOrder(stores, payment);
    } else if (status === 'pending' && payment.expiresAt && Date.now() > Date.parse(payment.expiresAt)) {
      status = 'expired';
    }

    return jsonRes({
      ok: true,
      status,
      payment,
      invitationId: payment.invitationId,
      clientToken: status === 'paid' ? (inv?.clientToken || payment.clientToken) : '',
      invitation: status === 'paid' ? inv : null,
      webhookActive: isBankWebhookConfigured(core),
    });
  }

  // 22d. Auto-Payment: Real Bank Transfer Notification Webhook (SePay / Casso / PayOS -> auto-unlocks invitation with ZERO admin action!)
  if ((action === 'payment_webhook' || action === 'sepay_webhook' || action === 'casso_webhook' || action === 'payos_webhook') && method === 'POST') {
    const body = await parseJson(req);
    const authRes = verifyWebhookAuth(req, url, body, core);
    if (!authRes.ok) {
      return jsonRes({ success: false, ok: false, error: authRes.reason }, 401);
    }

    const txList = parseIncomingBankTransactions(body);
    const matched = [];
    let coreDirty = false;

    for (const tx of txList) {
      const code = extractPaymentCodeFromText(tx.content);
      if (!code) continue;
      const payment = await getSinglePaymentOrder(stores, code);
      if (!payment) continue;

      if (tx.amount < Number(payment.amount || 0)) {
        payment.underpaidAmount = tx.amount;
        payment.lastBankRef = tx.ref;
        await saveSinglePaymentOrder(stores, payment);
        matched.push({ code, status: 'underpaid', received: tx.amount, expected: payment.amount });
        continue;
      }

      const now = new Date().toISOString();
      payment.status = 'paid';
      payment.paidAt = payment.paidAt || now;
      payment.paidAmount = tx.amount;
      payment.bankRef = tx.ref || payment.bankRef || ('TX_' + crypto.randomBytes(4).toString('hex').toUpperCase());
      payment.gateway = tx.gateway || 'BankWebhook';

      const invIdx = (core.invitations || []).findIndex(i => i.id === payment.invitationId);
      if (invIdx !== -1) {
        finalizeInvitationDelivery(core, core.invitations[invIdx], {
          userId: payment.userId,
          email: payment.email,
          name: payment.name,
          phone: payment.phone,
          packageId: payment.packageId,
          packageName: payment.packageName,
          amount: payment.amount,
          transferCode: payment.code,
          bankRef: payment.bankRef,
          gateway: payment.gateway,
          message: `Ngân hàng ${payment.gateway} xác nhận đã nhận ${tx.amount.toLocaleString('vi-VN')}đ (Mã GD: ${payment.bankRef})`,
        });
        coreDirty = true;
      }
      await saveSinglePaymentOrder(stores, payment);
      matched.push({ code, status: 'paid', invitationId: payment.invitationId, amount: tx.amount, bankRef: payment.bankRef });
    }

    if (coreDirty) await saveCore(stores, core);
    return jsonRes({ success: true, ok: true, processed: txList.length, matched }, 200);
  }

  // 22e. Auto-Payment Fallback / Admin Webhook Test (STRICTLY BLOCKED for customers when real Bank Webhook is active!)
  if (action === 'payment_confirm_demo' && method === 'POST') {
    const user = getAuthUser(req, url, auth);
    const body = await parseJson(req);
    const code = sanitizeId(String(body.code || '').toUpperCase());
    if (!code) return jsonRes({ ok: false, error: 'Thiếu mã giao dịch' }, 400);

    const payment = await getSinglePaymentOrder(stores, code);
    if (!payment) return jsonRes({ ok: false, error: 'Không tìm thấy đơn thanh toán' }, 404);

    const webhookOn = isBankWebhookConfigured(core);
    const isAdmin = user?.role === 'admin';
    if (webhookOn && !isAdmin) {
      return jsonRes({
        ok: false,
        error: 'Hệ thống đang bật xác minh tự động từ ngân hàng MB Bank. Vui lòng chuyển khoản đúng mã QR — hệ thống tự bàn giao ngay sau 3–5 giây khi nhận được tiền.',
      }, 403);
    }

    const token = req.headers.get('x-client-token') || String(body.clientToken || '').trim();
    const allowed = isAdmin || (payment.clientToken && payment.clientToken === token) || (user && payment.userId === user.id);
    if (!allowed) return jsonRes({ ok: false, error: 'Không có quyền xác nhận đơn này' }, 403);

    const now = new Date().toISOString();
    payment.status = 'paid';
    payment.paidAt = payment.paidAt || now;
    payment.paidAmount = payment.amount;
    payment.bankRef = isAdmin ? 'ADMIN_TEST_' + crypto.randomBytes(3).toString('hex').toUpperCase() : 'DIRECT_QR_' + crypto.randomBytes(3).toString('hex').toUpperCase();
    payment.gateway = isAdmin ? 'Admin-Test-Webhook' : 'Direct-QR-SelfConfirm';

    const invIdx = (core.invitations || []).findIndex(i => i.id === payment.invitationId);
    let inv = null;
    if (invIdx !== -1) {
      finalizeInvitationDelivery(core, core.invitations[invIdx], {
        userId: payment.userId,
        email: payment.email,
        name: payment.name,
        phone: payment.phone,
        packageId: payment.packageId,
        packageName: payment.packageName,
        amount: payment.amount,
        transferCode: payment.code,
        bankRef: payment.bankRef,
        gateway: payment.gateway,
        message: isAdmin ? 'Admin kiểm thử luồng bàn giao thanh toán tự động' : 'Khách chuyển khoản trực tiếp VietQR MB Bank (chưa bật Webhook tự động)',
      });
      inv = core.invitations[invIdx];
      await saveCore(stores, core);
    }
    await saveSinglePaymentOrder(stores, payment);
    return jsonRes({ ok: true, status: 'paid', payment, invitation: inv, clientToken: inv?.clientToken || payment.clientToken });
  }

  // 23. Guest RSVP / Wish submit
  if (action === 'guest_submit' && method === 'POST') {
    const id = sanitizeId(url.searchParams.get('id') || '');
    const idx = (core.invitations || []).findIndex(i => i.id === id);
    if (idx === -1) return jsonRes({ ok: false, error: 'Không tìm thấy thiệp' }, 404);
    const inv = core.invitations[idx];
    const body = await parseJson(req);
    const submitType = String(body.type || body.kind || 'wish');
    const now = new Date().toISOString();

    if (submitType === 'rsvp' || submitType === 'both') {
      const entry = {
        id: 'rsvp_' + crypto.randomBytes(4).toString('hex'),
        ...body,
        guestName: String(body.guestName || body.name || '').trim().slice(0, 100),
        side: String(body.side || 'Cả hai bên').slice(0, 40),
        attending: String(body.attending || 'yes').slice(0, 20),
        guestsCount: Math.max(1, Math.min(20, Number(body.guestsCount || 1))),
        phone: sanitizePhone(body.phone || ''),
        note: String(body.note || '').trim().slice(0, 500),
        createdAt: now,
      };
      inv.rsvps = inv.rsvps || [];
      inv.rsvps.unshift(entry);
    }

    let createdWish = null;
    const wishText = String(body.wish || body.message || '').trim().slice(0, 600);
    if (wishText) {
      createdWish = {
        id: 'w_' + crypto.randomBytes(4).toString('hex'),
        name: String(body.name || body.guestName || 'Khách mời').trim().slice(0, 80),
        relation: String(body.relation || 'Khách mời').trim().slice(0, 60),
        message: wishText,
        hidden: false,
        createdAt: now,
      };
      inv.wishes = inv.wishes || [];
      inv.wishes.unshift(createdWish);
    } else if (submitType === 'wish') {
      return jsonRes({ ok: false, error: 'Vui lòng nhập lời chúc' }, 400);
    }

    await saveCore(stores, core);
    return jsonRes({ ok: true, wish: createdWish, savedAt: now });
  }

  // 24. Upload Media to Cloud Storage (photos & custom audio, strict safe MIME allowlist)
  if ((action === 'upload' || action === 'upload_media') && method === 'POST') {
    const user = getAuthUser(req, url, auth);
    const invId = sanitizeId(url.searchParams.get('id') || '');
    const clientToken = req.headers.get('x-client-token') || '';
    const inv = (core.invitations || []).find(i => i.id === invId);
    const allowed = user?.role === 'admin' || (inv && inv.clientToken === clientToken) || (user && inv?.order?.userId === user.id);
    if (!allowed) return jsonRes({ ok: false, error: 'Không có quyền tải ảnh lên' }, 403);

    const form = await req.formData();
    const file = form.get('file');
    if (!file || typeof file.arrayBuffer !== 'function') {
      return jsonRes({ ok: false, error: 'Thiếu tệp tải lên' }, 400);
    }
    const rawMime = String(file.type || 'image/jpeg').split(';')[0].trim().toLowerCase();
    const ALLOWED_UPLOAD_MIMES = new Set([
      'image/jpeg',
      'image/jpg',
      'image/png',
      'image/webp',
      'image/gif',
      'image/avif',
      'audio/mpeg',
      'audio/mp3',
      'audio/mp4',
      'audio/ogg',
      'audio/wav',
      'audio/webm',
      'audio/aac',
      'audio/x-m4a',
      'audio/flac',
    ]);
    if (!ALLOWED_UPLOAD_MIMES.has(rawMime)) {
      return jsonRes({ ok: false, error: 'Định dạng tệp không được hỗ trợ (chỉ nhận ảnh JPG/PNG/WebP/GIF/AVIF hoặc nhạc MP3/M4A/WAV/OGG).' }, 400);
    }
    const mime = rawMime === 'image/jpg' ? 'image/jpeg' : rawMime;
    const buf = await file.arrayBuffer();
    if (buf.byteLength > 4.2 * 1024 * 1024) {
      return jsonRes({ ok: false, error: 'Ảnh vượt quá giới hạn 4MB' }, 400);
    }
    const key = 'med_' + crypto.randomBytes(8).toString('hex');
    await stores.mediaStore.set(key, buf, { metadata: { mime, invId } });
    return jsonRes({ ok: true, url: `/api?action=media&key=${key}` });
  }

  return jsonRes({ ok: false, error: 'Unknown API action' }, 404);
}

export async function handleApiRequest(req, opts = {}) {
  const cors = buildCorsHeaders(req);
  try {
    const res = await routeApiRequest(req, opts);
    return withCorsHeaders(res, cors);
  } catch (err) {
    return jsonRes({ ok: false, error: err?.message || 'Internal Server Error' }, 500, cors);
  }
}
