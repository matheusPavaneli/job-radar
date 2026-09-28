from collections.abc import Sequence

from fastembed import TextEmbedding

MODEL = "BAAI/bge-small-en-v1.5"
DIMENSIONS = 384


class Embedder:
    def __init__(self) -> None:
        self._model: TextEmbedding | None = None

    def __call__(self, texts: Sequence[str]) -> list[list[float]]:
        if self._model is None:
            self._model = TextEmbedding(model_name=MODEL)
        return [[float(value) for value in vector] for vector in self._model.embed(list(texts))]
