#!/usr/bin/env bash
#
# OMF MES 배포 스크립트 — 사내 서버에서 실행 (cron 이 매일 호출)
#
# 동작:
#   1) 현재 떠 있는 api 이미지 ID 기록 (롤백용)
#   2) Harbor 에서 .env.prod 의 IMAGE_TAG 이미지를 pull
#   3) migrate(1회성) → api 순으로 기동
#   4) api 가 healthy 가 될 때까지 대기
#   5) 실패하면 api 를 직전 이미지로 자동 롤백
#
# postgres 는 건드리지 않는다 — 데이터 볼륨을 쓰는 유일한 서비스라 재생성 대상에서 제외한다.
#
set -Eeuo pipefail

APP_DIR="${APP_DIR:-/opt/omf-mes}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"
ENV_FILE="${ENV_FILE:-.env.prod}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-180}"   # 초

cd "$APP_DIR"

log() { printf '%s [deploy] %s\n' "$(date '+%F %T')" "$*"; }
die() { log "ERROR: $*"; exit 1; }

# --- 중복 실행 방지 (cron 과 수동 실행이 겹치는 사고 방지) ---
exec 9>"$APP_DIR/.deploy.lock"
flock -n 9 || die "다른 배포가 이미 진행 중입니다."

[[ -f "$ENV_FILE" ]] || die "$ENV_FILE 이 없습니다. .env.prod.example 을 복사해서 만드세요."

COMPOSE=(docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE")

# IMAGE_TAG / REGISTRY 를 셸에서도 쓰기 위해 읽는다
set -a
# shellcheck disable=SC1090
. "./$ENV_FILE"
set +a

REGISTRY="${REGISTRY:-hub.crefle.com}"
IMAGE_TAG="${IMAGE_TAG:-main}"
API_IMAGE="${REGISTRY}/mes/backend:${IMAGE_TAG}"

log "===== 배포 시작 (image=${API_IMAGE}) ====="

# --- 1) 롤백용으로 현재 api 이미지 ID 기록 ---
PREV_API=""
api_cid=$("${COMPOSE[@]}" ps -q api 2>/dev/null || true)
if [[ -n "$api_cid" ]]; then
  PREV_API=$(docker inspect --format '{{.Image}}' "$api_cid")
  log "현재 api 이미지: ${PREV_API:0:19}"
else
  log "현재 api: 실행 중 아님 (최초 배포)"
fi

rollback() {
  if [[ -z "$PREV_API" ]]; then
    log "!!! 롤백할 직전 이미지가 없습니다 (최초 배포)"
    return
  fi
  log "!!! api 를 직전 이미지로 롤백합니다"
  # 직전 이미지 ID 에 현재 태그를 다시 붙여, compose 가 그것을 쓰도록 한다
  docker tag "$PREV_API" "$API_IMAGE"
  # --no-deps: postgres·migrate 는 건드리지 않는다. 스키마는 이미 적용된 상태다.
  "${COMPOSE[@]}" up -d --no-deps --force-recreate api || true
  log "!!! 롤백 완료"
  log "!!! 주의: Prisma 마이그레이션은 forward-only 라 스키마는 되돌아가지 않았습니다."
  log "!!!       이번 배포에 스키마 변경이 있었다면 구버전 코드가 신버전 스키마를 보고 있습니다."
  log "!!!       'docker compose -f ${COMPOSE_FILE} --env-file ${ENV_FILE} logs api' 로 확인하세요."
}

# --- 2) pull ---
log "Harbor 에서 이미지 pull..."
if ! "${COMPOSE[@]}" pull api; then
  die "pull 실패 — Harbor 접속/로그인 상태를 확인하세요 (docker login ${REGISTRY})"
fi

# --- 3) 기동 (migrate 가 먼저 완료된 뒤 api 가 뜬다) ---
# 스키마 변경이 있으면 이 단계에서 자동 적용된다.
# DB 백업을 붙이고 싶다면 아래 3줄의 주석을 해제하세요:
#   log "DB 백업..."
#   "${COMPOSE[@]}" exec -T postgres pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc \
#     > "$APP_DIR/backup/$(date +%Y%m%d-%H%M%S).dump"
log "migrate → api 기동..."
if ! "${COMPOSE[@]}" up -d --remove-orphans; then
  log "기동 실패. migrate 로그:"
  "${COMPOSE[@]}" logs --tail=50 migrate || true
  # migrate 가 실패했다면 api 는 애초에 교체되지 않았다 — 현재 이미지를 확인해서 판단한다
  cur=$("${COMPOSE[@]}" ps -q api 2>/dev/null || true)
  if [[ -n "$cur" && "$(docker inspect --format '{{.Image}}' "$cur")" != "$PREV_API" ]]; then
    rollback
  else
    log "api 는 교체되지 않았습니다 — 기존 컨테이너가 그대로 서비스 중입니다."
  fi
  die "배포 실패."
fi

# --- 4) 헬스체크 대기 ---
log "api 헬스체크 대기 (최대 ${HEALTH_TIMEOUT}초)..."
deadline=$(( $(date +%s) + HEALTH_TIMEOUT ))
while :; do
  cid=$("${COMPOSE[@]}" ps -q api 2>/dev/null || true)
  if [[ -n "$cid" ]]; then
    running=$(docker inspect --format '{{.State.Running}}' "$cid")
    health=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$cid")
    if [[ "$running" == "true" && ( "$health" == "healthy" || "$health" == "none" ) ]]; then
      log "api 정상"
      break
    fi
  fi

  if [[ $(date +%s) -ge $deadline ]]; then
    log "헬스체크 타임아웃. 최근 로그:"
    "${COMPOSE[@]}" logs --tail=50 api || true
    rollback
    die "헬스체크 실패 → 롤백했습니다."
  fi
  sleep 5
done

# --- 5) 배포 기록 ---
{
  echo "deployed_at=$(date -Iseconds)"
  echo "image_tag=${IMAGE_TAG}"
  cid=$("${COMPOSE[@]}" ps -q api)
  echo "api_image=$(docker inspect --format '{{.Config.Image}}' "$cid")"
  echo "api_image_id=$(docker inspect --format '{{.Image}}' "$cid")"
  echo "prev_api_image_id=${PREV_API:-none}"
} > "$APP_DIR/DEPLOYED"
log "배포 기록: $APP_DIR/DEPLOYED"

# --- 6) 정리 (롤백 여지를 위해 7일치는 남긴다) ---
docker image prune -f --filter "until=168h" >/dev/null 2>&1 || true

log "===== 배포 완료 ====="
