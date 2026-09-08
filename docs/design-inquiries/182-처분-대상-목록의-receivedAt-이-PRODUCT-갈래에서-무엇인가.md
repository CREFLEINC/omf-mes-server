# 182. `DispositionCandidate.receivedAt` 이 **PRODUCT 갈래에서 무엇인가** — 기간 한 번에 원천 하나가 사라진다

**구분: 통보**(회신을 기다리지 않는다 — 우리가 원천을 정했습니다. 다르면 갈아 끼웁니다)

| 칸 | 내용 |
|---|---|
| 걸리는 오퍼레이션 | `GET /quality/disposition-candidates`(질의 `receivedFrom`·`receivedTo` · 응답 `receivedAt` · 기본 정렬) |
| 구현 상태 | **구현 예정(I-21 PR ③)** — 계획서 `docs/coverage-100/slices/I-21.md` §4-1 · §9-1 **#8-b** |
| 판정 | §2 **1단계 본길**(모든 후보 조회의 결과가 달라진다) → 계약이 **갈래 한정어를 안 적었다** ⇒ **1-1단계 「정하고 통보」** |
| 되돌릴 때 | 원시 SQL 의 **`max(b.last_transaction_at)` 한 줄**을 다른 원천으로 바꾼다 |

## 무엇이 문제인가

계약이 이 목록을 「⭐ **원천 둘을 한 목록으로 합쳐 낸다** — 반품 입고(RETURN)와 OQC 불합격(PRODUCT)」로 세웠습니다. 그런데 응답 네 칸 중 **셋과 하나가 갈립니다**(계약 원문 실측):

| 칸 | 계약 설명 |
|---|---|
| `goodsReceiptId` | 「**반품 갈래**의 입고 전표. `sourceCode=PRODUCT` 면 null 이다」 |
| `receiptNo` | 「**반품 갈래**의 입고번호」 |
| `partnerName` | 「**반품 갈래**의 거래처 이름」 |
| **`receivedAt`** | 「**불량창고에 들어온 날**」 ← ⭐ **갈래 한정어가 없다. 「PRODUCT 면 null」이라는 문장도 없다** |

같은 축이 질의에도 있습니다 — `receivedFrom` = 「**대상이 불량창고에 들어온 날**」.
그리고 `REQ-PR-0025` 「판정은 **불량창고 입고 후**」와 프로세스 05 S11 「[판정 대기 시] 불량창고 입고 → 판정」이 **두 원천 모두** 불량창고 입고를 선행 사건으로 말합니다.

**「반품 갈래만」으로 읽으면 두 가지가 깨집니다:**

1. ⛔ **`receivedFrom`/`To` 를 넣는 순간 OQC 불합격 건이 전부 사라집니다** — NULL 비교는 UNKNOWN 입니다. 계약이 대문짝만하게 세운 「원천 둘을 한 목록으로」가 **기간 한 번에** 깨집니다.
2. ⛔ **정렬 `received_at DESC NULLS LAST` 가 PRODUCT 갈래를 언제나 마지막 페이지로 밉니다** — 1쪽만 보는 현장에서 OQC 불합격 건은 영영 안 보입니다.

## ⇒ 우리가 정한 것

**`receivedAt` 은 두 갈래 «공통» 칸이고, 원천은 «불량창고 잔액 행의 `last_transaction_at`» 입니다.**

```sql
JOIN LATERAL (
  SELECT …, max(b.last_transaction_at) AS received_at
    FROM inventory.inventory_balance b
    JOIN mdm.warehouse w ON w.warehouse_id = b.warehouse_id AND w.is_defect = true
   WHERE b.lot_id = c.lot_id AND b.on_hand_qty <> 0
) bal ON TRUE
```

- 이 목록은 **이미 불량창고 잔액을 잡고 있으므로**(통보 089 §8) **비용이 0**입니다.
- 계약 문자(「불량창고에 들어온 날」)와 **갈래 한정어가 없다**는 사실에 둘 다 맞습니다.
- ⛔ **정렬에서 `NULLS LAST` 를 쓰지 않습니다.** 잔액 행이 남아 있는 한 그 값은 NULL 이 아니지만, 혹시 NULL 이 남더라도 **기간 필터가 그 행을 지우지 않게** 합니다(공유계약 `L-8` — 판정 불가를 없는 것으로 만들지 않는다).
- **e2e 로 잠급니다** — 「기간 필터를 넣어도 PRODUCT 갈래가 살아남는다」.

## 📨 다른 원천을 원하시면

후보가 셋이었습니다 — ⓐ **불량창고 잔액의 `last_transaction_at`**(채택) ⓑ 불량창고로 넣은 입고 전표(OQC 갈래에는 **전표가 없습니다**) ⓒ **OQC 확정 시각**(`inspection_result.confirmed_at`).
ⓒ 를 원하시면 두 갈래가 **서로 다른 뜻의 날짜**를 한 칸에 담게 되므로(입고일 ↔ 판정일) 그 사실을 계약 설명에 적어 주셔야 합니다.

## 흔적

`docs/coverage-100/slices/I-21.md` §1-2 · §1-4-1 · §4-1 · §8-3 e2e **#9-a**·**#15** · §9-1 **#8-b** ·
`contracts/shipment-04제품출하.json`(`DispositionCandidate` · `disposition-candidates` 질의 · python 실측) ·
`REQ-PR-0025` · 프로세스 05 S11 · **통보 089 §8**(불량창고 축).
