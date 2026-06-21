import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { handleUpload } from '@vercel/blob/client';

import {
  MOMENTS,
  LIMITS,
  COUPLE,
  isValidMoment,
  GALLERY_PASSWORD,
  SESSION_SECRET,
} from '../lib/config.js';
import {
  getRollState,
  startRoll,
  addFile,
  countFiles,
  finishRoll,
  listByMoment,
} from '../lib/db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');

const app = express();
app.set('trust proxy', true);
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

function baseUrl(req) {
  const host = req.get('host') || '';
  const proto = host.includes('localhost') ? 'http' : 'https';
  return `${proto}://${host}`;
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
// API del rollo
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

// Inicia (o reanuda) el rollo del dispositivo para ese momento.
app.post('/api/roll/start', express.json({ limit: '64kb' }), async (req, res) => {
  try {
    const { momento, deviceId, name, message } = req.body || {};
    if (!isValidMoment(momento)) return res.status(400).json({ error: 'momento-invalido' });
    if (!deviceId || typeof deviceId !== 'string') return res.status(400).json({ error: 'device' });
    const cleanName = String(name || '').trim();
    if (cleanName.length < 1 || cleanName.length > 80) return res.status(400).json({ error: 'nombre' });
    const cleanMsg = String(message || '').trim().slice(0, 500);
    const result = await startRoll({ momento, deviceId, name: cleanName, message: cleanMsg });
    res.json({ uploadId: result.uploadId, resumed: !!result.resumed, limits: LIMITS });
  } catch (e) {
    console.error('roll-start', e);
    res.status(500).json({ error: 'server' });
  }
});

// Genera el token para subir un archivo DIRECTO a Vercel Blob (sin pasar por el
// límite de 4.5 MB de la función). Valida cupo y que el rollo exista.
app.post('/api/blob/upload', express.json({ limit: '1mb' }), async (req, res) => {
  try {
    const jsonResponse = await handleUpload({
      body: req.body,
      request: req,
      onBeforeGenerateToken: async (pathname, clientPayload) => {
        let p = {};
        try { p = JSON.parse(clientPayload || '{}'); } catch {}
        const { momento, deviceId, kind } = p;
        if (!isValidMoment(momento) || !deviceId || (kind !== 'photo' && kind !== 'video')) {
          throw new Error('payload-invalido');
        }
        const st = await getRollState(deviceId, momento);
        if (st.state === 'new') throw new Error('sin-rollo');
        const used = kind === 'video' ? st.videosUsed : st.photosUsed;
        const max = kind === 'video' ? LIMITS.maxVideos : LIMITS.maxPhotos;
        if (used >= max) throw new Error('limite');
        return {
          allowedContentTypes: ['image/*', 'video/*'],
          addRandomSuffix: true,
          maximumSizeInBytes: 140 * 1024 * 1024,
          tokenPayload: JSON.stringify({ momento, deviceId, kind }),
        };
      },
      onUploadCompleted: async () => {
        // El cliente confirma explícitamente vía /api/roll/confirm (funciona en
        // todos los entornos). Aquí no hace falta registrar nada.
      },
    });
    res.json(jsonResponse);
  } catch (e) {
    console.error('blob-upload', e.message);
    res.status(400).json({ error: e.message || 'upload' });
  }
});

// Registra un disparo ya subido (recibimos su URL de Blob).
app.post('/api/roll/confirm', express.json({ limit: '64kb' }), async (req, res) => {
  try {
    const { momento, deviceId, kind, url, filename, size, contentType } = req.body || {};
    if (!isValidMoment(momento) || !deviceId) return res.status(400).json({ error: 'bad-request' });
    if (kind !== 'photo' && kind !== 'video') return res.status(400).json({ error: 'kind' });
    if (!url || typeof url !== 'string' || !url.includes('.blob.vercel-storage.com')) {
      return res.status(400).json({ error: 'url-invalida' });
    }
    const max = kind === 'video' ? LIMITS.maxVideos : LIMITS.maxPhotos;
    if ((await countFiles(momento, deviceId, kind)) >= max) return res.status(409).json({ error: 'limite' });
    const result = await addFile({ momento, deviceId, kind, url, filename, size, contentType });
    if (result.error) return res.status(403).json({ error: result.error });
    res.json({ ok: true, count: result.count });
  } catch (e) {
    console.error('roll-confirm', e);
    res.status(500).json({ error: 'server' });
  }
});

// Cierra el rollo (sello de tiempo). Opcional.
app.post('/api/roll/finish', express.json({ limit: '64kb' }), async (req, res) => {
  try {
    const { momento, deviceId } = req.body || {};
    if (!isValidMoment(momento) || !deviceId) return res.status(400).json({ error: 'bad-request' });
    await finishRoll(momento, deviceId);
    res.json({ ok: true });
  } catch (e) {
    console.error('roll-finish', e);
    res.status(500).json({ error: 'server' });
  }
});

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
    res.setHeader(
      'Set-Cookie',
      `galeria=${makeSessionToken(24)}; HttpOnly; Path=/; Max-Age=86400; SameSite=Lax; Secure`
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
        f.downloadUrl = f.url;
        f.original_name = f.filename;
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
      BASE: baseUrl(req),
      BRIDE: COUPLE.bride,
      GROOM: COUPLE.groom,
    })
  );
});

export default app;
