#!/usr/bin/env bash
# Sets up AnyPress on one fresh Ubuntu server: Coolify, the provisioning API with its Postgres, the
# dashboard, the store templates, a ready-made storefront and the Coolify cleanup job. Safe to run again:
# each step finds what it made before.
#
#   sudo bash anypress-install.sh            install, using /root/anypress.env (see anypress.env.example)
#   sudo bash anypress-install.sh check      check an install
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

load() {
  mkdir -p "$STATE_DIR" && chmod 700 "$STATE_DIR"
  [ -f "$ANSWERS" ] || die "no answers file at $ANSWERS. Copy install/anypress.env.example there and fill it in."
  set -a
  . "$ANSWERS"
  [ -f "$STATE" ] && . "$STATE"
  [ -f "$CREDS" ] && . "$CREDS"
  set +a
  : "${ANYPRESS_BRAND_DOMAIN:?set ANYPRESS_BRAND_DOMAIN in $ANSWERS}"
  : "${ANYPRESS_STORE_DOMAIN:?set ANYPRESS_STORE_DOMAIN in $ANSWERS}"
  : "${ANYPRESS_ADMIN_EMAIL:?set ANYPRESS_ADMIN_EMAIL in $ANSWERS}"
  local v
  for v in S3_ENDPOINT S3_BUCKET S3_ACCESS_KEY_ID S3_SECRET_ACCESS_KEY; do
    [ -n "${!v:-}" ] || die "set $v in $ANSWERS: the API keeps store templates, snapshots and backups in that bucket and won't start without it"
  done
  COOLIFY_VERSION=${ANYPRESS_COOLIFY_VERSION:-4.4.6}
  API_REF=${ANYPRESS_API_REF:-main}
  DASHBOARD_REF=${ANYPRESS_DASHBOARD_REF:-main}
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
  for file in anypress-store.zip agency-storefront.zip version.txt SHA256SUMS; do
    if [ -n "${ANYPRESS_TEMPLATES_DIR:-}" ]; then
      cp "$ANYPRESS_TEMPLATES_DIR/$file" "$dir/$file"
    else
      curl -fsSL -o "$dir/$file" "https://github.com/$TEMPLATES_REPO/releases/download/$release/$file" \
        || die "could not download $file of $release from github.com/$TEMPLATES_REPO"
    fi
  done
  (cd "$dir" && sha256sum -c --quiet SHA256SUMS) || die "the archives of $release don't match their checksums"
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
    publish_template "$dir/agency-storefront.zip" "$READY_MADE_KEY:$READY_MADE_SECRET" "Agency storefront" "Agency storefront $version"
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
  local ip
  ip=$(public_ip)
  say "Done"
  cat <<EOF
  Add these DNS records (DNS only, not proxied), if they aren't there yet:

    A  *.$ANYPRESS_STORE_DOMAIN           $ip
    A  *.stores.$ANYPRESS_STORE_DOMAIN    $ip
    A  *.versions.$ANYPRESS_STORE_DOMAIN  $ip
    A  api.$ANYPRESS_BRAND_DOMAIN         $ip
    A  app.$ANYPRESS_BRAND_DOMAIN         $ip

  Coolify:    http://$ip:8000 (admin: $ANYPRESS_ADMIN_EMAIL)
  API:        $API_URL
  Dashboard:  $DASHBOARD_URL (sign in with $ANYPRESS_ADMIN_EMAIL; needs store email set)

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
  [ -n "$(container "${DASHBOARD_UUID:-none}")" ]; result $? "The dashboard is running"
  [ -f /etc/cron.d/anypress-coolify-cleanup ]; result $? "The Coolify cleanup job is set"
  [ -n "${STORE_TEMPLATE_RELEASE:-}" ] && [ -n "${STOREFRONT_TEMPLATE_RELEASE:-}" ]; result $? "The store templates are published (${STORE_TEMPLATE_RELEASE:-none})"
  [ -n "${STOREFRONT_DOMAIN:-}" ]; result $? "The storefront is built (${STOREFRONT_DOMAIN:-none})"
  local host
  for host in "api.$ANYPRESS_BRAND_DOMAIN" "app.$ANYPRESS_BRAND_DOMAIN" "check.$ANYPRESS_STORE_DOMAIN" "check.stores.$ANYPRESS_STORE_DOMAIN"; do
    getent ahostsv4 "$host" | awk '{print $1}' | grep -qx "$ip"; result $? "$host points at this server"
  done
  curl -sf --max-time 10 "$API_URL/health" >/dev/null; result $? "$API_URL/health answers over HTTPS"
  [ -n "${STORE_SMTP_PASSWORD:-}" ]; result $? "Stores and sign-in have email (STORE_SMTP_PASSWORD)"
  return $ok
}

main() {
  case "${1:-install}" in
    install)
      load
      packages
      install_coolify
      coolify_token
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
    *) die "unknown command $1 (use install or check)" ;;
  esac
}

main "$@"
