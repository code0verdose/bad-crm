#!/usr/bin/env bash
# Destroys the local development stack together with its data volumes and starts it again empty.
#
# This deletes pgdata, redis-data, minio-data, meili-data and mailpit-data — every local database
# row, uploaded file and captured mail. It exists because "my local database is in a weird state"
# is a normal development situation, and because `down -v` typed by hand is one flag away from
# being typed in the wrong terminal. Hence the explicit confirmation.
#
# Usage: pnpm docker:reset [--yes]

set -euo pipefail

# Resolved before the `cd`, so the path to up.sh stays correct however this script was invoked.
script_dir="$(cd "$(dirname "$0")" && pwd)"
cd "$script_dir/../.."

profile="${COMPOSE_PROFILES:-default}"

if [ "${1:-}" != "--yes" ]; then
  printf 'This deletes ALL local Docker volumes of the bad-crm project:\n'
  printf '  pgdata, redis-data, minio-data, meili-data, mailpit-data\n'
  printf 'Type "reset" to confirm: '
  read -r answer
  if [ "$answer" != "reset" ]; then
    printf 'Aborted, nothing was removed.\n'
    exit 1
  fi
fi

# `--profile '*'` enables every profile: without it `down` ignores services whose profile is not
# active and leaves, say, a Meilisearch container running after a reset. `--volumes` is what makes
# this destructive; `--remove-orphans` clears services renamed since the stack was last started.
docker compose --profile '*' down --volumes --remove-orphans

# Same start path as `pnpm docker:up`, so the one-shot bucket initialiser is handled identically.
COMPOSE_PROFILES="$profile" "$script_dir/up.sh"

printf 'Stack recreated from empty volumes. Roles and extensions were re-applied by initdb.\n'
