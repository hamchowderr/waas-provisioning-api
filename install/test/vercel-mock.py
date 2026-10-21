#!/usr/bin/env python3
"""A stand-in for the Vercel API calls the installer makes to put the dashboard on Vercel, for its CI run.

    vercel-mock.py PORT

Projects, their settings and domains, file uploads (checked against their SHA-1) and deployments, which are
ready on their second read and fail when a file they list wasn't uploaded. GET /state answers what was made.
"""
import hashlib
import json
import sys
import uuid
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import parse_qs, urlparse

PORT = int(sys.argv[1])
PROJECTS = {}
FILES = {}
DEPLOYMENTS = {}
ENV = {}
DOMAINS = {}


def project(key):
    return PROJECTS.get(key) or next((p for p in PROJECTS.values() if p["name"] == key), None)


class Handler(BaseHTTPRequestHandler):
    def reply(self, body, status=200):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def error(self, status, code, message):
        return self.reply({"error": {"code": code, "message": message}}, status)

    def handle_any(self, method):
        url = urlparse(self.path)
        if url.path == "/state":
            return self.reply({"projects": list(PROJECTS.values()), "env": ENV, "domains": DOMAINS,
                               "files": len(FILES), "deployments": list(DEPLOYMENTS.values())})
        if self.headers.get("Authorization") != "Bearer ci-vercel-token":
            return self.error(403, "forbidden", "Not authorized")
        if parse_qs(url.query).get("teamId", ["team_ci"])[0] != "team_ci":
            return self.error(403, "forbidden", "Not a member of this team")
        raw = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        p = url.path.strip("/").split("/")
        if method == "POST" and p == ["v2", "files"]:
            if hashlib.sha1(raw).hexdigest() != self.headers.get("x-vercel-digest"):
                return self.error(400, "invalid_digest", "The file's SHA-1 doesn't match")
            FILES[self.headers["x-vercel-digest"]] = len(raw)
            return self.reply({})
        body = json.loads(raw or b"{}")
        if method == "GET" and p[:2] == ["v9", "projects"] and len(p) == 3:
            found = project(p[2])
            return self.reply(found) if found else self.error(404, "not_found", "Project not found")
        if method == "POST" and p == ["v11", "projects"]:
            new = {"id": "prj_" + uuid.uuid4().hex[:12], "name": body["name"], "framework": body.get("framework")}
            PROJECTS[new["id"]] = new
            return self.reply(new)
        if method == "POST" and p[:2] == ["v10", "projects"] and p[3:] == ["env"]:
            for var in body:
                ENV.setdefault(p[2], {})[var["key"]] = var["type"]
            return self.reply({"created": body})
        if method == "GET" and p[:2] == ["v9", "projects"] and p[3:4] == ["domains"]:
            ok = p[4] in DOMAINS.get(p[2], [])
            return self.reply({"name": p[4]}) if ok else self.error(404, "not_found", "Domain not found")
        if method == "POST" and p[:2] == ["v10", "projects"] and p[3:] == ["domains"]:
            DOMAINS.setdefault(p[2], []).append(body["name"])
            return self.reply({"name": body["name"]})
        if method == "POST" and p == ["v13", "deployments"]:
            missing = [f["sha"] for f in body["files"] if f["sha"] not in FILES]
            if missing:
                return self.error(400, "missing_files", f"{len(missing)} files not uploaded")
            dep = {"id": "dpl_" + uuid.uuid4().hex[:12], "projectId": body["project"], "target": body["target"],
                   "readyState": "BUILDING", "files": len(body["files"]),
                   "has_package_json": any(f["file"] == "package.json" for f in body["files"]), "reads": 0}
            DEPLOYMENTS[dep["id"]] = dep
            return self.reply(dep)
        if method == "GET" and p[:2] == ["v13", "deployments"] and p[2] in DEPLOYMENTS:
            dep = DEPLOYMENTS[p[2]]
            dep["reads"] += 1
            if dep["reads"] >= 2:
                dep["readyState"] = "READY"
            return self.reply(dep)
        if method == "GET" and p == ["v6", "deployments"]:
            pid = parse_qs(url.query).get("projectId", [""])[0]
            deps = [{"uid": d["id"], "state": d["readyState"]} for d in DEPLOYMENTS.values() if d["projectId"] == pid]
            return self.reply({"deployments": deps[::-1][:1]})
        return self.error(404, "not_found", "Not found")

    def do_GET(self):
        self.handle_any("GET")

    def do_POST(self):
        self.handle_any("POST")

    def log_message(self, *args):
        pass


HTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
