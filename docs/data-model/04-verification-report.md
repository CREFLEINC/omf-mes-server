# OMF-MES 데이터 모델 v4 검증 보고서

> 최초 작성: 2026-08-25 · **재현 가능 여부로 재정리: 2026-08-28**
>
> 이전 판은 17개 항목을 전부 「PASS」로만 적었다. 그중 일부는 검증이 아니라
> **그 시점의 관찰**이었고, 하나는 실제로 동작하지 않는 것을 통과로 적은 것이었다
> (관계도 선택 — 콘솔 오류가 없다는 것만 보고 PASS 로 판정했다).
> 그래서 이 판은 **지금 돌려서 확인할 수 있는가**로 항목을 갈라 적는다.
> 경위: [`05-재검토-2026-08-28.md`](./05-재검토-2026-08-28.md)

## 읽는 법

| 구분 | 뜻 |
|---|---|
| **A. 재현 가능** | 이 저장소만으로 지금 돌릴 수 있다. 명령과 실측 결과를 함께 적는다 |
| **B. 자료를 갖추면 재현 가능** | 명령은 있으나 DB·외부 도구가 있어야 한다. 무엇이 필요한지 적는다 |
| **C. 시점 관찰** | 다시 돌릴 수 없다. 「그때 그랬다」는 기록으로만 읽는다 |

수치를 인용하기 전에 그 항목이 A 인지 확인한다. B·C 의 숫자는 근거가 아니라 이력이다.

---

## A. 재현 가능 — 2026-08-28 실행 결과

아래는 전부 실제로 돌려서 얻은 값이다.

| # | 항목 | 명령 | 결과 |
|---:|---|---|---|
| A1 | 설계 원본 격리 | `git check-ignore -v .design-reference/omf-mes/COMMIT.txt` | PASS — `.gitignore:28` 이 잡는다. `git status` 에 0건 |
| A2 | 카탈로그 ↔ DDL 정합 | `02-*.sql` 과 `model-catalog.json` 대조 (A2 주석 참조) | PASS — 테이블 174/174 차집합 0 · 컬럼 2,254 일치 · **컬럼 집합 불일치 0표** |
| A3 | Prisma 스키마 유효성 | `DATABASE_URL='postgresql://u:p@localhost:5432/db' npx prisma validate` | PASS — `The schema at prisma/schema.prisma is valid` |
| A4 | Prisma Client 생성 | `npx prisma generate` | PASS — v6.19.3 생성. 모델 수 `grep -cE '^model ' prisma/schema.prisma` = **172** |
| A5 | OpenAPI 매핑 | `python3 scripts/data_model/generate_artifacts.py` | **PASS_WITH_GAPS** — 444개 중 **439개 매핑(98.9%)**, 결손 2종 |
| A6 | 생성물 재현성 | `python3 scripts/data_model/generate_artifacts.py --check` | PASS — 7개 산출물 바이트 동일 |
| A7 | YAML 구조 | `python3 -c "import yaml; yaml.safe_load(open('docs/data-model/api-table-map.yaml'))"` | PASS — 헤더 444 = 항목 444, `mapped_operation_count`·결손 목록이 JSON 과 일치 |
| A8 | HTML 구조 | 필수 DOM ID·인라인 script 수 검사 (A8 주석 참조) | PASS — 필수 ID 19종 누락 0 · 인라인 script 1 · 외부 `src` 0 |
| A9 | HTML JavaScript | 인라인 script 추출 후 `node --check` | PASS |
| A10 | **HTML 시각·상호작용** | `node scripts/data_model/verify_html_report.mjs` | **PASS — 12/12** |
| A11 | 서버 단위 테스트 | `pnpm test` | PASS — **19 suites · 140 tests** |
| A12 | 서버 빌드 | `pnpm contracts:generate && pnpm build` | PASS — TSC **0 issues** · SWC **91 files** |
| A13 | 타입 체크 | `pnpm typecheck` | PASS — 오류 없음 |
| A14 | XLSX 구조 | `openpyxl` 로 시트·수식 수 확인 | PASS — **8시트 · 수식 21개** |

**A2 명령**

