import hashlib
import logging
import os
import random
import uuid
from collections.abc import Iterator, Sequence
from datetime import UTC, datetime, timedelta

import psycopg
import pytest
from psycopg.rows import TupleRow

from matching.ingest import MATCHES_PER_RESUME, Completed, Refused, run_ingest

DATABASE_URL = os.environ.get("DATABASE_URL")

pytestmark = pytest.mark.skipif(not DATABASE_URL, reason="DATABASE_URL not set")

Connection = psycopg.Connection[TupleRow]


def vector(text: str) -> list[float]:
    rng = random.Random(hashlib.sha256(text.encode()).digest())
    return [rng.uniform(-1, 1) for _ in range(384)]


def literal(values: Sequence[float]) -> str:
    return "[" + ",".join(repr(value) for value in values) + "]"


class FakeEmbed:
    def __init__(self) -> None:
        self.texts: list[str] = []

    def __call__(self, texts: Sequence[str]) -> list[list[float]]:
        self.texts.extend(texts)
        return [vector(text) for text in texts]


def item(number: int, description: str = "Build GraphQL APIs.", days_ago: int = 1) -> dict[str, object]:
    published = datetime.now(UTC) - timedelta(days=days_ago)
    return {
        "id": number,
        "url": f"https://remotive.com/remote-jobs/software-dev/job-{number}",
        "title": f"Engineer {number}",
        "company_name": "Acme",
        "tags": ["graphql"],
        "candidate_required_location": "Worldwide",
        "publication_date": published.strftime("%Y-%m-%dT%H:%M:%S"),
        "description": f"<p>{description}</p>",
    }


def completed(outcome: object) -> Completed:
    assert isinstance(outcome, Completed)
    return outcome


@pytest.fixture
def conn() -> Iterator[Connection]:
    assert DATABASE_URL
    with psycopg.connect(DATABASE_URL, autocommit=True, connect_timeout=10) as connection:
        yield connection


@pytest.fixture
def source(conn: Connection) -> Iterator[str]:
    name = f"test-{uuid.uuid4()}"
    yield name
    conn.execute("delete from jobs where source = %s", (name,))
    conn.execute("delete from ingest_runs where source = %s", (name,))


@pytest.fixture
def user(conn: Connection) -> Iterator[str]:
    user_id = f"test_{uuid.uuid4()}"
    conn.execute("insert into users (id) values (%s)", (user_id,))
    conn.execute(
        "insert into resumes (user_id, redacted_text, content_hash, embedding) values (%s, %s, 'h', %s::halfvec)",
        (user_id, "RESUME-TEXT-MARKER", literal(vector("resume"))),
    )
    yield user_id
    conn.execute("delete from users where id = %s", (user_id,))


def job_rows(conn: Connection, source: str) -> list[tuple[str, str]]:
    return [
        (row[0], row[1])
        for row in conn.execute(
            "select external_id, content_hash from jobs where source = %s order by external_id", (source,)
        ).fetchall()
    ]


def test_two_runs_over_the_same_feed_do_not_duplicate(conn: Connection, source: str) -> None:
    jobs = [item(1), item(2)]
    embed = FakeEmbed()

    first = completed(run_ingest(conn, source, lambda: list(jobs), embed))
    second = completed(run_ingest(conn, source, lambda: list(jobs), embed))

    assert (first.inserted, first.embedded) == (2, 2)
    assert (second.inserted, second.updated, second.embedded) == (0, 0, 0)
    assert len(embed.texts) == 2
    assert [external_id for external_id, _ in job_rows(conn, source)] == ["1", "2"]


