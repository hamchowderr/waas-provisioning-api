#!/usr/bin/env python3
"""A stand-in for the few Cloudflare DNS calls the installer makes, for its CI run.

    cloudflare-mock.py PORT ZONE [ZONE ...]

Serves /client/v4/zones and /client/v4/zones/<id>/dns_records (list by name, create, patch).
GET /state answers the records and how many writes were made. api.<first zone> starts out as a
proxied record pointing elsewhere, so the installer has one record to correct.
"""
import json
import sys
import uuid
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import parse_qs, unquote, urlparse

PORT = int(sys.argv[1])
ZONES = {name: uuid.uuid4().hex for name in sys.argv[2:]}
RECORDS = {}
WRITES = []

first = sys.argv[2]
RECORDS["seed"] = {"id": "seed", "zone": ZONES[first], "type": "A", "name": f"api.{first}", "content": "192.0.2.1", "proxied": True}


class Handler(BaseHTTPRequestHandler):
    def reply(self, result, status=200):
        body = json.dumps({"success": status < 400, "errors": [] if status < 400 else [{"code": status, "message": result}], "result": result}).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def authorized(self):
        if self.headers.get("Authorization") != "Bearer ci-cloudflare-token":
            self.reply("Invalid API token", 403)
            return False
        return True

    def body(self):
        return json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")

    def do_GET(self):
        url = urlparse(self.path)
        query = parse_qs(url.query)
        parts = url.path.strip("/").split("/")
        if url.path == "/state":
            return self.reply({"records": list(RECORDS.values()), "writes": WRITES})
        if not self.authorized():
            return None
        if parts[2:] == ["zones"]:
            name = query.get("name", [""])[0]
            return self.reply([{"id": i, "name": n} for n, i in ZONES.items() if n == name])
        if len(parts) == 5 and parts[2] == "zones" and parts[4] == "dns_records":
            name = unquote(query.get("name", [""])[0])
            return self.reply([r for r in RECORDS.values() if r["zone"] == parts[3] and r["name"] == name])
        return self.reply("not found", 404)

    def do_POST(self):
        parts = urlparse(self.path).path.strip("/").split("/")
        if not self.authorized():
            return None
        record = self.body()
        record.update(id=uuid.uuid4().hex, zone=parts[3])
        RECORDS[record["id"]] = record
        WRITES.append(f"POST {record['name']}")
        return self.reply(record)

    def do_PATCH(self):
        parts = urlparse(self.path).path.strip("/").split("/")
        if not self.authorized():
            return None
        record = RECORDS[parts[5]]
        record.update(self.body())
        WRITES.append(f"PATCH {record['name']}")
        return self.reply(record)

    def log_message(self, *args):
        pass


HTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
