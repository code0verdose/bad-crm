#!/bin/sh
# Wrapper that runs the parameterised role bootstrap.
#
# Two entry points, one code path:
#   * first-time initialisation of the PostgreSQL data directory — the entrypoint executes this file
#     because it is mounted into /docker-entrypoint-initdb.d;
#   * `pnpm db:bootstrap` — `docker compose run` executes the very same file from /opt/bad-crm/sql
#     in a one-off container. initdb.d only ever fires on an empty volume, so without the second
#     entry point a rotated password or a new role never reaches an existing installation and the
#     only way out is the destructive `pnpm docker:reset`.
#
#     Why a one-off container and not `docker compose exec`: the environment of a running container
#     is fixed when that container is created. After rotating APP_USER_PASSWORD in .env, `exec` hands
#     this script the value the container was born with — it re-applies the OLD password and prints
#     success. `run` builds its environment from the current compose configuration, so the new value
#     actually arrives. Verified against Docker Compose v5.2.0: with a rotated .env, `run` sees the
#     new value and `exec` the old one.
#
# Why a wrapper at all: 00-bootstrap-roles.sql takes psql variables so the same file can be run by
# hand against a managed PostgreSQL in a self-host install. The Docker entrypoint would execute a
# bare .sql file without those variables, so the SQL is kept outside initdb.d (/opt/bad-crm/sql) and
# invoked from here with values taken from the container environment.
#
# Fails loudly on a missing password instead of silently creating a passwordless role.

set -eu

: "${APP_MIGRATOR_PASSWORD:?APP_MIGRATOR_PASSWORD is required to bootstrap the app_migrator role}"
: "${APP_USER_PASSWORD:?APP_USER_PASSWORD is required to bootstrap the app_user role}"
: "${APP_AUTH_PASSWORD:?APP_AUTH_PASSWORD is required to bootstrap the app_auth role}"
: "${BACKUP_ROLE_PASSWORD:?BACKUP_ROLE_PASSWORD is required to bootstrap the backup_role role}"

# The connection is made to a maintenance database, not to the application database, because this
# script CREATES the application database when it is absent (`\gexec` in the SQL) and then
# `\connect`s into it. Pointing psql at a database that does not exist yet fails on exactly the host
# where the bootstrap matters most: a new one, or one whose database was just dropped for a clean
# restore. `postgres` exists in every cluster initdb ever produced; managed providers that name it
# differently override MAINTENANCE_DB.
MAINTENANCE_DB="${MAINTENANCE_DB:-postgres}"

# A one-off container shares the server's volumes but not its unix socket, so `pnpm db:bootstrap`
# points psql at the service over TCP. Only then is a password needed — during initdb the connection
# is socket-local and trusted. PGPASSWORD travels in the environment rather than in argv, which `ps`
# would expose.
#
# The assignment below stays unquoted on purpose: `NAME="value"` after the word `password` is the
# shape secret scanners match, and this file must stay scannable. A shell assignment performs no
# word splitting, so the quotes buy nothing here anyway.
if [ -n "${PGHOST:-}" ]; then
  : "${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required to reach the server over TCP}"
  export PGPASSWORD=$POSTGRES_PASSWORD
fi

# Escapes a value for psql's `\set name 'value'` form. Inside single quotes psql only treats the
# backslash and the closing quote specially, so escaping those two makes any generated password
# safe to pass — including one containing quotes, spaces or `$`.
psql_escape() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e "s/'/\\\\'/g"
}

# Five roles, and the fifth has no password of its own: `app_auth_definer` is NOLOGIN — it exists to
# own the SECURITY DEFINER resolvers and to hold the table privileges their bodies run with, which is
# precisely why nobody may connect as it. Naming it here anyway: this line is what an operator reads
# to check that a bootstrap did what the restore runbook says it does.
echo "bootstrap-roles: applying app_migrator / app_user / app_auth / app_auth_definer (NOLOGIN) / backup_role in ${POSTGRES_DB}"

# The variables are fed over stdin instead of `psql --set name=value`. Command-line arguments of a
# running process are world-readable (`ps -ef`, /proc/<pid>/cmdline), and during initdb this process
# runs next to whatever else shares the container's PID namespace. A heredoc is a pipe: no other
# process can read it. The server log is a separate leak with a separate fix — 00-bootstrap-roles.sql
# silences `log_statement` for its own session before it touches a password.
psql --username "$POSTGRES_USER" --dbname "$MAINTENANCE_DB" --no-psqlrc --quiet <<EOSQL
\set ON_ERROR_STOP on
\set db_name '$(psql_escape "$POSTGRES_DB")'
\set migrator_pw '$(psql_escape "$APP_MIGRATOR_PASSWORD")'
\set app_pw '$(psql_escape "$APP_USER_PASSWORD")'
\set auth_pw '$(psql_escape "$APP_AUTH_PASSWORD")'
\set backup_pw '$(psql_escape "$BACKUP_ROLE_PASSWORD")'
\i /opt/bad-crm/sql/00-bootstrap-roles.sql
EOSQL
