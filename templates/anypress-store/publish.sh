#!/usr/bin/env bash
# Uploads dist/anypress-store.zip as a base snapshot through the provisioning API, creates a
# version from it and, with --production, makes that version the product's production version.
#
#   WAAS_API_URL=... WAAS_KEY=... WAAS_SECRET=... templates/anypress-store/publish.sh <version name> [--production]
#
# WAAS_API_URL is the provisioning API's address. The key is a product (storefront) key.
# Prints the base snapshot id, the version id and its domain.
set -euo pipefail

VERSION_NAME=${1:?usage: publish.sh <version name> [--production]}
PRODUCTION=${2:-}
API=${WAAS_API_URL:?set WAAS_API_URL to the provisioning API address}
: "${WAAS_KEY:?set WAAS_KEY}" "${WAAS_SECRET:?set WAAS_SECRET}"
# Base snapshot names allow only letters, digits, spaces and dashes (5 to 50).
BASE_NAME=${BASE_NAME:-AnyPress store}
# The image tag the stores run: wordpress:<WP>-php<PHP>-apache. "7.1" follows 7.1.x patch releases.
WP_VERSION=${WP_VERSION:-7.1}
PHP_VERSION=${PHP_VERSION:-8.3}

HERE=$(cd "$(dirname "$0")" && pwd)
ZIP=$HERE/dist/anypress-store.zip
[ -f "$ZIP" ] || { echo "no $ZIP; run build.sh first" >&2; exit 1; }

api() { # method path [json]
    curl -sSf -u "$WAAS_KEY:$WAAS_SECRET" -H 'Content-Type: application/json' -X "$1" "$API$2" ${3:+-d "$3"}
}

wait_version() { # id
    for _ in $(seq 1 90); do
        local status
        status=$(api GET "/v1/versions?versionId=$1" | jq -r '.[0].statusCode')
        case "$status" in
            1) return 0 ;;
            2) echo "version $1 failed" >&2; return 1 ;;
        esac
        sleep 10
    done
    echo "version $1 not done after 15 minutes" >&2
    return 1
}

COMMENT="AnyPress store. $(unzip -p "$ZIP" waas-template.json | jq -c '{builtAt, wordPress, theme, plugins}')"
BASE=$(api POST /v1/basesnapshots "$(jq -n --arg name "$BASE_NAME" --arg comment "${COMMENT:0:500}" '{name: $name, comment: $comment}')")
BASE_ID=$(jq -r .id <<<"$BASE")
curl -sSf -T "$ZIP" "$(jq -r .uploadUrl <<<"$BASE")" >/dev/null
echo "base snapshot: $BASE_ID ($BASE_NAME)"

VERSION=$(api POST /v1/versions "$(jq -n --arg name "$VERSION_NAME" --arg wp "$WP_VERSION" --arg php "$PHP_VERSION" --arg snap "$BASE_ID" \
    '{name: $name, wordPressVersion: $wp, phpVersion: $php, snapshotId: $snap}')")
VERSION_ID=$(jq -r .id <<<"$VERSION")
echo "version: $VERSION_ID ($(jq -r .domainName <<<"$VERSION")), building"
wait_version "$VERSION_ID"
echo "version: done"

if [ "$PRODUCTION" = --production ]; then
    api PUT /v1/versions/production "$(jq -n --arg id "$VERSION_ID" '{versionId: $id}')" >/dev/null
    echo "version: production"
fi
