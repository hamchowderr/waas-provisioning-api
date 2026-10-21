#!/usr/bin/env python3
"""A stand-in for the Hostinger VPS API calls `anypress-install.sh hostinger` makes, for its CI run.

    hostinger-mock.py PORT SCRIPT_OUT

Has one purchased, not yet set up VPS (id 1001). Setting it up saves the post-install script it names to
SCRIPT_OUT, the way Hostinger writes /post_install, and the VPS is running two reads later.
GET /state answers the requests made and the scripts left in the account.
"""
import json
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlparse

PORT = int(sys.argv[1])
SCRIPT_OUT = sys.argv[2]
VM = {"id": 1001, "hostname": "srv1001.hstgr.cloud", "plan": "KVM 8", "state": "initial", "data_center_id": 17,
      "ipv4": [{"id": 1, "address": "203.0.113.10", "ptr": None}], "template": None}
TEMPLATES = [{"id": 1121, "name": "Ubuntu 24.04 with Coolify"}, {"id": 1077, "name": "Ubuntu 24.04 LTS"},
             {"id": 1002, "name": "Ubuntu 22.04 LTS"}, {"id": 1130, "name": "Ubuntu 24.04 with CloudPanel"}]
SCRIPTS = {}
REQUESTS = []
reads = {"left": None}


class Handler(BaseHTTPRequestHandler):
    def reply(self, body, status=200):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def handle_any(self, method):
        path = urlparse(self.path).path
        if path == "/state":
            return self.reply({"requests": REQUESTS, "scripts": list(SCRIPTS.values()), "vm": VM})
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
        REQUESTS.append({"method": method, "path": path, "body": {k: v for k, v in body.items() if k != "content"}})
        if self.headers.get("Authorization") != "Bearer ci-hostinger-token":
            return self.reply({"message": "Unauthenticated."}, 401)
        vm_path = f"/api/vps/v1/virtual-machines/{VM['id']}"
        if method == "GET" and path == "/api/vps/v1/virtual-machines":
            return self.reply([VM])
        if method == "GET" and path == vm_path:
            if reads["left"] is not None:
                reads["left"] -= 1
                if reads["left"] <= 0:
                    VM["state"] = "running"
            return self.reply(VM)
        if method == "GET" and path == "/api/vps/v1/templates":
            return self.reply(TEMPLATES)
        if method == "POST" and path == "/api/vps/v1/post-install-scripts":
            if len(body["content"].encode()) > 48 * 1024:
                return self.reply({"message": "The content may not be greater than 48 kilobytes."}, 422)
            script = {"id": 500 + len(REQUESTS), "name": body["name"], "content": body["content"]}
            SCRIPTS[script["id"]] = script
            return self.reply(script)
        if method == "DELETE" and path.startswith("/api/vps/v1/post-install-scripts/"):
            SCRIPTS.pop(int(path.rsplit("/", 1)[1]), None)
            return self.reply({"message": "Request accepted"})
        if method == "POST" and path == vm_path + "/setup":
            if VM["state"] != "initial":
                return self.reply({"message": "Virtual machine is already set up."}, 422)
            with open(SCRIPT_OUT, "w") as f:
                f.write(SCRIPTS[body["post_install_script_id"]]["content"])
            VM.update(state="creating", data_center_id=body["data_center_id"],
                      template=next(t for t in TEMPLATES if t["id"] == body["template_id"]))
            reads["left"] = 2
            return self.reply(VM)
        return self.reply({"message": "Not found"}, 404)

    def do_GET(self):
        self.handle_any("GET")

    def do_POST(self):
        self.handle_any("POST")

    def do_DELETE(self):
        self.handle_any("DELETE")

    def log_message(self, *args):
        pass


HTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
