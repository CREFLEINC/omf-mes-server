# 19. `IQC_SKIP`(한도승인)의 승인 화면이 `W-01-02` 인가 `W-03-09` 인가 — 「특채」는 9값에 없고, `screenId` 규칙이 걸리는 유형이 없다

| 칸 | 내용 |
|---|---|
| 걸리는 오퍼레이션 | `GET /app/approval-requests` · `GET /app/approval-requests/{approvalRequestId}` · `POST …:approve` · `POST …:reject`(응답의 `ApprovalTarget.screenId`·`openable`) |
| 구현 상태 | 구현 예정(I-1) — 9 유형 전건 `screenId` 키 생략 · `openable=false` |
| 판정 | §2 0단계 — W-CO-09 §6 「대상 경로가 없는 유형 → 「이 대상은 아직 열 수 있는 화면이 없습니다」 · 버튼 비활성」이 물러날 자리를 이미 그렸다. `docs/계약-재검토-2026-09-04.md` §3 과 같다 |
| 되돌릴 때 | `src/app/approval/` 의 대상 매퍼 표 한 곳(유형 → 화면 식별자). 응답만 바뀌고 저장 데이터 없음 |

## 무엇이 문제인가

계약 `ApprovalTarget.screenId` 는 「⭐ 첫 확정 규칙: 특채·한도승인 → `W-03-09`」를 적고, `x-internal-note` 로 「`IQC_SKIP` 에 이것이 성립하는지 의심」을 남겼다. 실측 —

1. **「특채」는 `approvalTypeCode` 9값에 없다**(`PURCHASE_ORDER`·`GOODS_ISSUE_DISPOSAL`·`INVENTORY_ADJUSTMENT`·`PRODUCTION_RESULT_CORRECT`·`IQC_SKIP`·
   `INBOUND_RECEIPT_CANCEL`·`GOODS_RECEIPT_CANCEL`·`GOODS_ISSUE_CANCEL`·`SHIPMENT_CANCEL`). W-06-15 §8-2 도 「실측 후보 9 중 특채만 빠진 그대로」라 적었다.
   ⇒ 확정 규칙이 실제로 걸릴 유형은 `IQC_SKIP` 하나뿐이다.
2. **그 `IQC_SKIP` 의 승인 화면을 화면 명세 둘이 서로 열어 뒀다** — W-CO-09 §5-1 「⚠ `W-01-02` 는 예외다 … 판정은 업무 화면, 결재는 결재함」 ·
   W-03-09 §8 #3 「한도승인 요청은 어느 화면이 만드나 — `W-01-02` 로 보이나 확인 안 함」(미결).
3. **`screenId` 는 «화면 식별자»인데 W-CO-09 §9 의 대응표 오른쪽 열은 «리소스 경로»다**(`omf-mes#352` §A6 이 같은 지적). 경로표를 화면표로 옮겨 주면 서버가 채울 수 있다.

## 지금 서버는

9 유형 전건 `screenId` 키를 생략하고 `openable=false` 를 낸다. **결과: 결재함 W-CO-09 우측 「대상」 구획의 유일한 액션 「대상 화면에서 보기 ↗」가 1차 내내 비활성**이다.
배포 노트에 적는다.

## 요청

1. `IQC_SKIP` 의 승인 화면을 `W-01-02` / `W-03-09` 중 하나로 확정해 달라(W-CO-09 §5-1 · W-03-09 §8 #3 을 한쪽으로).
2. 9 유형 → **화면 식별자** 표를 내려 달라(W-CO-09 §9 경로표를 화면표로). 없는 유형은 「없음」으로 명시해 주면 그 유형만 `openable=false` 로 남긴다.
3. 「특채」 승인이 필요하면 `approvalTypeCode` 에 값을 더할지, 아니면 특채는 승인 워크플로 밖(I-21 처분 흐름)인지 알려 달라.

우리 권고안(회신이 없으면 이대로 갈 값): 1 = `W-01-02`(요청을 만드는 화면 · M-01-13 의 짝) · 2 = 없는 유형은 전부 `openable=false` 유지 · 3 = 특채는 승인 워크플로 밖.

## 각주 — 우리 쪽에서 닫은 것(회신 불필요)

- `INBOUND_LOT` 의 대상 표: 계약 `logistics-01자재창고.json` 의 `:request-iqc-skip` 주석 「`target_type_code=INBOUND_LOT` · `target_id=lot_id`」와 W-01-02 §0 이 `trace.lot` 으로 답했다. 다만 서버 등록부 `app.entity_type_registry` 는 `(schema, table)` 유일이라 `LOT` 와 나란히 등재할 수 없어 **매퍼 별칭 `INBOUND_LOT → LOT`** 으로 푼다.
- 계약이 가리킨 `omf-mes-server#74` 는 우리 저장소 이슈(2026-09-02 닫힘, 제목 `audit.audit_event`)라 표지를 우리가 고친다.
