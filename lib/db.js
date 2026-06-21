import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { DB_MODE, SUPABASE } from './config.js';

export const dbMode = DB_MODE;

// ─────────────────────────────────────────────────────────────────────
// Backend Supabase
// ─────────────────────────────────────────────────────────────────────
let _sb = null;
function sb() {
  if (!_sb) {
    _sb = createClient(SUPABASE.url, SUPABASE.serviceKey, {
      auth: { persistSession: false },
    });
  }
  return _sb;
}

// ─────────────────────────────────────────────────────────────────────
// Backend local (JSON en disco) — solo desarrollo
// ─────────────────────────────────────────────────────────────────────
const LOCAL_DB = path.join(process.cwd(), '.data', 'db.json');
function readLocal() {
  try {
    return JSON.parse(fs.readFileSync(LOCAL_DB, 'utf8'));
  } catch {
    return { uploads: [], upload_files: [], device_locks: [] };
  }
}
function writeLocal(data) {
  fs.mkdirSync(path.dirname(LOCAL_DB), { recursive: true });
  fs.writeFileSync(LOCAL_DB, JSON.stringify(data, null, 2));
}

// ─────────────────────────────────────────────────────────────────────
// API pública
// ─────────────────────────────────────────────────────────────────────

export async function isLocked(deviceId, momento) {
  if (DB_MODE === 'supabase') {
    const { data, error } = await sb()
      .from('device_locks')
      .select('device_id')
      .eq('device_id', deviceId)
      .eq('momento', momento)
      .maybeSingle();
    if (error) throw error;
    return !!data;
  }
  const db = readLocal();
  return db.device_locks.some(
    (l) => l.device_id === deviceId && l.momento === momento
  );
}

// Inicia un "rollo": reserva el uso único del dispositivo para ese momento
// y crea la subida. Devuelve { uploadId } o { locked: true } si ya se usó.
export async function startRoll({ momento, deviceId, name, message }) {
  if (DB_MODE === 'supabase') {
    if (await isLocked(deviceId, momento)) return { locked: true };
    const up = await sb()
      .from('uploads')
      .insert({
        momento,
        device_id: deviceId,
        uploader_name: name,
        message: message || null,
        status: 'complete',
      })
      .select('id')
      .single();
    if (up.error) throw up.error;
    const uploadId = up.data.id;
    const lock = await sb()
      .from('device_locks')
      .insert({ device_id: deviceId, momento, upload_id: uploadId });
    if (lock.error) {
      if (lock.error.code === '23505') {
        await sb().from('uploads').delete().eq('id', uploadId);
        return { locked: true };
      }
      throw lock.error;
    }
    return { uploadId };
  }

  const db = readLocal();
  if (db.device_locks.some((l) => l.device_id === deviceId && l.momento === momento)) {
    return { locked: true };
  }
  const uploadId = crypto.randomUUID();
  db.uploads.push({
    id: uploadId,
    momento,
    device_id: deviceId,
    uploader_name: name,
    message: message || null,
    status: 'complete',
    created_at: new Date().toISOString(),
    completed_at: null,
  });
  db.device_locks.push({
    device_id: deviceId,
    momento,
    upload_id: uploadId,
    created_at: new Date().toISOString(),
  });
  writeLocal(db);
  return { uploadId };
}

// Devuelve { momento, device_id } de una subida, o null.
export async function getUpload(uploadId) {
  if (DB_MODE === 'supabase') {
    const { data, error } = await sb()
      .from('uploads')
      .select('id, momento, device_id, uploader_name, message')
      .eq('id', uploadId)
      .maybeSingle();
    if (error) throw error;
    return data || null;
  }
  const db = readLocal();
  return db.uploads.find((u) => u.id === uploadId) || null;
}

