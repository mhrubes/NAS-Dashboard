// Domaci rozcestnik: staticka stranka + male API pro uprave seznamu aplikaci (bez zavislosti).
// Cteni je verejne (v siti), uprava vyzaduje prihlaseni (scrypt hash hesla v .env).
const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { scryptSync, timingSafeEqual, createHmac } = require('crypto');

const PORT = parseInt(process.env.PORT, 10) || 3000;
const DATA_DIR = path.resolve(process.env.DATA_DIR || './data');
const DATA_FILE = path.join(DATA_DIR, 'apps.json');
const SEED_FILE = path.join(__dirname, 'seed', 'apps.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const COOKIE_SECURE = process.env.COOKIE_SECURE === 'true';
const TRUST_PROXY = process.env.TRUST_PROXY === 'true';
const SESSION_MS = 12 * 60 * 60 * 1000;
const MAX_APPS = 100;
const MAX_BODY = 128 * 1024;

// --- konfigurace hesla (fail-fast, bez fallbacku) ---
const [salt, hash] = (process.env.APP_PASSWORD_HASH || '').split(':');
const secret = process.env.SESSION_SECRET;
if (!salt || !hash || !secret) {
  console.error('Chybi APP_PASSWORD_HASH (salt:hash) nebo SESSION_SECRET v .env');
  process.exit(1);
}
const hashBuf = Buffer.from(hash, 'hex');

const safeEqual = (a, b) => a.length === b.length && timingSafeEqual(a, b);
const checkPassword = (pw) => safeEqual(scryptSync(String(pw ?? ''), salt, hashBuf.length), hashBuf);
const sign = (exp) => createHmac('sha256', secret).update(String(exp)).digest('hex');
const signToken = () => { const exp = Date.now() + SESSION_MS; return `${exp}.${sign(exp)}`; };
function verifyToken(token) {
  const [exp, sig] = String(token ?? '').split('.');
  if (!exp || !sig || !(Number(exp) > Date.now())) return false;
  return safeEqual(Buffer.from(sig), Buffer.from(sign(exp)));
}

// --- pomocne ---
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function sendJson(res, status, obj, extraHeaders = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extraHeaders });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new HttpError(413, 'Požadavek je příliš velký')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJson(req) {
  if (!/^application\/json/i.test(req.headers['content-type'] || '')) throw new HttpError(415, 'Očekáván JSON');
  try { return JSON.parse(await readBody(req)); } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(400, 'Neplatný JSON');
  }
}

const clientIp = (req) => (TRUST_PROXY && req.headers['x-forwarded-for']
  ? String(req.headers['x-forwarded-for']).split(',')[0].trim()
  : req.socket.remoteAddress) || 'unknown';

function isAuthed(req) {
  const m = /(?:^|;\s*)auth=([^;]+)/.exec(req.headers.cookie || '');
  return !!m && verifyToken(m[1]);
}
function requireAuth(req) {
  if (!isAuthed(req)) throw new HttpError(401, 'Nepřihlášen');
}

// --- validace dat ---
function checkString(v, label, max, { required = false } = {}) {
  if (v === undefined || v === null) v = '';
  if (typeof v !== 'string') throw new HttpError(400, `${label}: musí být text`);
  const s = v.trim();
  if (required && !s) throw new HttpError(400, `${label} je povinné`);
  if (s.length > max) throw new HttpError(400, `${label}: maximálně ${max} znaků`);
  return s;
}

function validateData(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) throw new HttpError(400, 'Neplatná data');
  if (!Array.isArray(d.apps)) throw new HttpError(400, 'Chybí seznam aplikací');
  if (d.apps.length > MAX_APPS) throw new HttpError(400, `Maximálně ${MAX_APPS} aplikací`);

  const apps = d.apps.map((a) => {
    if (!a || typeof a !== 'object') throw new HttpError(400, 'Neplatná aplikace');
    const url = checkString(a.url, 'URL', 300, { required: true });
    if (!/^https?:\/\//i.test(url)) throw new HttpError(400, 'URL musí začínat http:// nebo https://');
    try { new URL(url.split('{host}').join('example')); } catch { throw new HttpError(400, 'URL není platná'); }
    return {
      name: checkString(a.name, 'Název', 60, { required: true }),
      description: checkString(a.description, 'Popis', 300),
      url,
      icon: checkString(a.icon, 'Ikona', 8),
      group: checkString(a.group, 'Skupina', 40),
      check: a.check !== false,
    };
  });

  return {
    title: checkString(d.title, 'Nadpis', 100) || 'Domácí rozcestník',
    subtitle: checkString(d.subtitle, 'Podnadpis', 200),
    apps,
  };
}

