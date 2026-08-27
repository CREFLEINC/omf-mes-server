# OMF-MES 데이터 모델 v4

이 디렉터리는 설계 저장소 `CREFLEINC/omf-mes`의 2026-08-25 기준 계약과 현재 백엔드 모델을 결합한 데이터 모델 산출물이다.

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
| `04-verification-report.md` | DB·Prisma·API·XLSX·서버 검증 결과 |

기존 DB에는 전체 DDL이 아니라 `prisma/migrations/20260826000000_data_model_v4/migration.sql`을 적용한다.

## 재생성·검증

최종 마이그레이션을 적용한 PostgreSQL에서 카탈로그를 내보낸 뒤 다음 명령으로 파생 산출물을 생성한다.

```bash
python3 scripts/data_model/generate_artifacts.py
python3 scripts/data_model/generate_artifacts.py --check
```

XLSX는 공식 XLSX 작업 런타임의 `openpyxl` 절차로 생성한다. 수식이 포함되므로 생성 후 같은 런타임이 제공하는 `recalc.py`를 LibreOffice와 함께 실행해야 한다.

```bash
python3 scripts/data_model/build_logical_spec_workbook.py
python /path/to/xlsx-skill/scripts/recalc.py \
  outputs/01a0376d-9b7c-7ce0-be72-2df4ecd65d94/omf-mes-logical-table-spec-v4.xlsx 120
```

`--check`는 테이블·FK·API 매핑 참조 무결성과 생성 파일의 최신 상태를 함께 검사한다. OpenAPI 원본은 로컬 전용 `.design-reference/omf-mes`에서 읽으며, 이 디렉터리는 `.git/info/exclude`로 커밋 대상에서 제외한다.
