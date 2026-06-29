-- Applied to project scypfjpovfmgzbdnpwpz on 2026-06-11 as `pm_0001_schema`.
-- PM system lives in its own schema, fully separate from the CRM in `public`.

create schema if not exists pm;

create type pm.task_status as enum ('icebox','todo','doing','done','reference');
create type pm.priority    as enum ('high','medium','low','none');

create table pm.boards (
  key   text primary key,
  name  text not null,
  color text not null default '#888888',
  sort  int  not null default 0
);

insert into pm.boards (key, name, color, sort) values
  ('personal','Personal','#4f86c6',0),
  ('intuitive-intel','Intuitive Intel','#7b61c4',1),
  ('votf','VOTF','#5aa469',2);

create table pm.tasks (
  id            bigint generated always as identity primary key,
  board         text not null references pm.boards(key),
  title         text not null check (length(trim(title)) > 0),
  description   text not null default '',
  status        pm.task_status not null default 'todo',
  bucket        text not null default 'TODO',
  priority      pm.priority not null default 'none',
  labels        text[] not null default '{}',
  due           timestamptz,
  due_complete  boolean not null default false,
  archived      boolean not null default false,
  position      double precision not null default 65536,
  assignees     text[] not null default '{}',
  checklists    jsonb not null default '[]',
  attachments   jsonb not null default '[]',
  source        text not null default 'pm',
  source_id     text,
  source_url    text,
  created_at    timestamptz not null default now(),
  completed_at  timestamptz,
  updated_at    timestamptz not null default now()
);

create unique index tasks_source_uq on pm.tasks (source, source_id) where source_id is not null;
create index tasks_board_status_idx on pm.tasks (board, status, archived);
create index tasks_bucket_idx       on pm.tasks (board, bucket);
create index tasks_due_idx          on pm.tasks (due) where due is not null;
create index tasks_completed_idx    on pm.tasks (completed_at) where completed_at is not null;
create index tasks_labels_gin       on pm.tasks using gin (labels);
create extension if not exists pg_trgm;
create index tasks_title_trgm       on pm.tasks using gin (title gin_trgm_ops);

create table pm.comments (
  id         bigint generated always as identity primary key,
  task_id    bigint not null references pm.tasks(id) on delete cascade,
  author     text not null default 'Renner Skidmore',
  body       text not null,
  created_at timestamptz not null default now(),
  source     text not null default 'pm',
  source_key text
);
create unique index comments_source_uq on pm.comments (source, source_key) where source_key is not null;
create index comments_task_idx on pm.comments (task_id, created_at);

create table pm.app_config (
  key   text primary key,
  value text not null
);

create function pm.touch_updated_at() returns trigger language plpgsql as
$$ begin new.updated_at = now(); return new; end $$;
create trigger tasks_touch before update on pm.tasks
  for each row execute function pm.touch_updated_at();

-- Completion invariants in one place, used by both the API and the MCP server.
-- status -> done: stamp completed_at (keep an existing stamp) and set the
-- monthly done bucket; leaving done clears completed_at and resets the bucket.
create function pm.move_task(p_id bigint, p_status pm.task_status, p_bucket text default null)
returns pm.tasks language plpgsql as $$
declare t pm.tasks;
begin
  update pm.tasks set
    status = p_status,
    completed_at = case when p_status = 'done' then coalesce(completed_at, now()) else null end,
    due_complete = case when p_status = 'done' then true else due_complete end,
    bucket = coalesce(
      p_bucket,
      case when p_status = 'done'
           then 'Done ' || to_char(coalesce(completed_at, now()), 'Mon YY')
           else upper(p_status::text) end)
  where id = p_id
  returning * into t;
  if not found then raise exception 'task % not found', p_id; end if;
  return t;
end $$;

alter table pm.boards     enable row level security;
alter table pm.tasks      enable row level security;
alter table pm.comments   enable row level security;
alter table pm.app_config enable row level security;

insert into pm.app_config (key, value) values
  ('ui_secret',  encode(gen_random_bytes(16), 'hex')),
  ('mcp_secret', encode(gen_random_bytes(16), 'hex'));
