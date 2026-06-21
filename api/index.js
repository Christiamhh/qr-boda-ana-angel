import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import {
  MOMENTS,
  LIMITS,
  COUPLE,
  isValidMoment,
  GALLERY_PASSWORD,
  SESSION_SECRET,
  PUBLIC_BASE_URL,
} from '../lib/config.js';
import {
  presignPut,
  presignGet,
  objectExists,
  storageMode,
  localBlobPath,
  ensureLocalBlobDir,
} from '../lib/storage.js';
import {
  isLocked,
  startRoll,
  getRollState,
  getUpload,
  countFiles,
  addFile,
  finishRoll,
  listByMoment,
} from '../lib/db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const IS_HTTPS = PUBLIC_BASE_URL.startsWith('https');

const app = express();
app.use('/static', express.static(PUBLIC));

// ─────────────────────────────────────────────────────────────────────
// Utilidades
// ─────────────────────────────────────────────────────────────────────
function renderTemplate(file, replacements = {}) {
  let html = fs.readFileSync(path.join(PUBLIC, file), 'utf8');
  for (const [k, v] of Object.entries(replacements)) {
    html = html.split(`{{${k}}}`).join(v);
  }
  return html;
}

function sanitizeFilename(name = 'archivo') {
  const base = String(name).normalize('NFKD').replace(/[^\w.\- ]+/g, '').trim();
  return base.slice(0, 60) || 'archivo';
}

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie;
  if (!raw) return out;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > -1) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function makeSessionToken(hours = 24) {
  const exp = Date.now() + hours * 3600 * 1000;
  const payload = String(exp);
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('hex');
  return `${payload}.${sig}`;
}

function verifySessionToken(token) {
  if (!token || !token.includes('.')) return false;
  const [payload, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('hex');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  return Number(payload) > Date.now();
}

function requireGalleryAuth(req, res, next) {
  const token = parseCookies(req).galeria;
  if (verifySessionToken(token)) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'no-auth' });
  return res.redirect('/galeria');
}

// ─────────────────────────────────────────────────────────────────────
// Páginas de invitado (un QR / momento)
// ─────────────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.type('html').send(renderTemplate('inicio.html'));
});

for (const slug of Object.keys(MOMENTS)) {
  app.get(`/${slug}`, (req, res) => {
    res.type('html').send(
      renderTemplate('subir.html', {
        MOMENTO: slug,
        MOMENTO_LABEL: MOMENTS[slug].label,
      })
    );
  });
}

// ─────────────────────────────────────────────────────────────────────
// API de subida
// ─────────────────────────────────────────────────────────────────────
app.get('/api/status', async (req, res) => {
  try {
    const { deviceId, momento } = req.query;
    if (!isValidMoment(momento) || !deviceId) return res.status(400).json({ error: 'bad-request' });
    const st = await getRollState(String(deviceId), String(momento));
    if (st.state === 'in_progress') {
      const photosLeft = LIMITS.maxPhotos - st.photosUsed;
      const videosLeft = LIMITS.maxVideos - st.videosUsed;
      if (photosLeft <= 0 && videosLeft <= 0) st.state = 'done';
    }
    res.json(Object.assign({ limits: LIMITS }, st));
  } catch (e) {
    console.error('status', e);
    res.status(500).json({ error: 'server' });
  }
});

// Inicia el rollo: reserva el uso único del dispositivo y crea la subida.
app.post('/api/roll/start', express.json({ limit: '64kb' }), async (req, res) => {
  try {
    const { momento, deviceId, name, message } = req.body || {};
    if (!isValidMoment(momento)) return res.status(400).json({ error: 'momento-invalido' });
    if (!deviceId || typeof deviceId !== 'string') return res.status(400).json({ error: 'device' });
    const cleanName = String(name || '').trim();
    if (cleanName.length < 1 || cleanName.length > 80) return res.status(400).json({ error: 'nombre' });
    const cleanMsg = String(message || '').trim().slice(0, 500);
    const result = await startRoll({ momento, deviceId, name: cleanName, message: cleanMsg });
    if (result.locked) return res.status(409).json({ error: 'ya-subio' });
    res.json({ uploadId: result.uploadId, limits: LIMITS });
  } catch (e) {
    console.error('roll-start', e);
    res.status(500).json({ error: 'server' });
  }
});

// Valida que el rollo exista y pertenezca a este dispositivo (y momento).
async function ownRoll(req) {
  const { uploadId, deviceId, momento } = req.body || {};
  if (!uploadId || !deviceId) return null;
  const up = await getUpload(uploadId);
  if (!up || up.device_id !== deviceId) return null;
  if (momento && up.momento !== momento) return null;
  return up;
}

