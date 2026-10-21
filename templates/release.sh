#!/usr/bin/env bash
# Builds the two templates a new install publishes, the store (anypress-store) and the ready-made
# storefront (agency-storefront), into one folder with their checksums: what a templates-v* release
# carries (.github/workflows/release-templates.yml) and what install/anypress-install.sh publishes.
#
#   templates/release.sh <waas-plugins checkout> <WaaS Host version> <version> <out dir>
#
# The store gets WaaS Client from the checkout as it is; the storefront gets WaaS Host from the checkout's
# waas-host-v<WaaS Host version> tag. Writes anypress-store.zip, agency-storefront.zip, SHA256SUMS and version.txt.
set -euo pipefail

usage="usage: release.sh <waas-plugins checkout> <WaaS Host version> <version> <out dir>"
PLUGINS_REPO=$(cd "${1:?$usage}" && pwd)
HOST_VERSION=${2:?$usage}
VERSION=${3:?$usage}
mkdir -p "${4:?$usage}"
OUT=$(cd "$4" && pwd)
HERE=$(cd "$(dirname "$0")" && pwd)

"$HERE/anypress-store/build.sh" "$PLUGINS_REPO"

HOST_SRC=$(mktemp -d)
trap 'git -C "$PLUGINS_REPO" worktree remove --force "$HOST_SRC" 2>/dev/null || rm -rf "$HOST_SRC"' EXIT
git -C "$PLUGINS_REPO" worktree add --detach "$HOST_SRC" "waas-host-v$HOST_VERSION" >/dev/null
"$HERE/agency-storefront/build.sh" "$HOST_SRC" "$HOST_VERSION"

cp "$HERE/anypress-store/dist/anypress-store.zip" "$HERE/agency-storefront/dist/agency-storefront.zip" "$OUT/"
printf '%s\n' "$VERSION" > "$OUT/version.txt"
(cd "$OUT" && sha256sum anypress-store.zip agency-storefront.zip version.txt > SHA256SUMS)
cat "$OUT/SHA256SUMS"
