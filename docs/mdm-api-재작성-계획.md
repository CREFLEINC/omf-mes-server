# 기준정보 API 재작성 계획

> 근거: [ADR 0001](./adr/0001-mdm-api-rewrite-on-spec.md) · 용어: [CONTEXT.md](../CONTEXT.md)
> 계약: `omf-mes/deliverables/openapi/mdm-기준정보.json` (0.1.0 초안)

## 범위

`mdm` 태그 **23개 경로 / 46개 오퍼레이션**. `/app`(16) · `/quality`(25) ·
`/planning`(17) · `/integration`(4) · `/audit`(1)는 다음 라운드.

| 묶음 | 대상 | 오퍼 |
|---|---|---|
| 전체 CRUD | 창고, 로케이션, 코드그룹, 코드값, 부서 | 25 |
| ERP 수신본 — 부분 편집 | 품목(본체 + 환산·외부코드·BU매핑), 작업자(자격) | 13 |
| 조회 전용 | 단위, 거래처, 법인, 사업부, 공장, 라인, 공정, 설비 | 8 |

## 확정된 것

1. `src/` 전체 삭제 후 스펙 기준 재작성. `prisma/` 는 정본이므로 유지.
2. 스펙 형태(경로·메서드·봉투·헤더)는 동결. 미결 내용은 구현하며 정하고 계약
   소유자에게 되돌린다.
3. `/mdm` 응답의 int64 는 JSON 숫자.
4. 스펙 사본을 `contracts/` 에 두고 타입을 생성해, 어긋남을 컴파일러가 잡게 한다.
   사본 갱신은 사람이 하고 그 diff 가 계약 변경 알림이다.
5. PR 단위는 "한 번에 읽고 이해되는가" 기준. 계약이 태어나는 구간은 잘게,
   패턴 복제 구간은 마스터 단위로.

## 스펙과 현행의 차이 (재작성 이유)

| 축 | 스펙 | 삭제 대상 코드 |
|---|---|---|
| 식별자 | `{warehouseId}` int64 | `:warehouseCode` 문자열 |
| 수정 | `PUT` 전체 교체 | `PATCH` 부분 |
| 중지 | `POST /{id}:deactivate` → 200 + 본문 | `DELETE /{code}` → 204 |
| 목록 | `{items, page:{page,size,total}}` | `{items,total,page,size,totalPages}` |
| 상세 | `{warehouse, editability}` + 참조 건수 | Prisma 행 그대로 (snake_case) |
| 낙관적 잠금 | `If-Match` 필수 / `ETag` 응답, `version_no` 본문 비노출 | 없음 |
| 멱등 | `Idempotency-Key` 전 쓰기 필수 | `pop` 일부만 |
| 오류 | `{errors:[{scope,code,field,uniqueScope,message}]}` | Nest 기본 |

## 순서

### PR0 — 삭제 전 건져내기

스펙에 없고 코드에만 있는 도메인 규칙과, 그것을 못 박은 테스트 이름을 문서로
옮긴다. 이걸 먼저 하지 않으면 삭제와 함께 사라진다.

- 외부창고면 거래처 필수 (`ck_external_warehouse_partner`)
- 로케이션 상위 순환 방지
- 수용량과 수용단위는 쌍
- 사용 중지 시 하위 활성 로케이션 검사
- 공통코드 유효성 검사 대상 필드 목록
- 창고·라인·설비는 `(plant_id, code)` 로만 유일 — 전역 유일이 아님

### PR1~7 — 창고 (계약이 태어나는 구간, 정독 대상)

| # | 내용 |
|---|---|
| 1 | 멱등 저장소 마이그레이션 |
| 2 | `GET /mdm/warehouses` — `PageMeta` 봉투, 응답 매퍼, 검색·페이지 파라미터 |
| 3 | `GET /mdm/warehouses/{id}` — `ETag`, 편집 가능성, 참조 건수 |
| 4 | `POST /mdm/warehouses` — 오류 봉투 `{errors:[…]}` |
| 5 | 멱등 인터셉터 |
| 6 | `PUT /mdm/warehouses/{id}` — `If-Match`, 충돌 원인 |
| 7 | `POST /mdm/warehouses/{id}:deactivate` |

### PR8~ — 나머지 (패턴 복제 구간)

로케이션 → 코드그룹·코드값 → 부서 → 조회 전용 8종 → 품목 → 작업자.

`auth` 는 mdm 의 403·권한 검사가 전제하므로 PR1 앞에 필요하다. 스펙이 없어
삭제 전 코드를 근거로 다시 짓는다.

## 미결 — 해당 PR 에서 정한다

| 항목 | 정할 곳 | 메모 |
|---|---|---|
| 참조 건수를 세는 방법 | PR3 | 창고 13 · 로케이션 19 · 부서 7개 테이블. 품목·작업자는 ERP 수신본이라 셀 필요 없고, 코드값은 FK 참조가 0개라 셀 수 없음 |
| ERP 수신본 판정 근거 | PR3 | 스키마에 `source_system` 류 컬럼이 없다. 테이블 단위로 코드에 박아야 함 |
| 멱등 키 보관 기간·재사용 정책 | PR1·PR5 | |
| 충돌 원인 `erpSync`·`workerLease` 를 무엇으로 판정하나 | PR6 | 스키마에 리스 개념이 없음 |
| 편집 권한 매트릭스 (스펙 §8-8 미결) | PR4 | 계약 소유자에게 되돌릴 항목 |