// --- uloziste ---
async function ensureData() {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  try { await fsp.access(DATA_FILE); } catch { await fsp.copyFile(SEED_FILE, DATA_FILE); }
}

async function writeData(data) {
  const tmp = `${DATA_FILE}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await fsp.rename(tmp, DATA_FILE);
}

// --- prihlaseni, omezeni pokusu ---
const attempts = new Map();
const MAX_ATTEMPTS = 5;
const BLOCK_MS = 15 * 60 * 1000;

// --- API ---
async function handleApi(req, res, p) {
  const method = req.method;

  if (p === '/api/health' && method === 'GET') return sendJson(res, 200, { ok: true });

  if (p === '/api/apps' && method === 'GET') {
    return sendJson(res, 200, JSON.parse(await fsp.readFile(DATA_FILE, 'utf8')));
  }

  if (p === '/api/me' && method === 'GET') {
    requireAuth(req);
    return sendJson(res, 200, { ok: true });
  }

  if (p === '/api/login' && method === 'POST') {
    const ip = clientIp(req);
    const rec = attempts.get(ip);
    const blocked = rec && rec.n >= MAX_ATTEMPTS && Date.now() - rec.t < BLOCK_MS;
    if (blocked) throw new HttpError(429, 'Příliš mnoho pokusů, zkus to později');
    const body = await readJson(req);
    if (!checkPassword(body && body.password)) {
      const n = (rec && Date.now() - rec.t < BLOCK_MS ? rec.n : 0) + 1;
      attempts.set(ip, { n, t: Date.now() });
      throw new HttpError(401, 'Špatné heslo');
    }
    attempts.delete(ip);
    const cookie = `auth=${signToken()}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}${COOKIE_SECURE ? '; Secure' : ''}`;
    return sendJson(res, 200, { ok: true }, { 'Set-Cookie': cookie });
  }

  if (p === '/api/logout' && method === 'POST') {
    return sendJson(res, 200, { ok: true }, { 'Set-Cookie': 'auth=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
  }

  if (p === '/api/apps' && method === 'PUT') {
    requireAuth(req);
    const data = validateData(await readJson(req));
    await writeData(data);
    return sendJson(res, 200, data);
  }

  throw new HttpError(404, 'Nenalezeno');
}

// --- staticke soubory ---
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8',
};

async function serveStatic(req, res, p) {
  const rel = p === '/' ? 'index.html' : decodeURIComponent(p).replace(/^\/+/, '');
  const full = path.resolve(PUBLIC_DIR, rel);
  if (!full.startsWith(PUBLIC_DIR + path.sep)) throw new HttpError(404, 'Nenalezeno');
  let st;
  try { st = await fsp.stat(full); } catch { throw new HttpError(404, 'Nenalezeno'); }
  if (!st.isFile()) throw new HttpError(404, 'Nenalezeno');
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream',
    'Content-Length': st.size,
    'Cache-Control': 'no-cache',
  });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(full).pipe(res);
}

const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src *; img-src 'self' data:; frame-ancestors 'none'");
  try {
    const p = new URL(req.url, 'http://localhost').pathname;
    if (p.startsWith('/api/')) return await handleApi(req, res, p);
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Metoda není povolena');
    return await serveStatic(req, res, p);
  } catch (err) {
    if (res.headersSent) return res.destroy();
    const status = err instanceof HttpError ? err.status : (err instanceof URIError ? 400 : 500);
    if (status === 500) console.error('Request failed: ', err);
    sendJson(res, status, { error: status === 500 ? 'Interní chyba serveru' : err.message });
  }
});

ensureData().then(() => {
  server.listen(PORT, () => console.log(`nas-dashboard listening on :${PORT}, data ${DATA_DIR}`));
}).catch((err) => {
  console.error('Startup failed: ', err);
  process.exit(1);
});
