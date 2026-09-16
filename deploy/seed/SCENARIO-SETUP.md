# 시나리오 테스트 서버 데이터 셋업 절차

서버를 최신으로 배포한 뒤 DB 를 **비우고**, 기초데이터와 시나리오 데이터를 다시 세우는 절차다.
배포 담당자가 이 문서만 보고 처음부터 끝까지 진행할 수 있게 쓴다.

대상은 **개발·교육·테스트 서버**다. **운영(하노이) DB 에는 절대 하지 않는다** — DB 를 비우고
시나리오 시드를 넣는 절차라서다.

이 절차가 끝나면 아래 시나리오를 화면에서 처음부터 돌릴 수 있다.

| 순서 | 시나리오 | 흐름 |
|---|---|---|
| 1 | PLAN-WO-01 | ERP 생산오더 → 생산계획 → 확정(W/O) → 배포(자재 출고요청·피킹 지시) |
| 2 | PICK-ISSUE-01 | 모바일 피킹·출고 확정 → 생산창고 입고 → 관리자 웹 확인 |
| 3 | WIP-CHAIN-01 | POP 사출 작업 시작 → 자재 투입 → 실적·생산 LOT 라벨·완료 → 모바일 WIP 인계 → POP 조립 → 관리자 웹 확인 |
| (선택) | 제품 출하 피킹 | 출하작업지시 편성 → 모바일 제품 피킹 → 출하 처리 → POP 포장·출고 QR(포장 라벨·납품 라벨) 발행·부착 → 출하 확정. 제품 재고 시드(`mes-scenario-data.sql`)를 함께 넣으면 위 흐름과 같은 DB 에서 돌릴 수 있다 |

## 0. 전제

- 배포 디렉터리는 `/opt/services/omf-mes-server` 다(`install-deploy.sh` 기본값). 아래는 모두 이 디렉터리에서 실행한다.
- `.env.prod` 에 `POSTGRES_USER` · `POSTGRES_PASSWORD` · `POSTGRES_DB` 가 있고, **`ADMIN_INITIAL_PASSWORD` 가 비어 있지 않아야** 한다.
  표준 시드가 관리자 계정 `admin` 의 비밀번호를 이 값으로 만든다. 비어 있으면 로그인할 수 없다.
- 시나리오 SQL 은 설치 패키지에 들어가지 않는다(`install-deploy.sh` 는 `mes-initial-data.sql` 만 설치한다).
  저장소 `deploy/seed/` 의 아래 파일을 배포 디렉터리 `seed/` 로 **손으로 복사**한다.

| 파일 | 역할 |
|---|---|
| `mes-scenario-plan-wo-01.sql` | 공정·라인·설비·위치·라우팅·BOM 공정 매핑·시작 재고·ERP 생산오더 |
| `mes-scenario-pick-wip-01.sql` | 라우팅 공정 선후행 · 교대(24시간) · 단말 3대 · POP 단말-공정 매핑 |
| `mes-scenario-data.sql` (선택) | 제품 출하 피킹용 — S240 위치 1 · 제품 재고 10종(`SEED-S240-0001`~`0010`, 입고 전표 `GR-SEED-0001`) · 자재 P/O 5건. 위 두 파일과 독립이라 순서를 가리지 않는다 |

- 진행 중 쓰는 compose 명령은 아래 한 줄로 줄여 둔다.

```bash
cd /opt/services/omf-mes-server
C="docker compose -f docker-compose.prod.yml --env-file .env.prod"
set -a; . ./.env.prod; set +a
```

## 1. 서버 최신 배포

개발 서버는 GitHub Actions `deploy-dev` 가 main 병합 뒤 자동으로 배포한다. 수동으로 하려면:

```bash
./deploy.sh
grep -E 'git_revision|active_color' DEPLOYED
```

`deploy.sh` 는 이미지 pull → migrate → 반대쪽 api 기동 → 전환 → 이전 쪽 중지를 한다. DB 볼륨(`pgdata`)은
건드리지 않는다. 배포가 끝난 뒤 다음 단계로 간다.

