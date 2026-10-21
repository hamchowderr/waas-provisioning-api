#!/usr/bin/env bash
# Sets up AnyPress on one fresh Ubuntu server: Coolify, the provisioning API with its Postgres, the
# dashboard, the store templates, a ready-made storefront and the Coolify cleanup job. Safe to run again:
# each step finds what it made before.
#
#   sudo bash anypress-install.sh            install, using /root/anypress.env (see anypress.env.example)
#   sudo bash anypress-install.sh check      check an install
#   bash anypress-install.sh hostinger       from your computer: set up a Hostinger VPS that installs itself,
#   bash anypress-install.sh hetzner         or make a Hetzner Cloud server or a DigitalOcean Droplet that does,
#   bash anypress-install.sh digitalocean    using ./anypress.env with the provider's token (install/README.md)
#
# Needs: root, Ubuntu 22.04 or 24.04, ports 80, 443 and 8000 free. Writes /root/anypress/ (state and
# credentials, readable by root only).
# shellcheck disable=SC1090  # the answers and state files are sourced from runtime paths
set -euo pipefail

ANSWERS=${ANYPRESS_ANSWERS:-/root/anypress.env}
STATE_DIR=/root/anypress
STATE=$STATE_DIR/state.env
CREDS=$STATE_DIR/credentials.env
COOLIFY=http://127.0.0.1:8000/api/v1
# Where the store templates are released (templates-v*, .github/workflows/release-templates.yml).
TEMPLATES_REPO=hamchowderr/waas-provisioning-api

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
info() { printf '  %s\n' "$*"; }
die() { printf '\n\033[31mStopped: %s\033[0m\n' "$*" >&2; exit 1; }

# Saves KEY=value in a state file, replacing an earlier value.
remember() {
  local file=$1 key=$2 value=$3 line
  touch "$file" && chmod 600 "$file"
  line=$(printf '%s=%q' "$key" "$value")
  grep -qxF "$line" "$file" && return
  grep -v "^$key=" "$file" > "$file.tmp" || true
  printf '%s\n' "$line" >> "$file.tmp"
  mv "$file.tmp" "$file"
}

random_secret() { openssl rand -base64 32; }
random_hex() { openssl rand -hex 24; }

# Reads the answers file and stops when a required answer is missing.
answers() {
  [ -f "$ANSWERS" ] || die "no answers file at $ANSWERS. Copy install/anypress.env.example there and fill it in."
  set -a
  . "$ANSWERS"
  set +a
  : "${ANYPRESS_BRAND_DOMAIN:?set ANYPRESS_BRAND_DOMAIN in $ANSWERS}"
  : "${ANYPRESS_STORE_DOMAIN:?set ANYPRESS_STORE_DOMAIN in $ANSWERS}"
  : "${ANYPRESS_ADMIN_EMAIL:?set ANYPRESS_ADMIN_EMAIL in $ANSWERS}"
  local v
  for v in S3_ENDPOINT S3_BUCKET S3_ACCESS_KEY_ID S3_SECRET_ACCESS_KEY; do
    [ -n "${!v:-}" ] || die "set $v in $ANSWERS: the API keeps store templates, snapshots and backups in that bucket and won't start without it"
  done
}

