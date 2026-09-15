# MES 고객 기초데이터

배포와 마이그레이션이 끝난 빈 MES DB에 표준 애플리케이션 시드와 고객 기준정보를 한 번에 넣는다.
운영 서버에는 SQLite나 `sqlite3`가 필요하지 않다. `mes-initial-data.sql` 안에 원본 스냅샷이
포함된다.

## 실행

배포 디렉터리에서 다음 순서로 실행한다.

```bash
seed/load-mes-initial-data.sh --dry-run
seed/load-mes-initial-data.sh
```

`--dry-run`은 SQL 전체와 검증을 실행한 뒤 트랜잭션을 롤백한다. 실제 실행은 먼저 애플리케이션
표준 시드(`node dist/seed.js`)를 실행하고 고객 SQL을 커밋한다. 두 작업 모두 재실행 가능하다.

## 적재 범위

| 대상 | 건수 |
|---|---:|
| 법인 / 사업부 / 공장 | 1 / 1 / 2 |
| ERP 공통코드 그룹 / 값 | 8 / 244 |
| 부서 / 작업자 | 15 / 786 |
| ERP 거래처 / 역할 | 931 / 1,013 |
| 품목 | 9,269 |
| 창고 | 33 |
| BOM / 구성품 | 4,198 / 22,793 |

`item_group_nm = Mold`인 품목도 일반 품목으로 들어가지만 `mdm.mold`는 만들지 않는다.

## 고객 검토가 필요한 임시값

- 조직: `SAMJIN_LND_VINA`, `VIETNAM`, `PL11 Parts Plant`, `PL13 OA Plant`
- 국가/타임존: `VN`, `Asia/Ho_Chi_Minh`
- 원본 소요량이 `0 EA`인 BOM 구성 720행: `1 EA`로 적재
- 구성 순번 0이 있는 BOM 30개: 순서를 유지하도록 해당 BOM 구성 194행의 순번을 모두 +1
- 거래처를 신뢰성 있게 찾지 못한 사외창고 5개: `EXTWH_<창고코드>` 임시 거래처 생성

실제 실행 후 `erp_seed.seed_adjustment`에 원본값, 적재값, 사유가 남는다. 고객 확인이 끝나면
다음 명령으로 원본 스테이징만 제거할 수 있다.

```sql
DROP SCHEMA erp_seed CASCADE;
```

## 시나리오·교육용 데이터

`mes-scenario-data.sql`은 기초데이터 위에 시나리오 테스트와 현장 교육에 필요한 재고·P/O를 얹는다.
손으로 관리하는 정적 SQL이라 생성기 대상이 아니고, 설치 패키지에도 들어가지 않는다.
**운영(하노이) DB에는 넣지 않는다.**

| 대상 | 내용 |
|---|---|
| 위치 | `S240-01` 자재창고 기본 위치 — S240에 활성 위치가 없을 때만 만든다 |
| 제품 재고 | 제품 10종 × LOT 1개(`SEED-S240-0001`~`0010`), 수량 120~910, 창고 S240 |
| 입고 전표 | `GR-SEED-0001` 제품입고(POSTED) 1건 — 위 재고의 원장·잔량이 이 전표에서 나온다 |
| 자재 P/O | `PO-SEED-0001`~`0005`, PL13, 건마다 원자재 1종(수량 150~480), 상태 REGISTERED |

발주일과 영업일(`business_date`)은 적재 당일의 PL13 현지 날짜다. 입고예정일은 발주일 + 7일이다.
P/O 자재는 위 제품들의 BOM 구성품이라, 입하 → 생산 흐름을 한 묶음으로 교육할 수 있다.

### 실행

기초데이터 적재가 끝난 서버에서, 파일을 배포 디렉터리의 `seed/`로 복사한 뒤 기존 로더를 재사용한다.

```bash
SQL_FILE=seed/mes-scenario-data.sql seed/load-mes-initial-data.sh --dry-run
SQL_FILE=seed/mes-scenario-data.sql seed/load-mes-initial-data.sh
```

- 기초데이터가 없으면 사전조건 검사에서 멈추고 롤백한다.
- 다시 실행해도 안전하다. `GR-SEED-0001`이 있으면 기초재고를 건너뛰고, 이미 있는 P/O 번호도 건너뛴다.
- 번호에 `SEED` 접두어를 써서 서버 채번과 겹치지 않으므로 채번 카운터는 건드리지 않는다.

### 알려진 한계

- 위치는 S240에만 만든다. 다른 창고는 여전히 위치가 0건이라 입고·이동 도착지로 쓸 수 없다.
- LOT 유통기한이 비어 있다. 최소 잔존기한이 걸린 출하요청에서는 피킹이 거절된다(400).
- LOT 원천 유형 `GOODS_RECEIPT`는 코드그룹 `LOT_SOURCE_TYPE`에 없는 값이다. 기초재고용 값이 없어서
  원천 식별자가 가리키는 입고 전표의 이름을 썼다.
- P/O에는 ERP 번호가 없다. 단말은 자기 공장의 P/O만 보므로 PL13 단말로 입하해야 한다.

## 시나리오 PLAN-WO-01 (계획 → W/O → 배포 → 피킹)

`mes-scenario-plan-wo-01.sql`은 ERP 생산오더를 받아 생산계획 → 작업지시 → 배포 → 피킹까지 도는
시나리오의 기준정보와 시작 데이터를 얹는다. 기초데이터 위에 바로 얹히고 `mes-scenario-data.sql`과는
독립이라 순서를 가리지 않는다(둘 다 넣어도 된다). **운영(하노이) DB에는 넣지 않는다.**