def test_a_changed_job_is_updated_in_place_and_re_embedded(conn: Connection, source: str) -> None:
    embed = FakeEmbed()
    completed(run_ingest(conn, source, lambda: [item(1), item(2)], embed))
    before = dict(job_rows(conn, source))

    outcome = completed(run_ingest(conn, source, lambda: [item(1, description="Now with Rust."), item(2)], embed))

    after = dict(job_rows(conn, source))
    assert (outcome.inserted, outcome.updated, outcome.embedded) == (0, 1, 1)
    assert after.keys() == before.keys()
    assert after["1"] != before["1"]
    assert after["2"] == before["2"]
    assert "Now with Rust." in embed.texts[-1]
    row = conn.execute("select count(*) from jobs where source = %s and embedding is null", (source,)).fetchone()
    assert row == (0,)


def test_the_run_after_the_daily_limit_is_refused_without_fetching(conn: Connection, source: str) -> None:
    for _ in range(4):
        conn.execute("insert into ingest_runs (source) values (%s)", (source,))

    def fetch() -> list[object]:
        raise AssertionError("fetch must not be called once the limit is reached")

    outcome = run_ingest(conn, source, fetch, FakeEmbed(), max_runs=4)

    assert outcome == Refused(runs=4)
    row = conn.execute("select count(*) from ingest_runs where source = %s", (source,)).fetchone()
    assert row == (4,)


def test_runs_older_than_a_day_do_not_count_towards_the_limit(conn: Connection, source: str) -> None:
    for _ in range(4):
        conn.execute("insert into ingest_runs (source, started_at) values (%s, now() - interval '25 hours')", (source,))

    outcome = run_ingest(conn, source, lambda: [], FakeEmbed(), max_runs=4)

    assert isinstance(outcome, Completed)


def test_jobs_older_than_sixty_days_are_deleted_with_their_matches(conn: Connection, source: str, user: str) -> None:
    old = conn.execute(
        """
        insert into jobs (source, external_id, content_hash, title, company, url, description, published_at,
                          embedding)
        values (%s, 'old', 'h', 'Old', 'Acme', 'https://remotive.com/old', 'old', now() - interval '61 days',
                %s::halfvec)
        returning id
        """,
        (source, literal(vector("old"))),
    ).fetchone()
    assert old is not None
    conn.execute("insert into matches (user_id, job_id, score) values (%s, %s, 0.5)", (user, old[0]))

    outcome = completed(run_ingest(conn, source, lambda: [item(1, days_ago=61)], FakeEmbed()))

    assert outcome.deleted >= 1
    assert outcome.inserted == 0
    assert job_rows(conn, source) == []
    row = conn.execute("select count(*) from matches where job_id = %s", (old[0],)).fetchone()
    assert row == (0,)


def test_each_resume_keeps_its_best_matches_within_bounds(conn: Connection, source: str, user: str) -> None:
    jobs = [item(number) for number in range(MATCHES_PER_RESUME + 5)]
    completed(run_ingest(conn, source, lambda: list(jobs), FakeEmbed()))
    kept = conn.execute(
        """
        update matches set notified_at = now()
        where user_id = %s and job_id = (select job_id from matches where user_id = %s order by score desc limit 1)
        returning job_id, notified_at
        """,
        (user, user),
    ).fetchone()
    assert kept is not None

    completed(run_ingest(conn, source, lambda: list(jobs), FakeEmbed()))

    scores = [row[0] for row in conn.execute("select score from matches where user_id = %s", (user,)).fetchall()]
    assert len(scores) == MATCHES_PER_RESUME
    assert all(0 <= score <= 1 for score in scores)
    row = conn.execute("select notified_at from matches where user_id = %s and job_id = %s", (user, kept[0])).fetchone()
    assert row == (kept[1],)


def test_logs_carry_counts_and_no_job_or_resume_text(
    conn: Connection, source: str, user: str, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.INFO, logger="matching.ingest")

    completed(run_ingest(conn, source, lambda: [item(1, description="DESCRIPTION-MARKER")], FakeEmbed()))

    assert "fetched=1" in caplog.text
    assert "inserted=1" in caplog.text
    assert "DESCRIPTION-MARKER" not in caplog.text
    assert "RESUME-TEXT-MARKER" not in caplog.text
