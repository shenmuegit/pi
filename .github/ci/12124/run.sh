#!/usr/bin/env bash
set -uo pipefail

source_root="$GITHUB_WORKSPACE/source"
state_root="$GITHUB_WORKSPACE/.validation/12124"
log_root="$state_root/logs"
mkdir -p "$log_root" "$state_root/tmp" "$state_root/home/.config" "$state_root/cache/npm" "$state_root/cache/cargo"
export RUSTUP_HOME="${RUSTUP_HOME:-$HOME/.rustup}"
export HOME="$state_root/home" USERPROFILE="$state_root/home"
export TMPDIR="$state_root/tmp" TMP="$state_root/tmp" TEMP="$state_root/tmp"
export XDG_CONFIG_HOME="$HOME/.config" XDG_CACHE_HOME="$state_root/cache"
export NPM_CONFIG_CACHE="$state_root/cache/npm" CARGO_HOME="$state_root/cache/cargo"
export PI_NO_LOCAL_LLM=1 AWS_EC2_METADATA_DISABLED=true
cd "$source_root"

run_stage() {
  local name=$1
  shift
  "$@" 2>&1 | tee "$log_root/$name.log"
  local status=${PIPESTATUS[0]}
  printf '%s\n' "$status" > "$log_root/$name.exit"
  printf '%s\t%s\n' "$name" "$status" >> "$log_root/outcomes.tsv"
  return "$status"
}

{
  printf 'variant=%s\nexpected_ref=%s\nactual_ref=%s\n' "$VERIFY_VARIANT" "$VERIFY_REF" "$(git rev-parse HEAD)"
  printf 'runner_image=%s\nrunner_image_version=%s\n' "${ImageOS:-unknown}" "${ImageVersion:-unknown}"
  node --version
  npm --version
  rustc --version
  uname -a
  cat /etc/os-release
} | tee "$log_root/environment.txt"
if [[ "$(git rev-parse HEAD)" != "$VERIFY_REF" ]]; then exit 1; fi
sha256sum --check "$GITHUB_WORKSPACE/control/.github/ci/12124/$VERIFY_VARIANT.sha256" | tee "$log_root/expected-source-verification.txt"
input_status=${PIPESTATUS[0]}
if (( input_status != 0 )); then exit 1; fi
git status --short > "$log_root/status-before.txt"
git ls-tree -r HEAD packages/ai/src/utils/retry.ts packages/ai/test/retry.test.ts packages/ai/test/openai-codex-stream.test.ts packages/coding-agent/test/suite/regressions/12124-websocket-connection-limit-retry.test.ts > "$log_root/source-git-objects.txt"
sha256sum test.sh packages/ai/src/utils/retry.ts packages/ai/test/retry.test.ts packages/ai/test/openai-codex-stream.test.ts > "$log_root/source-sha256-before.txt"
new_test=packages/coding-agent/test/suite/regressions/12124-websocket-connection-limit-retry.test.ts
if [[ -f "$new_test" ]]; then sha256sum "$new_test" >> "$log_root/source-sha256-before.txt"; fi

system_dependencies() {
  sudo apt-get update && sudo apt-get install -y --no-install-recommends fd-find ripgrep || return 1
  if ! command -v fd > /dev/null; then sudo ln -s "$(command -v fdfind)" /usr/local/bin/fd; fi
}
run_stage system system_dependencies || exit 1
run_stage install npm ci --ignore-scripts || exit 1
run_stage build npm run build || exit 1
run_stage daemon npm run build:daemon --workspace packages/env
daemon_status=$?
run_stage check npm run check
check_status=$?
run_stage test ./test.sh
test_status=$?

git status --short > "$log_root/status-after.txt"
git diff --stat > "$log_root/generated-diff-stat.txt"
git diff > "$log_root/generated-diff.patch"
sha256sum --check "$log_root/source-sha256-before.txt" | tee "$log_root/source-sha256-verification.txt"
hash_status=${PIPESTATUS[0]}
git diff --check > "$log_root/diff-check.txt" 2>&1
diff_status=$?
printf '%s\n' "$hash_status" > "$log_root/source-hashes.exit"
printf '%s\n' "$diff_status" > "$log_root/diff-check.exit"
{
  printf '## #12124 %s\n\n' "$VERIFY_VARIANT"
  printf 'Source: `%s`\n\n' "$VERIFY_REF"
  printf '| Command | Exit code |\n| --- | --- |\n'
  while IFS=$'\t' read -r stage status; do printf '| %s | %s |\n' "$stage" "$status"; done < "$log_root/outcomes.tsv"
  printf '| source hashes | %s |\n| diff check | %s |\n' "$hash_status" "$diff_status"
} >> "$GITHUB_STEP_SUMMARY"
if (( daemon_status != 0 || check_status != 0 || test_status != 0 || hash_status != 0 || diff_status != 0 )); then exit 1; fi
