# 144. `repack-events` 에 페이지·필터·정렬 축이 하나도 없다(한 포장의 이력이 무한히 는다) + `HU-` 채번의 기간 축이 서버 UTC 날짜가 된다

| 칸 | 내용 |
|---|---|
| **구분** | **통보** — 질의 칸·정렬 축이 계약에 서면 호환으로 는다(오늘 저장하는 데이터가 달라지지 않는다) |
| 걸리는 오퍼레이션 | `GET /inventory/handling-units/{handlingUnitId}/repack-events` · `POST /inventory/handling-units` |
| 구현 상태 | **구현 예정(I-16 · 계획만 병합됨 · 오늘 코드 0줄 · 이력 표도 아직 없다 — 문의 140)** |
| 판정 | 조회 쪽 `coverage-100/README.md` §2 **1단계 계약 문자 그대로**(응답 스키마에 `page` 가 없다 → 전건 반환). 채번 기간 축 **0단계 선례**(I-10 `MATERIAL_RETURN` — 「기간 축은 서버 시각 UTC 날짜」) |
| 되돌릴 때 | 질의 칸이 계약에 서면 컨트롤러·뷰 한 자리(호환). `businessDate` 를 요청에 실으면 채번 인자 한 줄 |

## 무엇이 문제인가

ⓐ **이력 조회에 질의 축이 0 이다.** `GET /inventory/handling-units/{handlingUnitId}/repack-events` 의 `parameters` 는 path 의 `handlingUnitId` **하나뿐**이고(`contracts/logistics-01자재창고.json:1526-1536`), 응답도 `{items[]}` 뿐이라 `page` 가 없다(같은 도메인의 목록 조회 `GET /inventory/handling-units` 는 `page`·`size` 를 포함해 질의 7칸을 갖는다 — `:1209-1245`). 기간·유형·역할로 거를 축도, 상한도 없다. ⇒ **한 포장을 여러 번 치환하면 이력이 한 응답에 전건으로 실리고 무한히 는다.** 화면은 이 조회를 「[ 이력 보기 ]」 한 곳에서 부른다(`M-04-03-포장재구성스캔.md:208` 「재구성 이력 조회 | ✅ `GET .../repack-events`」).

ⓑ **이력이 느는 둘째 원천 — 다른 멱등키 재전송이 «빈 이벤트»를 남긴다.** 계약이 치환에 조건절을 안 달았다(`contracts/logistics-01자재창고.json:1448` — 「이 치환은 서버가 HandlingUnitRepackEvent(헤더) + Line(수량 변경 전/후)을 함께 기록한다」). 그래서 같은 내용으로 다시 치환해도 이벤트가 한 건 더 생긴다. 중복은 `Idempotency-Key` 로 막지만 **키가 다르면 흡수되지 않는다** — 이 오퍼레이션은 오프라인 대상이고(계약이 「큐에 쌓인 요청은 낙관적 잠금 토큰을 싣지 않는다(공유계약 C-9)」라 적었다 · `:1448`), 큐가 같은 치환을 다른 키로 재전송하면 `qtyBefore === qtyAfter` 인 **빈 이벤트**가 쌓인다.

ⓒ **`HandlingUnitCreate` 에 `businessDate` 가 없어 취급단위 번호의 기간 축을 서버가 잡는다.** `handling_unit_no` 는 `business_no_t NOT NULL UNIQUE` 인데 요청 본문에 원천이 0이고 화면이 「MES 채번 · **자동**」이라 적었다. `app.numbering_rule` 에 `HANDLING_UNIT` 행이 **없다**(DB 실측 3행 — `MATERIAL_ISSUE_REQUEST`·`PRODUCTION_RESULT`·`WORK_ORDER`)라 기본 패턴 `HU-{YYYYMMDD}-{SEQ4}` 로 매긴다. 그 `{YYYYMMDD}` 를 채울 날짜가 요청에 없다. ⇒ **서버 시각의 UTC 날짜**를 쓴다. ⚠ 하노이(UTC+7) **00:00~07:00 에 만든 포장이 전날 번호를 받는다.** 공유계약 C-8 은 「영업일은 클라이언트가 보낸다」인데 이 오퍼레이션에는 그 칸이 없다(같은 결함이 `WO-`·`MIR-`·`MR-` 에도 있다 — 기존 대기 14·15 와 같은 축).

## 지금 서버는

- **아직 없다.** 계획이 정한 동작은 아래와 같다.
- ⓐ `repack-events` 는 **전건을 내린다.** 페이지·필터를 지어내지 않고, 정렬만 서버가 못 박는다(`occurred_at desc`, 동률이면 id `desc` — 계약이 정렬 축을 안 주는데 순서를 정하지 않으면 반환 순서가 보장되지 않는다). 조회 축은 헤더가 아니라 **라인의 `handling_unit_id`** 다(합병은 원본이 여럿이라 헤더 한 칸으로 못 가리킨다).
- ⓑ 치환은 **언제나** 이벤트를 만든다(최초 채움도 `qtyBefore=0` 으로 남긴다). 변화 없는 줄도 남긴다 — 계약이 「변화가 있을 때만」을 안 적었다.
- ⓒ 채번은 `HANDLING_UNIT` 접두 `HU` 를 기본 접두 표에 한 줄 더해 쓰고, 기간 축은 **서버 UTC 날짜**다. 결번은 허용한다.
- ⓒ 이 표는 오늘 0행이라 정렬 축 인덱스를 더 걸지 않았다(조회 축 인덱스 1건만 만든다).

⇒ **묻는 것**: `repack-events` 에 `page`·`size`(또는 기간 필터)를 열 것인가 · `POST /inventory/handling-units` 에 `businessDate` 를 실을 것인가(안 실으면 하노이 새벽 발행분이 전날 번호를 받는다).

흔적: `docs/coverage-100/slices/I-16.md` §1-2 · §4-3 · §6-4 · §10-1 #4·#8 · §0-재수립 **R-3**(다른 멱등키 재전송이 빈 이벤트를 남긴다) · `contracts/logistics-01자재창고.json:1448·1526-1536` · `M-04-03-포장재구성스캔.md:208` · 기존 **문의 14**(채번 규칙 없는 표 — `handling_unit_no` 한 행 추가) · 기존 **대기 15**(`businessDate`/`occurredAt` 미저장) · 문의 140 · 문의 145.