```bash
python3 - <<'PY'
import json, re
cat = json.load(open('docs/data-model/model-catalog.json'))
sql = open('docs/data-model/02-omf-mes-postgresql-v4.sql', encoding='utf-8').read()
ddl = set(re.findall(r'^CREATE TABLE ([a-z_]+\.[a-z_]+) \(', sql, re.M))
print('테이블 차집합:', len(ddl ^ {t['qualified_name'] for t in cat['tables']}))
print('컬럼 합계:', sum(len(t['columns']) for t in cat['tables']))
print('FOREIGN KEY 문장:', len(re.findall(r'FOREIGN KEY', sql)),
      '/ relationships:', len(cat['relationships']))
PY
```

**A8 명령**

```bash
python3 - <<'PY'
import re
s = open('docs/data-model/03-data-model-api-map.html', encoding='utf-8').read()
need = {'graph','graphStage','tableDetail','tableSearch','schemaFilter','apiList','apiDetail',
        'apiTables','apiSearch','methodFilter','domainFilter','metrics','subtitle','reviewTitle',
        'reviewLead','reviewTallies','gapRows','reviewFilters','reviewFindings'}
print('누락 ID:', sorted(need - set(re.findall(r'id="([^"]+)"', s))) or '없음')
print('인라인 script:', len(re.findall(r'<script[^>]*>', s)),
      '| 외부 src:', len(re.findall(r'<script[^>]*src=', s)))
PY
```

### A10 이 무엇을 보는가

이전 판이 「Chrome 에서 관계도 선택 확인 — console errors 0」으로 적은 항목이다.
콘솔 오류가 없다는 것은 사실이었지만 **관계도 선택은 실제로 동작하지 않았다** —
패닝을 위해 `pointerdown` 에서 곧바로 `setPointerCapture()` 를 걸어, 뒤따르는
`click` 의 대상이 노드가 아니라 `<svg>` 로 바뀌고 있었다.

그래서 사람이 보고 적는 대신 돌려서 확인하도록 `verify_html_report.mjs` 를 두었다.
합성 이벤트가 아니라 CDP 의 `Input` 도메인으로 **진짜 포인터 이벤트**를 보낸다 —
`dispatchEvent` 로는 pointer capture 문제가 재현되지 않는다.

검사 12종: 노드 렌더 · 노드 크기 · **클릭 → 상세 패널** · 끌기(이동하되 선택 안 됨) ·
Fit · 휠 확대 · API 탭 · 재검토 탭 · 판정 필터 · 탭 복귀 · 1024px 반응형 · 콘솔 오류.

**이 검사가 옛 결함을 실제로 잡는지 확인했다.** 수정 전 HTML(`git show HEAD:…`)에 돌리면
`8/12 PASS` 로 떨어진다.

```
FAIL  노드가 클릭 가능한 크기 — 19×3px
FAIL  노드 클릭 → 상세 패널 — 강조 엣지 0
PASS  콘솔 오류 없음          ← 옛 판이 근거로 삼은 그 항목
```

Chrome·Chromium 이 없으면 종료 코드 `2`(SKIP)로 빠진다 — 없다고 통과로 적지 않는다.

---

## B. 자료를 갖추면 재현 가능

명령은 정해져 있으나 이 저장소만으로는 못 돌린다. **아래 항목의 결과는 2026-08-25 관찰값이며 이번에 다시 확인하지 못했다.**

| # | 항목 | 필요한 것 | 2026-08-25 관찰값 |
|---:|---|---|---|
| B1 | 순방향 마이그레이션 | PostgreSQL 16 빈 DB | 기준선부터 12개 SQL 순차 적용 성공 |
| B2 | 전체 설치 DDL | PostgreSQL 16 빈 DB | `02-*.sql` 적용 성공 — 174 tables |
| B3 | 최종 카탈로그 추출 | PostgreSQL 16 + `scripts/data_model/export_catalog.sql` | 174 tables · 2,254 columns · 533 FKs |
| B4 | Prisma introspection | 마이그레이션이 적용된 DB (`prisma db pull`) | 172 models |
| B5 | XLSX 수식 재계산 | 공식 `recalc.py` + LibreOffice | 21 formulas · 0 errors |
| B6 | XLSX 시각 검수 | LibreOffice A3 PDF 렌더링 | 8페이지 · 잘림·깨짐 없음 |

