# 28. 입하 라인이 「공급사 LOT 부착」인데 `supplierLotNo` 가 비어 오는 조합 — 계약이 막지 않았고 물리는 못 받는다

| 칸 | 내용 |
|---|---|
| 걸리는 오퍼레이션 | `POST /logistics/inbound-receipts` — 그리고 같은 라인 스키마를 쓰는 `PUT …/{id}/lines`(I-3 PR ④) · `POST …:split`(PR ⑤) |
| 구현 상태 | **구현함(§2 절차 1단계 가장자리 → 2단계 기준 2 「거부하는 쪽」)** — 400 `PAIR`, field `lines.{i}.supplierLotNo` |
| 판정 | `coverage-100/README.md` §2 1단계 **가장자리**(이 조합의 입력에서만 갈린다) → 2단계 **기준 2**(거부→허용은 호환 완화, 허용→거부는 깨는 변경) |
| 되돌릴 때 | 「보낼 수 있다」는 답이면 가드 한 덩어리(`inbound-receipt-rules.ts` 4줄)를 지우고, 대신 그 라인을 **미부착으로 간주**할지(=`supplier_lot_missing=true` 로 뒤집고 대체 사유를 요구할지) 정해 주셔야 한다. 서버가 조용히 뒤집지는 않는다 |

## 무엇이 문제인가

계약 `InboundReceiptLineUpsert` 는 라인 하나에 두 칸을 둔다.

| 칸 | 계약 | 물리 |
|---|---|---|
| `supplierLotMissing` | **required** · `boolean` · `default: false` | `supplier_lot_missing boolean NOT NULL DEFAULT false` |
| `supplierLotNo` | **선택** · `type: [string, null]` · `maxLength: 100` | `supplier_lot_no varchar(100) NULL` |

그리고 `InboundReceiptCreate` 의 description 이 LOT 규칙을 직접 적었다 —
「자재 LOT 은 **공급사 LOT 이 부착된 라인에만** 함께 생긴다. `supplierLotMissing=true` 인 라인은 LOT 없이 저장되고
P-01-01 이 `POST /trace/lots`(`numberSourceCode=MES`)로 나중에 채운다. **부착 라인의 LOT 이 없으면 이후 흐름이 통째로 막힌다.**」

⇒ 계약은 **두 갈래만** 적었다: 「부착(`false`) → LOT 을 만든다」 · 「미부착(`true`) → LOT 없이 저장하고 나중에 채운다」.
그런데 **셋째 조합**이 스키마상 적법하다 — **`supplierLotMissing=false` 이면서 `supplierLotNo` 가 널·생략**.
`supplierLotNo` 가 required 가 아니고, `supplierLotMissing` 의 `default: false` 때문에 **화면이 두 칸을 모두 안 보내면 자동으로 이 조합**이 된다.

이 조합에는 만들 LOT 의 **번호가 없다**. `trace.lot.lot_no` 는 `NOT NULL`(`varchar(100)` · `uq_lot(plant_id, lot_no)`)이고,
입하 등록의 LOT 은 채번을 타지 않는다 — 계약이 「`numberSourceCode=SUPPLIER` 축」으로 갈라 **공급사 스캔값이 그대로 번호**이기 때문이다
(I-3.md §5-1). 서버가 지어낼 값이 없다.

세 갈래를 다 실측했다.

| 조합 | 계약이 적었나 | 물리가 받나 | 서버 |
|---|:-:|:-:|---|
| `missing=false` + 번호 있음 | ⭕ | ⭕ | LOT 을 만든다(`lot_no` = `supplierLotNo`) |
| `missing=true` + 대체 사유 있음 | ⭕ | ⭕ | LOT 없이 저장한다 |
| **`missing=false` + 번호 없음** | ✕ **침묵** | ✕ `lot_no NOT NULL` | **400 `PAIR`** ← 이 문의 |

## 지금 서버는

**400 `PAIR`** 를 낸다 — field `lines.{i}.supplierLotNo`, 메시지 「공급사 LOT 번호가 없으면 supplierLotMissing 이 참이어야 합니다.」

- 코드 `PAIR` 를 고른 이유: 같은 라인의 **반대 방향**(`supplierLotMissing=true` ↔ `substituteLotReasonCode` 없음)이 이미 `PAIR` 다(I-3.md §1-5).
  「이 칸 하나가 비었다」가 아니라 「두 칸이 짝이 안 맞는다」라 `REQUIRED` 가 아니다.
- 막지 않으면 **500 이 난다** — 트랜잭션 한복판에서 `lot_no` NOT NULL 위반이고, 그 자리는 `PrismaClientKnownRequestError` 가 아니라
  공용 그물(`prismaErrorResponse`)에 안 걸린다. 화면은 사용자가 고칠 수 있는 입력 오류를 서버 장애로 본다.
- 흔적: 단위 테스트 `등록 — supplierLotMissing=false 인데 supplierLotNo 가 비면 400 PAIR 다(lot_no 가 NOT NULL 이라 LOT 을 못 만든다 · 문의 028)`
  + 코드 주석 `// 설계 미정 — 문의 028`(`src/logistics/inbound-receipt/inbound-receipt-rules.ts`).

## 요청

1. **`M-01-01`(입하 등록, 모바일)이 이 조합을 보낼 수 있습니까?** — 화면이 「LOT 라벨 스캔」을 건너뛴 라인을 저장할 때
   `supplierLotMissing` 을 **반드시 `true` 로 켜서** 보냅니까, 아니면 두 칸을 모두 비운 채 보낼 수 있습니까?
   (오프라인 큐에 쌓인 요청이 그대로 재전송되는 오퍼레이션이라, 한 번 보낼 수 있으면 반드시 옵니다.)
2. **보낼 수 있다면 — 서버가 그것을 「미부착」으로 간주해야 합니까?** 즉 `supplier_lot_missing` 을 참으로 뒤집고
   `substituteLotReasonCode` 를 요구할지, 아니면 사유 없이 미부착으로 저장할지 정해 주십시오.
   ⚠ 서버가 조용히 뒤집는 것은 §2 2단계 기준 4(값을 조용히 도출하지 않는다)에 걸려 지금은 하지 않습니다.
3. 곁들여: `supplierLotNo` 를 **required 로 올리지 않은 것**이 의도인지 확인해 주십시오.
   지금 스키마는 `supplierLotMissing` 의 `default: false` 때문에 **두 칸을 다 생략한 본문이 「부착인데 번호 없음」으로 읽힙니다** —
   화면이 「미부착」을 명시적으로 켜야만 저장되는 구조입니다.

우리 권고안(회신이 없으면 이대로 갈 값): **400 `PAIR` 로 거절한다.**
거절→허용은 나중에 풀 수 있고(호환 완화), 허용→거절은 깨는 변경입니다. 그리고 이 조합을 통과시키면
「부착 라인의 LOT 이 없으면 이후 흐름이 통째로 막힌다」는 계약 문장 그대로의 사고가 **저장된 뒤에** 드러납니다.
