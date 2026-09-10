#!/usr/bin/env bash
#
# OMF MES 현장 설치·초기 배포
#
# 사용법:
#   ./install-deploy.sh
#   APP_DIR=/opt/services/omf-mes-server ./install-deploy.sh
#
# 이 스크립트는 최초 환경 설정과 Registry 로그인을 담당한다.
# 실제 이미지 pull, migration, healthcheck, 롤백은 deploy.sh에 위임한다.
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="${APP_DIR:-/opt/services/omf-mes-server}"
REGISTRY="hub.crefle.com"
ENV_FILE="$APP_DIR/.env.prod"
DOCKER_CONFIG_DIR="$APP_DIR/.docker"

die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

prompt_default() {
  local prompt="$1" default="$2" value
  read -r -p "$prompt [$default]: " value
  printf '%s' "${value:-$default}"
}

validate_port() {
  [[ "$1" =~ ^[0-9]+$ ]] && (( 1 <= 10#$1 && 10#$1 <= 65535 ))
}

prompt_admin_password() {
  local password confirmation

  while true; do
    read -r -s -p '초기 관리자 비밀번호 (8자 이상): ' password
    printf '\n' >&2
    if (( ${#password} < 8 )); then
      printf '%s\n' '초기 관리자 비밀번호는 8자 이상이어야 합니다.' >&2
      continue
    fi
    if [[ "$password" == *"'"* ]]; then
      printf '%s\n' "초기 관리자 비밀번호에는 작은따옴표(')를 사용할 수 없습니다." >&2
      continue
    fi

    read -r -s -p '초기 관리자 비밀번호 확인: ' confirmation
    printf '\n' >&2
    if [[ "$password" != "$confirmation" ]]; then
      printf '%s\n' '입력한 초기 관리자 비밀번호가 일치하지 않습니다.' >&2
      continue
    fi

    printf '%s' "$password"
    return
  done
}

command -v docker >/dev/null 2>&1 || die "docker가 설치되어 있지 않습니다."
command -v openssl >/dev/null 2>&1 || die "openssl이 설치되어 있지 않습니다."
docker compose version >/dev/null 2>&1 || die "docker compose 플러그인을 사용할 수 없습니다."
docker info >/dev/null 2>&1 || die "현재 사용자가 Docker를 사용할 수 없습니다. docker 그룹 권한을 확인하세요."

mkdir -p "$APP_DIR" "$DOCKER_CONFIG_DIR"
[[ -f "$SCRIPT_DIR/../docker-compose.prod.yml" ]] || die "docker-compose.prod.yml을 설치 패키지에서 찾을 수 없습니다."
[[ -f "$SCRIPT_DIR/deploy.sh" ]] || die "deploy.sh를 설치 패키지에서 찾을 수 없습니다."
[[ -f "$SCRIPT_DIR/rollback.sh" ]] || die "rollback.sh를 설치 패키지에서 찾을 수 없습니다."
[[ -f "$SCRIPT_DIR/seed/load-mes-initial-data.sh" ]] || die "기초데이터 실행 스크립트를 설치 패키지에서 찾을 수 없습니다."
[[ -f "$SCRIPT_DIR/seed/mes-initial-data.sql" ]] || die "기초데이터 SQL을 설치 패키지에서 찾을 수 없습니다."
[[ -f "$SCRIPT_DIR/seed/README.md" ]] || die "기초데이터 안내 문서를 설치 패키지에서 찾을 수 없습니다."

if [[ -e "$ENV_FILE" ]]; then
  die "$ENV_FILE이 이미 존재합니다. 기존 설정을 보존하기 위해 중단합니다. 백업 후 다시 실행하세요."
fi

printf '%s\n' "OMF MES 초기 배포 설정을 입력하세요. 비밀번호 입력은 화면에 표시되지 않습니다."
POSTGRES_USER="$(prompt_default 'PostgreSQL 사용자' 'omf')"
read -r -s -p 'PostgreSQL 비밀번호: ' POSTGRES_PASSWORD
printf '\n'
[[ -n "$POSTGRES_PASSWORD" ]] || die "PostgreSQL 비밀번호는 필수입니다."
POSTGRES_DB="$(prompt_default 'PostgreSQL 데이터베이스' 'omf_mes')"
API_PORT="$(prompt_default '외부 API 포트' '3100')"
validate_port "$API_PORT" || die "API 포트는 1~65535 사이의 숫자여야 합니다."
IMAGE_TAG="$(prompt_default '배포할 이미지 태그' 'v1.0.0')"
[[ "$IMAGE_TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "이미지 태그는 v1.2.3 형식이어야 합니다."
LOG_TZ="$(prompt_default '로그 표기 타임존' 'Asia/Seoul')"
COOKIE_SECURE="$(prompt_default 'COOKIE_SECURE (TLS 사용 시 true)' 'false')"
[[ "$COOKIE_SECURE" == true || "$COOKIE_SECURE" == false ]] || die "COOKIE_SECURE는 true 또는 false여야 합니다."
ADMIN_INITIAL_PASSWORD="$(prompt_admin_password)"
JWT_SECRET="$(openssl rand -base64 48 | tr -d '\n')"

install -m 644 "$SCRIPT_DIR/../docker-compose.prod.yml" "$APP_DIR/docker-compose.prod.yml"
install -m 755 "$SCRIPT_DIR/deploy.sh" "$APP_DIR/deploy.sh"
install -m 755 "$SCRIPT_DIR/rollback.sh" "$APP_DIR/rollback.sh"
install -d -m 755 "$APP_DIR/seed"
install -m 755 "$SCRIPT_DIR/seed/load-mes-initial-data.sh" "$APP_DIR/seed/load-mes-initial-data.sh"
install -m 644 "$SCRIPT_DIR/seed/mes-initial-data.sql" "$APP_DIR/seed/mes-initial-data.sql"
install -m 644 "$SCRIPT_DIR/seed/README.md" "$APP_DIR/seed/README.md"

tmp_env="$(mktemp "$APP_DIR/.env.prod.XXXXXX")"
trap 'rm -f "$tmp_env"' EXIT
chmod 600 "$tmp_env"
{
  printf 'POSTGRES_USER=%s\n' "$POSTGRES_USER"
  printf 'POSTGRES_PASSWORD=%s\n' "$POSTGRES_PASSWORD"
  printf 'POSTGRES_DB=%s\n' "$POSTGRES_DB"
  printf 'JWT_SECRET=%s\n' "$JWT_SECRET"
  printf 'JWT_EXPIRES_IN_SECONDS=28800\n'
  printf 'COOKIE_SECURE=%s\n' "$COOKIE_SECURE"
  # 이 파일은 Docker Compose와 셸에서 함께 읽는다. 작은따옴표로 감싸면 공백·$·#가
  # 들어간 비밀번호도 두 파서가 같은 평문 값으로 해석한다.
  printf "ADMIN_INITIAL_PASSWORD='%s'\n" "$ADMIN_INITIAL_PASSWORD"
  printf 'API_PORT=%s\n' "$API_PORT"
  printf 'REGISTRY=%s\n' "$REGISTRY"
  printf 'DOCKER_CONFIG=%s\n' "$DOCKER_CONFIG_DIR"
  printf 'IMAGE_TAG=%s\n' "$IMAGE_TAG"
  printf 'LOG_TZ=%s\n' "$LOG_TZ"
} > "$tmp_env"
mv "$tmp_env" "$ENV_FILE"
trap - EXIT
chmod 600 "$ENV_FILE"

printf '\n%s에 Registry 로그인합니다. 배포용 계정 정보를 입력하세요.\n' "$REGISTRY"
DOCKER_CONFIG="$DOCKER_CONFIG_DIR" docker login "$REGISTRY"

cd "$APP_DIR"
DOCKER_CONFIG="$DOCKER_CONFIG_DIR" docker compose -f docker-compose.prod.yml --env-file .env.prod config >/dev/null \
  || die "Docker Compose 설정 검증에 실패했습니다."
DOCKER_CONFIG="$DOCKER_CONFIG_DIR" ./deploy.sh

printf '\n초기 배포가 완료되었습니다.\n접속 주소: http://<서버 LAN IP>:%s\n' "$API_PORT"
printf '기초데이터 확인: %s/seed/load-mes-initial-data.sh --dry-run\n' "$APP_DIR"
printf '기초데이터 적재: %s/seed/load-mes-initial-data.sh\n' "$APP_DIR"
