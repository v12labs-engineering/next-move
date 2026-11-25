#!/bin/sh
set -eu

[ "${INDIA_REGISTRY_ENABLED:-false}" = true ] || exit 0
# Discovery has its own process and lock; it never blocks a collection tick.
lock=/tmp/india-registry-cron.lock
if ! mkdir "$lock" 2>/dev/null; then
  if [ -f "$lock/pid" ] && kill -0 "$(cat "$lock/pid")" 2>/dev/null; then
    exit 0
  fi
  rm -rf "$lock"
  mkdir "$lock" 2>/dev/null || exit 0
fi
printf '%s\n' "$$" > "$lock/pid"
firecrawl_pid=
cleanup() {
  if [ -n "$firecrawl_pid" ]; then
    kill "$firecrawl_pid" 2>/dev/null || true
    wait "$firecrawl_pid" 2>/dev/null || true
  fi
  rm -rf "$lock"
}
trap cleanup EXIT
trap 'exit 143' INT TERM

unset REGISTRY_FIRECRAWL_URL
if [ "${INDIA_REGISTRY_MAP_BATCH:-24}" != 0 ]; then
  FIRECRAWL_CLOUD=off FIRECRAWL_LOCAL_BROWSER=never FIRECRAWL_LOCAL_ALLOW_PRIVATE=false \
    FIRECRAWL_LOCAL_HOME="$lock/firecrawl" firecrawl-local serve --port 13982 &
  firecrawl_pid=$!
  for attempt in 1 2 3 4 5; do
    kill -0 "$firecrawl_pid" 2>/dev/null || break
    if wget -T 1 -q -O /dev/null http://127.0.0.1:13982/health; then
      export REGISTRY_FIRECRAWL_URL=http://127.0.0.1:13982
      break
    fi
    sleep 1
  done
  if [ -z "${REGISTRY_FIRECRAWL_URL:-}" ]; then
    printf '%s\n' '{"firecrawl":"unavailable"}' >&2
  fi
fi

timeout 2700 node --import tsx /app/scripts/india/check-india-registry-links.mts \
  --kind hourly --limit "${INDIA_REGISTRY_WEBSITE_BATCH:-500}" \
  --domain-limit "${INDIA_REGISTRY_DOMAIN_BATCH:-600}"
