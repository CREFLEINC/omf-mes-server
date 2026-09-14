#!/usr/bin/env bash
#
# OMF MES 배포 스크립트 — 블루-그린
#
# 3100 은 proxy(nginx)가 받고 api-blue·api-green 중 «켜진 쪽»으로 넘긴다.
# 켜진 쪽은 proxy/active/upstream.conf 한 줄이 정한다 — 이 파일이 유일한 출처다.
#
# 동작:
#   1) 켜진 쪽을 읽고, 이번에 올릴 반대쪽을 정한다
#   2) Harbor 에서 .env.prod 의 IMAGE_TAG 이미지를 pull
#   3) migrate(1회성)
#   4) 반대쪽 api 를 새 이미지로 띄우고 healthy 대기
#   5) upstream 을 반대쪽으로 바꿔 nginx reload → proxy 를 거쳐 헬스체크
#   6) 드레인 뒤 이전 쪽 api 를 멈춘다 (지우지 않는다 — 급할 때 되돌릴 자리)
#
# 3)·4) 에서 실패하면 전환 전이라 켜진 쪽이 그대로 서비스한다.
# 5) 에서 실패하면 upstream 을 이전 쪽으로 되돌린다 — 이전 쪽은 6) 전까지 떠 있다.
#
# ⚠ 4)~6) 사이(수십 초) 옛 코드가 새 스키마 위에서 돈다. 컬럼 삭제·이름 변경·기본값 없는
#   NOT NULL 추가는 두 릴리스로 나눈다 — deploy/RELEASE.md 「마이그레이션 작성 규칙」.
#
# 옛 단일 `api` 컨테이너가 남아 있으면 첫 전환이다. 새 쪽이 healthy 가 된 뒤 옛 컨테이너를
# 멈추고 proxy 가 3100 을 넘겨받는다 — 그 몇 초만 끊긴다.
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
DRAIN_SECONDS="${DRAIN_SECONDS:-15}"      # 전환 뒤 이전 쪽이 처리 중인 요청을 끝낼 시간(초)

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
# (일치하지 않으면 DEPLOYED 의 image_tag 가 실제로 뜬 이미지와 달라진다)
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
if [[ -f "$DOCKER_CONFIG/config.json" ]]; then
  log "Harbor 자격증명 확인: $DOCKER_CONFIG/config.json"
else
  # 공개 저장소는 인증 없이 pull할 수 있다. 비공개 저장소라면 이후
  # docker pull 단계에서 인증 오류가 발생하므로 원인이 그대로 드러난다.
  log "Harbor 로그인 없음 — 공개 이미지 pull을 시도합니다 ($DOCKER_CONFIG/config.json 없음)"
fi

mkdir -p "$APP_DIR/logs" "$APP_DIR/proxy/active"
# proxy 설정은 저장소 deploy/proxy/omf-api.conf 에서 온다(deploy-dev.yml·install-deploy.sh 가 복사).
[[ -f "$APP_DIR/proxy/conf.d/omf-api.conf" ]] \
  || die "proxy/conf.d/omf-api.conf 가 없습니다. 저장소의 deploy/proxy/omf-api.conf 를 복사하세요."