검증 대상인 업무 결과(생산계획·작업지시·자재 출고요청·피킹 지시·실적)는 만들지 않는다. 화면에서
만드는 것이 시나리오다.

### A. 완성형 — 받자마자 전개부터 피킹까지 돈다 (품목 `F534F50200`)

| 대상 | 내용 |
|---|---|
| 공정 | `INJ` 사출(MACHINING) · `ASM` 조립(ASSEMBLY) |
| 생산라인 | PL13 `LINE-A` |
| 설비 | `INJ-01`(INJECTION_MOLDING·INJ) · `ASM-01`(PRESS·ASM), 둘 다 IN_SERVICE·LINE-A |
| 창고 관리수준 | S220·S210·S551을 ZONE으로 올린다(이미 ZONE 이상이면 그대로 둔다) |
| 위치 | `S220-WIP` 재공 · `S210-FG` 제품 · `S551-SCRAP` 불량 · `S230-01` 자재 — 모두 DEFAULT |
| 라우팅 | `RT-F534F50200-01` Rev1 CONFIRMED·기본(2026-09-01부) + 공정 2건 — op1 사출 C/T 30초, op2 조립 C/T 45초(산출 LOT 필수) |
| BOM 공정 매핑 | `A5C1M50101`→op1(실사용 INJ) · `F534202801`·`F534202802`→op2(실사용 ASM) |
| 시작 재고 | 구성품 3종 × 500 EA, `SEED-S230-A01`~`A03`, 위치 `S230-01`, 입고 전표 `GR-SEED-0003` |
| ERP 생산오더 | `PO-ERP-PLANWO-01`~`03` — F534F50200 100 EA, RECEIVED, 납기 이달 말 |

배포가 자재 출고요청을 만들려면 BOM 구성품이 그 공정에 묶여 있어야 한다 — 위 매핑이 그 자리다.

### B. 연습형 — 마스터를 화면에서 직접 만든다

| 대상 | 내용 |
|---|---|
| ERP 생산오더 | `PO-ERP-PRACTICE-01`(F536A42301AP) · `-02`(11107-001WH0), 각 100 EA, RECEIVED |
| 시작 재고 | 두 품목의 BOM 구성품 5종 × 500 EA, `SEED-S230-B01`~`B05`, 입고 전표 `GR-SEED-0004` |

공정·라우팅·설비·위치·BOM 매핑은 넣지 않는다. 그것을 만드는 것이 연습 과제다.

### C. 4M 보조 (선택)

교대 `DAY`·`NIGHT`, 금형 `MOLD-01`(IN_SERVICE·MOLD), 작업자 `901463`의 사출·조립 공정 자격.
`-v with_4m_extras=false`로 끄면 A·B만 넣는다.

### 실행

기초데이터 적재가 끝난 서버에서, 파일을 배포 디렉터리의 `seed/`로 복사한 뒤 기존 로더를 재사용한다.

```bash
SQL_FILE=seed/mes-scenario-plan-wo-01.sql seed/load-mes-initial-data.sh --dry-run
SQL_FILE=seed/mes-scenario-plan-wo-01.sql seed/load-mes-initial-data.sh
```

- 기초데이터가 없거나 품목·BOM·코드값이 어긋나면 사전 검사에서 멈추고 롤백한다.
- 다시 실행해도 안전하다. 입고 전표 번호가 있으면 시작 재고를 건너뛰고, 코드가 겹치는 기준정보·생산오더도
  건너뛴다. 창고 관리수준과 BOM 공정 매핑은 같은 값을 다시 쓴다.
- 번호에 `SEED`·`PO-ERP` 접두어를 써서 서버 채번과 겹치지 않으므로 채번 카운터는 건드리지 않는다.
- id를 하드코딩하지 않는다 — 공장·창고·품목·공정을 전부 코드로 찾으므로 DB를 새로 만들어도 그대로 돈다.

### 알려진 한계

- 조립 공정에 맞는 설비 유형이 코드 사전에 없다(`EQUIPMENT_TYPE` = INJECTION_MOLDING·PRESS·WATER_HEATER).
  `ASM-01`은 PRESS로 넣는다. 고객이 유형을 늘리면 그 값으로 바꾼다.
- LOT 유통기한이 비어 있다. 최소 잔존기한이 걸린 흐름에서는 피킹이 거절된다(400).
- LOT 원천 유형 `GOODS_RECEIPT`는 코드그룹 `LOT_SOURCE_TYPE`에 없는 값이다 — `mes-scenario-data.sql`과
  같은 규약으로 원천 식별자가 가리키는 입고 전표의 이름을 썼다.
- 연습형(B)은 마스터가 없어 그대로는 전개되지 않는다. 그것이 연습 과제다.
- 재고 예약이 없어(P-12) 같은 LOT이 여러 피킹 지시에 중복 배정될 수 있다. 완성형 생산오더 3건을
  한꺼번에 전개하면 나타난다 — 시작 재고 500 EA는 100 EA짜리 3건을 덮는 양이다.

## SQL 재생성

개발 PC에서 원본 SQLite가 바뀌었을 때만 실행한다.

```bash
python3 scripts/seed/generate_mes_initial_data.py \
  /path/to/gateway.sqlite3 \
  deploy/seed/mes-initial-data.sql
```
