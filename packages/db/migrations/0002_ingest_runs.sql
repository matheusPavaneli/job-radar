create table ingest_runs (
  id bigint generated always as identity primary key,
  source text not null,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  fetched integer,
  inserted integer,
  updated integer,
  deleted integer,
  error text
);
create index ingest_runs_source_started_idx on ingest_runs (source, started_at desc);
