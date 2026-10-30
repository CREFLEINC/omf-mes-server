#!/usr/bin/env bash
# 지금 구현된 API 를 순서대로 눌러 본다. 서버가 :3100 에 떠 있어야 한다.
set -u
API=${API:-http://localhost:3100/api}
JAR=$(mktemp -d)/cookie.txt
uuid(){ python3 -c "import uuid;print(uuid.uuid4())"; }
j(){ python3 -c "import json,sys;print(json.dumps(json.load(sys.stdin),ensure_ascii=False,indent=1))"; }
say(){ printf '\n\033[1m%s\033[0m\n' "$*"; }

say "1) 로그인"
curl -s -X POST "$API/app/sessions" -H 'Content-Type: application/json' -H "Idempotency-Key: $(uuid)" \
  -d '{"loginId":"admin","password":"demo-비밀번호-1234"}' -c "$JAR" | j

say "2) 지금 나는 누구인가"
curl -s "$API/app/sessions/current" -b "$JAR" | j

say "3) 기능 권한 격자의 «열» 117건"
curl -s "$API/app/permissions" -b "$JAR" | python3 -c "
import json,sys,collections
d=json.load(sys.stdin); print('총',len(d['items']),'건 · 축별',dict(sorted(collections.Counter(p['groupCode'] for p in d['items']).items())))"

say "4) 역할을 만들고 권한 117건을 통째로 부여 → 관리자에게 배정 → 다시 로그인"
RID=$(curl -s -X POST "$API/app/roles" -b "$JAR" -H 'Content-Type: application/json' -H "Idempotency-Key: $(uuid)" \
  -d '{"roleCode":"ROLE_DEMO_ALL","roleName":"데모 전권"}' | python3 -c "import json,sys;print(json.load(sys.stdin)['roleId'])")
curl -s "$API/app/permissions" -b "$JAR" | python3 -c "
import json,sys;print(json.dumps({'permissionCodes':[p['code'] for p in json.load(sys.stdin)['items']]}))" > /tmp/perms.json
curl -s -X PUT "$API/app/roles/$RID/permissions" -b "$JAR" -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $(uuid)" -d @/tmp/perms.json > /dev/null
curl -s -X PUT "$API/app/users/1/roles" -b "$JAR" -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $(uuid)" -d "{\"roleIds\":[4,$RID]}" > /dev/null
curl -s -X POST "$API/app/sessions" -H 'Content-Type: application/json' -H "Idempotency-Key: $(uuid)" \
  -d '{"loginId":"admin","password":"demo-비밀번호-1234"}' -c "$JAR" \
  | python3 -c "import json,sys;d=json.load(sys.stdin);print('roles',d['roles'],'· permissions',len(d['permissions']),'건')"

say "5) 창고 등록 → 상세(ETag·editability)"
PLANT=$(curl -s "$API/mdm/plants" -b "$JAR" | python3 -c "import json,sys;print(json.load(sys.stdin)['items'][0]['plantId'])")
BU=$(curl -s "$API/mdm/business-units" -b "$JAR" | python3 -c "import json,sys;print(json.load(sys.stdin)['items'][0]['businessUnitId'])")
WID=$(curl -s -X POST "$API/mdm/warehouses" -b "$JAR" -H 'Content-Type: application/json' -H "Idempotency-Key: $(uuid)" \
  -d "{\"plantId\":$PLANT,\"businessUnitId\":$BU,\"warehouseCode\":\"SMOKE-W1\",\"warehouseName\":\"연기검사 창고\",\"warehouseTypeCode\":\"MATERIAL\",\"managementLevelCode\":\"RACK\"}" \
  | python3 -c "import json,sys;print(json.load(sys.stdin)['warehouseId'])")
curl -s -D /dev/stderr -o /dev/null "$API/mdm/warehouses/$WID" -b "$JAR" 2>&1 >/dev/null | grep -i '^etag'
curl -s "$API/mdm/warehouses/$WID" -b "$JAR" | j

say "6) 로케이션을 붙이면 창고 코드가 잠긴다 (공유계약 B-4)"
curl -s -X POST "$API/mdm/locations" -b "$JAR" -H 'Content-Type: application/json' -H "Idempotency-Key: $(uuid)" \
  -d "{\"warehouseId\":$WID,\"locationCode\":\"SMOKE-L1\",\"locationName\":\"A-01-01\",\"locationTypeCode\":\"RACK\",\"allowMixedItem\":false,\"allowMixedLot\":false}" > /dev/null
curl -s "$API/mdm/warehouses/$WID" -b "$JAR" | python3 -c "import json,sys;print(json.load(sys.stdin)['editability'])"

say "7) 낙관적 잠금 — 낡은 If-Match 는 409 ConflictResponse"
BODY="{\"businessUnitId\":$BU,\"warehouseCode\":\"SMOKE-W1\",\"warehouseName\":\"한 번\",\"warehouseTypeCode\":\"MATERIAL\",\"managementLevelCode\":\"RACK\",\"isExternal\":false,\"isDefect\":false}"
curl -s -o /dev/null -X PUT "$API/mdm/warehouses/$WID" -b "$JAR" -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $(uuid)" -H 'If-Match: 1' -d "$BODY"
curl -s -w ' [HTTP %{http_code}]\n' -X PUT "$API/mdm/warehouses/$WID" -b "$JAR" -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $(uuid)" -H 'If-Match: 1' -d "$BODY"

say "8) 멱등 — 같은 키로 두 번이면 앞의 응답, 다른 내용이면 409"
K=$(uuid)
curl -s -X POST "$API/quality/cause-codes" -b "$JAR" -H 'Content-Type: application/json' -H "Idempotency-Key: $K" \
  -d '{"causeCode":"SMOKE-C1","causeName":"금형 마모"}' | python3 -c "import json,sys;print('1회차',json.load(sys.stdin)['causeCodeId'])"
curl -s -X POST "$API/quality/cause-codes" -b "$JAR" -H 'Content-Type: application/json' -H "Idempotency-Key: $K" \
  -d '{"causeCode":"SMOKE-C1","causeName":"금형 마모"}' | python3 -c "import json,sys;print('2회차',json.load(sys.stdin)['causeCodeId'])"
curl -s -w ' [HTTP %{http_code}]\n' -X POST "$API/quality/cause-codes" -b "$JAR" -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $K" -d '{"causeCode":"SMOKE-C2","causeName":"다른 내용"}'

say "9) 2계층 — 3계층 시도를 서버가 막는다"
DID=$(curl -s -X POST "$API/quality/defect-codes" -b "$JAR" -H 'Content-Type: application/json' -H "Idempotency-Key: $(uuid)" \
  -d '{"defectCode":"SMOKE-D","defectName":"외관","dispositionTypeCode":"REWORKABLE"}' \
  | python3 -c "import json,sys;print(json.load(sys.stdin)['defectCodeId'])")
D1=$(curl -s -X POST "$API/quality/defect-codes" -b "$JAR" -H 'Content-Type: application/json' -H "Idempotency-Key: $(uuid)" \
  -d "{\"defectCode\":\"SMOKE-D1\",\"defectName\":\"긁힘\",\"parentDefectCodeId\":$DID}" \
  | python3 -c "import json,sys;print(json.load(sys.stdin)['defectCodeId'])")
curl -s -w ' [HTTP %{http_code}]\n' -X POST "$API/quality/defect-codes" -b "$JAR" -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $(uuid)" -d "{\"defectCode\":\"SMOKE-D11\",\"defectName\":\"3계층\",\"parentDefectCodeId\":$D1}"

echo
echo "쿠키: $JAR"
