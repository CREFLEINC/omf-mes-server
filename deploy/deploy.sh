#!/usr/bin/env bash
#
# OMF MES 배포 스크립트
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
# root 권한은 필요하지 않다. 실행 사용자가 docker 그룹에 속해 있으면 된다.
#   확인: docker ps    (sudo 없이 동작해야 함)
#
# 배포 디렉터리는 이 스크립트가 놓인 위치로 자동 결정된다.
# 다른 곳을 쓰려면 APP_DIR 환경변수로 넘긴다.
#
# Harbor 자격증명도 배포 디렉터리를 따라간다($APP_DIR/.docker). 배포 디렉터리마다
# 다른 로봇 계정을 쓸 수 있다. 로그인은 반드시 같은 경로로 해야 한다:
#   docker --config <배포디렉터리>/.docker login hub.crefle.com -u 'robot$mes+server-pull'
#
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="${APP_DIR:-$SCRIPT_DIR}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"
ENV_FILE="${ENV_FILE:-.env.prod}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-180}"   # 초

cd "$APP_DIR"

# 로그 시각 표기용 타임존. 사이트별로 .env.prod 에서 지정한다.
#   개발 서버(한국)   LOG_TZ=Asia/Seoul
#   하노이 운영 서버  LOG_TZ=Asia/Ho_Chi_Minh
# 서버와 컨테이너는 UTC 로 돌지만, 로그를 읽는 사람은 현장 시각이 편하다.
# 여기서 TZ 를 지정해도 cron 스케줄 해석에는 영향이 없다 — 출력 형식만 바뀐다.
# (.env.prod 를 읽기 전 단계의 에러 로그는 아래 기본값으로 찍힌다)
LOG_TZ="${LOG_TZ:-UTC}"
log() { printf '%s [deploy] %s\n' "$(TZ="$LOG_TZ" date '+%F %T %Z')" "$*"; }
die() { log "ERROR: $*"; exit 1; }

# --- 중복 실행 방지 (cron 과 수동 실행이 겹치는 사고 방지) ---
exec 9>"$APP_DIR/.deploy.lock"
flock -n 9 || die "다른 배포가 이미 진행 중입니다."

[[ -f "$ENV_FILE" ]] || die "$ENV_FILE 이 없습니다. .env.prod.example 을 복사해서 만드세요."

# 호출 측이 미리 지정한 IMAGE_TAG 를 기억한다 — .env.prod 값보다 우선한다.
# docker compose 도 셸 환경변수를 --env-file 보다 우선하므로 양쪽이 항상 일치한다.
# (일치하지 않으면 롤백 시 엉뚱한 태그에 이미지를 붙이게 된다)
#
#   IMAGE_TAG=v1.2.0 ./deploy.sh     # .env.prod 는 그대로, 이번 배포만 v1.2.0
#   ./rollback.sh v1.2.0             # .env.prod 를 영구히 바꾼다
IMAGE_TAG_OVERRIDE="${IMAGE_TAG:-}"
DOCKER_CONFIG_OVERRIDE="${DOCKER_CONFIG:-}"

# IMAGE_TAG / REGISTRY / LOG_TZ 를 셸에서도 쓰기 위해 읽는다.
# (docker 확인보다 먼저 읽어야 이후 로그가 지정한 LOG_TZ 로 찍힌다)
set -a
# shellcheck disable=SC1090
. "./$ENV_FILE"
set +a

REGISTRY="${REGISTRY:-hub.crefle.com}"

# --- Harbor 자격증명 위치 ---
# 배포 디렉터리마다 다른 로봇 계정을 쓸 수 있도록 자격증명을 디렉터리 안에 둔다.
#
# 반드시 환경변수로 걸어야 한다. `docker --config` 플래그는 compose 플러그인에
# **인자로만** 전달되고 DOCKER_CONFIG 를 설정하지 않는다. 그래서 플래그 방식이면
# 아래 docker inspect/tag/prune 호출이 각자 ~/.docker 를 보게 된다.
#
#   기본값     $APP_DIR/.docker
#   덮어쓰기   .env.prod 의 DOCKER_CONFIG, 또는 셸에서 넘긴 값(이쪽이 우선)
DOCKER_CONFIG="${DOCKER_CONFIG_OVERRIDE:-${DOCKER_CONFIG:-$APP_DIR/.docker}}"
export DOCKER_CONFIG
if [[ -n "$IMAGE_TAG_OVERRIDE" ]]; then
  IMAGE_TAG="$IMAGE_TAG_OVERRIDE"
  export IMAGE_TAG          # compose 하위 프로세스도 같은 값을 보게 한다
  TAG_SOURCE="호출 측 지정 — ${ENV_FILE} 은 변경하지 않음"
else
  IMAGE_TAG="${IMAGE_TAG:-main}"
  TAG_SOURCE="${ENV_FILE}"
fi
API_IMAGE="${REGISTRY}/mes/backend:${IMAGE_TAG}"