COMPOSE=(docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE")
UPSTREAM_FILE="$APP_DIR/proxy/active/upstream.conf"
PROJECT=$("${COMPOSE[@]}" config 2>/dev/null | sed -n 's/^name: //p')
[[ -n "$PROJECT" ]] || die "compose 설정을 읽지 못했습니다: ${COMPOSE_FILE}"

cid_of() { "${COMPOSE[@]}" ps -a -q "$1" 2>/dev/null || true; }
is_running() { [[ -n "$1" && "$(docker inspect --format '{{.State.Running}}' "$1" 2>/dev/null)" == "true" ]]; }
upstream_line() { printf 'server api-%s:3100 resolve;\n' "$1"; }

wait_healthy() {
  local service="$1" deadline cid health
  deadline=$(( $(date +%s) + HEALTH_TIMEOUT ))
  while :; do
    cid=$("${COMPOSE[@]}" ps -q "$service" 2>/dev/null || true)
    if is_running "$cid"; then
      health=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$cid")
      [[ "$health" == "healthy" || "$health" == "none" ]] && return 0
    fi
    [[ $(date +%s) -lt $deadline ]] || return 1
    sleep 2
  done
}

# proxy 안에서 경로를 불러 본다(최대 10초). /_proxy/health 는 nginx 자신, /api/health 는 넘겨받은 api 다.
# Docker 헬스체크(10초 간격)를 기다리지 않는다 — 첫 전환에서 옛 api 로 되돌리는 판단이 그만큼 늦어진다.
through_proxy() {
  local path="$1" _
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    "${COMPOSE[@]}" exec -T proxy wget -q -O /dev/null "http://127.0.0.1:3100${path}" 2>/dev/null && return 0
    sleep 1
  done
  return 1
}

# upstream 을 한쪽으로 바꾸고 reload 한다. 실패하면 파일을 되돌리고 1 — 그때 nginx 는 옛 설정 그대로다.
switch_upstream() {
  local color="$1" before _
  before=$(cat "$UPSTREAM_FILE" 2>/dev/null || true)
  upstream_line "$color" > "$UPSTREAM_FILE.tmp"
  mv "$UPSTREAM_FILE.tmp" "$UPSTREAM_FILE"
  # 호스트에서 바꾼 파일이 컨테이너 안에 «보인 뒤» 검사한다. 안 보인 채 reload 하면
  # 옛 내용으로 성공해 전환이 조용히 안 된다(Docker Desktop 에서 실측 — 잠깐 늦게 보인다).
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    if "${COMPOSE[@]}" exec -T proxy cat /etc/nginx/omf-active/upstream.conf 2>/dev/null | grep -qF "api-${color}:"; then
      if "${COMPOSE[@]}" exec -T proxy nginx -t -q && "${COMPOSE[@]}" exec -T proxy nginx -s reload; then
        return 0
      fi
      break
    fi
    sleep 0.5
  done
  log "!!! upstream 을 api-${color} 로 바꾸지 못했습니다 — 파일을 되돌립니다"
  if [[ -n "$before" ]]; then printf '%s\n' "$before" > "$UPSTREAM_FILE"; fi
  return 1
}

# --- 1) 켜진 쪽 파악 ---
ACTIVE=$(grep -oE 'api-(blue|green):' "$UPSTREAM_FILE" 2>/dev/null | head -1 | sed -E 's/api-|://g' || true)
if [[ "$ACTIVE" == "blue" ]]; then TARGET=green; else TARGET=blue; fi

# compose 파일에서 사라진 옛 단일 api 서비스의 컨테이너 — 있으면 이번이 블루-그린 첫 전환이다.
mapfile -t LEGACY_API < <(docker ps -a -q \
  --filter "label=com.docker.compose.project=${PROJECT}" --filter "label=com.docker.compose.service=api")

PREV_COLOR=""
PREV_CID=""
if [[ -n "$ACTIVE" ]] && is_running "$(cid_of "api-${ACTIVE}")"; then
  PREV_COLOR="$ACTIVE"
  PREV_CID=$(cid_of "api-${ACTIVE}")
elif (( ${#LEGACY_API[@]} > 0 )); then
  PREV_CID="${LEGACY_API[0]}"
fi
PREV_API=""
if [[ -n "$PREV_CID" ]]; then PREV_API=$(docker inspect --format '{{.Image}}' "$PREV_CID"); fi

if [[ -n "$PREV_COLOR" ]]; then
  log "켜진 쪽: api-${PREV_COLOR} (${PREV_API:0:19}) → 이번에 올릴 쪽: api-${TARGET}"
elif (( ${#LEGACY_API[@]} > 0 )); then
  log "옛 단일 api 컨테이너(${PREV_API:0:19})가 있습니다 — 블루-그린 첫 전환입니다 (3100 을 넘기는 몇 초 끊김)"
else
  log "켜진 api 없음 — api-${TARGET} 로 시작합니다"
fi

# --- 2) pull ---
log "Harbor 에서 이미지 pull..."
if ! "${COMPOSE[@]}" pull "api-${TARGET}"; then
  die "pull 실패 — Harbor 접속/로그인 상태를 확인하세요.
       자격증명 위치: ${DOCKER_CONFIG}   (~/.docker 가 아닙니다)
       docker --config '${DOCKER_CONFIG}' login ${REGISTRY} -u 'robot\$mes+server-pull'"
fi

# proxy(nginx) 이미지는 «없을 때만» 여기서 받는다.
# - 전환 단계에서 받으면 옛 api 를 멈춘 뒤라 받는 동안 끊긴다(개발 서버 첫 전환 실측 약 6초).
# - 매번 받으면 같은 태그에 새 패치가 나올 때마다 proxy 가 재생성되며 끊긴다.
PROXY_IMAGE=$("${COMPOSE[@]}" config --images proxy 2>/dev/null | head -1 || true)
if [[ -z "$PROXY_IMAGE" ]] || ! docker image inspect "$PROXY_IMAGE" >/dev/null 2>&1; then
  log "proxy 이미지 pull (${PROXY_IMAGE:-이름 확인 실패})..."
  "${COMPOSE[@]}" pull proxy || die "proxy 이미지 pull 실패 — 아무것도 바꾸지 않았습니다."
fi

# --- 3) migrate ---
# 스키마 변경이 있으면 여기서 적용된다. 켜진 쪽은 계속 서비스한다.
# 스키마를 바꾸는 릴리스라면 배포 전 DB 백업을 권장한다 — deploy/RELEASE.md 3번 참조.
log "migrate..."
if ! "${COMPOSE[@]}" run --rm -T migrate; then
  die "migrate 실패 — 전환하지 않았습니다. 켜진 쪽이 그대로 서비스 중입니다."
fi

# --- 4) 반대쪽 기동 ---
log "api-${TARGET} 기동, 헬스체크 대기 (최대 ${HEALTH_TIMEOUT}초)..."
if ! "${COMPOSE[@]}" up -d --no-deps --force-recreate "api-${TARGET}" || ! wait_healthy "api-${TARGET}"; then
  log "api-${TARGET} 이 healthy 가 되지 않았습니다. 최근 로그:"
  "${COMPOSE[@]}" logs --tail=50 "api-${TARGET}" || true
  "${COMPOSE[@]}" stop "api-${TARGET}" || true
  die "전환하지 않았습니다 — 켜진 쪽이 그대로 서비스 중입니다."
fi
log "api-${TARGET} 정상"

# --- 5) 전환 ---
if (( ${#LEGACY_API[@]} > 0 )); then
  # 옛 api 가 3100 을 쥐고 있어 proxy 를 먼저 띄울 수 없다. 멈춘 컨테이너는 포트를 놓는다.
  # 지우지 않고 멈추기만 한다 — proxy 가 실패하면 다시 켠다.
  upstream_line "$TARGET" > "$UPSTREAM_FILE"
  log "옛 api 컨테이너를 멈추고 proxy 가 3100 을 넘겨받습니다..."
  docker stop "${LEGACY_API[@]}" >/dev/null
  if ! "${COMPOSE[@]}" up -d --no-deps proxy || ! through_proxy /_proxy/health || ! through_proxy /api/health; then
    log "!!! proxy 로 넘기지 못했습니다 — 옛 api 컨테이너를 다시 켭니다. 최근 로그:"
    "${COMPOSE[@]}" logs --tail=30 proxy || true
    "${COMPOSE[@]}" rm -sf proxy >/dev/null 2>&1 || true
    docker start "${LEGACY_API[@]}" >/dev/null || true
    "${COMPOSE[@]}" stop "api-${TARGET}" || true
    rm -f "$UPSTREAM_FILE"
    die "첫 전환 실패 — 옛 구성으로 되돌렸습니다."
  fi
  docker rm "${LEGACY_API[@]}" >/dev/null
else
  [[ -f "$UPSTREAM_FILE" ]] || upstream_line "$TARGET" > "$UPSTREAM_FILE"
  # 평소에는 아무것도 안 바뀐다. proxy 정의(이미지 등)가 바뀐 배포에서만 재생성되며 잠깐 끊긴다.
  "${COMPOSE[@]}" up -d --no-deps proxy || die "proxy 기동 실패."
  through_proxy /_proxy/health || die "proxy 가 응답하지 않습니다."
  if ! switch_upstream "$TARGET"; then
    "${COMPOSE[@]}" stop "api-${TARGET}" || true
    die "전환하지 않았습니다 — 켜진 쪽이 그대로 서비스 중입니다."
  fi
  if ! through_proxy /api/health; then
    log "!!! proxy 를 거친 헬스체크 실패"
    if [[ -n "$PREV_COLOR" ]] && switch_upstream "$PREV_COLOR"; then
      "${COMPOSE[@]}" stop "api-${TARGET}" || true
      die "api-${PREV_COLOR} 로 되돌렸습니다."
    fi
    die "되돌릴 쪽이 없습니다 — 'docker compose -f ${COMPOSE_FILE} --env-file ${ENV_FILE} logs proxy api-${TARGET}' 로 확인하세요."
  fi
fi
log "전환 완료 — proxy → api-${TARGET}"

# --- 6) 이전 쪽 중지 ---
if [[ -n "$PREV_COLOR" ]]; then
  log "api-${PREV_COLOR} 드레인 ${DRAIN_SECONDS}초 뒤 중지 (지우지 않는다)..."
  sleep "$DRAIN_SECONDS"
  "${COMPOSE[@]}" stop "api-${PREV_COLOR}" \
    || log "api-${PREV_COLOR} 중지 실패 — 떠 있어도 요청은 api-${TARGET} 로만 갑니다."
fi

# --- 7) 배포 기록 ---
#
# 이미지가 스스로 들고 있는 출처를 함께 남긴다. `image_tag=main` 만으로는
# "지금 무엇이 돌고 있나"에 답할 수 없다 — 가변 태그는 언제든 다른 것을 가리킨다.
# git_revision 과 image_digest 가 태그를 신뢰하지 않고 대조할 수 있는 값이다.
#
# 주의: api_image_id 는 config blob digest 이고, Harbor·빌드 로그가 보여주는 것은
#       manifest digest 다. 같은 이미지인데도 값이 다르므로 서로 대조하면 안 된다.
cid=$(cid_of "api-${TARGET}")
img_id=$(docker inspect --format '{{.Image}}' "$cid")

# build-push.yml 의 metadata-action 이 붙이는 OCI 라벨. 라벨이 없으면 <no value> 가 나온다.
GIT_REV=$(docker inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$cid" 2>/dev/null || true)
if [[ -z "$GIT_REV" || "$GIT_REV" == "<no value>" ]]; then GIT_REV=none; fi

# RepoDigests 는 레지스트리에서 받아온 이미지에만 있다. docker tag 로 붙인 태그나
# 로컬 빌드에는 없을 수 있으므로 그때는 none 으로 남긴다.
IMG_DIGEST=$(docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$img_id" 2>/dev/null \
  | grep -m1 -F "${REGISTRY}/mes/backend@" || true)
IMG_DIGEST="${IMG_DIGEST#*@}"
if [[ -z "$IMG_DIGEST" ]]; then IMG_DIGEST=none; fi

{
  echo "deployed_at=$(TZ="$LOG_TZ" date -Iseconds)"
  echo "image_tag=${IMAGE_TAG}"
  echo "git_revision=${GIT_REV}"
  echo "image_digest=${IMG_DIGEST}"
  echo "active_color=${TARGET}"
  echo "api_image=$(docker inspect --format '{{.Config.Image}}' "$cid")"
  echo "api_image_id=${img_id}"
  echo "prev_api_image_id=${PREV_API:-none}"
} > "$APP_DIR/DEPLOYED"
log "배포 기록: $APP_DIR/DEPLOYED"
log "  git_revision=${GIT_REV}"
log "  image_digest=${IMG_DIGEST}"

# --- 8) 정리 (롤백 여지를 위해 7일치는 남긴다) ---
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
