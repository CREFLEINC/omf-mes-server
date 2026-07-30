#!/usr/bin/env bash
#
# 특정 이미지 버전으로 전환 (롤백 · 릴리스 적용 공용)
#
#   ./rollback.sh v1.2.3        # 특정 릴리스로
#   ./rollback.sh sha-a1b2c3d   # 특정 커밋으로
#   ./rollback.sh stable        # 최근 릴리스 추종
#   ./rollback.sh main          # 최신 main 추종 (개발 서버)
#
# 이름은 rollback 이지만 하는 일은 ".env.prod 의 IMAGE_TAG 를 바꾸고 배포"다.
# 하노이 현장에 새 릴리스를 올릴 때도 이걸 쓴다 — deploy/RELEASE.md 5번 참조.
#
# 주의: Prisma 마이그레이션은 되돌아가지 않는다(forward-only).
#       스키마를 바꾼 배포를 되돌리는 경우, 구버전 코드가 신버전 스키마에서
#       동작하는지 확인해야 한다. 컬럼 추가 정도면 대개 문제없지만,
#       컬럼 삭제·타입 변경이 있었다면 구버전 코드가 깨진다.
#
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="${APP_DIR:-$SCRIPT_DIR}"
ENV_FILE="${ENV_FILE:-.env.prod}"
cd "$APP_DIR"

TAG="${1:-}"
[[ -n "$TAG" ]] || { echo "사용법: $0 <이미지태그>   예) $0 v1.0.0"; exit 1; }

[[ -f "$ENV_FILE" ]] || { echo "$ENV_FILE 이 없습니다."; exit 1; }

if grep -q '^IMAGE_TAG=' "$ENV_FILE"; then
  sed -i.bak "s|^IMAGE_TAG=.*|IMAGE_TAG=${TAG}|" "$ENV_FILE"
else
  echo "IMAGE_TAG=${TAG}" >> "$ENV_FILE"
fi

echo "IMAGE_TAG 를 ${TAG} 로 변경했습니다. 배포를 실행합니다..."
exec "$APP_DIR/deploy.sh"
