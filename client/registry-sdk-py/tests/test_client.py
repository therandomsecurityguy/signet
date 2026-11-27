from __future__ import annotations

import base64
import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest

from signet_registry import (
    RegistryClient,
    RegistryClientError,
    content_digest_matches,
    parse_artifact_sha256,
    sha256_hex,
)


class FixtureHandler(BaseHTTPRequestHandler):
    content = b"# fixture artifact\n"
    sha = sha256_hex(content)

    def do_GET(self):  # noqa: N802 (stdlib naming)
        if self.path == f"/v1/artifacts/{self.sha}":
            self.send_response(200)
            self.send_header("content-type", "text/markdown")
            self.send_header(
                "content-digest",
                f"sha-256=:{base64.b64encode(bytes.fromhex(self.sha)).decode('ascii')}:",
            )
            self.end_headers()
            self.wfile.write(self.content)
            return
        if self.path == f"/v1/artifacts/{'c' * 64}":
            # Digest-verified but deliberately wrong bytes for the requested digest.
            self.send_response(200)
            self.send_header(
                "content-digest",
                f"sha-256=:{base64.b64encode(bytes.fromhex('c' * 64)).decode('ascii')}:",
            )
            self.end_headers()
            self.wfile.write(b"wrong bytes")
            return
        if self.path == f"/v1/artifacts/{'d' * 64}":
            body = json.dumps({"error": {"code": "ARTIFACT_NOT_FOUND", "message": "Artifact not found."}}).encode()
            self.send_response(404)
            self.send_header("content-type", "application/json")
            self.end_headers()
            self.wfile.write(body)
            return
        self.send_response(400)
        self.end_headers()

    def log_message(self, *_args):  # silence test output
        return


@pytest.fixture()
def server():
    httpd = HTTPServer(("127.0.0.1", 0), FixtureHandler)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{httpd.server_port}"
    httpd.shutdown()
    thread.join(timeout=5)


class TestHelpers:
    def test_parse_artifact_sha256(self):
        sha = "a1" * 32
        assert parse_artifact_sha256(f"urn:sg:artifact:sha256:{sha}") == sha
        assert parse_artifact_sha256("urn:sg:artifact:sha256:zz") is None
        assert parse_artifact_sha256(sha) is None

    def test_content_digest_matches(self):
        sha = "ab" * 32
        header = f"sha-256=:{base64.b64encode(bytes.fromhex(sha)).decode('ascii')}:"
        assert content_digest_matches(header, sha)
        assert not content_digest_matches(header, "cd" * 32)
        # Header without a sha-256 field is treated as absent (match).
        assert content_digest_matches("unparseable", sha)


class TestFetchArtifact:
    def test_verifies_bytes_and_header(self, server):
        client = RegistryClient(server)
        result = client.fetch_artifact(sha256=FixtureHandler.sha)
        assert result.digest_verified
        assert result.content == FixtureHandler.content
        assert result.content_digest is not None

        by_urn = client.fetch_artifact(artifact_urn=f"urn:sg:artifact:sha256:{FixtureHandler.sha}")
        assert by_urn.digest_verified
        assert by_urn.content == FixtureHandler.content

    def test_flags_wrong_bytes(self, server):
        client = RegistryClient(server)
        result = client.fetch_artifact(sha256="c" * 64)
        assert not result.digest_verified

    def test_requires_a_target(self, server):
        client = RegistryClient(server)
        with pytest.raises(RegistryClientError) as excinfo:
            client.fetch_artifact()
        assert excinfo.value.status == 400

    def test_maps_http_errors(self, server):
        client = RegistryClient(server)
        with pytest.raises(RegistryClientError) as excinfo:
            client.fetch_artifact(sha256="d" * 64)
        assert excinfo.value.status == 404
        assert excinfo.value.code == "ARTIFACT_NOT_FOUND"
        assert "Artifact not found." in str(excinfo.value)
