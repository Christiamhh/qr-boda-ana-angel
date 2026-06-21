-- Esquema Supabase para la boda de Ana Donaire & Angel Aguilar
-- Ejecutar en el SQL editor de Supabase (o via migracion).

-- Tabla de subidas (una fila por invitado por momento)
create table if not exists public.uploads (
  id            uuid primary key default gen_random_uuid(),
  momento       text not null check (momento in ('ceremonia','recepcion')),
  device_id     text not null,
  uploader_name text not null,
  message       text,
  status        text not null default 'pending' check (status in ('pending','complete')),
  created_at    timestamptz not null default now(),
  completed_at  timestamptz
);

-- Archivos de cada subida
create table if not exists public.upload_files (
  id            uuid primary key default gen_random_uuid(),
  upload_id     uuid not null references public.uploads(id) on delete cascade,
  kind          text not null check (kind in ('photo','video')),
  r2_key        text not null,
  original_name text,
  size_bytes    bigint,
  content_type  text,
  created_at    timestamptz not null default now()
);

-- Bloqueo de uso unico: un dispositivo solo puede completar una subida por momento
create table if not exists public.device_locks (
  device_id  text not null,
  momento    text not null check (momento in ('ceremonia','recepcion')),
  upload_id  uuid references public.uploads(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (device_id, momento)
);

create index if not exists idx_uploads_momento on public.uploads(momento, status);
create index if not exists idx_upload_files_upload on public.upload_files(upload_id);

-- El acceso es solo desde el servidor con la service key (bypass RLS).
-- Mantener RLS activado y sin politicas publicas: nadie llega a estos datos
-- desde el cliente.
alter table public.uploads       enable row level security;
alter table public.upload_files  enable row level security;
alter table public.device_locks  enable row level security;
