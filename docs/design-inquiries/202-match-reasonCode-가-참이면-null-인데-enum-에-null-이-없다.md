# 202. ⛔ **계약 자기 모순** — `match.reasonCode` 가 「참이면 `null`」이라 적혔는데 **`enum` 에 `null` 이 없다**

**구분: 통보**(회신을 기다리지 않는다) · ⭐ **저장소 ajv 설정 그대로 «실행»해 확인했습니다**

| 칸 | 내용 |
|---|---|
| 걸리는 오퍼레이션 | `GET /logistics/shipment-lot-allocations`(200 응답의 `match` 객체) |
| 구현 상태 | **구현 예정(I-22 PR ⑦a)** — `matched=true` 면 **키를 생략**한다 |
| 판정 | §2 **1단계 본길** → 계약 두 문장이 모순이라 **응답이 실제로 깨지지 않는 쪽**을 고름 |
| 되돌릴 때 | 뷰 한 줄. 계약이 `enum` 에 `null` 을 더하면 그때 `null` 로 내립니다 |

## 실측

```json
"reasonCode": {
  "type": ["string", "null"],
  "enum": ["LABEL_ITEM_MISMATCH", "LOT_NOT_ALLOCATED"],      // ⛔ null 이 enum 에 «없다»
  "x-code-key": "CD-SHIPMENT-LOT-MATCH-FAIL-REASON",
  "description": "… matched 가 참이면 null 이다."               // ⛔ enum 과 모순
}
"required": ["matched"]                                       // reasonCode 는 «선택»이다
```

저장소 e2e 와 **같은 설정**(`ajv/dist/2020` · `{strict:false, allErrors:true}` + `ajv-formats` + int64 등 6포맷)으로 컴파일해 돌렸습니다:

| 응답 | 결과 |
|---|---|
| `{matched:true, reasonCode:null}` | ⛔ **FAIL** — `keyword:"enum"`, `allowedValues:["LABEL_ITEM_MISMATCH","LOT_NOT_ALLOCATED"]` |
| `{matched:true}`(키 생략) | ⭕ PASS |
| `{matched:false, reasonCode:"LOT_NOT_ALLOCATED"}` | ⭕ PASS |
| `match` 키 자체 생략 | ⭕ PASS |

⇒ **`type` 에 `"null"` 이 있어도 `enum` 이 그것을 다시 막습니다.** JSON Schema 에서 `enum` 은 `type` 과 **AND** 로 걸립니다.

## ⇒ 우리가 정한 것

- `matched = true` 면 **`reasonCode` 키를 생략**합니다.
- `matched = false` 면 두 값 중 하나를 싣습니다 — `LABEL_ITEM_MISMATCH`(이 납품라벨은 다른 품목용) · `LOT_NOT_ALLOCATED`(이 출하에 배분되지 않은 LOT).
- `lotQ` 를 안 주면 **`match` 객체 자체를 안 만듭니다**(계약 「`lotQ` 를 준 요청에만 실린다」).

## 📨 알려 드리는 것

**둘 중 하나로 고쳐 주십시오** —
ⓐ `enum` 에 `null` 을 더한다(`["LABEL_ITEM_MISMATCH","LOT_NOT_ALLOCATED", null]`) · ⓑ description 을 「참이면 **키를 생략한다**」로 바꾼다.

지금 문장대로 구현하면 **계약에서 만든 검증기가 서버 응답을 거부**합니다. ⭐ 저희는 ⓑ 로 갔습니다 — 응답이 깨지지 않는 쪽입니다.
⚠ 이 자리는 **계약 안에서 두 문장이 부딪힌 네 번째**입니다(문의 188 과 같은 결).

## 흔적

`docs/coverage-100/slices/I-22.md` §0 #5 · §1-2 ⑥ · §1-4-0 · §4-4 · §8-5 **A-14** · §0-재수립 **R-8** ·
`contracts/shipment-04제품출하.json`(`match.reasonCode` · python) · `test/logistics-picking.e2e-spec.ts:44-48`(ajv 설정 선례) · **문의 188**.
