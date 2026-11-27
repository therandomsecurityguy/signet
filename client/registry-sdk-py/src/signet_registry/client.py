"""Minimal read client for the Signet registry API (stdlib transport).

The client deliberately stays small: fetch content-addressed artifact bytes
and verify them locally (re-hash + ``Content-Digest`` header). Everything
else — envelopes, signatures, inclusion proofs — stays verifiable without a
client library because the helpers in :mod:`signet_registry.verify` operate
on plain bytes.
"""

from __future__ import annotations

import base64
import json
import re
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any, Callable, Mapping, Optional

from .verify import sha256_hex

_SHA256_PATTERN = re.compile(r"^[0-9a-f]{64}$")
_ARTIFACT_URN_PATTERN = re.compile(r"^urn:sg:artifact:sha256:([0-9a-f]{64})$")
# RFC 9530 Content-Digest structured field: sha-256=:BASE64:
_CONTENT_DIGEST_PATTERN = re.compile(r"sha-256=:([^:]+):")


class RegistryClientError(Exception):
    """Raised for HTTP-level failures against the registry API."""

    def __init__(self, message: str, status: int, code: Optional[str] = None):
        super().__init__(message)
        self.status = status
        self.code = code


@dataclass(frozen=True)
class ArtifactFetch:
    sha256: str
    content: bytes
    digest_verified: bool
    content_digest: Optional[str] = None


def parse_artifact_sha256(urn: str) -> Optional[str]:
    match = _ARTIFACT_URN_PATTERN.match(urn)
    return match.group(1) if match else None


def content_digest_matches(header: str, sha256_hex_value: str) -> bool:
    match = _CONTENT_DIGEST_PATTERN.search(header)
    if not match:
        return True
    expected = base64.b64encode(bytes.fromhex(sha256_hex_value)).decode("ascii")
    return match.group(1) == expected


class RegistryClient:
    """Read client for one registry deployment.

    ``headers`` can carry deployment-specific requirements, e.g. the
    Cloudflare Access service-token headers for the deployed tunnels.
    ``opener`` overrides the stdlib transport (tests, custom agents).
    """

    def __init__(
        self,
        base_url: str,
        *,
        api_token: Optional[str] = None,
        headers: Optional[Mapping[str, str]] = None,
        timeout: float = 30.0,
        opener: Optional[Callable[[urllib.request.Request], Any]] = None,
    ):
        self.base_url = base_url.rstrip("/")
        self._api_token = api_token
        self._headers = dict(headers or {})
        self._timeout = timeout
        self._opener = opener or (lambda request: urllib.request.urlopen(request, timeout=timeout))

    def fetch_artifact(
        self,
        *,
        sha256: Optional[str] = None,
        artifact_urn: Optional[str] = None,
    ) -> ArtifactFetch:
        """Fetch artifact bytes and verify them locally.

        The bytes are re-hashed and compared with the requested digest, and
        with the ``Content-Digest`` header when the server sends one.
        ``digest_verified == False`` means the bytes must not be trusted.
        """
        digest = sha256 if sha256 is not None else (parse_artifact_sha256(artifact_urn) if artifact_urn else None)
        if not digest or not _SHA256_PATTERN.match(digest):
            raise RegistryClientError("A sha256 or artifact_urn is required.", 400)
        request = urllib.request.Request(f"{self.base_url}/v1/artifacts/{digest}", method="GET")
        request.add_header("accept", "*/*")
        if self._api_token:
            request.add_header("authorization", f"Bearer {self._api_token}")
        for key, value in self._headers.items():
            request.add_header(key, value)
        try:
            with self._opener(request) as response:
                content = response.read()
                content_digest = response.headers.get("content-digest")
        except urllib.error.HTTPError as error:
            message = f"Artifact fetch failed ({error.code})"
            code: Optional[str] = None
            try:
                body = json.loads(error.read().decode("utf-8"))
                message = body.get("error", {}).get("message", message)
                code = body.get("error", {}).get("code")
            except Exception:
                pass
            raise RegistryClientError(message, error.code, code) from error
        header_matches = content_digest_matches(content_digest, digest) if content_digest else True
        return ArtifactFetch(
            sha256=digest,
            content=content,
            digest_verified=sha256_hex(content) == digest and header_matches,
            content_digest=content_digest,
        )