# 무엇을 배포하려 했는지를 먼저 남긴다 — 아래 점검에서 죽어도 로그에 의도가 보인다
log "===== 배포 시작 (image=${API_IMAGE}) ====="
log "태그 출처: ${TAG_SOURCE}"
log "자격증명: ${DOCKER_CONFIG}"

# docker 접근 권한 확인 — 여기서 걸러야 원인이 명확하다.
# root 는 필요 없지만 실행 사용자가 docker 그룹에 속해 있어야 한다.
docker info >/dev/null 2>&1 || die "docker 에 접근할 수 없습니다. 실행 사용자가 docker 그룹에 속해 있는지 확인하세요 (id -nG)."

# Harbor 로그인 여부를 pull 전에 확인한다 — 여기서 안 걸러면 pull 이
# "not found" 나 "unauthorized" 로 죽어서 원인이 자격증명인지 태그인지 헷갈린다.
if [[ ! -f "$DOCKER_CONFIG/config.json" ]]; then
  die "Harbor 로그인이 없습니다 ($DOCKER_CONFIG/config.json 없음).
       docker --config '$DOCKER_CONFIG' login $REGISTRY -u 'robot\$mes+server-pull'"
fi

mkdir -p "$APP_DIR/logs"

COMPOSE=(docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE")

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
  die "pull 실패 — Harbor 접속/로그인 상태를 확인하세요.
       자격증명 위치: ${DOCKER_CONFIG}   (~/.docker 가 아닙니다)
       docker --config '${DOCKER_CONFIG}' login ${REGISTRY} -u 'robot\$mes+server-pull'"
fi

# --- 3) 기동 (migrate 가 먼저 완료된 뒤 api 가 뜬다) ---
# 스키마 변경이 있으면 이 단계에서 자동 적용된다.
# 스키마를 바꾸는 릴리스라면 배포 전 DB 백업을 권장한다 — deploy/RELEASE.md 3번 참조.
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
#
# 이미지가 스스로 들고 있는 출처를 함께 남긴다. `image_tag=main` 만으로는
# "지금 무엇이 돌고 있나"에 답할 수 없다 — 가변 태그는 언제든 다른 것을 가리킨다.
# git_revision 과 image_digest 가 태그를 신뢰하지 않고 대조할 수 있는 값이다.
#
# 주의: api_image_id 는 config blob digest 이고, Harbor·빌드 로그가 보여주는 것은
#       manifest digest 다. 같은 이미지인데도 값이 다르므로 서로 대조하면 안 된다.
cid=$("${COMPOSE[@]}" ps -q api)
img_id=$(docker inspect --format '{{.Image}}' "$cid")

# build-push.yml 의 metadata-action 이 붙이는 OCI 라벨. 라벨이 없으면 <no value> 가 나온다.
GIT_REV=$(docker inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$cid" 2>/dev/null || true)
if [[ -z "$GIT_REV" || "$GIT_REV" == "<no value>" ]]; then GIT_REV=none; fi

# RepoDigests 는 레지스트리에서 받아온 이미지에만 있다. 롤백에서 docker tag 로
# 붙인 태그나 로컬 빌드에는 없을 수 있으므로 그때는 none 으로 남긴다.
IMG_DIGEST=$(docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$img_id" 2>/dev/null \
  | grep -m1 -F "${REGISTRY}/mes/backend@" || true)
IMG_DIGEST="${IMG_DIGEST#*@}"
if [[ -z "$IMG_DIGEST" ]]; then IMG_DIGEST=none; fi

{
  echo "deployed_at=$(TZ="$LOG_TZ" date -Iseconds)"
  echo "image_tag=${IMAGE_TAG}"
  echo "git_revision=${GIT_REV}"
  echo "image_digest=${IMG_DIGEST}"
  echo "api_image=$(docker inspect --format '{{.Config.Image}}' "$cid")"
  echo "api_image_id=${img_id}"
  echo "prev_api_image_id=${PREV_API:-none}"
} > "$APP_DIR/DEPLOYED"
log "배포 기록: $APP_DIR/DEPLOYED"
log "  git_revision=${GIT_REV}"
log "  image_digest=${IMG_DIGEST}"

# --- 6) 정리 (롤백 여지를 위해 7일치는 남긴다) ---
#
# 반드시 라벨로 우리 이미지에 한정한다. `docker image prune` 은 데몬 전역에서
# 도는 명령이라, 다른 서비스와 도커를 공유하는 서버(개발 서버가 그렇다)에서
# 범위를 안 좁히면 남의 dangling 이미지까지 -f 로 지운다.
#
# 이 라벨은 build-push.yml 의 metadata-action 이 모든 빌드에 붙인다.
# 라벨이 바뀌면 이 줄은 아무것도 못 지우게 될 뿐 사고는 나지 않는다.
PRUNE_LABEL="org.opencontainers.image.source=https://github.com/CREFLEINC/omf-mes-server"
docker image prune -f \
  --filter "until=168h" \
  --filter "label=${PRUNE_LABEL}" >/dev/null 2>&1 || true

log "===== 배포 완료 ====="
