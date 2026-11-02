-- Lienzo: collaborative whiteboard.

create table if not exists users (
  id            uuid primary key default gen_random_uuid(),
  email         text not null unique,
  name          text not null,
  password_hash text,
  role          text not null default 'member' check (role in ('admin', 'member')),
  color         text not null,
  disabled      boolean not null default false,
  created_at    timestamptz not null default now()
);

create table if not exists sessions (
  token_hash text primary key,
  user_id    uuid not null references users (id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index if not exists sessions_user_idx on sessions (user_id);

create table if not exists invites (
  token_hash text primary key,
  email      text not null,
  role       text not null default 'member' check (role in ('admin', 'member')),
  created_by uuid references users (id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at    timestamptz
);

create table if not exists boards (
  id          uuid primary key default gen_random_uuid(),
  title       text not null,
  owner_id    uuid references users (id) on delete set null,
  scene       jsonb not null default '{"elements": [], "appState": {}}'::jsonb,
  thumbnail   text,
  starred_by  uuid[] not null default '{}',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz
);
create index if not exists boards_updated_idx on boards (updated_at desc) where deleted_at is null;

create table if not exists files (
  id         text primary key,
  board_id   uuid not null references boards (id) on delete cascade,
  mime       text not null,
  size       integer not null,
  data       bytea not null,
  created_by uuid references users (id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists files_board_idx on files (board_id);

create table if not exists comments (
  id          uuid primary key default gen_random_uuid(),
  board_id    uuid not null references boards (id) on delete cascade,
  parent_id   uuid references comments (id) on delete cascade,
  author_id   uuid references users (id) on delete set null,
  x           double precision,
  y           double precision,
  body        text not null,
  resolved    boolean not null default false,
  created_at  timestamptz not null default now()
);
create index if not exists comments_board_idx on comments (board_id, created_at);
