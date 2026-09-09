# 195. 출하검사 롤업을 **라인에 매다는 칸이 0개**이고, 그대로 두면 **「합격인데 납품라벨을 영원히 못 뽑는」** 상태가 생긴다

**구분: 통보**(회신을 기다리지 않는다) · ⭐ **3관점 재검토가 두 번째 사고(uiux Blocker)를 찾아 함께 담았습니다**

| 칸 | 내용 |
|---|---|
| 걸리는 오퍼레이션 | `GET /logistics/shipment-requests`(+`/{id}`·`summary`)의 `shippingInspectionStatusCode` · `GET /logistics/shipment-lot-allocations` 의 `oqcPassed` |
| 구현 상태 | **구현 예정(I-22 PR ④·⑦a)** — 두 파생을 **한 함수**로 통일한다 |
| 판정 | §2 **1단계 본길** → 계약이 값만 주고 축을 안 줌 ⇒ **0단계 선례**(`inspection_request.target_type_code` enum + `lot_id` 병존)로 축을 세우고 **통보** |
| 되돌릴 때 | 조인 축 한 줄. ⚠ 다만 축이 갈리면 아래 ⛔ 상태가 재현됩니다 |

## 계약이 요구하는 것

`ShipmentRequest.shippingInspectionStatusCode`(**헤더 required 칸**) 5값 —
`NOT_REQUIRED`·`PENDING`·`PASSED`·`REJECTED`·`HELD`, 롤업 우선순위 「**가장 나쁜 것이 이긴다**: REJECTED > HELD > PENDING > PASSED > NOT_REQUIRED」.
`W-04-02` §5-4 가 다섯 모양을 그림으로 못박았습니다. **판정 단위는 「라인」**입니다 — 「= true, **라인 전체** 결과 없음 → 대기」.

## ⛔ 그런데 라인에 검사를 매다는 칸이 없습니다

`quality.inspection_request.target_type_code` 의 enum 은 **`LOT`·`WORK_ORDER`·`SHIPMENT_REQUEST` 셋**입니다(`SHIPMENT_REQUEST_LINE` 없음).
⭐ 그리고 `inspection_request.lot_id` 는 **`target_type_code` 와 «병존»**합니다(`W-04-03` §4-A 「대상 LOT \| `lot_id` \| nullable — **다형과 병존**」).

## ⇒ 우리가 정한 것

**한 라인의 검사 상태**를 이렇게 냅니다:

```
required=false                                       → NOT_REQUIRED
모집단 = OQC · status_code='CONFIRMED' · 그 의뢰의 «최대 CONFIRMED 회차» 이고
         ( target_type_code='LOT'   AND coalesce(lot_id, target_id) ∈ 그 라인이 집은 LOT )
      OR ( target_type_code='SHIPMENT_REQUEST' AND target_id = 그 작업지시
           AND (lot_id IS NULL OR lot_id ∈ 그 라인이 집은 LOT) )     ← lot_id 병존을 버리지 않는다
0건 → PENDING · REJECTED 있으면 REJECTED · HELD 있으면 HELD · 전건 ACCEPTED → PASSED
```

헤더 값은 라인들에 우선순위를 적용합니다.

## ⛔⛔ 그리고 **`oqcPassed` 를 같은 함수로 통일합니다** — 안 그러면 이런 상태가 생깁니다

OQC 를 **헤더 대상**(`target_type_code='SHIPMENT_REQUEST'`)으로만 낸 작업지시에서:

| 화면 | 값 | 결과 |
|---|---|---|
| `W-04-02` 「검사」 열 | 라인 축 롤업 → `PASSED` | 「✅ 합격」 |
| `W-04-04` §5-4 관문 ② | 합격 | 출하 확정 **통과** |
| `P-04-02` §5-1 대상 목록 | `oqcPassed`(LOT 축만) → **false** | ⛔ **「발행 불가」** |

`P-04-02` §5-6 이 「**발행 취소 ⛔ 두지 않는다**」라 되돌릴 수도 없습니다. ⇒ 운영자는 **목록에서 합격을 보고 출하는 확정되는데 납품라벨만 영원히 못 뽑고, 이유는 어디에도 안 뜹니다.**
`W-04-02` §5-4 가 「뭉치면 **왜 막히는지 목록에서 알 수 없다**」로 막으려 한 실패를 다른 화면에서 재현하는 모양입니다.

⇒ **`oqcPassed = (그 배분이 매달린 라인의 `shippingInspectionRequired` 가 false) ? true : 라인 검사 상태 === 'PASSED'`.**

## 📨 알려 드리는 것

1. **OQC 의뢰가 「출하작업지시 라인」을 가리킬 수 있어야 하는지** 정해 주십시오. 지금은 LOT 또는 작업지시(헤더)뿐이라 서버가 「그 라인이 집은 LOT」으로 우회합니다.
2. **헤더 대상 OQC 하나가 그 작업지시의 «모든» 필수 라인을 물들이는 것이 맞습니까?** (`lot_id` 가 채워져 있으면 그 LOT 을 집은 라인만 물들이도록 좁혔습니다.)
3. ⚠ 계약이 「검사 대상이 아닌 배분(`shippingInspectionRequired=false`)은 **`oqcPassed=true`** 로 내린다」라 적었습니다 — **「검사를 안 했다」가 「합격」으로 표시됩니다.** 의도가 맞는지 확인해 주십시오.

## 🔎 이 통보가 «흡수»한 것 (3관점 재검토 · 2026-09-09)

| 어디서 왔나 | 무엇 |
|---|---|
| **UI/UX 관점**(⛔ **Blocker 2** · 후보 **β**) | ⭐⭐ **「합격인데 납품라벨을 영원히 못 뽑는」 영구 상태를 찾았다.** `oqcPassed`(LOT 축)와 라인 검사(LOT+헤더 축)가 갈려, 헤더 대상 OQC 만 있는 출하는 `W-04-02` 「✅ 합격」·`W-04-04` 통과인데 `P-04-02` 대상 목록에서 **영영 비활성**이고 §5-6 이 「발행 취소 ⛔ 두지 않는다」라 되돌릴 수도 없다 ⇒ **두 파생을 한 함수로 통일**하고 PR 배치를 당겼다 |
| **UI/UX 관점**(⓸ 반증) | ⭐ **`inspection_request.lot_id` 가 `target_type_code` 와 «병존»한다**(`W-04-03` §4-A · `schema.prisma:3374`) — 계획의 헤더 갈래가 그것을 버려 **헤더 검사 하나가 모든 라인을 물들이던** 자리를 막았다 |
| **API 관점**(Minor A-9) | 용어 정정 — `shippingInspectionStatusCode` 는 **헤더 required 칸**이지 라인 축이 아니다(라인별 판정은 롤업의 «내부 중간값») |

⇒ 초판 후보 **F**(「축을 골랐다」)에 uiux **β** 와 `lot_id` 병존을 합쳐 이 문서가 됐다.

## 흔적

`docs/coverage-100/slices/I-22.md` §0 #4 · §5-2 · 부록 **#20·#21·#22** · §0-재수립 **R-5·R-10** ·
`contracts/quality-03품질.json`(`InspectionRequest.targetTypeCode`) · `prisma/schema.prisma:3374`·`:3410` ·
`prisma/migrations/20260907174412_…`·`20260907193144_…` · `W-04-02` §5-3·§5-4 · `W-04-03` §4-A · `W-04-04` §5-4 · `P-04-02` §5-1·§5-6(설계 사본).
