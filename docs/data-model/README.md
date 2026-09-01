# OMF-MES 데이터 모델 v4

이 디렉터리는 설계 저장소 `CREFLEINC/omf-mes`의 계약과 현재 백엔드 모델을 결합한 데이터 모델 산출물이다.

기준이 둘이라는 점에 주의한다. **물리 모델**은 `a8f46f2`(2026-08-25) 계약을 보고 만들어졌고,
**API 매핑 수치**는 `contracts/` 사본(`contracts/COMMIT.txt` 가 기준 커밋)을 대조한다.
둘이 벌어진 지점은 `05-재검토-2026-08-28.md`가 정리한다.

| 파일 | 용도 |
|---|---|
| `00-design-basis-and-decisions.md` | 기준선, 모델링 원칙, 계약 차이 해소표 |
| `01-logical-table-spec.md` | 전체 논리 테이블 및 컬럼 명세 |
| `../../outputs/01a0376d-9b7c-7ce0-be72-2df4ecd65d94/omf-mes-logical-table-spec-v4.xlsx` | 필터·수식 검증을 포함한 XLSX 전달본 |
| `02-omf-mes-postgresql-v4.sql` | 빈 PostgreSQL 16 DB용 전체 설치 DDL |
| `api-table-map.yaml` | OpenAPI 작업별 테이블·접근 유형 매핑 |
| `api-table-map.json` | XLSX·HTML 생성용 API 매핑 JSON |
| `03-data-model-api-map.html` | 전체 관계도와 API-테이블 관계 대화형 검증 문서 |
| `model-catalog.json` | PostgreSQL 카탈로그의 기계 판독 스냅샷 |
| `workbook-data.json` | XLSX 빌더 입력 데이터 |
| `validation-report.json` | 모델·OpenAPI 교차 검증 결과 |
| `04-verification-report.md` | 검증 항목을 **재현 가능 여부(A/B/C)**로 갈라 적은 표 |
| `05-재검토-2026-08-28.md` | 이슈 11건·서버 API 재검토 결과와 조치 목록 |
| `review-findings.json` | 재검토 발견 124건의 기계 판독본 (HTML 「재검토 결과」 탭 입력) |

기존 DB에는 전체 DDL이 아니라 `prisma/migrations/20260826000000_data_model_v4/migration.sql`을 적용한다.

## 재생성·검증

파생 산출물은 모두 `model-catalog.json` 에서 나온다. 그것부터 살아 있는 DB 에서 내보낸다.

```bash
# 마이그레이션을 모두 적용한 DB 에서 카탈로그를 내보낸다.
# _prisma_migrations 는 먼저 지운다 — export_catalog.sql 이 시스템 스키마만 빼고 전부
# 담으므로, 남겨 두면 업무 표 하나로 섞여 표·컬럼·FK 수가 통째로 어긋난다.
psql -d omf_mes -c 'DROP TABLE IF EXISTS public._prisma_migrations'
psql -d omf_mes -tA -X -f scripts/data_model/export_catalog.sql \
  > docs/data-model/model-catalog.json

python3 scripts/data_model/generate_artifacts.py
python3 scripts/data_model/generate_artifacts.py --check

# HTML 보고서의 상호작용을 실제 Chrome 으로 검사한다(노드 선택·패닝·탭·반응형).
# 눈으로 보고 「PASS」라고 적었다가 선택이 망가진 채 배포된 적이 있어 스크립트로 두었다.
node scripts/data_model/verify_html_report.mjs
```

전체 DDL(`02-omf-mes-postgresql-v4.sql`)은 카탈로그와 별개로 `pg_dump` 로 뜬다.
명령은 그 파일 머리말에 적혀 있다.

XLSX 를 다시 만들었으면 **수식 재계산을 반드시 함께 돌린다** — openpyxl 은 수식만 쓰고
값을 남기지 않아, 빠뜨리면 계산 캐시가 빈 채로 전달된다. 자세한 항목별 재현 조건은
`04-verification-report.md` 를 본다.

```bash
python3 scripts/data_model/build_logical_spec_workbook.py

# LibreOffice 는 OOXML 을 열 때 재계산하므로 변환만으로 캐시가 채워진다.
# 왕복해도 시트·표·조건부서식·주석·틀고정은 보존된다.
soffice --headless --norestore --convert-to xlsx --outdir /tmp/omf-xlsx \
  outputs/01a0376d-9b7c-7ce0-be72-2df4ecd65d94/omf-mes-logical-table-spec-v4.xlsx
cp /tmp/omf-xlsx/omf-mes-logical-table-spec-v4.xlsx \
  outputs/01a0376d-9b7c-7ce0-be72-2df4ecd65d94/omf-mes-logical-table-spec-v4.xlsx
```

재계산됐는지는 Validation 시트로 확인한다. 게이트 7개가 모두 PASS 로 보여야 하며,
Actual 칸이 비어 있으면 재계산이 안 된 것이다.

`--check`는 테이블·FK·API 매핑 참조 무결성과 생성 파일의 최신 상태를 함께 검사한다.

### 계약 원본

OpenAPI 원본은 `contracts/` 에서 읽는다. 저장소에 커밋돼 있으므로 클론 직후 바로 돈다.
받아오기·대조는 `contracts/README.md` 를 본다.

```bash
pnpm contracts:check     # 설계 저장소와 어긋나지 않았는지
pnpm contracts:update    # 어긋났으면 받아온다
```

`contracts/COMMIT.txt` 가 산출물의 `contract_reference_commit` 이 된다.

### 계약이 앞서 나갈 때

계약에만 있고 물리 모델에 없는 테이블은 `api_mapping.py`의 `PENDING_TABLES`에 등록한다.
등록하지 않으면 생성기가 매핑 규칙 부재로 죽고, 아무 표에나 붙이면 결손이 사라진다.
등록된 결손은 `validation-report.json`의 `contract_model_gaps`와 HTML 「재검토 결과」 탭에 나온다.
결손이 있으면 상태가 `PASS`가 아니라 `PASS_WITH_GAPS`다.
