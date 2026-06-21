# Diseño — QR Boda: subida de recuerdos (Ana Donaire & Ángel Aguilar)

Fecha: 2026-06-19
Estado: aprobado por el usuario ("vámonos con eso")

## Objetivo

Web app para una boda. Dos códigos QR (entrada de la **ceremonia** y entrada de la
**recepción**) que abren una página elegante donde cada invitado sube recuerdos desde su
teléfono. Cada subida queda guardada de inmediato en la carpeta del momento correspondiente,
identificando quién la subió y con un mensaje opcional para los novios.

Pareja: **Ana Donaire & Ángel Aguilar**.
Idioma: español. Zona horaria de referencia: America/Tegucigalpa.

## Requisitos (acordados)

1. **Dos QR → dos páginas → dos carpetas separadas.**
   - `/ceremonia` sube a la carpeta `ceremonia/`.
   - `/recepcion` sube a la carpeta `recepcion/`.
2. **Uso único por dispositivo y por QR.** Cada dispositivo puede usar **cada QR una sola
   vez**. No se permite re-escanear/re-subir en el mismo momento desde el mismo dispositivo.
   Un dispositivo sí puede aportar a la ceremonia *y* a la recepción (una vez en cada una).
3. **Cupo por QR por dispositivo: 15 fotos + 2 videos.** Cada video ≤ 30 segundos.
4. **Cámara nativa.** La página ofrece "Tomar foto/video" (cámara nativa del teléfono, calidad
   completa) y "Elegir de la galería". Las fotos se comprimen suavemente (máx. ~2560 px, calidad
   ~85%). Los videos se suben tal cual; solo se valida la duración ≤ 30 s.
5. **Identificación del que sube:** nombre obligatorio. **Mensaje** opcional para los novios.
   Se invita a que **al menos uno de los videos** sean palabras habladas para la pareja.
6. **Galería privada** para Ana & Ángel: protegida con contraseña, organizada por momento,
   mostrando nombre + mensaje de cada quien, con descarga (individual y masiva).
7. **Diseño elegante**, moderno, minimalista y delicado. Carteles de entrada hechos en Canva;
   la página web vestida con el mismo lenguaje visual.
8. **Gratis o casi**, alojado bajo `boda.doitgenius.com` **sin afectar** el sitio existente
   (genius-growth-partners en Vercel).

## Arquitectura

Mismo stack que el sitio existente del usuario (familiaridad): **Node.js + Express + HTML/CSS/JS
vanilla**, desplegado en **Vercel como función serverless**, en un **proyecto Vercel separado**
(este folder `QR BODA`). El sitio GENIUS queda intacto.

```
Invitado (teléfono)
  → boda.doitgenius.com/ceremonia  (o /recepcion)
  → página de subida (cámara nativa, compresión suave en cliente, validaciones)
  → POST /api/upload
       → archivos a Cloudflare R2 (carpeta del momento)
       → metadatos a Supabase (quién, mensaje, momento, claves de archivo)
       → marca el dispositivo como "usado" para ese momento
Novios
  → boda.doitgenius.com/galeria  (login con contraseña)
  → ve y descarga todo por momento
```

### Componentes

- **Frontend de invitado** (`/ceremonia`, `/recepcion`): una sola plantilla parametrizada por
  el momento. Inputs de cámara/galería, contadores (15 fotos / 2 videos), campo nombre, campo
  mensaje, invitación a video de palabras, barra de progreso de subida, estado de "ya subiste".
- **Lógica de cliente** (`public/js/upload.js`): huella de dispositivo, control de cupos,
  validación de duración de video, compresión de imágenes (canvas), subida con progreso,
  bloqueo local tras éxito.
