import 'dotenv/config';

// ─── Pareja y evento ──────────────────────────────────────────────────
export const COUPLE = {
  bride: 'Ana Donaire',
  groom: 'Ángel Aguilar',
  initials: 'A · A',
};

// ─── Momentos (un QR / carpeta por momento) ───────────────────────────
export const MOMENTS = {
  ceremonia: { slug: 'ceremonia', label: 'Ceremonia', folder: 'ceremonia' },
  recepcion: { slug: 'recepcion', label: 'Recepción', folder: 'recepcion' },
};

export function isValidMoment(slug) {
  return Object.prototype.hasOwnProperty.call(MOMENTS, slug);
}

// ─── Límites de cupo ──────────────────────────────────────────────────
export const LIMITS = {
  maxPhotos: 15,
  maxVideos: 2,
  maxVideoSeconds: 30, // tope real; la grabación in-app se corta sola a los 30s
  maxPhotoBytes: 15 * 1024 * 1024, // 15 MB por foto (tras compresión suave)
  maxVideoBytes: 120 * 1024 * 1024, // 120 MB por video
};

// ─── Backends ─────────────────────────────────────────────────────────
export const R2 = {
  accountId: process.env.R2_ACCOUNT_ID || '',
  accessKeyId: process.env.R2_ACCESS_KEY_ID || '',
  secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || '',
  bucket: process.env.R2_BUCKET || 'boda-ana-angel',
  endpoint:
    process.env.R2_ENDPOINT ||
    (process.env.R2_ACCOUNT_ID
      ? `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`
      : ''),
};

export const SUPABASE = {
  url: process.env.SUPABASE_URL || '',
  serviceKey: process.env.SUPABASE_SERVICE_KEY || '',
};

// Modo de almacenamiento: 'r2' si hay credenciales, si no 'local' (solo dev).
export const STORAGE_MODE =
  R2.accessKeyId && R2.secretAccessKey && R2.endpoint ? 'r2' : 'local';

// Modo de base de datos: 'supabase' si hay credenciales, si no 'local' (solo dev).
export const DB_MODE = SUPABASE.url && SUPABASE.serviceKey ? 'supabase' : 'local';

export const GALLERY_PASSWORD = process.env.GALLERY_PASSWORD || 'AnaYAngel2026';
export const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-secret-cambiar';
export const PUBLIC_BASE_URL =
  process.env.PUBLIC_BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