B1–B3 은 `docker compose up -d postgres`(`docker-compose.yml` 의 `postgres:16-alpine`)로 띄우면 돌릴 수 있다
(이 검사를 돌린 환경에는 Docker·`psql` 이 없었다). **A2 는 B3 의 대체 검사다** —
DB 에서 다시 뽑는 대신 커밋된 스냅샷을 DDL 과 대조한다. 스냅샷이 DB 와 어긋난 경우는
잡지 못하므로 B3 을 대신하지 않는다.

### ⚠ B5 미이행 — XLSX 수식 캐시가 비어 있다

2026-08-28 에 `workbook-data.json` 이 444 오퍼레이션 기준으로 갱신되면서
XLSX 도 다시 만들었다(`build_logical_spec_workbook.py`). 고정값은 최신이다 —
`Validation` 시트의 Expected 가 **OpenAPI 작업 444 · 매핑 완료 439**,
`Summary` 의 검증 게이트가 **OpenAPI 매핑 GAP 439/444** 로 바뀌었다.

**그러나 수식 21개의 계산 캐시는 비어 있다.** LibreOffice 가 없어 `recalc.py` 를 돌리지
못했다. 사람이 Excel·LibreOffice 로 열면 자동 재계산되어 정상으로 보이지만,
`openpyxl` 의 `data_only=True` 로 읽으면 그 21칸이 `None` 이다.
**전달 전에 B5 를 한 번 돌려야 한다.**

---

## C. 시점 관찰 — 다시 돌릴 수 없거나, 검증이 아니었던 것

| 항목 | 이전 판의 서술 | 실제 |
|---|---|---|
| OpenAPI 매핑 커버리지 | 「437/437 mapped · 100%」 | **항진명제였다.** `coverage` 가 계산값이 아니라 문자열 상수였고, 규칙 없는 경로는 예외로 죽어 100% 외의 값이 나올 수 없었다. 2026-08-28 에 실측 계산으로 바꿔 A5 가 됐다 |
| XLSX 교차 검증 | 「7/7 gates」 | **자기참조 검사다.** Expected 와 Actual 이 같은 `workbook-data.json` 에서 나온다 — 「JSON 을 빠짐없이 옮겼는가」만 본다. 모델이 옳은지는 보지 않는다 |
| HTML 시각·상호작용 | 「PASS — console errors 0」 | **동작하지 않는 것을 통과로 적었다.** A10 참조 |
| FK 533개 | 「533 FKs」 | `pg_catalog` 행 수다. 선언된 `FOREIGN KEY` 문장은 **528개**이고 차이 5건은 파티션 부모·자식에 복제된 제약이다. 둘 다 맞는 수지만 무엇을 센 값인지 적어야 한다 |
| 멱등·낙관적 잠금 | (표에 없음) | `api-table-map.json` 이 437건 **전부 `false`** 로 기록하고 있었다. 실측은 `Idempotency-Key` **222** · `If-Match` **132**. 2026-08-28 에 `$ref` 파라미터를 풀도록 고쳤다 |

---

## 검증 경계

- **정본은 SQL 과 PostgreSQL 카탈로그다.** Prisma 는 CHECK 제약·표현식 인덱스·파티션을
  완전히 표현하지 못한다. Prisma 스키마에는 조회·쓰기 타입에 필요한 172개 논리 모델을 병합했다.
- **미결 업무코드의 값은 구조 검증 범위 밖이다.** DB enum 으로 고정하지 않고
  `mdm.code_group`/`mdm.code_value` 에서 배포 전 결정한다. 값 자체의 어긋남은
  `05-재검토-2026-08-28.md` §4 가 다룬다.
- **A 항목도 문서·소스 수준이다.** 운영 DB 의 실데이터는 보지 않았다 —
  백필이 필요한 변경의 비용은 이 표로 산정할 수 없다.
- **A5 의 수치는 재생성 시점 계약에 딸린다.** `.design-reference/omf-mes/COMMIT.txt` 가
  기준을 적는다. 계약이 바뀌면 숫자도 바뀐다.

## 이번 검사를 돌린 환경

macOS 26.6 · Python 3.12.13 · Node v26.7.0 · pnpm 11.17.0 · Prisma 6.19.3 ·
Chrome 151.0.7922.174 · PyYAML·openpyxl 설치함.
**없었던 것**: Docker · `psql` · LibreOffice · `recalc.py`.
