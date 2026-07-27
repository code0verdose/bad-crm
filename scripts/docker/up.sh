#!/usr/bin/env bash
# Starts the local development stack and returns only once it is actually usable.
#
# `docker compose up --detach --wait` on its own is not enough here: it treats *any* container that
# leaves the running state as a failure and exits 1 — including the one-shot MinIO bucket
# initialiser, which is supposed to exit 0 and be done. Verified against Docker Compose v5.2.0.
#
# So the stack is started in two steps:
#   1. long-running services with `--wait`, which blocks until every healthcheck is green;
#   2. every one-shot service with `compose run`, whose exit status is the container's own — a
#      failing bucket initialisation therefore fails this script instead of being swallowed.
#
# Which services are one-shot is not hardcoded: it is read from the `com.bad-crm.oneshot` label in
# docker-compose.yml, so adding another initialiser needs no change here.
#
# Usage: pnpm docker:up                          # default profile (everything)
#        COMPOSE_PROFILES=minimal pnpm docker:up # minimal profile (no Meilisearch, no Mailpit)

set -euo pipefail

cd "$(dirname "$0")/../.."

profile="${COMPOSE_PROFILES:-default}"

compose() {
  docker compose --profile "$profile" "$@"
}

oneshot_services="$(compose config --format json | node -e '
let raw = "";
process.stdin.on("data", (chunk) => { raw += chunk; });
process.stdin.on("end", () => {
  const services = JSON.parse(raw).services ?? {};
  for (const [name, service] of Object.entries(services)) {
    if (service.labels?.["com.bad-crm.oneshot"] === "true") process.stdout.write(`${name}\n`);
  }
});
')"

all_services="$(compose config --services)"

long_running_services="$all_services"

if [ -n "$oneshot_services" ]; then
  # `|| true` would be wrong here: grep exits 1 for "no lines matched" but 2 for a real failure
  # (bad pattern, unreadable input), and swallowing 2 leaves an empty service list — after which
  # `compose up --wait` is called with no arguments and starts *everything*, one-shot containers
  # included, which is the exact failure mode this script exists to avoid.
  long_running_services="$(printf '%s\n' "$all_services" | grep -vxF "$oneshot_services" || [ "$?" -eq 1 ])"
fi

if [ -z "$long_running_services" ]; then
  printf 'error: no long-running service resolved for profile %s — refusing to start\n' "$profile" >&2
  exit 1
fi

printf 'Starting the bad-crm dev stack (profile: %s)\n' "$profile"

# `--wait-timeout` is not optional in practice: every service is `restart: unless-stopped`, so a
# container that keeps failing its healthcheck is restarted forever and a bare `--wait` never
# returns. Bounded wait plus the logs of whatever did not come up beats a hung terminal.
set +e
# shellcheck disable=SC2086 # deliberate word splitting: one CLI argument per service name
compose up --detach --wait --wait-timeout 180 $long_running_services
up_status=$?
set -e

if [ "$up_status" -ne 0 ]; then
  printf '\nThe stack did not become healthy within 180s. Last 50 log lines per service:\n' >&2
  compose logs --tail=50 >&2 || true
  compose ps >&2 || true
  exit "$up_status"
fi

for service in $oneshot_services; do
  compose run --rm "$service"
done

compose ps
