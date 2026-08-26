# OMF-MES 데이터 모델 v4 검증 보고서

검증일: 2026-08-25 (Asia/Seoul)

| 검증 항목 | 방법 | 결과 |
|---|---|---|
| 설계 원본 격리 | `.git/info/exclude`와 `git check-ignore` | PASS — `.design-reference/` 커밋 제외 |
| 순방향 마이그레이션 | PostgreSQL 16.15 빈 DB에 기준선부터 12개 SQL 순차 적용 | PASS |
| 전체 설치 DDL | 별도 빈 DB에 `02-omf-mes-postgresql-v4.sql` 적용 | PASS — 174 tables |
| 최종 카탈로그 | `pg_catalog`에서 테이블·컬럼·FK 추출 | PASS — 174 tables, 2,254 columns, 533 FKs |
| Prisma 정합성 | 최종 DB introspection, `prisma validate`, `prisma generate` | PASS — 172 models |
| OpenAPI 매핑 | 7개 OpenAPI JSON, 전체 path operation 검증 | PASS — 437/437 mapped |
| 생성물 재현성 | `generate_artifacts.py --check` | PASS |
| YAML 구조 | YAML 파서 로드 및 작업 수 확인 | PASS — 437 operations |
| HTML 구조 | HTML parser, 필수 DOM ID, 단일 인라인 script | PASS |
| HTML JavaScript | 인라인 script 추출 후 `node --check` | PASS |
| HTML 시각·상호작용 | Chrome에서 관계도 선택, API 선택, 패널 연동, 1024px 반응형 확인 | PASS — console errors 0 |
| XLSX 생성 | 공식 XLSX 작업 런타임의 `openpyxl` 절차, 8개 시트 | PASS — 전체 상세 행 포함 |
| XLSX 수식 | 공식 `recalc.py` + 격리 LibreOffice 24.2 | PASS — 21 formulas, 0 errors |
| XLSX 교차 검증 | LibreOffice 계산 캐시와 Expected/Actual 비교 | PASS — 7/7 gates |
| XLSX 시각 검수 | LibreOffice A3 PDF 8페이지 렌더링 후 전 페이지 확인 | PASS — 잘림·깨짐 없음 |
| 서버 단위 테스트 | Jest `--runInBand` | PASS — 19 suites, 140 tests |
| 서버 빌드 | 계약 타입 생성 후 Nest TSC + SWC | PASS — 0 issues, 91 files |

## 검증 경계

- Chrome 시각 검수는 기본 데스크톱 뷰와 1024px 반응형 뷰를 대상으로 했다. 관계도는 `production.work_order`, API 매핑은 `GET /app/approval-requests`와 승인 처리 API를 대표 시나리오로 확인했다.
- 레이아웃은 1280px 이상에서 관계도+상세 패널, API 목록+계약 상세+관계 테이블의 그리드로 구성하고, 1100px 이하에서는 관계 테이블 보조 패널을 숨기는 2열 반응형 규칙과 `prefers-reduced-motion`을 적용했다.
- 호스트 LibreOffice 앱은 macOS 격리 상태와 코드 서명 검증 문제로 실행하지 않았다. 호스트 보안 설정을 변경하지 않고 Ubuntu 컨테이너의 LibreOffice 24.2에서 동일한 공식 `recalc.py`와 렌더링 절차를 실행했다.
- Prisma는 PostgreSQL의 CHECK 제약, 표현식 인덱스, 파티션을 완전히 표현하지 못하므로 해당 정본은 SQL과 PostgreSQL 카탈로그다. Prisma 스키마에는 조회·쓰기 타입에 필요한 172개 논리 모델을 병합했다.
- 미결 업무코드 50종의 값은 구조 검증 범위 밖이다. DB enum으로 고정하지 않고 `mdm.code_group`/`mdm.code_value`에서 배포 전 결정하도록 유지했다.
