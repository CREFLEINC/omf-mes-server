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

## SQL 재생성

개발 PC에서 원본 SQLite가 바뀌었을 때만 실행한다.

```bash
python3 scripts/seed/generate_mes_initial_data.py \
  /path/to/gateway.sqlite3 \
  deploy/seed/mes-initial-data.sql
```
