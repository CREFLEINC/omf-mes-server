# 278. 출고 QR 은 POP 이 만들고, 서버는 렌디션을 내지 않는다

| 칸 | 내용 |
|---|---|
| **구분** | **통보** — 사용자 결정(2026-09-16). 회신을 기다리지 않는다. 통보 277 §4(결정 8·9)의 **2단계**다 |
| 걸리는 오퍼레이션 | `GET /logistics/goods-issues` · `POST /app/document-issues` · `GET /app/document-issues/{documentIssueLogId}/rendition` |
| 구현 상태 | **서버 — 이번 루틴에서 한 줄.** 단말 범위에 POP 을 더한 것뿐이다(P-22). 렌디션·QR 생성 코드는 만들지 않는다. POP·모바일은 별도 저장소 |
| 판정 | 통보 277 이 「서버는 값만 준다 → POP 이 배치·명령 생성·출력까지 한다」를 이미 정했다(결정 8). 출고 QR 은 그 단계적 적용(결정 9)의 다음 칸이다 |
| 되돌릴 때 | `terminal-logistics-scope.ts` 의 `GET /logistics/goods-issues` 를 `['MOBILE']` 로 되돌리면 끝이다. 그러면 `P-01-02` 는 다시 401 로 막힌다 |

---

## 1. 결정

| # | 항목 | 결정 |
|---|---|---|
| 1 | QR 이미지 생성·출력 주체 | **POP.** 서버는 `GOODS_ISSUE_QR` 렌디션을 만들지 않는다 |
| 2 | 서버 렌디션 현 동작 | png·tspl **422 유지.** 이 유형은 렌디션을 부르지 않으므로 호출되지 않는다 |
| 3 | 단말 다운로드 허용 목록 | **손대지 않는다** — `GOODS_ISSUE_QR` 을 넣지 않는다 |
| 4 | QR 페이로드 | `OMF-GIL\|<goodsIssueLineId>\|<출고번호>\|<라인번호>` — 예 `OMF-GIL\|17\|GI-20260916-0003\|1` |
| 5 | 모바일 해석 축 | `OMF-GIL\|` 접두어면 `GET /logistics/goods-issues?goodsIssueLineId=` · 아니면 기존 출고번호 경로 유지 |
| 6 | 단말 범위 | `GET /logistics/goods-issues` 를 **POP 에도 연다**(공장 강제 유지) |

## 2. 페이로드 양식

```
OMF-GIL|17|GI-20260916-0003|1
접두어  |라인id|출고번호       |라인번호
```

| 칸 | 값 | 이유 |
|---|---|---|
| 접두어 | `OMF-GIL` 고정 | 파서가 **이 접두어 하나로** 자재 LOT 라벨과 가른다(§3) |
| 라인 id | `logistics.goods_issue_line.goods_issue_line_id` | 조회 축이 이미 있다(`goods-issue-query.service.ts`) |
| 출고번호 | `goods_issue.goods_issue_no` | 파싱 실패·구버전 앱에서도 **사람이 읽고** 출고번호 경로로 되돌아갈 수 있다 |
| 라인번호 | `goods_issue_line.line_no` | 육안 대조용 |

| 공통 규칙 | 값 |
|---|---|
| 구분자 | `\|` (U+007C) — 통보 277 §2 와 같다 |
| 칸 수 | 정확히 4 |
| 라벨 면 텍스트 | 출고번호 · 라인번호 · 품목코드 · LOT · 수량 · 도착 위치 |

### 2-1. ⛔ 서버는 이 문자열을 만들지도 읽지도 않는다

POP 이 조합하고 모바일이 판다. 서버가 보는 것은 **모바일이 푼 뒤 보내오는 `goodsIssueLineId`**
하나뿐이고, 그 축은 이미 있다. 그래서 이 양식이 바뀌어도 **서버 코드는 바뀌지 않는다.**

## 3. 자재 LOT 라벨과 어떻게 갈리나

통보 277 §2(49행)가 자재 LOT 의 QR 내용을 **`lotNo` 문자열 그대로**로 정했다 — 접두어도 유형
표시도 없다. 그래서 두 라벨은 이렇게 갈린다.

| | 자재 LOT 라벨 | 출고 QR |
|---|---|---|
| 접두어 | **없다** | `OMF-GIL` |
| 칸 수 | 5 (`품목\|수량\|날짜\|공급사\|번호`) | 4 |
| 예 | `040101-00022S\|12.5\|260731\|100019\|0001` | `OMF-GIL\|17\|GI-20260916-0003\|1` |

⚠ **`L1\|…` 은 근거가 아니다.** 초안이 「자재 LOT 라벨 `L1\|…` 과 같은 관례」를 근거로 들었으나
두 겹으로 어긋난다 — ⓐ `L1\|` 은 설계 문서 규정이 아니라 **클라이언트 코드 관행**이고
(`apps/pop/src/main/tspl-label.ts:293`, 설계 문서 0건), ⓑ **통보 277 §5(181행)가 이미 폐기를
지시했다.** 신규 경로 `apps/web/src/screens/pop-material-lot-label/label-tspl.ts:179` 는 이미
`lotNo` 만 싣는다.

⇒ 결론은 그대로다. 오히려 **더 안전하다** — 자재 LOT 이 접두어를 안 쓰게 되어, 접두어의 유무가
곧 유형 판별이 된다.

## 4. ⚠ 계약이 빈 근거를 인용하고 있다 (이번 실측)

