#!/usr/bin/env sh
# Runs a command with the Docker environment Testcontainers needs on this machine.
#
#   scripts/docker/testcontainers-env.sh pnpm test:integration
#
# WHY THIS EXISTS
#   Testcontainers looks for a daemon at the default socket and gives up with «Could not find a
#   working container runtime strategy» — a message that says nothing about the cause. On a Mac with
#   Colima (or Rancher, or any rootless setup) the daemon is reachable, `docker ps` works, and the
#   socket simply is not at /var/run/docker.sock. Two variables fix it, and they are easy to get
#   wrong in opposite directions:
#
#     DOCKER_HOST                            — where *this process* talks to the daemon.
#     TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE  — the path a *container* should mount to reach it,
#                                              which is /var/run/docker.sock inside the VM even when
#                                              the host path is somewhere else entirely. Setting this
#                                              to the host path is the mistake that produces
#                                              «error while creating mount source path … operation
#                                              not supported».
#
#   The endpoint is asked of Docker itself rather than guessed, so this works for Docker Desktop
#   (where it resolves to the default and changes nothing), Colima, and anything else that publishes
#   a context.
#
# In CI nothing is set: the runner has a daemon at the default socket, and this script is not used
# there — see .github/workflows/ci.yml, job «database isolation».
set -eu

if [ "$#" -eq 0 ]; then
  echo "usage: $0 <command> [args...]" >&2
  exit 64
fi

endpoint=$(docker context inspect --format '{{.Endpoints.docker.Host}}' 2>/dev/null || true)

if [ -z "$endpoint" ]; then
  echo "testcontainers-env: no docker context found — is the daemon running?" >&2
  echo "                    (colima start / open -a Docker), then try again" >&2
  exit 69
fi

# Only the socket path needs the override; a TCP endpoint is reachable from a container as it is.
case "$endpoint" in
  unix://*)
    DOCKER_HOST="$endpoint"
    TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE="/var/run/docker.sock"
    export DOCKER_HOST TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE
    ;;
  *)
    DOCKER_HOST="$endpoint"
    export DOCKER_HOST
    ;;
esac

exec "$@"
