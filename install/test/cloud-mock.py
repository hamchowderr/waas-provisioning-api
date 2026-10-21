#!/usr/bin/env python3
"""A stand-in for the Hetzner Cloud and DigitalOcean API calls `anypress-install.sh hetzner` and
`anypress-install.sh digitalocean` make, for their CI run.

    cloud-mock.py PORT OUT_DIR

Serves Hetzner under /hetzner/v1 and DigitalOcean under /digitalocean/v2. A new server's user data is
saved to OUT_DIR/<provider>-user-data, and the server is running on its second read.
GET /state answers the requests made.
"""
import json
import os
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import parse_qs, urlparse

PORT = int(sys.argv[1])
OUT = sys.argv[2]
REQUESTS = []
SERVERS = {"hetzner": {}, "digitalocean": {}}
TOKENS = {"hetzner": "Bearer ci-hetzner-token", "digitalocean": "Bearer ci-digitalocean-token"}
SERVER_TYPES = [{"name": "cx22", "cores": 2, "memory": 4, "disk": 40, "architecture": "x86", "deprecation": None},
                {"name": "cpx41", "cores": 8, "memory": 16, "disk": 240, "architecture": "x86", "deprecation": None}]


class Handler(BaseHTTPRequestHandler):
    def reply(self, body, status=200):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def handle_any(self, method):
        url = urlparse(self.path)
        if url.path == "/state":
            return self.reply({"requests": REQUESTS})
        query = parse_qs(url.query)
        parts = url.path.strip("/").split("/")
        provider, rest = parts[0], parts[2:]
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
        REQUESTS.append({"provider": provider, "method": method, "path": "/" + "/".join(rest),
                         "body": {k: v for k, v in body.items() if k != "user_data"}})
        if provider not in TOKENS or self.headers.get("Authorization") != TOKENS[provider]:
            return self.reply({"message": "unauthorized", "error": {"message": "unauthorized"}}, 401)
        servers = SERVERS[provider]
        key = "servers" if provider == "hetzner" else "droplets"
        one = "server" if provider == "hetzner" else "droplet"
        if method == "GET" and rest == [key]:
            name = query.get("name", [""])[0]
            return self.reply({key: [s for s in servers.values() if s["name"] == name]})
        if method == "GET" and rest == ["server_types"] and provider == "hetzner":
            return self.reply({"server_types": SERVER_TYPES})
        if method == "POST" and rest == [key]:
            with open(os.path.join(OUT, f"{provider}-user-data"), "w") as f:
                f.write(body["user_data"])
            sid = 4000 + len(servers)
            if provider == "hetzner":
                server = {"id": sid, "name": body["name"], "status": "initializing",
                          "public_net": {"ipv4": {"ip": "198.51.100.20"}}, "reads": 0}
                servers[sid] = server
                return self.reply({"server": server, "action": {"id": 1, "status": "running"}, "root_password": "ci-root-pw"}, 201)
            server = {"id": sid, "name": body["name"], "status": "new", "networks": {"v4": []}, "reads": 0}
            servers[sid] = server
            return self.reply({"droplet": server}, 202)
        if method == "GET" and len(rest) == 2 and rest[0] == key and int(rest[1]) in servers:
            server = servers[int(rest[1])]
            server["reads"] += 1
            if server["reads"] >= 2:
                if provider == "hetzner":
                    server["status"] = "running"
                else:
                    server.update(status="active", networks={"v4": [{"type": "private", "ip_address": "10.0.0.5"},
                                                                    {"type": "public", "ip_address": "198.51.100.30"}]})
            return self.reply({one: server})
        return self.reply({"message": "not found", "error": {"message": "not found"}}, 404)

    def do_GET(self):
        self.handle_any("GET")

    def do_POST(self):
        self.handle_any("POST")

    def log_message(self, *args):
        pass


HTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
