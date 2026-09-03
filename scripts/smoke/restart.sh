#!/usr/bin/env bash
# 데모 서버를 지금 코드로 다시 띄운다. API 가 늘 때마다 이것만 돌리면 된다.
set -euo pipefail
cd "$(dirname "$0")/../.."

pkill -f 'ts-node.*src/main.ts' 2>/dev/null || true
sleep 2

LOG=${LOG:-/tmp/omf-demo-server.log}
DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:55432/omf_demo' \
JWT_SECRET='demo-only-secret-value-not-used-in-production-0123456789' \
PORT=3100 \
  nohup npx ts-node --compiler-options '{"module":"commonjs"}' src/main.ts > "$LOG" 2>&1 &

for _ in $(seq 1 40); do
  if curl -sf -o /dev/null http://localhost:3100/api/health; then
    tail -1 "$LOG"
    exit 0
  fi
  sleep 1
done
echo "서버가 안 떴다 — $LOG 를 본다" >&2
tail -20 "$LOG" >&2
exit 1