## 2. 백업 (되돌릴 일이 있을 때를 위해)

DB 를 비우기 전에 덤프를 하나 떠 둔다. 첨부 파일 볼륨까지 뜨는 방법은 `RELEASE.md` 3번에 있다.

```bash
mkdir -p backup
$C exec -T postgres pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc \
  > backup/$(date -u +%Y%m%dT%H%M%SZ)-before-scenario-reset.dump
ls -lh backup/
```

## 3. DB 비우기

api 가 DB 에 붙어 있으면 DROP 이 막힌다. **양쪽 api 를 먼저 멈춘다.** 서비스가 잠시 끊기므로
사용자에게 미리 알린다.

```bash
$C stop api-blue api-green
$C exec -T postgres psql -U "$POSTGRES_USER" -d postgres \
  -c "DROP DATABASE \"$POSTGRES_DB\" WITH (FORCE);" \
  -c "CREATE DATABASE \"$POSTGRES_DB\" OWNER \"$POSTGRES_USER\";"
```

⛔ `docker compose down -v` 는 쓰지 않는다. 첨부 파일 볼륨(`attachments`)까지 지운다.

## 4. 스키마 반영

빈 DB 에 마이그레이션을 다시 적용한다. `deploy.sh` 의 migrate 는 배포 시점에 한 번 돈 것이라 DB 를 비운 뒤에는
따로 돌려야 한다.

```bash
$C run --rm -T migrate
```

마지막 줄이 `All migrations have been successfully applied.` 이어야 한다.

## 5. 데이터 적재 (순서 고정)

각 단계는 `--dry-run` 으로 먼저 검증한다. dry-run 은 SQL 전체와 검증을 실행한 뒤 롤백한다.
로더는 적용할 때마다 표준 애플리케이션 시드(`node dist/seed.js`)를 먼저 돌린다 — 재실행해도 안전하다.

```bash
# (1) 표준 시드 + 고객 기초데이터
seed/load-mes-initial-data.sh --dry-run
seed/load-mes-initial-data.sh

# (1b · 선택) 제품 출하 피킹용 제품 재고 — 넣지 않으면 아래 9번의 «제품 출하 피킹»만 못 한다
SQL_FILE=seed/mes-scenario-data.sql seed/load-mes-initial-data.sh --dry-run
SQL_FILE=seed/mes-scenario-data.sql seed/load-mes-initial-data.sh

# (2) PLAN-WO-01 — 공정·설비·라우팅·위치·시작 재고·생산오더
SQL_FILE=seed/mes-scenario-plan-wo-01.sql seed/load-mes-initial-data.sh --dry-run
SQL_FILE=seed/mes-scenario-plan-wo-01.sql seed/load-mes-initial-data.sh

# (3) PICK-ISSUE-01 → WIP-CHAIN-01 — 선후행·교대·단말·매핑
SQL_FILE=seed/mes-scenario-pick-wip-01.sql seed/load-mes-initial-data.sh --dry-run
SQL_FILE=seed/mes-scenario-pick-wip-01.sql seed/load-mes-initial-data.sh
```

- (2) 없이 (3) 을 돌리면 사전 검사에서 멈추고 롤백한다(`라우팅 RT-F534F50200-01 이 없습니다`).
- (3) 은 **계획을 확정하기 전**에 넣어야 한다. 라우팅 공정 선후행은 계획을 확정하는 순간에만 W/O 선후행으로
  옮겨지고, 그것이 있어야 모바일 WIP 인계가 후행 W/O 를 찾는다. 이미 확정한 계획이 있으면
  `-v backfill_wo_dependency=true` 로 소급할 수 있다(파일 머리말 참조).
- 마지막 출력의 `등록되지 않은 단말 3대` NOTICE 는 정상이다(7번에서 등록한다).

## 6. api 재기동

멈춘 api 를 다시 올린다. 켜진 쪽은 `DEPLOYED` 의 `active_color` 다.

```bash
ACTIVE=$(sed -n 's/^active_color=//p' DEPLOYED)
$C up -d --no-deps "api-$ACTIVE"
curl -fsS http://127.0.0.1:3100/api/health
```

