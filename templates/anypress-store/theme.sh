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
THEME_VERSION=${THEME_VERSION:-0.22.1}
THEME_SHA256=${THEME_SHA256:-e67ceb8cb1ea5feb1586b44b5113f2738af44ab3182555cb7b0ae203ebf8f625}

# Downloads <url> to <file>. A GitHub release link that keeps failing (github.com answers 504 at times) is fetched
# through GitHub's API instead, which serves the same file; GITHUB_TOKEN is sent there when set.
anypress_download() { # <url> <file>
    local url=$1 file=$2 repo tag name api auth=()
    curl -sSfL --retry 4 --retry-all-errors -o "$file" "$url" && return
    [[ $url =~ ^https://github\.com/([^/]+/[^/]+)/releases/download/([^/]+)/([^/]+)$ ]] || return 1
    repo=${BASH_REMATCH[1]} tag=${BASH_REMATCH[2]} name=${BASH_REMATCH[3]}
    [ -n "${GITHUB_TOKEN:-}" ] && auth=(-H "Authorization: Bearer $GITHUB_TOKEN")
    echo "GitHub release link failed; fetching $name through the API" >&2
    api=$(curl -sSfL --retry 4 --retry-all-errors "${auth[@]}" "https://api.github.com/repos/$repo/releases/tags/$tag" \
        | awk -v want="$name" '/"url": *"https:\/\/api\.github\.com\/repos\/.*\/releases\/assets\// { gsub(/[",]/, "", $2); u = $2 }
            /"name":/ { n = $2; gsub(/[",]/, "", n); if (n == want && u != "") { print u; exit } }')
    [ -n "$api" ] || { echo "no asset $name in $repo $tag" >&2; return 1; }
    curl -sSfL --retry 4 --retry-all-errors "${auth[@]}" -H "Accept: application/octet-stream" -o "$file" "$api"
}

anypress_theme_fetch() { # <dir>: download (or reuse), verify and unpack the theme zip into <dir>/anypress
    local dest=$1 zip
    mkdir -p "$dest"
    zip="$dest/anypress-$THEME_VERSION.zip"
    if ! { [ -f "$zip" ] && echo "$THEME_SHA256  $zip" | sha256sum -c --quiet 2>/dev/null; }; then
        anypress_download "https://github.com/$THEME_REPO/releases/download/v$THEME_VERSION/anypress.zip" "$zip"
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
