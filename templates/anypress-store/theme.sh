#!/usr/bin/env bash
# The AnyPress theme the store template installs: a release of github.com/hamchowderr/anypress-theme,
# pinned by version and checksum. Bump both (from the release's SHA256SUMS) to build on a newer theme.
#
#   templates/anypress-store/theme.sh fetch <dir>   # unpack the pinned theme into <dir>/anypress
#   templates/anypress-store/theme.sh check         # the theme's own Playground check, with this template's
#                                                   # starter pages (mu-plugins/anypress-patterns.php) added
#
# build.sh sources this file for THEME_VERSION and anypress_theme_fetch.
THEME_REPO=hamchowderr/anypress-theme
THEME_VERSION=${THEME_VERSION:-0.4.3}
THEME_SHA256=${THEME_SHA256:-7e7c60959541b4d7c9e9ba890d19e112980dfa5c27cf033ba3aac71ec6464bce}

anypress_theme_fetch() { # <dir>: download (or reuse), verify and unpack the theme zip into <dir>/anypress
    local dest=$1 zip
    mkdir -p "$dest"
    zip="$dest/anypress-$THEME_VERSION.zip"
    if ! { [ -f "$zip" ] && echo "$THEME_SHA256  $zip" | sha256sum -c --quiet 2>/dev/null; }; then
        curl -sSfL -o "$zip" "https://github.com/$THEME_REPO/releases/download/v$THEME_VERSION/anypress.zip"
        echo "$THEME_SHA256  $zip" | sha256sum -c --quiet || { echo "checksum mismatch: AnyPress theme $THEME_VERSION" >&2; return 1; }
    fi
    rm -rf "$dest/anypress" && unzip -q "$zip" -d "$dest"
    [ "$(sed -n 's/^Version: *//p' "$dest/anypress/style.css" | head -1)" = "$THEME_VERSION" ] \
        || { echo "AnyPress theme zip is not version $THEME_VERSION" >&2; return 1; }
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
    set -euo pipefail
    HERE=$(cd "$(dirname "$0")" && pwd)
    WORK=$HERE/.work/theme
    case "${1:-}" in
        fetch)
            anypress_theme_fetch "${2:?usage: theme.sh fetch <dir>}"
            ;;
        check)
            anypress_theme_fetch "$WORK"
            # The checks live with the theme, in tests/ of the same release's source.
            rm -rf "$WORK/src" && mkdir -p "$WORK/src"
            curl -sSfL "https://github.com/$THEME_REPO/archive/refs/tags/v$THEME_VERSION.tar.gz" | tar -xz -C "$WORK/src" --strip-components=1
            cd "$WORK/src/tests"
            npm ci --no-audit --no-fund
            ANYPRESS_THEME="$WORK/anypress" STARTERS="$HERE/mu-plugins/anypress-patterns.php" SHOTS="${SHOTS:-$WORK/shots}" npm run theme
            ;;
        *)
            echo "usage: theme.sh fetch <dir> | check" >&2; exit 1
            ;;
    esac
fi
