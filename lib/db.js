import { put, list } from '@vercel/blob';

// ─────────────────────────────────────────────────────────────────────
// Metadatos del rollo guardados como JSON en Vercel Blob.
// Una "ficha" por (momento, dispositivo): meta/{momento}/{deviceId}.json
// Contiene: { uploadId, momento, deviceId, name, message, photos:[], videos:[], createdAt, completedAt }
// Cada foto/video: { url, filename, size, contentType, at }
// ─────────────────────────────────────────────────────────────────────

function metaPath(momento, deviceId) {
  return `meta/${momento}/${deviceId}.json`;
}

async function readMeta(momento, deviceId) {
  const { blobs } = await list({ prefix: metaPath(momento, deviceId), limit: 1 });
  if (!blobs.length) return null;
  try {
    const res = await fetch(blobs[0].url + '?_=' + Date.now(), { cache: 'no-store' });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function writeMeta(meta) {
  await put(metaPath(meta.momento, meta.deviceId), JSON.stringify(meta), {
    access: 'public',
    contentType: 'application/json',
    addRandomSuffix: false,
    allowOverwrite: true,
    cacheControlMaxAge: 0,
  });
}

// Estado del rollo: new | in_progress (con cuántas fotos/videos lleva).
export async function getRollState(deviceId, momento) {
  const m = await readMeta(momento, deviceId);
  if (!m) return { state: 'new' };
  return {
    state: 'in_progress',
    uploadId: m.uploadId,
    photosUsed: (m.photos || []).length,
    videosUsed: (m.videos || []).length,
  };
}

// Inicia el rollo (crea la ficha). Si ya existía, la devuelve (para reanudar).
export async function startRoll({ momento, deviceId, name, message }) {
  const existing = await readMeta(momento, deviceId);
  if (existing) return { uploadId: existing.uploadId, resumed: true };
  const uploadId =
    (globalThis.crypto && crypto.randomUUID)
      ? crypto.randomUUID()
      : 'u' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  await writeMeta({
    uploadId, momento, deviceId,
    name, message: message || '',
    photos: [], videos: [],
    createdAt: new Date().toISOString(), completedAt: null,
  });
  return { uploadId };
}

export async function countFiles(momento, deviceId, kind) {
  const m = await readMeta(momento, deviceId);
  if (!m) return 0;
  return (kind === 'video' ? (m.videos || []) : (m.photos || [])).length;
}

// Registra un archivo recién subido (ya está en Blob; recibimos su URL).
export async function addFile({ momento, deviceId, kind, url, filename, size, contentType }) {
  const m = await readMeta(momento, deviceId);
  if (!m) return { error: 'no-roll' };
  const arr = kind === 'video' ? (m.videos || (m.videos = [])) : (m.photos || (m.photos = []));
  arr.push({ url, filename: filename || null, size: size || null, contentType: contentType || null, at: new Date().toISOString() });
  await writeMeta(m);
  return { ok: true, count: arr.length };
}

export async function finishRoll(momento, deviceId) {
  const m = await readMeta(momento, deviceId);
  if (!m) return;
  m.completedAt = new Date().toISOString();
  await writeMeta(m);
}

// Lista las fichas con al menos un archivo, por momento, para la galería.
export async function listByMoment(momento) {
  const { blobs } = await list({ prefix: `meta/${momento}/` });
  const out = [];
  for (const b of blobs) {
    try {
      const m = await (await fetch(b.url + '?_=' + Date.now(), { cache: 'no-store' })).json();
      const files = [
        ...(m.photos || []).map((f) => ({ ...f, kind: 'photo' })),
        ...(m.videos || []).map((f) => ({ ...f, kind: 'video' })),
      ];
      if (files.length) {
        out.push({
          id: m.uploadId,
          uploader_name: m.name,
          message: m.message,
          created_at: m.createdAt,
          files,
        });
      }
    } catch {}
  }
  out.sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')));
  return out;
}
