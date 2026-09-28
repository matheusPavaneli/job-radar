create extension if not exists vector;

do $$
begin
  if not exists (select from pg_roles where rolname = 'job_radar_app') then
    create role job_radar_app nologin;
  end if;
end $$;
grant job_radar_app to current_user;

create or replace function app_user_id() returns text
language sql stable
as $$ select nullif(current_setting('app.user_id', true), '') $$;

create table users (
  id text primary key,
  created_at timestamptz not null default now()
);

create table invites (
  code text primary key,
  created_at timestamptz not null default now(),
  redeemed_by text references users (id) on delete set null,
  redeemed_at timestamptz
);

create table jobs (
  id uuid primary key default gen_random_uuid(),
  source text not null,
  external_id text not null,
  content_hash text not null,
  title text not null,
  company text not null,
  url text not null,
  location text,
  tags text[] not null default '{}',
  description text not null,
  published_at timestamptz not null,
  ingested_at timestamptz not null default now(),
  embedding halfvec(384),
  search tsvector generated always as (
    setweight(to_tsvector('english', title), 'A') ||
    setweight(to_tsvector('english', company), 'B') ||
    setweight(to_tsvector('english', description), 'C')
  ) stored,
  unique (source, external_id)
);
create index jobs_published_at_idx on jobs (published_at desc, id desc);
create index jobs_search_idx on jobs using gin (search);
create index jobs_embedding_idx on jobs using hnsw (embedding halfvec_cosine_ops);

create table resumes (
  user_id text primary key references users (id) on delete cascade,
  redacted_text text not null,
  content_hash text not null,
  embedding halfvec(384) not null,
  updated_at timestamptz not null default now()
);

create table matches (
  user_id text not null references users (id) on delete cascade,
  job_id uuid not null references jobs (id) on delete cascade,
  score real not null,
  created_at timestamptz not null default now(),
  notified_at timestamptz,
  primary key (user_id, job_id)
);
create index matches_user_score_idx on matches (user_id, score desc);

create table push_subscriptions (
  endpoint text primary key,
  user_id text not null references users (id) on delete cascade,
  p256dh text not null,
  auth text not null,
  created_at timestamptz not null default now()
);
create index push_subscriptions_user_idx on push_subscriptions (user_id);

grant select on jobs to job_radar_app;

grant select, insert on users to job_radar_app;
grant select, insert, update, delete on resumes, matches, push_subscriptions to job_radar_app;
grant delete on users to job_radar_app;
grant select, update on invites to job_radar_app;

alter table users enable row level security;
alter table resumes enable row level security;
alter table matches enable row level security;
alter table push_subscriptions enable row level security;

create policy own_user on users for all to job_radar_app
  using (id = app_user_id()) with check (id = app_user_id());
create policy own_resume on resumes for all to job_radar_app
  using (user_id = app_user_id()) with check (user_id = app_user_id());
create policy own_matches on matches for all to job_radar_app
  using (user_id = app_user_id()) with check (user_id = app_user_id());
create policy own_push on push_subscriptions for all to job_radar_app
  using (user_id = app_user_id()) with check (user_id = app_user_id());
