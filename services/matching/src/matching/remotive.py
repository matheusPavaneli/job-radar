import hashlib
import json
import urllib.request
from dataclasses import dataclass
from datetime import UTC, datetime
from html.parser import HTMLParser

FEED_URL = "https://remotive.com/api/remote-jobs"
MAX_BYTES = 20 * 1024 * 1024
TIMEOUT_SECONDS = 30

_BLOCK_TAGS = frozenset({"p", "div", "br", "li", "ul", "ol", "h1", "h2", "h3", "h4", "h5", "h6", "tr", "section"})
_SKIPPED_TAGS = frozenset({"script", "style"})


@dataclass(frozen=True)
class Job:
    source: str
    external_id: str
    title: str
    company: str
    url: str
    location: str | None
    tags: tuple[str, ...]
    description: str
    published_at: datetime


def fetch_jobs() -> list[object]:
    request = urllib.request.Request(FEED_URL, headers={"User-Agent": "job-radar"})
    with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS) as response:
        body: bytes = response.read(MAX_BYTES + 1)
    if len(body) > MAX_BYTES:
        raise ValueError(f"Remotive response exceeds {MAX_BYTES} bytes")
    payload: object = json.loads(body)
    jobs = payload.get("jobs") if isinstance(payload, dict) else None
    if not isinstance(jobs, list):
        raise ValueError("Remotive response has no jobs list")
    return list(jobs)


def normalize(item: object, source: str) -> Job | None:
    if not isinstance(item, dict):
        return None
    external_id = _text(item.get("id"))
    title = _text(item.get("title"))
    company = _text(item.get("company_name"))
    url = _text(item.get("url"))
    published_at = _utc(item.get("publication_date"))
    description = item.get("description")
    if (
        external_id is None
        or title is None
        or company is None
        or url is None
        or not url.startswith("https://")
        or published_at is None
        or not isinstance(description, str)
    ):
        return None
    tags = item.get("tags")
    return Job(
        source=source,
        external_id=external_id,
        title=title,
        company=company,
        url=url,
        location=_text(item.get("candidate_required_location")),
        tags=tuple(tag.strip() for tag in tags if isinstance(tag, str) and tag.strip())
        if isinstance(tags, list)
        else (),
        description=html_to_text(description),
        published_at=published_at,
    )


def content_hash(job: Job) -> str:
    fields = [
        job.title,
        job.company,
        job.url,
        job.location,
        list(job.tags),
        job.description,
        job.published_at.isoformat(),
    ]
    encoded = json.dumps(fields, ensure_ascii=False, separators=(",", ":")).encode()
    return hashlib.sha256(encoded).hexdigest()


def html_to_text(html: str) -> str:
    parser = _TextExtractor()
    parser.feed(html)
    parser.close()
    lines = (" ".join(line.split()) for line in "".join(parser.parts).splitlines())
    return "\n".join(line for line in lines if line)


class _TextExtractor(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self._skipping = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in _SKIPPED_TAGS:
            self._skipping += 1
        elif tag in _BLOCK_TAGS:
            self.parts.append("\n")

    def handle_endtag(self, tag: str) -> None:
        if tag in _SKIPPED_TAGS:
            self._skipping = max(0, self._skipping - 1)
        elif tag in _BLOCK_TAGS:
            self.parts.append("\n")

    def handle_data(self, data: str) -> None:
        if not self._skipping:
            self.parts.append(data)


def _text(value: object) -> str | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return str(value)
    if isinstance(value, str) and value.strip():
        return value.strip()
    return None


def _utc(value: object) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC)