load() {
  mkdir -p "$STATE_DIR" && chmod 700 "$STATE_DIR"
  answers
  set -a
  [ -f "$STATE" ] && . "$STATE"
  [ -f "$CREDS" ] && . "$CREDS"
  set +a
  COOLIFY_VERSION=${ANYPRESS_COOLIFY_VERSION:-4.4.6}
  API_REF=${ANYPRESS_API_REF:-main}
  DASHBOARD_REF=${ANYPRESS_DASHBOARD_REF:-main}
  CLOUDFLARE=${ANYPRESS_CLOUDFLARE_API:-https://api.cloudflare.com/client/v4}
  VERCEL=${ANYPRESS_VERCEL_API:-https://api.vercel.com}
  API_URL=https://api.$ANYPRESS_BRAND_DOMAIN
  DASHBOARD_URL=https://app.$ANYPRESS_BRAND_DOMAIN
}

# Calls Coolify's API: coolify METHOD PATH [JSON]. Prints the response body; fails on an HTTP error.
coolify() {
  local method=$1 path=$2 body=${3:-} out code
  out=$(mktemp)
  code=$(curl -sS -o "$out" -w '%{http_code}' -X "$method" "$COOLIFY$path" \
    -H "Authorization: Bearer $COOLIFY_TOKEN" -H 'Content-Type: application/json' -H 'Accept: application/json' \
    ${body:+--data "$body"}) || { rm -f "$out"; die "Coolify did not answer $method $path"; }
  if [ "${code:0:1}" != 2 ]; then
    cat "$out" >&2; rm -f "$out"
    die "Coolify answered $code to $method $path"
  fi
  cat "$out"; rm -f "$out"
}

packages() {
  say "Checking the server"
  [ "$(id -u)" = 0 ] || die "run as root (sudo bash $0)"
  . /etc/os-release
  [ "${ID:-}" = ubuntu ] || info "This is $PRETTY_NAME; the installer is tested on Ubuntu 22.04 and 24.04."
  local missing=()
  for tool in curl jq openssl; do command -v "$tool" >/dev/null || missing+=("$tool"); done
  if [ ${#missing[@]} -gt 0 ]; then
    info "Installing ${missing[*]}"
    apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "${missing[@]}" >/dev/null
  fi
}

install_coolify() {
  say "Coolify"
  if docker ps --format '{{.Names}}' 2>/dev/null | grep -qx coolify; then
    info "Already installed: $(docker exec coolify php artisan --version 2>/dev/null || echo running)"
  else
    if [ -z "${ANYPRESS_COOLIFY_PASSWORD:-}" ]; then
      # Coolify wants upper and lower case, a digit and a symbol.
      ANYPRESS_COOLIFY_PASSWORD="Ap-$(openssl rand -hex 12)-X9"
      remember "$CREDS" ANYPRESS_COOLIFY_PASSWORD "$ANYPRESS_COOLIFY_PASSWORD"
    fi
    info "Installing Coolify $COOLIFY_VERSION (a few minutes)"
    curl -fsSL https://cdn.coollabs.io/coolify/install.sh -o /tmp/coolify-install.sh
    ROOT_USERNAME=admin ROOT_USER_EMAIL=$ANYPRESS_ADMIN_EMAIL ROOT_USER_PASSWORD=$ANYPRESS_COOLIFY_PASSWORD \
      bash /tmp/coolify-install.sh "$COOLIFY_VERSION" > "$STATE_DIR/coolify-install.log" 2>&1 \
      || { tail -30 "$STATE_DIR/coolify-install.log"; die "Coolify's installer failed (log: $STATE_DIR/coolify-install.log)"; }
    info "Installed"
  fi
  local _
  for _ in $(seq 1 60); do
    curl -sf http://127.0.0.1:8000/api/health >/dev/null && return
    sleep 5
  done
  die "Coolify did not come up on port 8000"
}

# Turns on Coolify's API and makes the token the API drives Coolify with, unless one was given.
coolify_token() {
  say "Coolify API"
  if [ -z "${COOLIFY_TOKEN:-}" ]; then
    info "Turning on API access and making a token"
    COOLIFY_TOKEN=$(docker exec coolify php artisan tinker --execute '
      $s = \App\Models\InstanceSettings::get(); $s->is_api_enabled = true; $s->save();
      $u = \App\Models\User::find(0) ?? \App\Models\User::orderBy("id")->first();
      $t = $u->teams()->orderBy("id")->first();
      session(["currentTeam" => $t]);
      echo "TOKEN=" . $u->createToken("AnyPress API", ["read", "read:sensitive", "write", "deploy"])->plainTextToken;
    ' 2>/dev/null | sed -n 's/^.*TOKEN=//p' | tail -1)
    [ -n "$COOLIFY_TOKEN" ] || die "could not make a Coolify API token. Make one in Coolify (Keys & Tokens → API tokens, with read, read:sensitive, write and deploy), put it in $ANSWERS as COOLIFY_TOKEN and run again."
    remember "$CREDS" COOLIFY_TOKEN "$COOLIFY_TOKEN"
  fi
  local version
  version=$(coolify GET /version) || die "the Coolify token was refused"
  info "Coolify $version answers"
  if [ -z "${SERVER_UUID:-}" ]; then
    SERVER_UUID=$(coolify GET /servers | jq -r 'map(select(.ip == "host.docker.internal" or .name == "localhost")) | .[0].uuid // empty')
    [ -n "$SERVER_UUID" ] || die "Coolify has no localhost server"
    remember "$STATE" SERVER_UUID "$SERVER_UUID"
  fi
}

# Prints the uuid of the Coolify project with this name, making it first if needed.
project() {
  local name=$1 uuid
  uuid=$(coolify GET /projects | jq -r --arg n "$name" 'map(select(.name == $n)) | .[0].uuid // empty')
  if [ -z "$uuid" ]; then
    uuid=$(coolify POST /projects "$(jq -nc --arg n "$name" '{name: $n}')" | jq -r .uuid)
  fi
  printf '%s' "$uuid"
}

projects() {
  say "Coolify projects"
  API_PROJECT=$(project "WaaS API"); remember "$STATE" API_PROJECT "$API_PROJECT"
  STORES_PROJECT=$(project "WaaS Stores"); remember "$STATE" STORES_PROJECT "$STORES_PROJECT"
  STOREFRONT_PROJECT=$(project "WaaS Storefront"); remember "$STATE" STOREFRONT_PROJECT "$STOREFRONT_PROJECT"
  info "WaaS API, WaaS Stores and WaaS Storefront are there"
}

database() {
  say "Postgres"
  if [ -n "${DB_UUID:-}" ] && coolify GET "/databases/$DB_UUID" >/dev/null 2>&1; then
    info "Already there"
    return
  fi
  local password response
  password=$(random_hex)
  response=$(coolify POST /databases/postgresql "$(jq -nc --arg s "$SERVER_UUID" --arg p "$API_PROJECT" --arg pw "$password" \
    '{server_uuid: $s, project_uuid: $p, environment_name: "production", name: "waas-api-db", image: "postgres:16-alpine",
      postgres_user: "waas", postgres_password: $pw, postgres_db: "waas", instant_deploy: true}')")
  DB_UUID=$(jq -r .uuid <<<"$response")
  DATABASE_URL=$(jq -r '.internal_db_url // empty' <<<"$response")
  [ -n "$DATABASE_URL" ] || DATABASE_URL="postgres://waas:$password@$DB_UUID:5432/waas"
  remember "$STATE" DB_UUID "$DB_UUID"
  remember "$CREDS" DATABASE_URL "$DATABASE_URL"
  info "Made waas-api-db"
}

# Makes a Coolify application from a public GitHub repository: app NAME REPO REF BUILD_PACK PORT DOMAIN.
app() {
  local name=$1 repo=$2 ref=$3 pack=$4 port=$5 domain=$6
  coolify POST /applications/public "$(jq -nc --arg s "$SERVER_UUID" --arg p "$API_PROJECT" --arg n "$name" \
    --arg r "$repo" --arg b "$ref" --arg k "$pack" --arg port "$port" --arg d "$domain" \
    '{server_uuid: $s, project_uuid: $p, environment_name: "production", name: $n, git_repository: $r, git_branch: $b,
      build_pack: $k, ports_exposes: $port, domains: $d, is_auto_deploy_enabled: false, instant_deploy: false}')" | jq -r .uuid
}

# Sets an application's environment from KEY=value lines on stdin (empty values are left out).
envs() {
  local uuid=$1
  coolify PATCH "/applications/$uuid/envs/bulk" \
    "$(jq -Rn '{data: [inputs | select(test("^[A-Z_0-9]+=.")) | capture("^(?<key>[A-Z_0-9]+)=(?<value>.*)$") | . + {is_literal: true}]}')" >/dev/null
}

# Deploys an application and waits for the build to finish.
deploy() {
  local uuid=$1 label=$2 deployment status
  deployment=$(coolify POST "/deploy?uuid=$uuid&force=false" | jq -r '.deployments[0].deployment_uuid')
  info "Building $label (this takes a few minutes)"
  for _ in $(seq 1 120); do
    status=$(coolify GET "/deployments/$deployment" | jq -r .status)
    case "$status" in
      finished) info "$label is deployed"; return ;;
      failed|cancelled-by-user) die "$label failed to build. See the deployment log in Coolify (WaaS API project)." ;;
    esac
    sleep 10
  done
  die "$label is still building after 20 minutes"
}

api() {
  say "Provisioning API"
  [ -n "${SECRETS_KEY:-}" ] || { SECRETS_KEY=$(random_secret); remember "$CREDS" SECRETS_KEY "$SECRETS_KEY"; }
  [ -n "${ADMIN_TOKEN:-}" ] || { ADMIN_TOKEN=$(random_secret); remember "$CREDS" ADMIN_TOKEN "$ADMIN_TOKEN"; }
  [ -n "${AUTH_SECRET:-}" ] || { AUTH_SECRET=$(random_secret); remember "$CREDS" AUTH_SECRET "$AUTH_SECRET"; }
  if [ -z "${API_UUID:-}" ]; then
    API_UUID=$(app waas-api https://github.com/hamchowderr/waas-provisioning-api "$API_REF" dockerfile 4111 "$API_URL")
    remember "$STATE" API_UUID "$API_UUID"
  fi
  local brand_domain=$ANYPRESS_BRAND_DOMAIN
  [ "$ANYPRESS_BRAND_DOMAIN" = "$ANYPRESS_STORE_DOMAIN" ] && brand_domain=
  envs "$API_UUID" <<EOF
DATABASE_URL=$DATABASE_URL
SECRETS_KEY=$SECRETS_KEY
ADMIN_TOKEN=$ADMIN_TOKEN
PROVISIONER=coolify
COOLIFY_URL=http://coolify:8080
COOLIFY_TOKEN=$COOLIFY_TOKEN
COOLIFY_SERVER_UUID=$SERVER_UUID
COOLIFY_PROJECT_UUID=$STORES_PROJECT
PLATFORM_DOMAIN=$ANYPRESS_STORE_DOMAIN
BRAND_DOMAIN=$brand_domain
STORES_DOMAIN=stores.$ANYPRESS_STORE_DOMAIN
VERSIONS_DOMAIN=versions.$ANYPRESS_STORE_DOMAIN
PUBLIC_URL=$API_URL
AUTH_URL=$DASHBOARD_URL
AUTH_SECRET=$AUTH_SECRET
AUTH_BRAND=${STORE_BRAND_NAME:-}
STORE_BRAND_NAME=${STORE_BRAND_NAME:-}
S3_ENDPOINT=${S3_ENDPOINT:-}
S3_BUCKET=${S3_BUCKET:-}
S3_ACCESS_KEY_ID=${S3_ACCESS_KEY_ID:-}
S3_SECRET_ACCESS_KEY=${S3_SECRET_ACCESS_KEY:-}
S3_REGION=${S3_REGION:-auto}
STORE_SMTP_PASSWORD=${STORE_SMTP_PASSWORD:-}
STORE_MAIL_FROM=${STORE_MAIL_FROM:-}
TOSEND_ADMIN_KEY=${TOSEND_ADMIN_KEY:-}
STOREFRONT_PRODUCT_ID=${READY_MADE_PRODUCT:-}
EOF
  deploy "$API_UUID" "the API"
  wait_healthy
  API_STOREFRONT_PRODUCT_ID=${READY_MADE_PRODUCT:-}
}

# The newest running container of a Coolify application.
container() { docker ps --filter "name=^$1" --format '{{.Names}}' | head -1; }

wait_healthy() {
  local name
  for _ in $(seq 1 30); do
    name=$(container "$API_UUID")
    if [ -n "$name" ] && docker exec "$name" wget -qO- http://127.0.0.1:4111/health >/dev/null 2>&1; then
      info "The API answers /health"
      return
    fi
    sleep 5
  done
  die "the API is not healthy. See its logs in Coolify (WaaS API → waas-api → Logs)."
}

dashboard() {
  say "Dashboard"
  if [ -n "${VERCEL_TOKEN:-}" ]; then dashboard_vercel; return; fi
  if [ -z "${DASHBOARD_UUID:-}" ]; then
    DASHBOARD_UUID=$(app waas-dashboard https://github.com/hamchowderr/waas-dashboard "$DASHBOARD_REF" nixpacks 3000 "$DASHBOARD_URL")
    remember "$STATE" DASHBOARD_UUID "$DASHBOARD_UUID"
  fi
  envs "$DASHBOARD_UUID" <<EOF
WAAS_API_URL=$API_URL
WAAS_ADMIN_TOKEN=$ADMIN_TOKEN
ALLOWED_ADMIN_EMAILS=$ANYPRESS_ADMIN_EMAIL
EOF
  deploy "$DASHBOARD_UUID" "the dashboard"
}

# Calls Vercel's API: vercel METHOD PATH [JSON]. Prints the response body; returns 1 on an HTTP error.
vercel() {
  local method=$1 path=$2 body=${3:-} out code sep='?'
  [[ $path == *\?* ]] && sep='&'
  [ -n "${VERCEL_TEAM_ID:-}" ] && path="$path${sep}teamId=$VERCEL_TEAM_ID"
  out=$(mktemp)
  code=$(curl -sS -o "$out" -w '%{http_code}' -X "$method" "$VERCEL$path" -H "Authorization: Bearer $VERCEL_TOKEN" \
    -H 'Content-Type: application/json' ${body:+--data-binary @-} <<<"$body") || code=000
  cat "$out"; rm -f "$out"
  [ "${code:0:1}" = 2 ]
}

# With VERCEL_TOKEN: the dashboard is a Vercel project in the client's account instead of a Coolify app. Its
# source is uploaded from the dashboard repository, so the account needs no access to our GitHub.
dashboard_vercel() {
  local name=${ANYPRESS_VERCEL_PROJECT:-anypress-dashboard} domain=app.$ANYPRESS_BRAND_DOMAIN src files out id state f sha _
  [ -z "${DASHBOARD_UUID:-}" ] || info "The dashboard was a Coolify app before; delete waas-dashboard in Coolify's WaaS API project."
  if [ -z "${VERCEL_PROJECT_ID:-}" ]; then
    out=$(vercel GET "/v9/projects/$name") || out=$(vercel POST /v11/projects "$(jq -nc --arg n "$name" '{name: $n, framework: "nextjs"}')") \
      || die "Vercel did not make the project $name: $(jq -r '.error.message // .' <<<"$out")"
    VERCEL_PROJECT_ID=$(jq -r .id <<<"$out")
    remember "$STATE" VERCEL_PROJECT_ID "$VERCEL_PROJECT_ID"
  fi
  info "Vercel project $name"
  out=$(vercel POST "/v10/projects/$VERCEL_PROJECT_ID/env?upsert=true" "$(jq -nc --arg u "$API_URL" --arg t "$ADMIN_TOKEN" --arg e "$ANYPRESS_ADMIN_EMAIL" \
    '[{key: "WAAS_API_URL", value: $u}, {key: "WAAS_ADMIN_TOKEN", value: $t}, {key: "ALLOWED_ADMIN_EMAILS", value: $e}]
     | map(. + {type: "encrypted", target: ["production", "preview"]})')") || die "Vercel did not take the settings: $out"
  vercel GET "/v9/projects/$VERCEL_PROJECT_ID/domains/$domain" >/dev/null \
    || out=$(vercel POST "/v10/projects/$VERCEL_PROJECT_ID/domains" "$(jq -nc --arg d "$domain" '{name: $d}')") \
    || die "Vercel did not add $domain: $(jq -r '.error.message // .' <<<"$out")"

  src=$(mktemp -d)
  curl -fsSL "https://codeload.github.com/hamchowderr/waas-dashboard/tar.gz/$DASHBOARD_REF" | tar xz -C "$src" --strip-components=1 \
    || die "could not download the dashboard ($DASHBOARD_REF)"
  rm -rf "$src/.beads" "$src/.github"
  files=$(mktemp)
  info "Uploading $(cd "$src" && find . -type f | wc -l) files"
  while IFS= read -r -d '' f; do
    sha=$(sha1sum "$src/$f" | cut -d' ' -f1)
    curl -fsS -o /dev/null -X POST "$VERCEL/v2/files${VERCEL_TEAM_ID:+?teamId=$VERCEL_TEAM_ID}" -H "Authorization: Bearer $VERCEL_TOKEN" \
      -H 'Content-Type: application/octet-stream' -H "x-vercel-digest: $sha" --data-binary @"$src/$f" || die "Vercel did not take $f"
    jq -nc --arg f "$f" --arg s "$sha" --argjson n "$(stat -c %s "$src/$f")" '{file: $f, sha: $s, size: $n}' >> "$files"
  done < <(cd "$src" && find . -type f -printf '%P\0')
  out=$(vercel POST /v13/deployments "$(jq -sc --arg n "$name" --arg p "$VERCEL_PROJECT_ID" \
    '{name: $n, project: $p, target: "production", files: ., projectSettings: {framework: "nextjs"}}' "$files")") \
    || die "Vercel did not start the deployment: $(jq -r '.error.message // .' <<<"$out")"
  rm -rf "$src" "$files"
  id=$(jq -r .id <<<"$out")
  info "Building on Vercel ($id)"
  for _ in $(seq 1 90); do
    state=$(vercel GET "/v13/deployments/$id" | jq -r '.readyState // .status') || true
    case "$state" in
      READY) info "Deployed: https://$domain"; return ;;
      ERROR|CANCELED) die "the dashboard's Vercel build failed; see the project's Deployments page on Vercel" ;;
    esac
    sleep 10
  done
  die "the dashboard is still building on Vercel after 15 minutes"
}

# Coolify keeps 60 days of scheduled task history and every store runs wp-cron each minute: keep 7.
cleanup_cron() {
  say "Coolify cleanup job"
  cat > /etc/cron.d/anypress-coolify-cleanup <<'EOF'
# AnyPress: keep 7 days of Coolify scheduled task history (docs/self-hosting.md).
23 4 * * * root docker exec coolify-db psql -U coolify -d coolify -c "DELETE FROM scheduled_task_executions WHERE created_at < now() - interval '7 days'" > /dev/null 2>&1
EOF
  chmod 644 /etc/cron.d/anypress-coolify-cleanup
  info "Runs daily at 04:23"
}

storefront_key() {
  say "Storefront API key"
  if [ -n "${STOREFRONT_KEY:-}" ]; then
    info "Already made"
    return
  fi
  local out
  out=$(docker exec "$(container "$API_UUID")" npm run -s create-key -- --product-name "Storefront")
  STOREFRONT_PRODUCT=$(sed -n 's/^product: *//p' <<<"$out")
  STOREFRONT_KEY=$(sed -n 's/^key: *//p' <<<"$out")
  STOREFRONT_SECRET=$(sed -n 's/^secret: *//p' <<<"$out")
  [ -n "$STOREFRONT_SECRET" ] || die "could not make the storefront's API key: $out"
  remember "$CREDS" STOREFRONT_PRODUCT "$STOREFRONT_PRODUCT"
  remember "$CREDS" STOREFRONT_KEY "$STOREFRONT_KEY"
  remember "$CREDS" STOREFRONT_SECRET "$STOREFRONT_SECRET"
  info "Made (in $CREDS)"
}

# Calls Cloudflare's API: cloudflare METHOD PATH [JSON]. Prints the result; fails when Cloudflare says it failed.
cloudflare() {
  local method=$1 path=$2 body=${3:-} out
  out=$(curl -sS -X "$method" "$CLOUDFLARE$path" -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
    -H 'Content-Type: application/json' ${body:+--data "$body"}) || die "Cloudflare did not answer $method $path"
  if [ "$(jq -r '.success // false' <<<"$out" 2>/dev/null)" != true ]; then
    jq -r '.errors[]? | "  \(.code): \(.message)"' <<<"$out" >&2 2>/dev/null || printf '%s\n' "$out" >&2
    die "Cloudflare refused $method $path (the token needs Zone:DNS:Edit on the zone)"
  fi
  jq -c .result <<<"$out"
}

# The id of the Cloudflare zone a name is in: the zone named like it or like the nearest parent domain.
cloudflare_zone() {
  local name=${1#\*.} id
  while [[ $name == *.* ]]; do
    # Runs in a command substitution, where a failed call doesn't stop the script by itself.
    id=$(cloudflare GET "/zones?name=$name") || exit 1
    id=$(jq -r '.[0].id // empty' <<<"$id")
    [ -n "$id" ] && { printf '%s' "$id"; return; }
    name=${name#*.}
  done
  die "no Cloudflare zone for $1 that the token can see"
}

# Sets a DNS-only record in Cloudflare (Traefik and Vercel get the certificates): dns_record NAME TYPE VALUE.
# A record of another type is changed only when the installer made it (comment "AnyPress").
dns_record() {
  local name=$1 type=$2 value=$3 zone existing record id current proxied other
  zone=$(cloudflare_zone "$name")
  existing=$(cloudflare GET "/zones/$zone/dns_records?name=$(jq -rn --arg n "$name" '$n | @uri')")
  other=$(jq -r --arg t "$type" '[.[] | select(.type != $t and .comment != "AnyPress")][0].type // empty' <<<"$existing")
  [ -z "$other" ] || die "$name already has a $other record in Cloudflare. Remove it, then run again."
  record=$(jq -c --arg t "$type" '([.[] | select(.type == $t)] + .)[0] // {}' <<<"$existing")
  id=$(jq -r '.id // empty' <<<"$record")
  current=$(jq -r '"\(.type) \(.content)"' <<<"$record")
  proxied=$(jq -r '.proxied // false' <<<"$record")
  if [ -z "$id" ]; then
    cloudflare POST "/zones/$zone/dns_records" "$(jq -nc --arg n "$name" --arg t "$type" --arg v "$value" \
      '{type: $t, name: $n, content: $v, ttl: 1, proxied: false, comment: "AnyPress"}')" >/dev/null
    info "Added $name"
  elif [ "$current" != "$type $value" ] || [ "$proxied" != false ]; then
    cloudflare PATCH "/zones/$zone/dns_records/$id" "$(jq -nc --arg t "$type" --arg v "$value" '{type: $t, content: $v, proxied: false}')" >/dev/null
    info "Pointed $name at $value (was $current$([ "$proxied" = true ] && echo ', proxied'))"
  else
    info "$name is set"
  fi
}

dns() {
  say "DNS"
  if [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
    info "No CLOUDFLARE_API_TOKEN: the records to add are printed at the end"
    return
  fi
  local ip name type value
  ip=$(public_ip)
  [ -n "$ip" ] || die "could not find this server's public IP address"
  while read -r type name value; do dns_record "$name" "$type" "$value"; done < <(dns_records "$ip")
}

# The records AnyPress needs, as TYPE NAME VALUE lines: dns_records IP. The dashboard is on Vercel with VERCEL_TOKEN.
dns_records() {
  local name
  for name in "*.$ANYPRESS_STORE_DOMAIN" "*.stores.$ANYPRESS_STORE_DOMAIN" "*.versions.$ANYPRESS_STORE_DOMAIN" "api.$ANYPRESS_BRAND_DOMAIN"; do
    printf 'A %s %s\n' "$name" "$1"
  done
  if [ -n "${VERCEL_TOKEN:-}" ]; then
    printf 'CNAME %s cname.vercel-dns.com\n' "app.$ANYPRESS_BRAND_DOMAIN"
  else
    printf 'A %s %s\n' "app.$ANYPRESS_BRAND_DOMAIN" "$1"
  fi
}

# Calls the provisioning API from this server, past DNS and certificates: waas AUTH METHOD PATH [JSON],
# AUTH being key:secret or "admin" for the admin token. Prints the response body; fails on an HTTP error.
waas() {
  local auth=$1 method=$2 path=$3 body=${4:-} out code ip
  local -a login=(-u "$auth")
  [ "$auth" = admin ] && login=(-H "Authorization: Bearer $ADMIN_TOKEN")
  ip=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' "$(container "$API_UUID")" | awk '{print $1}')
  out=$(mktemp)
  code=$(curl -sS -o "$out" -w '%{http_code}' -X "$method" "http://$ip:4111$path" "${login[@]}" \
    -H 'Content-Type: application/json' ${body:+--data "$body"}) || { rm -f "$out"; die "the API did not answer $method $path"; }
  if [ "${code:0:1}" != 2 ]; then
    cat "$out" >&2; rm -f "$out"
    die "the API answered $code to $method $path"
  fi
  cat "$out"; rm -f "$out"
}

# The template release to publish: ANYPRESS_TEMPLATES_REF (a templates-v* tag), else the newest release.
# With ANYPRESS_TEMPLATES_DIR (a folder templates/release.sh wrote), that folder instead.
templates_release() {
  if [ -n "${ANYPRESS_TEMPLATES_DIR:-}" ]; then
    printf 'folder %s' "$(sha256sum "$ANYPRESS_TEMPLATES_DIR/SHA256SUMS" | cut -c1-12)"
  elif [ -n "${ANYPRESS_TEMPLATES_REF:-}" ]; then
    printf '%s' "$ANYPRESS_TEMPLATES_REF"
  else
    curl -fsSL "https://api.github.com/repos/$TEMPLATES_REPO/releases?per_page=100" \
      | jq -r 'map(select((.tag_name | startswith("templates-v")) and (.draft | not) and (.prerelease | not))) | .[0].tag_name // empty'
  fi
}

# Puts the release's archives in a folder and checks them: templates_fetch RELEASE DIR.
templates_fetch() {
  local release=$1 dir=$2 file
  for file in anypress-store.zip version.txt SHA256SUMS; do
    templates_get "$release" "$dir" "$file" || die "could not download $file of $release from github.com/$TEMPLATES_REPO"
  done
  # Releases before templates-v1.0.14 named the storefront archive agency-storefront.zip.
  if ! templates_get "$release" "$dir" seller-storefront.zip; then
    templates_get "$release" "$dir" agency-storefront.zip \
      || die "could not download seller-storefront.zip of $release from github.com/$TEMPLATES_REPO"
    mv "$dir/agency-storefront.zip" "$dir/seller-storefront.zip"
    sed -i 's/ agency-storefront\.zip$/ seller-storefront.zip/' "$dir/SHA256SUMS"
  fi
  (cd "$dir" && sha256sum -c --quiet SHA256SUMS) || die "the archives of $release don't match their checksums"
}

# One file of a templates release into DIR: templates_get RELEASE DIR FILE. Fails if it isn't there.
templates_get() {
  local release=$1 dir=$2 file=$3
  if [ -n "${ANYPRESS_TEMPLATES_DIR:-}" ]; then
    [ -f "$ANYPRESS_TEMPLATES_DIR/$file" ] && cp "$ANYPRESS_TEMPLATES_DIR/$file" "$dir/$file"
  else
    curl -fsSL -o "$dir/$file" "https://github.com/$TEMPLATES_REPO/releases/download/$release/$file" 2>/dev/null
  fi
}

# Uploads an archive as a template of the key's product, builds a version from it and makes that the
# production version, which new stores are made from: publish_template ZIP KEY:SECRET TEMPLATE_NAME VERSION_NAME.
publish_template() {
  local zip=$1 auth=$2 name=$3 version_name=$4 base version status
  base=$(waas "$auth" POST /v1/basesnapshots "$(jq -nc --arg n "$name" --arg c "$version_name, released on github.com/$TEMPLATES_REPO" \
    '{name: $n, comment: $c}')")
  curl -fsS -T "$zip" "$(jq -r .uploadUrl <<<"$base")" >/dev/null || die "could not upload $name to the bucket (S3_*)"
  version=$(waas "$auth" POST /v1/versions "$(jq -nc --arg n "$version_name" --arg s "$(jq -r .id <<<"$base")" \
    '{name: $n, wordPressVersion: "7.1", phpVersion: "8.3", snapshotId: $s}')")
  version=$(jq -r .id <<<"$version")
  info "Building $version_name (a few minutes)"
  for _ in $(seq 1 90); do
    status=$(waas "$auth" GET "/v1/versions?versionId=$version")
    status=$(jq -r '.[0].statusCode' <<<"$status")
    case "$status" in
      1)
        waas "$auth" PUT /v1/versions/production "$(jq -nc --arg v "$version" '{versionId: $v}')" >/dev/null
        info "$version_name is the production version"
        return
        ;;
      2) die "$version_name failed to build. See the Jobs page on the dashboard." ;;
    esac
    sleep 10
  done
  die "$version_name is still building after 15 minutes"
}

# The store template on the storefront's product, and the ready-made storefront template on a product of
# its own (the API's STOREFRONT_PRODUCT_ID). A newer release is published on the next run.
templates() {
  say "Store templates"
  if [ "${ANYPRESS_TEMPLATES:-on}" = off ]; then
    info "Skipped (ANYPRESS_TEMPLATES=off)"
    return
  fi
  local release dir version out
  release=$(templates_release)
  [ -n "$release" ] || die "no template release on github.com/$TEMPLATES_REPO"
  if [ "$release" = "${STORE_TEMPLATE_RELEASE:-}" ] && [ "$release" = "${STOREFRONT_TEMPLATE_RELEASE:-}" ]; then
    info "Already published ($release)"
    return
  fi
  dir=$(mktemp -d)
  templates_fetch "$release" "$dir"
  version=$(cat "$dir/version.txt")
  if [ "$release" != "${STORE_TEMPLATE_RELEASE:-}" ]; then
    publish_template "$dir/anypress-store.zip" "$STOREFRONT_KEY:$STOREFRONT_SECRET" "AnyPress store" "AnyPress store $version"
    STORE_TEMPLATE_RELEASE=$release; remember "$STATE" STORE_TEMPLATE_RELEASE "$release"
  fi
  if [ -z "${READY_MADE_KEY:-}" ]; then
    out=$(docker exec "$(container "$API_UUID")" npm run -s create-key -- --product-name "Ready-made storefronts")
    READY_MADE_PRODUCT=$(sed -n 's/^product: *//p' <<<"$out")
    READY_MADE_KEY=$(sed -n 's/^key: *//p' <<<"$out")
    READY_MADE_SECRET=$(sed -n 's/^secret: *//p' <<<"$out")
    [ -n "$READY_MADE_SECRET" ] || die "could not make the ready-made storefronts' API key: $out"
    remember "$CREDS" READY_MADE_PRODUCT "$READY_MADE_PRODUCT"
    remember "$CREDS" READY_MADE_KEY "$READY_MADE_KEY"
    remember "$CREDS" READY_MADE_SECRET "$READY_MADE_SECRET"
  fi
  if [ "$release" != "${STOREFRONT_TEMPLATE_RELEASE:-}" ]; then
    publish_template "$dir/seller-storefront.zip" "$READY_MADE_KEY:$READY_MADE_SECRET" "Seller storefront" "Seller storefront $version"
    STOREFRONT_TEMPLATE_RELEASE=$release; remember "$STATE" STOREFRONT_TEMPLATE_RELEASE "$release"
  fi
  rm -rf "$dir"
}

# The storefront customers buy stores on: a ready-made WordPress site with WaaS Host, already connected to
# the API with its own key (POST /admin/products/{id}/storefront). Its owner adds payments and plans.
storefront() {
  say "Storefront"
  if [ -z "${READY_MADE_PRODUCT:-}" ]; then
    info "Skipped: no store templates"
    return
  fi
  if [ "${API_STOREFRONT_PRODUCT_ID:-}" != "$READY_MADE_PRODUCT" ]; then
    envs "$API_UUID" <<<"STOREFRONT_PRODUCT_ID=$READY_MADE_PRODUCT"
    deploy "$API_UUID" "the API (with ready-made storefronts)"
    wait_healthy
    API_STOREFRONT_PRODUCT_ID=$READY_MADE_PRODUCT
  fi
  local current status
  current=$(waas admin GET "/admin/products/$STOREFRONT_PRODUCT/storefront")
  if [ "$current" = null ]; then
    current=$(waas admin POST "/admin/products/$STOREFRONT_PRODUCT/storefront" "$(jq -nc --arg n "${STORE_BRAND_NAME:-AnyPress}" \
      --arg e "$ANYPRESS_ADMIN_EMAIL" --arg s "${ANYPRESS_STOREFRONT_SUBDOMAIN:-}" '{name: $n, email: $e} + (if $s == "" then {} else {subdomain: $s} end)')")
    info "Building it (a few minutes)"
  fi
  for _ in $(seq 1 90); do
    status=$(jq -r .statusCode <<<"$current")
    case "$status" in
      1)
        STOREFRONT_DOMAIN=$(jq -r .domainName <<<"$current")
        remember "$STATE" STOREFRONT_DOMAIN "$STOREFRONT_DOMAIN"
        info "https://$STOREFRONT_DOMAIN is ready"
        return
        ;;
      2) die "the storefront failed to build. See the Jobs page on the dashboard." ;;
    esac
    sleep 10
    current=$(waas admin GET "/admin/products/$STOREFRONT_PRODUCT/storefront")
  done
  die "the storefront is still building after 15 minutes"
}

public_ip() { curl -s4 --max-time 5 https://api.ipify.org || hostname -I | awk '{print $1}'; }

summary() {
  local ip type name value
  ip=$(public_ip)
  say "Done"
  if [ -n "${CLOUDFLARE_API_TOKEN:-}" ]; then
    echo "  DNS: the records are set in Cloudflare (DNS only). Certificates follow once they resolve."
  else
    echo "  Add these DNS records (DNS only, not proxied), if they aren't there yet:"
    echo
    dns_records "$ip" | while read -r type name value; do printf '    %-5s %-40s %s\n' "$type" "$name" "$value"; done
  fi
  cat <<EOF

  Coolify:    http://$ip:8000 (admin: $ANYPRESS_ADMIN_EMAIL)
  API:        $API_URL
  Dashboard:  $DASHBOARD_URL$([ -n "${VERCEL_TOKEN:-}" ] && echo ' (on Vercel)') (sign in with $ANYPRESS_ADMIN_EMAIL; needs store email set)

  Passwords, keys and the storefront's API key: $CREDS
  Keep a copy of SECRETS_KEY off this server: without it, store passwords and database backups can't be read.

EOF
  if [ -n "${STOREFRONT_DOMAIN:-}" ]; then
    cat <<EOF
  Storefront: https://$STOREFRONT_DOMAIN (the dashboard's API keys page links to its wp-admin)
  Next: in its FluentCart, connect Stripe and make the plans customers buy (docs/self-hosting.md, section 6).
EOF
  else
    echo "  Next: publish a store template and set up the storefront (docs/self-hosting.md, sections 5 and 6)."
  fi
  cat <<EOF
  Check everything with: sudo bash $0 check
EOF
}

check() {
  load
  local ok=0 ip name
  ip=$(public_ip)
  result() { if [ "$1" = 0 ]; then printf '  \033[32mok\033[0m    %s\n' "$2"; else printf '  \033[31mfails\033[0m %s\n' "$2"; ok=1; fi; }
  say "Checking AnyPress on $ip"
  curl -sf http://127.0.0.1:8000/api/health >/dev/null; result $? "Coolify is running"
  [ -n "${COOLIFY_TOKEN:-}" ] && coolify GET /version >/dev/null 2>&1; result $? "Coolify's API takes the token"
  name=$(container "${API_UUID:-none}")
  [ -n "$name" ] && docker exec "$name" wget -qO- http://127.0.0.1:4111/health >/dev/null 2>&1; result $? "The API answers /health"
  if [ -n "${VERCEL_TOKEN:-}" ]; then
    [ "$(vercel GET "/v6/deployments?projectId=${VERCEL_PROJECT_ID:-none}&target=production&limit=1" 2>/dev/null | jq -r '.deployments[0].state // empty')" = READY ]
    result $? "The dashboard is deployed on Vercel"
  else
    [ -n "$(container "${DASHBOARD_UUID:-none}")" ]; result $? "The dashboard is running"
  fi
  [ -f /etc/cron.d/anypress-coolify-cleanup ]; result $? "The Coolify cleanup job is set"
  [ -n "${STORE_TEMPLATE_RELEASE:-}" ] && [ -n "${STOREFRONT_TEMPLATE_RELEASE:-}" ]; result $? "The store templates are published (${STORE_TEMPLATE_RELEASE:-none})"
  [ -n "${STOREFRONT_DOMAIN:-}" ]; result $? "The storefront is built (${STOREFRONT_DOMAIN:-none})"
  local host
  for host in "api.$ANYPRESS_BRAND_DOMAIN" "app.$ANYPRESS_BRAND_DOMAIN" "check.$ANYPRESS_STORE_DOMAIN" "check.stores.$ANYPRESS_STORE_DOMAIN"; do
    if [ "$host" = "app.$ANYPRESS_BRAND_DOMAIN" ] && [ -n "${VERCEL_TOKEN:-}" ]; then
      getent ahostsv4 "$host" | grep -q .; result $? "$host resolves (Vercel)"
      continue
    fi
    getent ahostsv4 "$host" | awk '{print $1}' | grep -qx "$ip"; result $? "$host points at this server"
  done
  curl -sf --max-time 10 "$API_URL/health" >/dev/null; result $? "$API_URL/health answers over HTTPS"
  [ -n "${STORE_SMTP_PASSWORD:-}" ]; result $? "Stores and sign-in have email (STORE_SMTP_PASSWORD)"
  return $ok
}

# ---- Front doors: run on your own computer, not on the server. Each makes a server with the provider's
# API and hands it post_install_script, which installs AnyPress on it. ----

# Calls a provider's API: provider_api BASE TOKEN METHOD PATH [JSON]. Prints the response body; fails on an
# HTTP error.
provider_api() {
  local base=$1 token=$2 method=$3 path=$4 body=${5:-} out code
  out=$(mktemp)
  code=$(curl -sS -o "$out" -w '%{http_code}' -X "$method" "$base$path" \
    -H "Authorization: Bearer $token" -H 'Content-Type: application/json' -H 'Accept: application/json' \
    ${body:+--data-binary @-} <<<"$body") || { rm -f "$out"; die "$PROVIDER did not answer $method $path"; }
  if [ "${code:0:1}" != 2 ]; then
    jq -r '.message // .error.message // .' "$out" >&2 2>/dev/null || cat "$out" >&2; rm -f "$out"
    die "$PROVIDER answered $code to $method $path"
  fi
  cat "$out"; rm -f "$out"
}

hostinger() { provider_api "$HOSTINGER" "$HOSTINGER_API_TOKEN" "$@"; }
hetzner() { provider_api "$HETZNER" "$HETZNER_API_TOKEN" "$@"; }
digitalocean() { provider_api "$DIGITALOCEAN" "$DIGITALOCEAN_TOKEN" "$@"; }

# The script the new server runs once as root (Hostinger's post-install script, cloud-init user data
# elsewhere): it writes the answers (without the providers' settings) and this installer (compressed, to fit
# the providers' size limits) to /root, adds your SSH key and installs, logging to /root/anypress/install.log.
# It ends by writing the installer's exit code to /root/anypress/post-install.status.
post_install_script() {
  local end
  # A heredoc end marker the answers can't contain.
  end=ANYPRESS_END_$(openssl rand -hex 8)
  cat <<SCRIPT
#!/bin/bash
# AnyPress, set up by anypress-install.sh $FRONT_DOOR.
umask 077
mkdir -p /root/anypress /root/.ssh
cat > /root/anypress.env <<'$end'
$(grep -v '^[[:space:]]*\(export[[:space:]]\+\)\?\(HOSTINGER\|HETZNER\|DIGITALOCEAN\)_' "$ANSWERS")
$end
SCRIPT
  [ -n "$SSH_KEY" ] && printf "echo '%s' >> /root/.ssh/authorized_keys\n" "$SSH_KEY"
  cat <<SCRIPT
base64 -d > /root/anypress-install.sh.gz <<'$end'
$(gzip -9c "$INSTALLER" | base64)
$end
gunzip -f /root/anypress-install.sh.gz
bash /root/anypress-install.sh 2>&1 | tee -a /root/anypress/install.log
status=\${PIPESTATUS[0]}
echo "\$status" > /root/anypress/post-install.status
exit "\$status"
SCRIPT
}

# What every front door needs: the answers, the provider's token, this installer as a file and an SSH key.
front_door() {
  FRONT_DOOR=$1 PROVIDER=$2
  ANSWERS=${ANYPRESS_ANSWERS:-./anypress.env}
  INSTALLER=${BASH_SOURCE[0]}
  [ -f "$INSTALLER" ] || die "save the installer to a file and run it from there (bash anypress-install.sh $FRONT_DOOR)"
  local tool f
  for tool in curl jq openssl gzip base64; do command -v "$tool" >/dev/null || die "install $tool first"; done
  answers
  LOCAL_DIR=${ANYPRESS_LOCAL_DIR:-$HOME/.anypress}
  mkdir -p "$LOCAL_DIR" && chmod 700 "$LOCAL_DIR"
  SSH_KEY=
  case "${ANYPRESS_SSH_KEY:-}" in
    none) ;;
    "") for f in "$HOME/.ssh/id_ed25519.pub" "$HOME/.ssh/id_rsa.pub"; do [ -f "$f" ] && { SSH_KEY=$(head -1 "$f"); break; }; done ;;
    *) [ -f "$ANYPRESS_SSH_KEY" ] || die "no SSH public key at $ANYPRESS_SSH_KEY"; SSH_KEY=$(head -1 "$ANYPRESS_SSH_KEY") ;;
  esac
  SERVER_NAME=${ANYPRESS_SERVER_NAME:-anypress-${ANYPRESS_BRAND_DOMAIN//./-}}
  say "$PROVIDER"
}

# Once the server is up: with an SSH key, shows the installer's log as it runs, until it ends.
follow_install() {
  local ip=$1 known=$LOCAL_DIR/$FRONT_DOOR-$2.known_hosts _
  info "Server $ip is up; AnyPress is installing on it (about 15 minutes)"
  if [ -z "$SSH_KEY" ]; then
    echo "  Without an SSH key this stops here. Follow /root/anypress/install.log on the server (the provider's"
    echo "  browser console), or wait for https://api.$ANYPRESS_BRAND_DOMAIN/health to answer."
    return
  fi
  rm -f "$known"
  for _ in $(seq 1 30); do
    ssh -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile="$known" \
      "root@$ip" true 2>/dev/null && break
    sleep 10
  done
  # Shows the log until the installer writes its exit code, and exits with it.
  ssh -o BatchMode=yes -o UserKnownHostsFile="$known" "root@$ip" '
    until [ -f /root/anypress/install.log ]; do sleep 2; done
    tail -n +1 -f /root/anypress/install.log & t=$!
    until [ -f /root/anypress/post-install.status ]; do sleep 5; done
    sleep 2; kill $t; exit "$(cat /root/anypress/post-install.status)"' \
    || die "the installer stopped on the server; its log is /root/anypress/install.log there (ssh root@$ip). Fix the answers in /root/anypress.env and run: bash /root/anypress-install.sh"
  say "Installed on $ip"
  echo "  Logins and keys: /root/anypress/credentials.env on the server (ssh root@$ip)"
}

# anypress-install.sh hostinger: sets up a Hostinger VPS you bought with plain Ubuntu 24.04 and
# post_install_script as its post-install script (48 KB at most, logged to /post_install.log).
hostinger_install() {
  front_door hostinger Hostinger
  : "${HOSTINGER_API_TOKEN:?set HOSTINGER_API_TOKEN in $ANSWERS (hPanel → Account → API)}"
  HOSTINGER=${ANYPRESS_HOSTINGER_API:-https://developers.hostinger.com}
  local vm template dc script body password action='' state hostname ip _

  vm=${HOSTINGER_VPS_ID:-}
  if [ -z "$vm" ]; then
    vm=$(hostinger GET /api/vps/v1/virtual-machines) || exit 1
    if [ "$(jq '[.[] | select(.state == "initial")] | length' <<<"$vm")" != 1 ]; then
      jq -r '.[] | "    \(.id)  \(.hostname)  \(.plan // "")  \(.state)"' <<<"$vm" >&2
      die "set HOSTINGER_VPS_ID in $ANSWERS to one of the servers above"
    fi
    vm=$(jq -r '.[] | select(.state == "initial") | .id' <<<"$vm")
  fi
  vm=$(hostinger GET "/api/vps/v1/virtual-machines/$vm") || exit 1
  state=$(jq -r .state <<<"$vm"); hostname=$(jq -r .hostname <<<"$vm")
  dc=${HOSTINGER_DATA_CENTER_ID:-$(jq -r '.data_center_id // empty' <<<"$vm")}
  vm=$(jq -r .id <<<"$vm")
  info "Server $vm ($hostname) is $state"
  if [ "$state" != initial ] && [ "${HOSTINGER_RECREATE:-}" != yes ]; then
    die "server $vm is already set up. To wipe it and install AnyPress on it, set HOSTINGER_RECREATE=yes. To update an install, run the installer on the server."
  fi
  if [ "$state" = initial ] && [ -z "$dc" ]; then
    hostinger GET /api/vps/v1/data-centers | jq -r '.[] | "    \(.id)  \(.city), \(.location)"' >&2
    die "set HOSTINGER_DATA_CENTER_ID in $ANSWERS to one of the data centers above"
  fi

  template=${HOSTINGER_TEMPLATE_ID:-}
  if [ -z "$template" ]; then
    # Plain Ubuntu 24.04: the installer brings Coolify itself, with your email as its admin.
    template=$(hostinger GET /api/vps/v1/templates) || exit 1
    template=$(jq -r '[.[] | select((.name | test("^Ubuntu 24\\.04")) and (.name | test("with|panel|coolify"; "i") | not))]
      | sort_by(.name | length) | .[0].id // empty' <<<"$template")
    [ -n "$template" ] || die "Hostinger has no plain Ubuntu 24.04 template; set HOSTINGER_TEMPLATE_ID"
  fi
  info "Template $template"

  script=$(post_install_script)
  [ "$(printf '%s' "$script" | wc -c)" -le 49152 ] || die "the post-install script is over Hostinger's 48 KB limit"
  body=$(jq -n --arg name "AnyPress $ANYPRESS_BRAND_DOMAIN" --arg content "$script" '{name: $name, content: $content}')
  SCRIPT_ID=$(hostinger POST /api/vps/v1/post-install-scripts "$body" | jq -r .id) || exit 1
  # The script holds the answers, so it is deleted from the Hostinger account once the server has it.
  trap '[ -n "${SCRIPT_ID:-}" ] && hostinger DELETE "/api/vps/v1/post-install-scripts/$SCRIPT_ID" >/dev/null' EXIT

  # The root password (Hostinger wants 12+ characters with upper and lower case and a digit) is kept on this
  # computer for hPanel's browser terminal; SSH uses your key.
  password="Ap$(openssl rand -hex 12)X9"
  printf 'HOSTINGER_ROOT_PASSWORD=%s\n' "$password" > "$LOCAL_DIR/hostinger-$vm.env"
  chmod 600 "$LOCAL_DIR/hostinger-$vm.env"

  if [ "$state" = initial ]; then
    body=$(jq -n --argjson t "$template" --argjson d "$dc" --argjson s "$SCRIPT_ID" --arg p "$password" \
      '{template_id: $t, data_center_id: $d, post_install_script_id: $s, password: $p, enable_backups: true}')
    hostinger POST "/api/vps/v1/virtual-machines/$vm/setup" "$body" >/dev/null || exit 1
    info "Setting up the server"
  else
    body=$(jq -n --argjson t "$template" --argjson s "$SCRIPT_ID" --arg p "$password" \
      '{template_id: $t, post_install_script_id: $s, password: $p}')
    action=$(hostinger POST "/api/vps/v1/virtual-machines/$vm/recreate" "$body" | jq -r .id) || exit 1
    info "Wiping and rebuilding the server"
  fi
  echo "  Root password: $LOCAL_DIR/hostinger-$vm.env"

  info "Installing Ubuntu (a few minutes)"
  for _ in $(seq 1 120); do
    if [ -n "$action" ]; then
      state=$(hostinger GET "/api/vps/v1/virtual-machines/$vm/actions/$action") || exit 1
      state=$(jq -r .state <<<"$state")
      [ "$state" = error ] && die "Hostinger could not rebuild the server (see its actions in hPanel)"
      [ "$state" = success ] && action=
    fi
    if [ -z "$action" ]; then
      state=$(hostinger GET "/api/vps/v1/virtual-machines/$vm") || exit 1
      ip=$(jq -r '.ipv4[0].address // empty' <<<"$state")
      state=$(jq -r .state <<<"$state")
      [ "$state" = error ] && die "Hostinger could not set up the server (see its actions in hPanel)"
      [ "$state" = running ] && break
    fi
    sleep 10
  done
  [ "$state" = running ] || die "the server is still installing after 20 minutes"
  hostinger DELETE "/api/vps/v1/post-install-scripts/$SCRIPT_ID" >/dev/null && SCRIPT_ID=
  follow_install "$ip" "$vm"
}

# anypress-install.sh hetzner: makes a Hetzner Cloud server (Ubuntu 24.04) with post_install_script as its
# user data (32 KiB at most).
hetzner_install() {
  front_door hetzner "Hetzner Cloud"
  : "${HETZNER_API_TOKEN:?set HETZNER_API_TOKEN in $ANSWERS (Cloud Console → your project → Security → API tokens, Read & Write)}"
  HETZNER=${ANYPRESS_HETZNER_API:-https://api.hetzner.cloud/v1}
  local server script body id ip state _
  server=$(hetzner GET "/servers?name=$SERVER_NAME") || exit 1
  [ "$(jq '.servers | length' <<<"$server")" = 0 ] \
    || die "a server named $SERVER_NAME is already in this project. To update its install, run the installer on it; to make another, set ANYPRESS_SERVER_NAME."
  if [ -z "${HETZNER_SERVER_TYPE:-}" ]; then
    hetzner GET "/server_types?per_page=50" | jq -r '.server_types[] | select(.deprecation == null)
      | "    \(.name)  \(.cores) CPU, \(.memory) GB, \(.disk) GB, \(.architecture)"' >&2
    die "set HETZNER_SERVER_TYPE in $ANSWERS to one of the types above (4 GB of memory or more; x86)"
  fi
  script=$(post_install_script)
  [ "$(printf '%s' "$script" | wc -c)" -le 32768 ] || die "the user data is over Hetzner's 32 KiB limit"
  body=$(jq -n --arg n "$SERVER_NAME" --arg t "$HETZNER_SERVER_TYPE" --arg l "${HETZNER_LOCATION:-}" --arg u "$script" \
    '{name: $n, server_type: $t, image: "ubuntu-24.04", user_data: $u, labels: {anypress: "true"}} + (if $l == "" then {} else {location: $l} end)')
  server=$(hetzner POST /servers "$body") || exit 1
  id=$(jq -r .server.id <<<"$server")
  ip=$(jq -r '.server.public_net.ipv4.ip // empty' <<<"$server")
  # Hetzner emails a root password unless the server has a Hetzner SSH key; it is also in this answer.
  jq -r '"HETZNER_ROOT_PASSWORD=\(.root_password // "")"' <<<"$server" > "$LOCAL_DIR/hetzner-$id.env"
  chmod 600 "$LOCAL_DIR/hetzner-$id.env"
  info "Made server $id ($SERVER_NAME, $HETZNER_SERVER_TYPE); root password: $LOCAL_DIR/hetzner-$id.env"
  for _ in $(seq 1 60); do
    server=$(hetzner GET "/servers/$id") || exit 1
    state=$(jq -r .server.status <<<"$server")
    ip=$(jq -r '.server.public_net.ipv4.ip // empty' <<<"$server")
    [ "$state" = running ] && break
    sleep 5
  done
  [ "$state" = running ] || die "the server is still starting after 5 minutes"
  follow_install "$ip" "$id"
}

# anypress-install.sh digitalocean: makes a DigitalOcean Droplet (Ubuntu 24.04) with post_install_script as
# its user data (64 KiB at most).
digitalocean_install() {
  front_door digitalocean DigitalOcean
  : "${DIGITALOCEAN_TOKEN:?set DIGITALOCEAN_TOKEN in $ANSWERS (Control Panel → API → Personal access tokens, write)}"
  DIGITALOCEAN=${ANYPRESS_DIGITALOCEAN_API:-https://api.digitalocean.com/v2}
  local droplet script body id ip state _
  droplet=$(digitalocean GET "/droplets?name=$SERVER_NAME") || exit 1
  [ "$(jq '.droplets | length' <<<"$droplet")" = 0 ] \
    || die "a Droplet named $SERVER_NAME is already in this account. To update its install, run the installer on it; to make another, set ANYPRESS_SERVER_NAME."
  script=$(post_install_script)
  [ "$(printf '%s' "$script" | wc -c)" -le 65536 ] || die "the user data is over DigitalOcean's 64 KiB limit"
  body=$(jq -n --arg n "$SERVER_NAME" --arg r "${DIGITALOCEAN_REGION:-nyc3}" --arg s "${DIGITALOCEAN_SIZE:-s-4vcpu-8gb}" --arg u "$script" \
    '{name: $n, region: $r, size: $s, image: "ubuntu-24-04-x64", user_data: $u, monitoring: true, tags: ["anypress"]}')
  droplet=$(digitalocean POST /droplets "$body") || exit 1
  id=$(jq -r .droplet.id <<<"$droplet")
  info "Made Droplet $id ($SERVER_NAME, ${DIGITALOCEAN_SIZE:-s-4vcpu-8gb} in ${DIGITALOCEAN_REGION:-nyc3})"
  for _ in $(seq 1 60); do
    droplet=$(digitalocean GET "/droplets/$id") || exit 1
    state=$(jq -r .droplet.status <<<"$droplet")
    ip=$(jq -r '[.droplet.networks.v4[] | select(.type == "public")][0].ip_address // empty' <<<"$droplet")
    [ "$state" = active ] && [ -n "$ip" ] && break
    sleep 5
  done
  [ "$state" = active ] || die "the Droplet is still starting after 5 minutes"
  follow_install "$ip" "$id"
}

main() {
  case "${1:-install}" in
    install)
      load
      packages
      install_coolify
      coolify_token
      dns
      projects
      database
      api
      storefront_key
      templates
      storefront
      dashboard
      cleanup_cron
      summary
      ;;
    check) check ;;
    hostinger) hostinger_install ;;
    hetzner) hetzner_install ;;
    digitalocean) digitalocean_install ;;
    *) die "unknown command $1 (use install, check, hostinger, hetzner or digitalocean)" ;;
  esac
}

# Sourced (the installer's CI does, to test single steps), it only defines the functions.
[ "${BASH_SOURCE[0]}" != "$0" ] || main "$@"
