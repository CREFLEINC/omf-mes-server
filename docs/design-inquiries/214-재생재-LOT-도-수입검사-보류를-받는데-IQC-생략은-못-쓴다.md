# 214. 재생재 LOT 도 **수입검사 보류**를 받는데, **IQC 생략은 쓸 수 없다**

**구분: 통보**(회신을 기다리지 않는다 — 흐름은 입하와 같게 두고, 급행 수단이 없다는 사실만 알려 드립니다)

| 칸 | 내용 |
|---|---|
| 걸리는 오퍼레이션 | `POST /logistics/recycle-entries`(I-17) · 영향은 `POST /production/material-consumptions`(I-11 · 병합됨) |
| 구현 상태 | **그대로 간다** — 서버가 새로 막는 것도 푸는 것도 없다 |
| 판정 | §2 **1-1단계 통보** — MES 본질(품질 흐름)은 걸리나 **바꾸는 비용이 안 걸린다**(흐름이 이미 있고 되돌릴 것이 0) |

## 무엇이 났나

재생재 등록은 LOT 코어 `createWithin()` 의 **셋째 사용처**다(`lot-registry.service.ts:10-13` 이 스스로 「사용처 셋 … 재생재 I-17」이라 적어 두었다). 그 코어가 **무조건 두 가지**를 한다:

| 자리 | 무엇 |
|---|---|
| `lot-registry.service.ts:19`·`:85` | `status_code = INITIAL_LOT_STATUS = **'INSPECTION_PENDING'**` |
| `:99-105` | ⭐ **`lot_hold` 를 건다** — `reasonCode = INSPECTION_HOLD_REASON` · `targetLotStatusCode = 'INSPECTION_PENDING'`. 주석이 「화면이 보내지 않고 «서버가» 건다(MLOT #5)」 |

그리고 자재 투입이 그 상태를 막는다 — `material-consumption.service.ts`:
```
} else if (lot.status_code !== LOT_NORMAL) {
  // `P-02-03` §5-2 ⌜`NORMAL` → 투입 가능 · 나머지 셋은 ⛔ 차단⌝
  errors.push(field('lotId', ERROR_CODE.INVALID, '투입할 수 없는 상태의 LOT 입니다.'));
}
```

⇒ **재생재 LOT 은 만든 직후 자재 투입에서 400 이다.**

## ⇒ 우리가 정한 것 — **입하와 같게 둔다**

⛔ **예외를 만들지 않는다.** 재생재 LOT 이 `NORMAL` 로 가는 길은 **입하 LOT 과 똑같이** 있다:

```
재생재 등록 → LOT(INSPECTION_PENDING) + lot_hold(수입검사)
           → 품질이 합격으로 해제 → `lot-hold-release-accepted`(INSPECTION_PENDING → NORMAL)
           → 자재 투입 가능
```

근거 — §2 **2단계 기준 1**(재고·품질 상태를 «덜» 쓰는 쪽: 코어에 예외를 내지 않는다) · **기준 5**(새 개념을 안 만드는 쪽).
⭐ 그리고 코어 주석이 이미 그 이유를 적어 뒀다 — 「표식에 예외를 두지 않으려는 것 — 예외를 내려면 `LockedLot` 발급 경로가 하나 더 생기고 그러면 **리뷰가 실측한 우회가 «권장 관용구»가 된다**」.

## 📨 알려 드리는 것 — **급행 수단이 없습니다**

⛔ **재생재 LOT 은 IQC 생략을 쓸 수 없습니다.** `lot-iqc-skip.service.ts:102` 가 자격을 원천 유형으로 닫았습니다:

```
const INBOUND_LOT_SOURCE = 'INBOUND_RECEIPT_LINE';
...
if (lot.source_type_code !== INBOUND_LOT_SOURCE) { → 거부 }
```

재생재 LOT 의 `source_type_code` 는 **`'RECYCLE_ENTRY'`** 라 그 문을 못 지납니다.

⇒ **현장이 분쇄재를 급히 재투입해야 할 때 우회 수단이 0입니다.** 품질이 보류를 해제해 주기를 기다려야 합니다.

**정해 주십시오(급하지 않습니다 — 이 통보는 흐름을 막지 않습니다)**:
1. 분쇄재를 **수입검사에 태우는 것이 맞습니까?** 사내에서 난 것이라 「수입」이 뜻과 어긋날 수 있습니다.
2. 맞다면 **IQC 생략 자격을 재생재까지 넓혀야 합니까?** 넓히면 `lot-iqc-skip.service.ts` 의 상수 한 줄과 화면 자격 문구가 바뀝니다(문의 019·150 과 같은 축).

⚠ 현장 흐름에 병목이 생기면 2번이 먼저 필요해질 자리입니다.

## 흔적

`src/core/lot/lot-registry.service.ts:10-13`·`:19`·`:85`·`:99-105` ·
`src/production/material-consumption/material-consumption.service.ts`(`!== LOT_NORMAL` 갈래) ·
`src/trace/lot/lot-iqc-skip.service.ts:12`·`:102` ·
`src/core/document-state/transitions.ts:211`(`lot-hold-release-accepted`) ·
`docs/coverage-100/slices/I-17.md` §0-재수립 **R-4** · [[019]] · [[150]]