헬스체크가 DB 까지 찌르므로(`SELECT 1`) 여기서 200 이면 DB 연결까지 된 것이다.

## 7. 적재 확인

```bash
$C exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "
SELECT 'process'  AS kind, count(*) FROM mdm.process WHERE process_code IN ('INJ','ASM')
UNION ALL SELECT 'equipment', count(*) FROM mdm.equipment WHERE equipment_code IN ('INJ-01','ASM-01')
UNION ALL SELECT 'routing-dep', count(*) FROM planning.routing_operation_dependency
UNION ALL SELECT 'shift', count(*) FROM mdm.shift WHERE is_active
UNION ALL SELECT 'terminal', count(*) FROM mdm.terminal WHERE terminal_code LIKE 'SEED-%'
UNION ALL SELECT 'terminal-process', count(*) FROM mdm.terminal_process
UNION ALL SELECT 'seed-lot', count(*) FROM trace.lot WHERE lot_no LIKE 'SEED-S230-%'
UNION ALL SELECT 'production-order', count(*) FROM planning.production_order WHERE production_order_no LIKE 'PO-ERP-%'
UNION ALL SELECT 's240-lot (선택)', count(*) FROM trace.lot WHERE lot_no LIKE 'SEED-S240-%'
UNION ALL SELECT 'plan+wo (0 이어야)', (SELECT count(*) FROM planning.production_plan) + (SELECT count(*) FROM production.work_order);"
```

| kind | 기대값 |
|---|---:|
| process | 2 |
| equipment | 2 |
| routing-dep | 1 |
| shift | 2 |
| terminal | 3 |
| terminal-process | 2 |
| seed-lot | 8 (완성형 3 + 연습형 5) |
| production-order | 5 |
| s240-lot | 10 (`mes-scenario-data.sql` 을 넣었을 때 · 안 넣었으면 0) |
| plan+wo | 0 |

## 8. 단말 재등록

DB 를 비웠으므로 이전 단말 등록은 모두 무효다. 기기 쪽에 남은 토큰도 지워야 새로 등록할 수 있다.

| 기기 | 기기 쪽 정리 | 등록 |
|---|---|---|
| 모바일 앱 | 앱 데이터 삭제 또는 재설치 | 관리자 웹 W-CO-06 에서 `SEED-MOB-01` 토큰 발급 → 앱에 입력 |
| POP (사출) | POP userData 삭제 | W-CO-06 에서 `SEED-POP-INJ-01` 토큰 발급 → POP 에 입력 |
| POP (조립) | 같은 PC 면 사출을 마친 뒤 POP 머리줄 [단말 재등록] | W-CO-06 에서 `SEED-POP-ASM-01` 토큰 발급 → 입력 |

관리자 웹 로그인은 `admin` / `.env.prod` 의 `ADMIN_INITIAL_PASSWORD` 다.

## 9. 시나리오 시작

1. **PLAN-WO-01** — 생산오더 `PO-ERP-PLANWO-01`(F534F50200 100 EA) 로 계획을 만들고 확정한다. W/O 가 사출·조립
   2건 생기고 선후행 1건이 함께 생긴다. 배포하면 자재 출고요청과 피킹 지시가 만들어진다.
2. **PICK-ISSUE-01** — 모바일 M-01-08 에서 피킹·출고 확정, M-01-09 에서 생산창고 입고. W-01-13 · W-01-07 · W-02-10 에서 확인한다.
3. **WIP-CHAIN-01** — POP(사출) 에서 작업 시작 → 자재 투입 → 실적·생산 LOT 라벨·작업 완료. 모바일 M-02-01 에서 사출 LOT 을
   조립 W/O 로 인계. POP(조립) 에서 같은 흐름. W-02-08 에서 확인한다.

### (선택) 제품 출하 피킹

`mes-scenario-data.sql` 을 넣었을 때. 위 생산 흐름과 같은 DB·같은 단말로 돌린다. ERP 출하지시서(sales order)는 연계가
채우는 것이라 여기서는 만들지 않고, W-04-01 의 **단독 생성**으로 출하작업지시를 편성한다.

