from datetime import UTC, datetime

from matching.remotive import content_hash, normalize


def remotive_item(**overrides: object) -> dict[str, object]:
    item: dict[str, object] = {
        "id": 2091144,
        "url": "https://remotive.com/remote-jobs/software-dev/graphql-engineer-2091144",
        "title": "  GraphQL Engineer ",
        "company_name": "Acme",
        "tags": ["graphql", " node ", "", 3],
        "candidate_required_location": "Worldwide",
        "publication_date": "2026-09-21T12:55:11",
        "description": "<p>Build <b>APIs</b> &amp; tools.</p><ul><li>Federation</li><li>Postgres</li></ul>"
        "<script>track()</script>",
    }
    item.update(overrides)
    return item


def test_normalize_reduces_html_to_text() -> None:
    job = normalize(remotive_item(), "remotive")
    assert job is not None
    assert job.description == "Build APIs & tools.\nFederation\nPostgres"


def test_normalize_reads_publication_date_as_utc() -> None:
    job = normalize(remotive_item(), "remotive")
    assert job is not None
    assert job.published_at == datetime(2026, 9, 21, 12, 55, 11, tzinfo=UTC)


def test_normalize_converts_an_offset_date_to_utc() -> None:
    job = normalize(remotive_item(publication_date="2026-09-21T09:55:11-03:00"), "remotive")
    assert job is not None
    assert job.published_at == datetime(2026, 9, 21, 12, 55, 11, tzinfo=UTC)


def test_normalize_keeps_text_tags_and_trims_fields() -> None:
    job = normalize(remotive_item(), "remotive")
    assert job is not None
    assert job.tags == ("graphql", "node")
    assert job.title == "GraphQL Engineer"
    assert job.external_id == "2091144"
    assert job.source == "remotive"
    assert job.location == "Worldwide"


def test_normalize_rejects_items_missing_a_required_field() -> None:
    for field in ("id", "title", "company_name", "url", "publication_date", "description"):
        item = remotive_item()
        del item[field]
        assert normalize(item, "remotive") is None, field


def test_normalize_rejects_invalid_values() -> None:
    assert normalize(remotive_item(url="javascript:alert(1)"), "remotive") is None
    assert normalize(remotive_item(publication_date="yesterday"), "remotive") is None
    assert normalize(remotive_item(title="   "), "remotive") is None
    assert normalize(remotive_item(id=True), "remotive") is None
    assert normalize("not an object", "remotive") is None


def test_content_hash_is_stable_for_the_same_job() -> None:
    first = normalize(remotive_item(), "remotive")
    second = normalize(remotive_item(), "remotive")
    assert first is not None and second is not None
    assert content_hash(first) == content_hash(second)


def test_content_hash_ignores_key_order_in_the_input() -> None:
    item = remotive_item()
    reversed_item = dict(reversed(list(item.items())))
    first = normalize(item, "remotive")
    second = normalize(reversed_item, "remotive")
    assert first is not None and second is not None
    assert content_hash(first) == content_hash(second)


def test_content_hash_changes_when_the_description_changes() -> None:
    first = normalize(remotive_item(), "remotive")
    second = normalize(remotive_item(description="<p>Build APIs.</p>"), "remotive")
    assert first is not None and second is not None
    assert content_hash(first) != content_hash(second)
