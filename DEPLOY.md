# Guía para publicar — Boda Ana & Ángel

Todo el código está construido y probado. Faltan los pasos que necesitan **tus cuentas**
(login/2FA/tarjeta), que hacemos juntos en ~15 min. Aquí está el detalle exacto.

---

## Estado actual

- ✅ App completa: dos páginas de subida (`/ceremonia`, `/recepcion`), cámara nativa,
  compresión suave de fotos, validación de videos ≤30s, uso único por dispositivo y por QR.
- ✅ Galería privada para los novios (`/galeria`, con contraseña) + descarga.
- ✅ Página para generar y descargar los QR (`/qr`) para meterlos en Canva.
- ✅ Probado de punta a punta en modo local (sin cuentas).
- ⏳ Falta: almacenamiento real (R2), base de datos real (Supabase), publicar en Vercel
  con el dominio `boda.doitgenius.com`, y diseñar los carteles en Canva.

## Probar localmente ahora mismo

```
npm install
npm start
```
Abrir http://localhost:3000/ceremonia (o /recepcion, /galeria, /qr).
En modo local guarda en `.data/` (no necesita cuentas). Contraseña de galería por defecto:
`AnaYAngel2026`.

---

## 1) Decisión de almacenamiento (importante)

El código usa una API S3 estándar, así que sirve cualquiera de estos. A confirmar en la mañana:

- **Cloudflare R2** (recomendado): 10 GB gratis, sin costo de descarga. ⚠️ Cloudflare pide una
  **tarjeta en archivo** para activar R2 aunque uses la capa gratis.
- **Backblaze B2**: 10 GB gratis (también pide tarjeta).
- **Supabase Storage**: sin tarjeta hasta 1 GB; arriba de eso necesita plan Pro ($25/mes).

Mi recomendación: R2. Si no querés poner tarjeta en ningún lado, lo hablamos: para 100 invitados
al máximo son ~20 GB, que no entra en capas sin tarjeta.

## 2) Supabase (metadatos + uso único)

1. Crear proyecto en https://supabase.com (capa gratis).
2. En el **SQL Editor**, pegar y ejecutar el contenido de `db/schema.sql`.
3. En **Project Settings → API**, copiar:
   - `Project URL` → variable `SUPABASE_URL`
   - `service_role` key (secreta) → variable `SUPABASE_SERVICE_KEY`

## 3) Cloudflare R2 (archivos)

1. Activar R2 y crear un bucket, p. ej. `boda-ana-angel`.
2. Crear un **API Token de R2** (Object Read & Write) → copiar Access Key ID y Secret.
3. Anotar el **Account ID** (R2 → endpoint S3: `https://<accountid>.r2.cloudflarestorage.com`).
4. Configurar **CORS** del bucket (R2 → Settings → CORS policy) para permitir la subida directa
   desde el navegador:

```json
[
  {
    "AllowedOrigins": ["https://boda.doitgenius.com", "http://localhost:3000"],
    "AllowedMethods": ["GET", "PUT", "HEAD"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

## 4) Variables de entorno

Crear `.env` (local) y/o cargarlas en Vercel (Project → Settings → Environment Variables):

```
R2_ACCOUNT_ID=...
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
R2_BUCKET=boda-ana-angel
R2_ENDPOINT=https://<accountid>.r2.cloudflarestorage.com
SUPABASE_URL=...
SUPABASE_SERVICE_KEY=...
GALLERY_PASSWORD=elige-una-contraseña
SESSION_SECRET=algo-largo-y-aleatorio
PUBLIC_BASE_URL=https://boda.doitgenius.com
```

> Sin estas variables la app corre en modo local (disco + JSON). Con ellas, usa R2 + Supabase.

## 5) Publicar en Vercel (proyecto separado — NO toca tu sitio GENIUS)

Opción CLI (rápida):
```
npm i -g vercel
vercel        # crear NUEVO proyecto (no reusar genius-growth-partners)
vercel --prod
```
Luego en el dashboard del nuevo proyecto:
- **Settings → Environment Variables**: pegar las del paso 4.
- **Settings → Domains**: agregar `boda.doitgenius.com`. Como `doitgenius.com` ya está en tu
  cuenta Vercel, se crea solo el registro DNS del subdominio. El proyecto del sitio principal
  queda intacto.

## 6) Carteles en Canva

1. Abrir `/qr` (con la contraseña de galería) y **descargar los dos PNG** de alta resolución.
2. En Canva: diseñar dos carteles (Ceremonia y Recepción), modernos/minimalistas, con los
   nombres de Ana & Ángel, una instrucción corta ("Escanea para compartir tus fotos y videos")
   y pegar encima el QR correspondiente.

---

## Ajustes rápidos

- **Cambiar cupos** (15 fotos / 2 videos / 30 s): `lib/config.js` → `LIMITS`.
- **Cambiar contraseña de galería**: variable `GALLERY_PASSWORD`.
- **Textos/diseño**: `public/subir.html` y `public/css/styles.css`.
