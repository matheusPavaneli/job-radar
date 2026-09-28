import logging
import os
import sys
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

import psycopg
from psycopg.rows import TupleRow

from matching.embed import DIMENSIONS, Embedder
from matching.remotive import Job, content_hash, fetch_jobs, normalize

SOURCE = "remotive"
MAX_RUNS_PER_DAY = 4
RETENTION_DAYS = 60
MATCHES_PER_RESUME = 100
EMBED_BATCH = 256

log = logging.getLogger("matching.ingest")

Connection = psycopg.Connection[TupleRow]
Fetch = Callable[[], list[object]]
Embed = Callable[[Sequence[str]], list[list[float]]]


@dataclass(frozen=True)
class Refused:
    runs: int


@dataclass(frozen=True)
class Completed:
    fetched: int
    invalid: int
    inserted: int
    updated: int
    embedded: int
    deleted: int
    resumes: int


Outcome = Refused | Completed


def run_ingest(conn: Connection, source: str, fetch: Fetch, embed: Embed, max_runs: int = MAX_RUNS_PER_DAY) -> Outcome:
    with conn.transaction():
        conn.execute("select pg_advisory_xact_lock(hashtext(%s))", (f"ingest:{source}",))
        row = conn.execute(
            "select count(*) from ingest_runs where source = %s and started_at > now() - interval '24 hours'",
            (source,),
        ).fetchone()
        runs = row[0] if row else 0
        if runs >= max_runs:
            log.warning("ingest refused source=%s runs_last_24h=%d limit=%d", source, runs, max_runs)
            return Refused(runs=runs)
        inserted_run = conn.execute("insert into ingest_runs (source) values (%s) returning id", (source,)).fetchone()
    if inserted_run is None:
        raise RuntimeError("ingest_runs insert returned no id")
    run_id: int = inserted_run[0]

    try:
        outcome = _collect(conn, source, fetch, embed)
    except Exception as exc:
        conn.execute(
            "update ingest_runs set finished_at = now(), error = %s where id = %s",
            (type(exc).__name__, run_id),
        )
        raise

    conn.execute(
        "update ingest_runs set finished_at = now(), fetched = %s, inserted = %s, updated = %s, deleted = %s"
        " where id = %s",
        (outcome.fetched, outcome.inserted, outcome.updated, outcome.deleted, run_id),
    )
    log.info(
        "ingest finished source=%s fetched=%d invalid=%d inserted=%d updated=%d embedded=%d deleted=%d resumes=%d",
        source,
        outcome.fetched,
        outcome.invalid,
        outcome.inserted,
        outcome.updated,
        outcome.embedded,
        outcome.deleted,
        outcome.resumes,
    )
    return outcome


def _collect(conn: Connection, source: str, fetch: Fetch, embed: Embed) -> Completed:
    items = fetch()
    cutoff = datetime.now(UTC) - timedelta(days=RETENTION_DAYS)
    jobs: dict[str, Job] = {}
    invalid = 0
    for item in items:
        job = normalize(item, source)
        if job is None:
            invalid += 1
        elif job.published_at >= cutoff:
            jobs[job.external_id] = job

    inserted, updated = _upsert(conn, list(jobs.values()))
    embedded = _embed_pending(conn, source, embed)
    with conn.transaction():
        deleted = conn.execute(
            "delete from jobs where published_at < now() - make_interval(days => %s)", (RETENTION_DAYS,)
        ).rowcount
        resumes = _recompute_matches(conn)
    return Completed(
        fetched=len(items),
        invalid=invalid,
        inserted=inserted,
        updated=updated,
        embedded=embedded,
        deleted=deleted,
        resumes=resumes,
    )


def _upsert(conn: Connection, jobs: Sequence[Job]) -> tuple[int, int]:
    inserted = 0
    updated = 0
    with conn.transaction():
        for job in jobs:
            row = conn.execute(
                """
                insert into jobs (source, external_id, content_hash, title, company, url, location, tags,
                                  description, published_at)
                values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                on conflict (source, external_id) do update set
                  content_hash = excluded.content_hash,
                  title = excluded.title,
                  company = excluded.company,
                  url = excluded.url,
                  location = excluded.location,
                  tags = excluded.tags,
                  description = excluded.description,
                  published_at = excluded.published_at,
                  ingested_at = now(),
                  embedding = null
                where jobs.content_hash is distinct from excluded.content_hash
                returning xmax = 0
                """,
                (
                    job.source,
                    job.external_id,
                    content_hash(job),
                    job.title,
                    job.company,
                    job.url,
                    job.location,
                    list(job.tags),
                    job.description,
                    job.published_at,
                ),
            ).fetchone()
            if row is None:
                continue
            if row[0]:
                inserted += 1
            else:
                updated += 1
    return inserted, updated


def _embed_pending(conn: Connection, source: str, embed: Embed) -> int:
    pending = conn.execute(
        "select id, title, company, description from jobs where source = %s and embedding is null order by id",
        (source,),
    ).fetchall()
    for start in range(0, len(pending), EMBED_BATCH):
        batch = pending[start : start + EMBED_BATCH]
        vectors = embed([f"{title}\n{company}\n{description}" for _, title, company, description in batch])
        if len(vectors) != len(batch):
            raise ValueError(f"embedder returned {len(vectors)} vectors for {len(batch)} texts")
        with conn.transaction():
            for (job_id, *_), vector in zip(batch, vectors, strict=True):
                if len(vector) != DIMENSIONS:
                    raise ValueError(f"embedder returned {len(vector)} dimensions, expected {DIMENSIONS}")
                conn.execute("update jobs set embedding = %s::halfvec where id = %s", (_vector_literal(vector), job_id))
    return len(pending)


def _recompute_matches(conn: Connection) -> int:
    conn.execute("select set_config('hnsw.ef_search', %s, true)", (str(MATCHES_PER_RESUME * 2),))
    conn.execute(
        """
        with nearest as (
          select r.user_id, j.id as job_id, greatest(0, 1 - (j.embedding <=> r.embedding))::real as score
          from resumes r
          cross join lateral (
            select id, embedding from jobs
            where embedding is not null
            order by embedding <=> r.embedding
            limit %(limit)s
          ) j
        ), upserted as (
          insert into matches (user_id, job_id, score)
          select user_id, job_id, score from nearest
          on conflict (user_id, job_id) do update set score = excluded.score
        )
        delete from matches m
        where not exists (select 1 from nearest n where n.user_id = m.user_id and n.job_id = m.job_id)
        """,
        {"limit": MATCHES_PER_RESUME},
    )
    row = conn.execute("select count(*) from resumes").fetchone()
    return row[0] if row else 0


def _vector_literal(vector: Sequence[float]) -> str:
    return "[" + ",".join(repr(value) for value in vector) + "]"


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    database_url = os.environ.get("DATABASE_URL")
    if not database_url:
        log.error("DATABASE_URL is not set")
        return 2
    try:
        with psycopg.connect(database_url, autocommit=True, connect_timeout=10) as conn:
            run_ingest(conn, SOURCE, fetch_jobs, Embedder())
    except Exception:
        log.exception("ingest failed source=%s", SOURCE)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
