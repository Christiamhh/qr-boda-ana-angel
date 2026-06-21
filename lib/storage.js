import fs from 'node:fs';
import path from 'node:path';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { STORAGE_MODE, R2 } from './config.js';

export const storageMode = STORAGE_MODE;

let _s3 = null;
function s3() {
  if (!_s3) {
    _s3 = new S3Client({
      region: 'auto',
      endpoint: R2.endpoint,
      credentials: {
        accessKeyId: R2.accessKeyId,
        secretAccessKey: R2.secretAccessKey,
      },
    });
  }
  return _s3;
}

const LOCAL_ROOT = path.join(process.cwd(), '.data', 'uploads');

// URL a la que el cliente sube el archivo (PUT directo).
export async function presignPut(key, contentType) {
  if (STORAGE_MODE === 'r2') {
    const cmd = new PutObjectCommand({
      Bucket: R2.bucket,
      Key: key,
      ContentType: contentType,
    });
    return getSignedUrl(s3(), cmd, { expiresIn: 900 });
  }
  return `/api/local-blob/${encodeURIComponent(key)}`;
}

// URL temporal para ver/descargar un archivo (GET).
export async function presignGet(key, downloadName) {
  if (STORAGE_MODE === 'r2') {
    const cmd = new GetObjectCommand({
      Bucket: R2.bucket,
      Key: key,
      ResponseContentDisposition: downloadName
        ? `attachment; filename="${downloadName.replace(/"/g, '')}"`
        : undefined,
    });
    return getSignedUrl(s3(), cmd, { expiresIn: 3600 });
  }
  return `/api/local-blob/${encodeURIComponent(key)}`;
}

// Confirma que el objeto realmente se subió.
export async function objectExists(key) {
  if (STORAGE_MODE === 'r2') {
    try {
      await s3().send(new HeadObjectCommand({ Bucket: R2.bucket, Key: key }));
      return true;
    } catch {
      return false;
    }
  }
  return fs.existsSync(path.join(LOCAL_ROOT, key));
}

// ─── Helpers solo para modo local (desarrollo) ───────────────────────
export function localBlobPath(key) {
  return path.join(LOCAL_ROOT, key);
}
export function ensureLocalBlobDir(key) {
  const full = localBlobPath(key);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  return full;
}
