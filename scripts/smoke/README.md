# 손으로 만져 보는 데모

⚠ **커밋 대상이 아니다.** 지금 구현된 API 를 실제로 눌러 보려고 만든 것이라 저장소에
넣지 않았다. 필요 없으면 `scripts/smoke/` 를 지우면 된다.

## 1. DB 세우기

```bash
export PGPASSWORD=postgres
export PATH="/opt/homebrew/opt/postgresql@16/bin:$PATH"
psql -h 127.0.0.1 -p 55432 -U postgres -d postgres -c 'DROP DATABASE IF EXISTS omf_demo'
psql -h 127.0.0.1 -p 55432 -U postgres -d postgres -c 'CREATE DATABASE omf_demo'

export DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:55432/omf_demo'
npx prisma migrate deploy
ADMIN_INITIAL_PASSWORD='demo-비밀번호-1234' \
  npx ts-node --compiler-options '{"module":"commonjs"}' prisma/seed.ts
```

⚠ 시드는 **공통코드·역할·admin 계정까지만** 만든다. 법인·사업부·공장은 없다 —
창고를 세우려면 먼저 넣어야 한다.

```bash
P(){ psql -h 127.0.0.1 -p 55432 -U postgres -d omf_demo -At -c "$1"; }
P "insert into mdm.legal_entity (legal_entity_code,legal_entity_name,country_code,timezone_code) values ('DEMO-LE','데모 법인','VN','Asia/Ho_Chi_Minh')"
P "insert into mdm.business_unit (business_unit_code,business_unit_name,legal_entity_id) select 'DEMO-BU','데모 사업부',legal_entity_id from mdm.legal_entity limit 1"
P "insert into mdm.plant (plant_code,plant_name,legal_entity_id,business_unit_id,timezone_code) select 'DEMO-P','하노이 공장',le.legal_entity_id,bu.business_unit_id,'Asia/Ho_Chi_Minh' from mdm.legal_entity le join mdm.business_unit bu on true limit 1"
```

## 2. 서버 띄우기 / 다시 띄우기

```bash
bash scripts/smoke/restart.sh
```

API 가 늘 때마다 이것만 다시 돌리면 된다 — 뜬 뒤 `/api/health` 가 응답할 때까지 기다린다.

## 2-1. API 스펙 보기

`http://localhost:3100/api/docs`

⛔ Nest 가 컨트롤러에서 «반사»한 문서가 아니라 `contracts/` 의 OpenAPI 원본을 합친 것이다.
표제에 `⛔ 미구현` 이 붙은 것은 계약에는 있는데 아직 서버에 없는 자리다.

## 3. 눌러 보기

```bash
bash scripts/smoke/api-smoke.sh
```
