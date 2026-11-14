"""Only the Cloudflare gateway may talk to this server, once it is set up.

In production the browser never reaches Fly directly: it talks to the gateway Worker (gateway/), which signs users in
with WorkOS, checks their plan and credits in D1, and forwards the request here with a shared secret in the
`x-orro-gateway` header. With `ORRO_GATEWAY_SECRET` set, any request without that secret is refused, so nobody can
start a batch (and spend API credits) by calling orro-research.fly.dev directly. Without it (local development) the
server is open, as before.

`/api/health` stays open: Fly's health check calls it without the header. It only says which keys are set, never
their values.
"""

from __future__ import annotations

import hmac
import os

from starlette.types import ASGIApp, Receive, Scope, Send

HEADER = b"x-orro-gateway"
OPEN_PATHS = {"/api/health"}


class GatewayGuard:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        secret = os.environ.get("ORRO_GATEWAY_SECRET", "").strip()
        if not secret or scope["type"] not in ("http", "websocket") or scope.get("path") in OPEN_PATHS:
            await self.app(scope, receive, send)
            return
        sent = dict(scope.get("headers") or []).get(HEADER, b"")
        if hmac.compare_digest(sent, secret.encode()):
            await self.app(scope, receive, send)
            return
        if scope["type"] == "websocket":
            await send({"type": "websocket.close", "code": 4403})
            return
        body = b'{"detail":"Use the Orro site: this server only answers its gateway."}'
        await send({
            "type": "http.response.start",
            "status": 403,
            "headers": [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode())],
        })
        await send({"type": "http.response.body", "body": body})
