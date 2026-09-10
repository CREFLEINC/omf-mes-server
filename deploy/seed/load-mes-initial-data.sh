#!/usr/bin/env bash
# Load the static customer seed into the PostgreSQL Docker Compose service.
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f "$SCRIPT_DIR/../docker-compose.prod.yml" ]]; then
  APP_DIR="${APP_DIR:-$SCRIPT_DIR/..}"
else
  APP_DIR="${APP_DIR:-$SCRIPT_DIR/../..}"
fi
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"
ENV_FILE="${ENV_FILE:-.env.prod}"
SQL_FILE="${SQL_FILE:-$SCRIPT_DIR/mes-initial-data.sql}"
APPLY=true

die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

if [[ "${1:-}" == "--dry-run" ]]; then
  APPLY=false
elif [[ -n "${1:-}" ]]; then
  die "usage: $0 [--dry-run]"
fi

cd "$APP_DIR"
[[ -f "$ENV_FILE" ]] || die "$ENV_FILE not found"
[[ -f "$SQL_FILE" ]] || die "$SQL_FILE not found"
command -v docker >/dev/null 2>&1 || die "docker not found"

set -a
# shellcheck disable=SC1090
. "./$ENV_FILE"
set +a

: "${POSTGRES_USER:?POSTGRES_USER is required in $ENV_FILE}"
: "${POSTGRES_DB:?POSTGRES_DB is required in $ENV_FILE}"

COMPOSE=(docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE")
"${COMPOSE[@]}" exec -T postgres pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  >/dev/null || die "postgres service is not ready"

if [[ "$APPLY" == true ]]; then
  printf 'Running the standard application seed first...\n'
  "${COMPOSE[@]}" run --rm \
    -e ADMIN_INITIAL_PASSWORD="${ADMIN_INITIAL_PASSWORD:-}" \
    migrate node dist/seed.js
fi

printf 'Loading %s (apply=%s)...\n' "$SQL_FILE" "$APPLY"
"${COMPOSE[@]}" exec -T postgres \
  psql -X -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v apply="$APPLY" < "$SQL_FILE"
