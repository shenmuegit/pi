#!/usr/bin/env bash
set -euo pipefail

phase=${1:?Missing validation phase}
case "$phase" in
  prepare|system|install|build|check|daemon|tests|conformance|summary) ;;
  *) printf 'Unknown validation phase\n' >&2; exit 64 ;;
esac
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
state="$PWD/.validation/11311"
export RUSTUP_HOME="${RUSTUP_HOME:-$HOME/.rustup}"
export HOME="$state/home"
export TMPDIR="$state/tmp" TMP="$state/tmp" TEMP="$state/tmp"
export npm_config_cache="$state/npm-cache"
export CARGO_HOME="$PWD/node_modules/.cache/pi-11311-cargo"
export NODE_COMPILE_CACHE="$state/node-cache"
export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_OPTIONAL_LOCKS=0
mkdir -p "$HOME" "$TMPDIR" "$npm_config_cache" "$CARGO_HOME" "$state/logs"
trap 'printf "%s\n" "$?" > "$state/logs/$phase.exit"' EXIT
exec > >(tee "$state/logs/$phase.log") 2>&1

case "$phase" in
  prepare)
    test "$(git rev-parse HEAD)" = bdb151774ed6bef2b5676bbff4669f20a0c233fe
    git diff --exit-code
    case "${PI_VERIFY_VARIANT:-}" in
      baseline) ;;
      patched)
        git apply --check "$script_dir/oauth-callback.patch"
        git apply "$script_dir/oauth-callback.patch"
        printf '%s\n' \
          '10b6f2d0171fa2b9ad98de3845c6ca19df117f06bb77cf5d23fb39fe5dfc9934  packages/mcp/src/oauth/callback.ts' \
          '67ef9add657795d3f457c7e03a45cac5387f24a0cbcb6244a470c8d3e254e4ce  packages/mcp/test/oauth.test.ts' | sha256sum --check
        ;;
      *) printf 'Unknown source variant\n' >&2; exit 64 ;;
    esac
    git diff --check
    git diff --stat
    git rev-parse HEAD
    sha256sum packages/mcp/src/oauth/callback.ts packages/mcp/test/oauth.test.ts
    ;;
  system)
    sudo apt-get update
    sudo apt-get install -y libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev fd-find ripgrep
    sudo ln -s "$(command -v fdfind)" /usr/local/bin/fd
    node --version
    npm --version
    rustc --version
    cargo --version
    fd --version
    uname -a
    df -T .
    ;;
  install)
    npm ci --ignore-scripts
    ;;
  build)
    npm run build
    sha256sum packages/ai/src/providers/data/*.json > "$state/logs/model-data-sha256.txt"
    ;;
  check)
    npm run check
    ;;
  daemon)
    npm run build:daemon --workspace packages/env
    ;;
  tests)
    ./test.sh
    ;;
  conformance)
    npm run test:mcp-conformance
    ;;
  summary)
    printf 'check=%s\ntest.sh=%s\nmcp-conformance=%s\n' \
      "${VERIFY_CHECK:-missing}" "${VERIFY_TESTS:-missing}" "${VERIFY_CONFORMANCE:-missing}"
    git diff --check
    sha256sum packages/mcp/src/oauth/callback.ts packages/mcp/test/oauth.test.ts
    test "${VERIFY_CHECK:-}" = success
    test "${VERIFY_TESTS:-}" = success
    test "${VERIFY_CONFORMANCE:-}" = success
    ;;
esac