// Pide una URL prefirmada para un disparo (una foto o un video).
app.post('/api/roll/presign', express.json({ limit: '64kb' }), async (req, res) => {
  try {
    const { kind, filename, contentType, size } = req.body || {};
    const up = await ownRoll(req);
    if (!up) return res.status(403).json({ error: 'no-autorizado' });
    if (kind !== 'photo' && kind !== 'video') return res.status(400).json({ error: 'kind' });
    const max = kind === 'video' ? LIMITS.maxVideos : LIMITS.maxPhotos;
    const maxBytes = kind === 'video' ? LIMITS.maxVideoBytes : LIMITS.maxPhotoBytes;
    if (typeof size === 'number' && size > maxBytes) return res.status(400).json({ error: 'archivo-grande' });
    const count = await countFiles(up.id, kind);
    if (count >= max) return res.status(409).json({ error: 'limite' });
    const folder = MOMENTS[up.momento].folder;
    const rand = crypto.randomBytes(3).toString('hex');
    const key = `${folder}/${up.id}/${kind}-${String(count).padStart(2, '0')}-${rand}-${sanitizeFilename(filename)}`;
    const url = await presignPut(key, contentType || 'application/octet-stream');
    res.json({ key, url, storageMode });
  } catch (e) {
    console.error('roll-presign', e);
    res.status(500).json({ error: 'server' });
  }
});

// Confirma que el disparo se subió y lo registra.
app.post('/api/roll/confirm', express.json({ limit: '64kb' }), async (req, res) => {
  try {
    const { key, kind, filename, size, contentType } = req.body || {};
    const up = await ownRoll(req);
    if (!up) return res.status(403).json({ error: 'no-autorizado' });
    if (!key || (kind !== 'photo' && kind !== 'video')) return res.status(400).json({ error: 'bad-request' });
    if (!(await objectExists(key))) return res.status(400).json({ error: 'sin-confirmar' });
    await addFile({ uploadId: up.id, kind, key, filename, size, contentType });
    const count = await countFiles(up.id, kind);
    res.json({ ok: true, count });
  } catch (e) {
    console.error('roll-confirm', e);
    res.status(500).json({ error: 'server' });
  }
});

// Cierra el rollo (sello de tiempo). Opcional.
app.post('/api/roll/finish', express.json({ limit: '64kb' }), async (req, res) => {
  try {
    const up = await ownRoll(req);
    if (!up) return res.status(403).json({ error: 'no-autorizado' });
    await finishRoll(up.id);
    res.json({ ok: true });
  } catch (e) {
    console.error('roll-finish', e);
    res.status(500).json({ error: 'server' });
  }
});

// ─── Almacenamiento local (solo desarrollo, sin R2) ──────────────────
if (storageMode === 'local') {
  app.put('/api/local-blob/:key', express.raw({ type: '*/*', limit: '200mb' }), (req, res) => {
    try {
      const key = decodeURIComponent(req.params.key);
      const full = ensureLocalBlobDir(key);
      fs.writeFileSync(full, req.body);
      res.json({ ok: true });
    } catch (e) {
      console.error('local-put', e);
      res.status(500).json({ error: 'server' });
    }
  });
  app.get('/api/local-blob/:key', (req, res) => {
    const key = decodeURIComponent(req.params.key);
    const full = localBlobPath(key);
    if (!fs.existsSync(full)) return res.status(404).end();
    res.sendFile(full);
  });
}

// ─────────────────────────────────────────────────────────────────────
// Galería privada de los novios
// ─────────────────────────────────────────────────────────────────────
app.get('/galeria', (req, res) => {
  const token = parseCookies(req).galeria;
  if (verifySessionToken(token)) return res.type('html').send(renderTemplate('galeria.html'));
  res.type('html').send(renderTemplate('login.html', { ERROR: '' }));
});

app.post('/galeria/login', express.urlencoded({ extended: false }), (req, res) => {
  const pass = (req.body && req.body.password) || '';
  if (pass === GALLERY_PASSWORD) {
    const secure = IS_HTTPS ? ' Secure;' : '';
    res.setHeader(
      'Set-Cookie',
      `galeria=${makeSessionToken(24)}; HttpOnly; Path=/; Max-Age=86400; SameSite=Lax;${secure}`
    );
    return res.redirect('/galeria');
  }
  res.type('html').send(renderTemplate('login.html', { ERROR: 'Contraseña incorrecta' }));
});

app.post('/galeria/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'galeria=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax;');
  res.redirect('/galeria');
});

app.get('/api/admin/gallery', requireGalleryAuth, async (req, res) => {
  try {
    const momento = String(req.query.momento || '');
    if (!isValidMoment(momento)) return res.status(400).json({ error: 'momento' });
    const uploads = await listByMoment(momento);
    for (const u of uploads) {
      for (const f of u.files) {
        f.url = await presignGet(f.r2_key);
        f.downloadUrl = await presignGet(f.r2_key, f.original_name || 'recuerdo');
      }
    }
    res.json({ momento, uploads });
  } catch (e) {
    console.error('admin-gallery', e);
    res.status(500).json({ error: 'server' });
  }
});

app.get('/qr', requireGalleryAuth, (req, res) => {
  res.type('html').send(
    renderTemplate('qr.html', {
      BASE: PUBLIC_BASE_URL,
      BRIDE: COUPLE.bride,
      GROOM: COUPLE.groom,
    })
  );
});

export default app;