`contracts/logistics-01자재창고.json` 의 `goodsIssueLineId` 설명 원문 —
⌜라인 단위 출고 QR 을 스캔했을 때. 그 라인이 속한 출고 전표를 낸다. **근거: `P-01-02` §5-2 ·
`M-01-09` §5-6**⌝. 그런데 두 절 어디에도 그 근거가 없다.

| 인용된 절 | 실제 내용 |
|---|---|
| `P-01-02` §5-2 | `target_type_code`/`target_id` **다형 참조**를 정한 절(라인=`GOODS_ISSUE_LINE`, 파렛트=`HANDLING_UNIT`). QR 내용 규정 **0줄** |
| `M-01-09` §5-6 | 액션 **활성 조건**표(「출고 QR 스캔 — 항상, 포커스 고정」). 스캔값 해석 규정 **0줄** |

두 절에서 도출되는 것은 「출고 QR 은 전표가 아니라 **라인**을 가리킨다」 하나뿐이다.
스캔값이 라인 id 를 **어떤 문자열 형태로** 싣는지는 설계 wiki·계약 7벌·`docs/` 전체에서 **0건**이다.

⚠ 그리고 API 요구서(`06-API-요구서-01자재창고.md:312`)는 「출고 No ≠ 출고 QR No」라고 구분해
두었는데, **「출고 QR No」를 담을 칸이 물리 스키마에도 계약에도 없다**(`qr_no`·`qrNo` 전수 0건).
칸이 없으므로 이번 결정은 **번호를 새로 만들지 않고** 라인 id 를 그대로 싣는다.

## 5. 반영 대상

### 설계 (설계팀 — 사용자를 통해 전달)

| 문서 | 반영 |
|---|---|
| `P-01-02` 출고QR발행 | §5-2 **뒤에 페이로드 절을 신설**(§2). 라벨 구성 주체 = POP |
| `M-01-09` 생산창고입고 §5-6 | 스캔값 해석 규정 추가 — 접두어 분기(§2-1). §6 예외표의 「QR 이 다른 라인의 것」 판정 근거도 여기서 선다 |
| 「MES 라벨 표준 사양」 | 출고 QR 서식 추가(통보 277 §3 의 자재 LOT 서식과 나란히) |
| 계약 `logistics-01자재창고.json` | ⓐ `GET /logistics/goods-issues` 의 `x-screens` 에 `P-01-02` 추가 ⓑ `goodsIssueLineId` 설명의 「근거: …§5-2 · §5-6」을 **실제로 그 내용이 선 뒤에** 다시 가리키게 한다 |
| 「출고 QR No」 | 칸이 없다 — **번호를 둘 것인지** 정해 주십시오. 두지 않는다면 요구서 :312 의 문구를 고친다 |

### 서버 (이 저장소)

| 파일 | 변경 |
|---|---|
| `src/auth/terminal-logistics-scope.ts` | `GET /logistics/goods-issues` 허용 단말에 `POP` 추가 |
| `src/auth/terminal-logistics-scope.spec.ts` · `test/logistics-goods-issue.e2e-spec.ts` | 회귀 |
| `test/app-document-issue-write.e2e-spec.ts` | POSTED 출고 라인의 발행 **성공** 경로(여태 거부 쪽만 봤다) |
| `docs/계약-선행-수정항목.md` **P-22** | 위 §4 를 포함해 기록 |

⭐ 마이그레이션 없음 · 스키마 변경 없음 · 렌디션 코드 없음 · `contracts/` 무수정.

### 클라이언트 (별도 저장소)

| 자리 | 변경 |
|---|---|
| POP `P-01-02` | 출고번호 입력 칸(진입) · QR 라벨 **자체 생성**(캔버스 PNG → `rendition.save`) · `fetchLabelRendition` 을 부르지 않는다 |
| 모바일 `M-01-09` | 스캔값 파서 — `OMF-GIL\|` 접두어면 `goodsIssueLineId` 축, 아니면 기존 경로 유지 |

## 6. 범위 밖 — 발견했지만 이번에 고치지 않는 것

- **파렛트(`HANDLING_UNIT`) 단위 출고 QR.** `P-01-02` §5-2 가 후보로 적었고 물리도 받지만, HU 를
  출고 시 만드는 주체가 미정이다(문의 145·163·164 · client #1095). 이번 양식은 라인 단위만 다룬다.
- **「출고 QR No」 칸** — §4. 만들지 말지가 정해지지 않았다.
- 서버가 라벨 «값»을 내려주는 길(통보 277 §4-1 이 자재 LOT 에 대해 제안한 `DocumentIssue` 확장).
  출고 QR 은 POP 이 이미 가진 전표·라인 데이터로 라벨을 그릴 수 있어 이번엔 필요하지 않았다.

## 근거

- `src/auth/terminal-logistics-scope.ts` · `src/logistics/goods-issue/goods-issue.controller.ts:49`
- `src/logistics/goods-issue/goods-issue-query.service.ts` — `goodsIssueLineId` 축
- `design/wiki/screens/01/P-01-02-출고QR발행.md:115-137` · `M-01-09-생산창고입고호퍼잔량.md:182-191`
- `design/wiki/api-contracts/06-API-요구서-01자재창고.md:312`
- `contracts/logistics-01자재창고.json` — `goodsIssueLineId` · `q`
- 통보 **277** §2(49행) · §4(결정 8·9) · §5(181행)
- `docs/계약-선행-수정항목.md` **P-22**
