#!/usr/bin/env bash
# Builds a new store from the template the way the API does, and checks it loads as every site type.
#
#   templates/anypress-store/restore-check.sh <anypress-store.zip> [site type ...]
#
# Starts the store's own compose file (src/provisioner/coolify/compose.ts, size small, with Redis for the site types
# that get it) in Docker, restores the zip
# with the agent's own `restore` operation, then for each site type (the keys of roles.json when none are given)
# restarts WordPress with that ANYPRESS_TENANT_ROLES and checks the home page, a page through WordPress, the
# WordPress REST API and the store's MCP server answer, with no PHP fatal error in the logs. WordPress Playground has
# no web server, no MariaDB and no agent, so a store that only breaks on the server passes there. Needs Docker and Node 22.
set -euo pipefail

ZIP=$(realpath "$1")
shift
HERE=$(cd "$(dirname "$0")" && pwd)
API=$(cd "$HERE/../.." && pwd)
TYPES=("$@")
[ ${#TYPES[@]} -gt 0 ] || mapfile -t TYPES < <(node -e "console.log(Object.keys(require('$HERE/roles.json')).join('\n'))")
WORK=$(mktemp -d)
PROJECT=anypress-restore-check
PORT=${PORT:-18080}
trap 'docker compose -p "$PROJECT" -f "$WORK/compose.yml" down -v >/dev/null 2>&1 || true; rm -rf "$WORK"' EXIT

compose() {
    # The store's compose file with Coolify's variables filled in, the site type as its only phpConstant and a port.
    node --experimental-strip-types --no-warnings --input-type=module - "$1" "$PORT" > "$WORK/compose.yml" <<'JS'
const { parse, stringify } = await import(process.env.API + '/node_modules/yaml/dist/index.js');
const { renderCompose, encodeConstants } = await import(process.env.API + '/src/provisioner/coolify/compose.ts');
const [type, port] = process.argv.slice(2);
// Community and everything stores have their own Redis, as the API gives them (CACHED_SITE_TYPES in provisioner.ts).
const doc = parse(renderCompose({ wordPressVersion: '7.1', phpVersion: '8.3', size: 'small', cache: ['community', 'everything'].includes(type) }));
const values = {
  SERVICE_PASSWORD_DB: 'check', SERVICE_PASSWORD_ROOT: 'check-root',
  WAAS_CONSTANTS_B64: encodeConstants({ ANYPRESS_TENANT_ROLES: { value: type } }),
};
for (const service of Object.values(doc.services)) {
  for (const [name, value] of Object.entries(service.environment ?? {})) {
    if (typeof value === 'string') service.environment[name] = value.replace(/\$\{(\w+)(:-)?\}/g, (_, v) => values[v] ?? '');
  }
}
doc.services.wordpress.ports = [`${port}:80`];
process.stdout.write(stringify(doc));
JS
}

fail() { echo "restore check: $*" >&2; docker compose -p "$PROJECT" -f "$WORK/compose.yml" logs --tail 50 wordpress php agent >&2 || true; exit 1; }

export API
compose "${TYPES[0]}"
docker compose -p "$PROJECT" -f "$WORK/compose.yml" up -d --wait --wait-timeout 300 --remove-orphans >/dev/null 2>&1
docker compose -p "$PROJECT" -f "$WORK/compose.yml" cp "$ZIP" agent:/tmp/template.zip >/dev/null
ARGS=$(printf '{"url":"file:///tmp/template.zip","home":"http://localhost:%s"}' "$PORT" | base64 -w0)
docker compose -p "$PROJECT" -f "$WORK/compose.yml" exec -T agent php /tmp/waas-agent.php restore "$ARGS" | grep -q '^WAAS_RESULT {"database":true,"content":true' \
    || fail "the agent could not restore the template"

for type in "${TYPES[@]}"; do
    compose "$type"
    docker compose -p "$PROJECT" -f "$WORK/compose.yml" up -d --wait --wait-timeout 300 --remove-orphans >/dev/null 2>&1
    for path in / "/?restore-check=$type" /wp-json/ /wp-json/mcp/anypress; do
        # Twice: a plugin a site type switches on is switched on during the first request.
        curl -s -o /dev/null "http://localhost:$PORT$path" || true
        code=$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:$PORT$path")
        case "$path:$code" in
            /wp-json/mcp/anypress:401 | /wp-json/mcp/anypress:403 | /wp-json/mcp/anypress:405) ;; # the MCP server is there and wants a login
            *:200) ;;
            *) fail "$type: $path answered $code" ;;
        esac
    done
    if docker compose -p "$PROJECT" -f "$WORK/compose.yml" logs wordpress php agent 2>&1 | grep -q 'PHP Fatal error'; then
        fail "$type: PHP fatal error"
    fi
    echo "$type: ok, restored by the agent and served by the store's own containers"
done
