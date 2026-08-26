#!/usr/bin/env bash
#
# Run a private PostgreSQL cluster for development, owned by the current user.
#
# The normal path is the system PostgreSQL — see README "Database setup". That
# needs a one-off `sudo` to create your role. If you cannot or would rather not
# do that, this script initialises a throwaway cluster under .devdb on a spare
# port instead. No sudo, no system changes.
#
#   ./scripts/dev-postgres.sh start | stop | status | reset
#
set -euo pipefail

PORT="${FE_PG_PORT:-55432}"
PGDATA="${FE_PG_DATA:-$(cd "$(dirname "$0")/.." && pwd)/.devdb}"
# The socket directory must be short: PostgreSQL caps the path at 107 bytes and
# a project path can easily exceed that.
SOCKDIR="${FE_PG_SOCK:-/tmp/fe-pg}"
PGBIN="${FE_PG_BIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}"

if [ -z "${PGBIN:-}" ] || [ ! -x "$PGBIN/pg_ctl" ]; then
  echo "PostgreSQL binaries not found. Set FE_PG_BIN to the directory holding pg_ctl." >&2
  exit 1
fi

start() {
  mkdir -p "$SOCKDIR"
  if [ ! -d "$PGDATA/base" ]; then
    echo "Initialising a cluster in $PGDATA ..."
    "$PGBIN/initdb" -D "$PGDATA" -U "$USER" -A trust >/dev/null
  fi
  "$PGBIN/pg_ctl" -D "$PGDATA" \
    -o "-p $PORT -k $SOCKDIR -c listen_addresses=127.0.0.1" \
    -l "$PGDATA/server.log" start
  sleep 1
  for db in fashion_express fashion_express_test; do
    "$PGBIN/createdb" -h 127.0.0.1 -p "$PORT" -U "$USER" "$db" 2>/dev/null \
      && echo "created $db" || true
  done
  cat <<MSG

Cluster is up on port $PORT. Point .env at it:

  DATABASE_URL=postgresql://$USER@127.0.0.1:$PORT/fashion_express
  DATABASE_URL_TEST=postgresql://$USER@127.0.0.1:$PORT/fashion_express_test

Then: npm run migration:run
MSG
}

case "${1:-start}" in
  start)  start ;;
  stop)   "$PGBIN/pg_ctl" -D "$PGDATA" stop ;;
  status) "$PGBIN/pg_ctl" -D "$PGDATA" status ;;
  reset)
    "$PGBIN/pg_ctl" -D "$PGDATA" stop 2>/dev/null || true
    rm -rf "$PGDATA"
    start ;;
  *) echo "usage: $0 {start|stop|status|reset}" >&2; exit 1 ;;
esac
