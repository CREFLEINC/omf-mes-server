#!/usr/bin/env bash
# 데모 서버를 지금 코드로 다시 띄운다. API 가 늘 때마다 이것만 돌리면 된다.
set -euo pipefail
cd "$(dirname "$0")/../.."

pkill -f 'ts-node.*src/main.ts' 2>/dev/null || true
sleep 2

LOG=${LOG:-/tmp/omf-demo-server.log}

# LAN 에서 부를 수 있게 이 기계의 IP 를 알아내 CORS 목록에 넣는다.
# 화면 개발 서버가 다른 포트로 뜨는 경우를 함께 연다(5173=Vite, 3000=Next).
LAN_IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo '')
ORIGINS='http://localhost:5173,http://localhost:3000'
if [ -n "$LAN_IP" ]; then
  ORIGINS="$ORIGINS,http://$LAN_IP:5173,http://$LAN_IP:3000"
fi

DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:55432/omf_demo' \
JWT_SECRET='demo-only-secret-value-not-used-in-production-0123456789' \
CORS_ORIGINS="$ORIGINS" \
PORT=3100 \
  nohup npx ts-node --compiler-options '{"module":"commonjs"}' src/main.ts > "$LOG" 2>&1 &

for _ in $(seq 1 40); do
  if curl -sf -o /dev/null http://localhost:3100/api/health; then
    tail -1 "$LOG"
    [ -n "$LAN_IP" ] && echo "LAN: http://$LAN_IP:3100/api  (docs: /api/docs)"
    exit 0
  fi
  sleep 1
done
echo "서버가 안 떴다 — $LOG 를 본다" >&2
tail -20 "$LOG" >&2
exit 1
