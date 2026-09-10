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

## SQL 재생성

개발 PC에서 원본 SQLite가 바뀌었을 때만 실행한다.

```bash
python3 scripts/seed/generate_mes_initial_data.py \
  /path/to/gateway.sqlite3 \
  deploy/seed/mes-initial-data.sql
```
