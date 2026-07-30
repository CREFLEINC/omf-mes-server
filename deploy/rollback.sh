#!/usr/bin/env bash
#
# 특정 이미지 버전으로 수동 롤백/고정
#
#   ./rollback.sh v1.2.3        # 릴리스 버전으로
#   ./rollback.sh sha-a1b2c3d   # 특정 커밋으로
#   ./rollback.sh main          # 다시 최신 main 추종으로 복귀
#
# 주의: Prisma 마이그레이션은 되돌아가지 않는다(forward-only).
#       스키마를 바꾼 배포를 되돌리는 경우, 구버전 코드가 신버전 스키마에서
#       동작하는지 확인해야 한다. 컬럼 추가 정도면 대개 문제없지만,
#       컬럼 삭제·타입 변경이 있었다면 구버전 코드가 깨진다.
#
set -Eeuo pipefail

APP_DIR="${APP_DIR:-/opt/omf-mes}"
ENV_FILE="${ENV_FILE:-.env.prod}"
cd "$APP_DIR"

TAG="${1:-}"
[[ -n "$TAG" ]] || { echo "사용법: $0 <이미지태그>   예) $0 v1.0.0"; exit 1; }

if grep -q '^IMAGE_TAG=' "$ENV_FILE"; then
  sed -i.bak "s|^IMAGE_TAG=.*|IMAGE_TAG=${TAG}|" "$ENV_FILE"
else
  echo "IMAGE_TAG=${TAG}" >> "$ENV_FILE"
fi

echo "IMAGE_TAG 를 ${TAG} 로 변경했습니다. 배포를 실행합니다..."
exec ./deploy.sh
