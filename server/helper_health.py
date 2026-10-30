"""Cheap capability discovery shared by the full and download-only helpers."""
import json
from http import HTTPStatus


async def process_request(connection, request):
    path = connection if isinstance(connection, str) else request.path
    if path != "/health":
        return None
    body = json.dumps({"cpu_audio": True, "protocol": 1}).encode()
    headers = [("Content-Type", "application/json"), ("Access-Control-Allow-Origin", "*"),
               ("Cross-Origin-Resource-Policy", "cross-origin"),
               ("Content-Length", str(len(body)))]
    if isinstance(connection, str):  # websockets 12/13 legacy API
        return HTTPStatus.OK, headers, body
    from websockets.http11 import Response
    from websockets.datastructures import Headers
    return Response(200, "OK", Headers(headers), body)