- **API** (`api/index.js`, Express):
  - `GET /:momento` sirve la página inyectando el momento.
  - `GET /api/status?device=…&momento=…` indica si ese dispositivo ya subió en ese momento.
  - `POST /api/upload` recibe archivos + metadatos, valida cupo/uso único en servidor, guarda
    en R2 y Supabase. La verificación de uso único es **autoritativa en el servidor** (no solo
    en el cliente).
  - `GET /galeria` (protegido) lista y enlaza descargas; `GET /api/admin/…` para datos/descarga.
- **Almacenamiento de archivos:** Cloudflare R2 (S3-compatible), un bucket con prefijos
  `ceremonia/` y `recepcion/`. 10 GB gratis; excedente en centavos, sin costo de egreso.
- **Base de datos / metadatos:** Supabase (Postgres). Tablas:
  - `uploads`: id, momento, device_id, uploader_name, message, created_at.
  - `upload_files`: id, upload_id, kind (photo|video), r2_key, size, original_name.
  - `device_locks`: (device_id, momento) único → impone el uso único.

### Identificación de dispositivo y "no doble escaneo"

Combinación, suficiente para invitados no adversarios:
- Huella de dispositivo en cliente (hash estable de userAgent + pantalla + plataforma + zona +
  un id aleatorio persistido en localStorage **y** cookie).
- Registro autoritativo en servidor: fila única `(device_id, momento)` en `device_locks`.
- Al abrir la página se consulta el estado; si ya subió en ese momento, se muestra
  "Ya compartiste tus recuerdos de la ceremonia 💛 ¡Gracias!".

Limitación conocida y aceptada: modo incógnito / borrar datos / otro dispositivo puede evadirlo.
Es aceptable para una boda; no se busca seguridad anti-fraude.

### Manejo de errores

- Validaciones de cliente con mensajes claros (cupo excedido, video > 30 s, formato no soportado).
- El servidor revalida cupo y uso único; si el momento ya está bloqueado, responde 409 con
  mensaje amable.
- Subida resiliente: progreso visible; si falla un archivo, se informa y se permite reintentar
  sin perder lo ya subido (idempotencia por device_id + momento en proceso).
- Límites de tamaño y conteo aplicados en servidor como defensa.

### Pruebas

- Validación de cupos (15 fotos / 2 videos) y de duración de video en cliente.
- Uso único: segundo intento en el mismo momento/dispositivo → bloqueado (cliente y servidor).
- Separación de carpetas (ceremonia vs recepción).
- Subida real a R2 + fila en Supabase con nombre y mensaje.
- Galería: login, listado por momento, descarga.

## Diseño visual

Estética: moderna, minimalista, delicada. Tipografía serif elegante para nombres/títulos +
sans limpia para el cuerpo. Paleta crema/rosa empolvado/dorado suave, mucho espacio en blanco,
ornamento mínimo. Los **carteles de entrada** (Ceremonia y Recepción, con el QR) se diseñan en
Canva con la cuenta del usuario; la página web reutiliza la misma paleta y tipografías.

## Alojamiento y costo

- Proyecto Vercel separado → subdominio `boda.doitgenius.com` vía DNS en Vercel. No toca el
  proyecto del sitio existente.
- Costo objetivo: gratis. R2 (10 GB gratis, sin egreso) + Supabase (capa gratis). Excedente de
  almacenamiento del orden de centavos si 100 invitados suben al máximo (~20 GB).

## Fuera de alcance (YAGNI)

- Cuentas/login de invitados (solo nombre).
- Moderación de contenido / aprobación previa.
- Edición de fotos/videos en el navegador (solo compresión suave + validación de duración).
- App nativa (es web).

## Pasos que requieren las cuentas del usuario

A ejecutar usando la sesión de Chrome "abierto" del usuario (o juntos si pide login/2FA):
1. Diseñar los dos carteles en Canva.
2. Crear bucket en Cloudflare R2 + credenciales.
3. Crear proyecto Supabase + tablas + claves.
4. Crear proyecto en Vercel, variables de entorno, dominio `boda.doitgenius.com`.