순서에 주의한다 — **출하 처리(W-04-04)가 포장(P-04-01)보다 먼저다.** 출하 LOT 배분(`shipment_lot_allocation`)은
출하 처리가 만들고, POP 포장 화면은 그 배분을 취급 단위에 잇는다(`src/logistics/shipment-allocation/shipment-allocation.controller.ts`).
POP 는 「피킹 완료된 당일 출하」만 목록에 띄운다.

1. **W-04-01 출하작업지시 편성** — 출하지시서를 고르지 않고 단독 생성. 고객·납품처(기초데이터 거래처, 예: `100003`),
   출하 희망일, **이행 공장 PL13**(비우면 모바일·POP 목록에 나오지 않는다), 라인에 S240 재고 품목
   (예: `F534F50200` 480 EA 중 100). 최소 잔존기한은 비운다 — 시드 LOT 에 유통기한이 없어 값을 넣으면 피킹이 거절된다.
   납품 라벨까지 뽑으려면 라인의 **출하 검사를 「불요」** 로 둔다 — 검사 필요로 두면 OQC 합격 전에는 납품 라벨 발행이
   422 로 거절된다(`src/app/document-issue/create-rules.ts`).
2. **모바일 M-04-01 제품 피킹** — 지시 라인에 S240 의 제품 LOT(`SEED-S240-…`)을 집어 피킹 확정. 원장 전표는 생기지 않고
   잔량의 `picked_qty` 만 오른다.
3. **W-04-04 출하 처리** — 창고 S240, 라인별 LOT 배분 = 출하 수량. 되돌릴 수 없다(재고 즉시 차감, 출하 전표·출고 전표 생성).
4. **POP P-04-01 포장 실적 + 출고 QR 부착** — 단말 공정에 `can_input_result` 가 켜져 있어야 열린다(시드 POP 단말은 켜져 있다).
   당일 출하를 고르고 → 포장 유형·창고 → 생산 LOT 스캔(직접 입력 가능)으로 내용물 구성 → 포장 확정. 확정되면 화면이
   **자동으로** 라벨을 발행·인쇄한다: 포장 라벨(`PACKING_LABEL`, 대상 취급 단위 1건)과 납품 라벨(`DELIVERY_LABEL`,
   대상 OQC 합격·검사 불요 배분). 발행 → 렌디션(PNG) → 단말 인쇄 → 인쇄 결과 보고(`:report-print`) 순서이고, 인쇄 성공
   보고까지 돼야 라벨이 「붙은 것」으로 친다. 프린터가 없으면 인쇄 실패로 보고되고 발행 기록만 남는다 — 실습에는 가상
   프린터 큐(CUPS 등)를 단말에 잡아 둔다.
5. **W-04-12 출하 확정** — 확정은 되돌릴 수 없다. 확정 시 ERP 아웃박스(`IF-SHIPMENT-PGI-SEND`)에 적재된다.
   확정에 라벨 발행은 전제가 아니다.

알려진 한계(2026-09-16 코드 기준):

- **포장 라벨(`PACKING_LABEL`)은 렌디션이 서버에 없다**(`src/app/document-issue/rendition.service.ts` → 422). 발행 기록은
  남지만 그릴 수 없어 POP 인쇄가 서지 않는다. 배포 모드 POP 도 이 유형을 렌디션 대상에서 빼 두었다. 포장 라벨을 실제로
  붙이는 실습은 이 구현이 들어온 뒤에 한다.
- 납품 라벨(`DELIVERY_LABEL`)은 PNG 만 지원한다(`tspl` 422). 명령형(RAW) 프린터가 아닌 큐에서 실습한다.
- 취급 단위 취소 경로가 없다. 잘못 포장하면 새 취급 단위로 다시 확정한다.

시나리오별 데이터의 뜻과 알려진 한계는 `README.md` 의 해당 절에 있다.

## 처음부터 다시 하려면

3번(DB 비우기)부터 다시 한다. 배포와 백업은 이미 되어 있으므로 1·2번은 건너뛰어도 된다. 단말은 다시 등록해야 한다.
