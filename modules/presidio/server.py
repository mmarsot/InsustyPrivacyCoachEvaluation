"""Presidio analyzer as a line server for the bench's Presidio baseline (src/systems/presidio.ts).

Reads one JSON request per line on stdin ({"id", "text", "language"}) and writes one JSON line per
request on stdout ({"id", "spans": [{"start", "end", "type", "score"}], "ms"}). The first line out is
{"ready": true, ...} once the analyzer is loaded.

It never reaches the network: sockets are disabled before anything else is imported, and
tldextract (which Presidio's e-mail recognizer calls, and which downloads the Public Suffix List by
default) is pinned to its bundled snapshot with no cache directory. Presidio is a baseline under
the same harness, never a component of the product.
"""

import json
import socket
import sys
import time


def _no_network(*_args, **_kwargs):
    raise OSError("network access is disabled for the Presidio baseline")


socket.socket.connect = _no_network  # type: ignore[method-assign]
socket.socket.connect_ex = _no_network  # type: ignore[method-assign]
socket.create_connection = _no_network  # type: ignore[assignment]
socket.getaddrinfo = _no_network  # type: ignore[assignment]

import tldextract  # noqa: E402

tldextract.extract = tldextract.TLDExtract(cache_dir=None, suffix_list_urls=(), fallback_to_snapshot=True)  # type: ignore[assignment]

import presidio_analyzer  # noqa: E402
from presidio_analyzer import AnalyzerEngine  # noqa: E402
from presidio_analyzer.nlp_engine import NlpEngineProvider  # noqa: E402
import spacy  # noqa: E402


def main() -> None:
    started = time.perf_counter()
    nlp = NlpEngineProvider(nlp_configuration={"nlp_engine_name": "spacy", "models": [{"lang_code": "en", "model_name": "en_core_web_sm"}]}).create_engine()
    analyzer = AnalyzerEngine(nlp_engine=nlp, supported_languages=["en"])
    analyzer.analyze(text="warm up jo@example.org", language="en")
    version = getattr(presidio_analyzer, "__version__", None)
    if version is None:
        from importlib.metadata import version as dist_version

        version = dist_version("presidio-analyzer")
    print(json.dumps({"ready": True, "presidio": version, "spacy": spacy.__version__, "model": "en_core_web_sm", "python": sys.version.split()[0], "loadMs": (time.perf_counter() - started) * 1000}), flush=True)
    for line in sys.stdin:
        if not line.strip():
            continue
        request = json.loads(line)
        t0 = time.perf_counter()
        # The default registry is English; every text runs through it, as Presidio ships.
        results = analyzer.analyze(text=request["text"], language="en")
        spans = [{"start": r.start, "end": r.end, "type": r.entity_type, "score": r.score} for r in results]
        print(json.dumps({"id": request["id"], "spans": spans, "ms": (time.perf_counter() - t0) * 1000}), flush=True)


if __name__ == "__main__":
    main()