// Cuenta archivos ya guardados de un tipo (photo|video) en una subida.
export async function countFiles(uploadId, kind) {
  if (DB_MODE === 'supabase') {
    const { count, error } = await sb()
      .from('upload_files')
      .select('id', { count: 'exact', head: true })
      .eq('upload_id', uploadId)
      .eq('kind', kind);
    if (error) throw error;
    return count || 0;
  }
  const db = readLocal();
  return db.upload_files.filter((f) => f.upload_id === uploadId && f.kind === kind).length;
}

// Registra un archivo recién subido (un disparo del rollo).
export async function addFile({ uploadId, kind, key, filename, size, contentType }) {
  if (DB_MODE === 'supabase') {
    const { error } = await sb().from('upload_files').insert({
      upload_id: uploadId,
      kind,
      r2_key: key,
      original_name: filename || null,
      size_bytes: size || null,
      content_type: contentType || null,
    });
    if (error) throw error;
    return;
  }
  const db = readLocal();
  db.upload_files.push({
    id: crypto.randomUUID(),
    upload_id: uploadId,
    kind,
    r2_key: key,
    original_name: filename || null,
    size_bytes: size || null,
    content_type: contentType || null,
    created_at: new Date().toISOString(),
  });
  writeLocal(db);
}

// Marca el rollo como terminado (sello de tiempo). No es obligatorio.
export async function finishRoll(uploadId) {
  if (DB_MODE === 'supabase') {
    await sb().from('uploads').update({ completed_at: new Date().toISOString() }).eq('id', uploadId);
    return;
  }
  const db = readLocal();
  const u = db.uploads.find((x) => x.id === uploadId);
  if (u) { u.completed_at = new Date().toISOString(); writeLocal(db); }
}

// Estado del rollo de un dispositivo en un momento: nuevo, o en progreso con
// cuántas fotos/videos ya subió (para poder reanudar).
export async function getRollState(deviceId, momento) {
  if (DB_MODE === 'supabase') {
    const { data: lock, error } = await sb()
      .from('device_locks')
      .select('upload_id')
      .eq('device_id', deviceId)
      .eq('momento', momento)
      .maybeSingle();
    if (error) throw error;
    if (!lock || !lock.upload_id) return { state: 'new' };
    const photosUsed = await countFiles(lock.upload_id, 'photo');
    const videosUsed = await countFiles(lock.upload_id, 'video');
    return { state: 'in_progress', uploadId: lock.upload_id, photosUsed, videosUsed };
  }
  const db = readLocal();
  const lock = db.device_locks.find((l) => l.device_id === deviceId && l.momento === momento);
  if (!lock || !lock.upload_id) return { state: 'new' };
  const photosUsed = db.upload_files.filter((f) => f.upload_id === lock.upload_id && f.kind === 'photo').length;
  const videosUsed = db.upload_files.filter((f) => f.upload_id === lock.upload_id && f.kind === 'video').length;
  return { state: 'in_progress', uploadId: lock.upload_id, photosUsed, videosUsed };
}

// Lista las subidas con al menos un archivo, por momento, con sus archivos.
export async function listByMoment(momento) {
  if (DB_MODE === 'supabase') {
    const { data, error } = await sb()
      .from('uploads')
      .select(
        'id, uploader_name, message, created_at, upload_files(kind, r2_key, original_name, size_bytes)'
      )
      .eq('momento', momento)
      .order('created_at', { ascending: true });
    if (error) throw error;
    return (data || [])
      .map((u) => ({
        id: u.id,
        uploader_name: u.uploader_name,
        message: u.message,
        created_at: u.created_at,
        files: u.upload_files || [],
      }))
      .filter((u) => u.files.length > 0);
  }
  const db = readLocal();
  return db.uploads
    .filter((u) => u.momento === momento)
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
    .map((u) => ({
      id: u.id,
      uploader_name: u.uploader_name,
      message: u.message,
      created_at: u.created_at,
      files: db.upload_files.filter((f) => f.upload_id === u.id),
    }))
    .filter((u) => u.files.length > 0);
}
