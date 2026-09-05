# I-1 재검토 — **API 설계 관점** (브리프 `brief-I-1-review.md`)

> 대상 `I-1.md` · 계약 사본 `a6a87e1` 읽기 전용. 근거는 `jq`·소스·설계 저장소 사본 실측.
> ⭐ **§1-1 횡단표(403 9 · 멱등 7 · If-Match 6 · ETag 8) 재실측 — 전건 일치**, 그대로 선다.

---

## 1. 문의 후보 3건 — 「정말 새 문의인가」

1~15번(`~/omf-design-requests/`)·`design-inquiries/016·017`·`계약-되돌림-mdm.md` 전문 검색 —
**승인·결재 축의 물음 0건**. 「기존」으로 접힐 것은 없다. 다만 개별 판정은 갈린다.

### 018 `inProgressCount` 연결 칸 없음 — ✏ **수정(문의는 유지, 물음을 바꾼다)**
§2 적용(가장자리 → 2단계 기준 3)과 I-1 에서 칸을 안 더하는 결론에 **동의**한다.
⛔ 그러나 「유형 축 근사」를 영구 결론처럼 물으면 안 된다 — `app.approval_request` 는 지금 **0행**이고
첫 행을 만드는 것이 I-2 의 상신인데, 상신은 `selectRoute()` 가 고른 `approvalRouteId` 를 **이미 쥐고
있다**. I-2 에서 nullable 칸 하나를 더하면 **백필 0**으로 그 순간부터 정확해진다. ⇒ 018 의 물음은
「근사로 둘까요」가 아니라 **「I-2 에서 칸을 더해 정확히 세도 되는가 — 아니면 J-9 의 「옛 결재선으로
끝난다」가 결재선 «식별자»가 아닌 다른 뜻인가」**여야 한다. §2-3 「되돌릴 때」에 「I-2 가 무비용
시점」을 한 줄, `plan.md` §3(I-2 코어 PR)에 예고.

### 019 `screenId` 의 W-03-09 규칙 — ✅ **동의(근거 둘 보강)**
① `x-internal-note` 가 IQC_SKIP 에서 스스로 무너진 것 외에, 그 규칙이 말하는 「특채」는
`approvalTypeCode` **9값에 아예 없다**(실측). 확정 규칙의 두 대상 중 하나는 없는 유형이고 하나는
노트가 부정한다 → **9값 전건에서 못 낸다**가 사실. ② 설계가 절반 답을 갖고 있다 — `W-CO-09` §9 3행
「채운 표의 오른쪽 열은 «리소스 경로»이고 `screenId` 가 요구하는 것은 «화면 식별자»다(`omf-mes#352`
§A6)」. 이 문장을 인용해 「경로표를 화면표로 옮겨 주면 끝난다」로 물으면 회신이 빨라진다.

### 020 `INBOUND_LOT` 대응 표 없음 — ⛔ **반대(전제가 틀렸다). 다시 세운다**
「대응 표가 없다」는 **사실이 아니다**. 실측 둘 —
1. 설계 `design/wiki/decisions-policy/공유계약.md:227` (A-10 대응표): `INBOUND_LOT` → `/trace/lots/{id}`.
2. **우리 계약 사본 안에 있다** — `contracts/logistics-01자재창고.json:6569`
   「`target_type_code=INBOUND_LOT` · **`target_id=lot_id`** 로 서버가 채운다」.
⇒ §2 **0단계에서 끝난다** — 대상 표는 `trace.lot`, 키는 `lot_id`. 「등록부에 안 넣는다」는 근거를 잃는다.
⭐ 대신 **진짜 물음이 남는다**: `app.entity_type_registry` 는 `@@unique([schema_name, table_name])`
(`prisma/schema.prisma:3746`)이라 **한 표에 유형 코드 둘을 담지 못한다.** `LOT → trace.lot` 이 이미
시드에 있으므로 `INBOUND_LOT` 행은 **물리적으로 만들 수 없다**. ⇒ 020 을 다음으로 갈아 끼운다 —
> 「승인 대상 `INBOUND_LOT` 은 `trace.lot`(A-10·계약 내부 주석)인데 등록부가 표 하나에 유형 하나만
> 허용한다. ① 등록부에 `INBOUND_LOT` 을 «별칭»으로 두는가 ② 매퍼가 `INBOUND_LOT→LOT` 을 아는가
> ③ 유일 제약을 푸는가. 서버는 ②(코드 한 줄, 스키마 안 늘림)로 간다 — 2단계 기준 3.」
`omf-mes-server#74` 가 닫혀 있다는 관찰(실측 — CLOSED 2026-09-02 · 제목 `audit.audit_event`)은 각주로 붙인다.

### ⭐ 새 후보 021 — `ApprovalTarget.displayName` 의 표시 문자열 원천이 없다 (**추가 권고**)
`required` 이고 계약 예시가 「기타 출고 · 문서 #4412」인데 — `entity_type_registry` 에 **표시명 칸이
없고**(`schema.prisma:3735`), 코드 그룹도 없다(`APPROVAL_TYPE`·`APPROVER_TYPE` 은 **폐기 그룹** —
`seed.ts:1403` · `CD-APPROVAL-TARGET-TYPE` 은 계약 enum 이라 G-32 등재 대상 아님). ⇒ 한국어 라벨을
**서버가 지어내야** 8값이 성립하는데, 하노이는 베트남어 화면이라 되돌리기도 비싸다.
§2: 가장자리 → 2단계 **기준 4** ⇒ **`"{targetTypeCode} #{targetId}"`**(예: `GOODS_ISSUE #4412`)로 내고
021 로 묻는다. ⚠ §2-5 「등록부의 유형 + #{targetId}」는 등록부가 코드만 준다는 점에서 근거 문장이 틀렸다.

---

## 2. `request()`·`assertNoOpenRequest`·`assertApproved` 를 I-2 로 미룸(§3-5) — ✅ **동의 · ✏ 구멍 하나**

요구서 §7:264 「요청 생성은 각 도메인 계약 소관」·§1-2 상신 9경로 전건이 다른 파일 — 재확인했다.
I-1 12건에 요청을 만드는 오퍼레이션은 **0건**이 맞고, 채번을 지역 포맷터로 짓는 쪽이 나쁘다는 데 동의.

⛔ **다만 I-1.md 어디에도 「그럼 e2e 는 승인 요청 행을 어떻게 만드나」가 없다.** PR②·PR④ 의 e2e 11건이
전부 `approval_request` + `approval_step` 행을 전제한다. 채워야 할 것 —
- `approval_request_no` 는 `NOT NULL UNIQUE` 라 **테스트가 번호를 직접 짓는다**. 픽스처 헬퍼
  (`test/support/approval.fixture.ts`)에 `AP-E2E-{seq}` 리터럴로 박고, **주석으로 「채번은 I-2 다 —
  이 리터럴을 서비스로 옮기지 않는다」**를 남긴다(사실상의 채번 구현이 되는 것을 막는다).
- `approval_step` 은 **상신 시점에 전개**되고 결재는 그 행을 UPDATE 한다(계약 J-6 · 물리 실측:
  `decision_code` 만 nullable, `approver_id` 는 NOT NULL). ⇒ 픽스처가 단계 행까지 만든다.
- ⚠ 그래서 PR④ e2e 이름 **`같은 Idempotency-Key 로 두 번 승인해도 approval_step 은 한 행이다`는
  틀렸다** — 행 수는 애초에 안 는다(상신이 만든 행이다). 「**두 번째 승인이 `decision_at`·
  `decision_comment` 를 덮지 않는다**」로 바꾼다.

---

## 3. J-8 후속 통지 = 상태 조회 갈래(§3-4) — ✅ **동의 · ✏ 인덱스 한 줄을 A6 에 얹는다**

콜백 거부 근거 셋에 전부 동의한다(계약 문자 · 도메인 간 호출 금지 · 훅표가 제2 라우팅표가 된다).

⛔ **API 관점의 대가가 하나 빠졌다** — 이 갈래를 고르면 `(targetTypeCode, targetId)` 질의가
**계약이 지정한 유일한 경로**(`GET /app/approval-requests` description)이자 I-2 이후 **모든 `:post` 의
자물쇠 경로**가 된다. 그런데 실측상 `app.approval_request` 에 그 축의 인덱스가 **없다**(PK·`no` UNIQUE뿐).
- 권고: A6 마이그레이션에 `CREATE INDEX ix_approval_request_target ON app.approval_request
  (target_type_code, target_id);` 한 줄을 **같은 선행 커밋에 얹는다**. 추가·비유일이라 두 릴리스 규칙
  미해당이고 되돌림 비용 0.
- `plan.md` §4 A6 행을 「부분 유일 인덱스 **+ 대상 축 인덱스**」로 고친다. ⚠ 이것은 README §1-2
  조건 1(없던 마이그레이션)이 **아니다** — 이미 있는 A6 항목의 같은 표·같은 커밋이다.
- (선택) `assignedToMe` 가 `approval_step.approver_id` 로 걸리는데 PG 는 FK 에 인덱스를 안 만든다.
  1차 데이터량이 작아 **지금은 넣지 않는다**(2단계 기준 3) — I-1.md 에 한 줄만 남긴다.

---

## 4. §6-2 `screenId` 생략 + `openable=false` / §6-3 `approverIsActive=false`

- **§6-2 ✅ 동의**(기준 4·3 이 같은 쪽). ✏ **결과가 배포 노트감이다** — 9값 전건 `openable=false` 면
  **결재함의 「대상 열기」가 전 유형에서 비활성**이다. `plan.md` §6 배포 노트에 한 행(누락).
- **§6-3 ✅ 동의** — 「생길 수 없는 행 · 그래도 `false` 가 사실」이 계약 문장과 맞고, 문의 대상 아님도 옳다.
  ✏ 하나만: `approverName`·`approverDepartmentName` 은 **`required` 가 아니다**(실측) → 비-USER 행에선
  **키 생략**(널 금지 · §5 #7). §2-2 는 「조인」이라고만 적어 이 갈래가 없다.

---

## 5. PR 4개 분할·순서(§7) — ✏ **개수 4는 ✅ · 순서는 ②↔③ 을 바꾼다**

코어를 전용 PR(≤200줄)로 떼는 것은 CLAUDE.md 그대로라 동의한다(`plan.md` §1 의 「3」은 정정 대상).
⛔ **순서가 틀렸다** — PR② 결재함 조회의 `currentStepNo`·`isMyTurn`·`isCurrent` 는 「`step_no` 오름차순
첫 미결 단계」로 PR③ 코어의 `NOT_YOUR_TURN` 판정과 **같은 계산**이다. ②를 먼저 내면 그 계산이 조회에
한 벌·코어에 또 한 벌 생기고, 다음 슬라이스에서 갈라진다.
⇒ **① 결재선 CRUD·단계 치환 → ② 코어(`selectRoute`·현재단계 계산기·`approve`/`reject`·전이표) →
③ 결재함 조회(+e2e) → ④ `:approve`/`:reject`(+e2e)**. 줄 수 합계·건수·커버리지는 그대로다.
⚠ 이 순서면 ②(코어)가 ①의 마이그레이션에 의존하지 않아 **①과 병렬**로도 선다.

**PR① 에 추가로 박아야 할 것 두 가지** —
1. **`POST /app/approval-routes` 는 이 저장소 최초의 「201 + ETag」다**(실측: 계약이 201 에 ETag 를
   선언한 자리는 mdm 전체에서 `putaway-rules` 와 여기뿐이고 구현 선례가 없다). `runIdempotent` 는
   **재전송 시 저장된 body 를 그대로 돌려준다**(`idempotency.service.ts:84`). ⇒ `work()` 가
   `{ versionNo, route }` 를 돌려주고 컨트롤러가 `setEtag(res, result.versionNo)` 후 `route` 만 응답해야
   **재전송에도 ETag 가 나간다**(`runVersioned` 와 같은 모양). 밖에서 계산하면 재전송 응답에 ETag 가 빈다.
   e2e 이름: `결재선 — 같은 Idempotency-Key 재전송도 같은 ETag 를 준다`.
2. **중복 활성 400 의 `code` 가 I-1.md 어디에도 없다.** 새로 지을 필요 없다 — `ERROR_CODE.UNIQUE_VIOLATION`
   이 이미 있다(실측). POST·`:activate` 둘 다 이것으로 낸다. §1-5 표에 행을 더하고 e2e 가 코드를 단언한다.

---

## 6. `plan-api.md` ↔ `I-1.md` 어긋남 중 **구현에 영향 주는 것**

| # | 자리 | 어긋남 | 판정 |
|:-:|---|---|---|
| 1 | `PUT …/steps` 의 ETag(§5-3) | I-1: 「`runVersioned` 금지 — 계약이 헤더를 선언 안 했다」. **실측 선례는 반대다** — `PUT /mdm/items/{itemId}/bu-item-maps` 등 **자식 치환 6자리**가 계약에 ETag 가 없는데도 `runVersioned` 로 부모 버전을 올리고 ETag 를 내린다(`item-detail.controller.ts:113` · `withBumpedItem`) | ✏ **선례를 따른다(§2 0단계 — 판단 아님)**. 부모 버전을 올리는 것은 I-1 결론과 같고, ETag 를 함께 내려야 **연속 저장이 409 로 막히지 않는다**(안 내리면 화면이 매번 부모 GET 을 다시 해야 한다). 계약이 이 헤더를 선언 안 한 것은 **문의가 아니라 「알려만 두는 것」**으로 요청서 말미에 적는다. ⇒ e2e `PUT …/steps 는 ETag 를 내리지 않는다` 를 **`…부모 version_no 를 올리고 새 ETag 를 준다`** 로 바꾼다 |
| 2 | 빈 배열 400 의 코드(§1-5) | I-1: 「`LINE_REQUIRED` 가 빈 배열·`:activate` 단계 0 을 함께 덮는다」. 실측: `steps.minItems:1` 은 **계약 검증 가드**가 먼저 잡고 `minItems → RANGE` 로 매핑된다(`validation-error.mapper.ts:12·26`) — 서비스까지 오지 않는다 | ✏ **가른다**. 빈 배열 = `RANGE`(가드), `:activate` 단계 0 = `LINE_REQUIRED`(서비스). e2e 두 건이 각각 다른 코드를 단언해야 한다 |
| 3 | 403 등록 4건(§5-1) | `plan-api.md` §5.3 ① 과 **일치**. ⚠ 다만 「도출표와 겹치면 검사가 막는다」는 부정확하다 — spec 이 막는 것은 **같은 키에 같은 «권한»**이고 같은 키 자체는 허용된다(`operation-permissions.spec.ts` 넷째 it) | ✅(문구만) |
| 4 | 코어 시그니처가 `tx` 를 받는데 누가 여느냐(§3-1) | `runIdempotent` 는 **자기 트랜잭션의 `tx` 를 work 에 넘기지 않는다**(`master-write.ts:31`) | ✏ I-1.md 에 한 줄: **컨트롤러→서비스가 `prisma.$transaction` 을 열고 코어에 `tx` 를 넘긴다.** 코어가 `tx` 를 받는 이유는 I-2 상신이 «자기 트랜잭션 안»에서 부르기 때문이다 |
| 5 | `:approve`/`:reject` 의 403 (§5-1) | 데이터 축 403 을 **상세 조회에만** 적었다 | ✏ 결재선에 아예 없는 사용자는 `:approve` 도 **403**(상세와 같은 규칙), 단계에 있으나 차례가 아니면 **400 `NOT_YOUR_TURN`** — 두 갈래를 e2e 이름에 박는다 |
| 6 | `GET /app/approval-routes` 의 `q`(「승인 유형 검색」) | 검색할 «이름»이 물리에도 코드 그룹에도 없다(§1 021 과 같은 뿌리) — 코드 문자열 부분일치만 가능 | ✏ 구현은 `approval_type_code ILIKE` 로 두고 **021 요청서에 각주**. 별건 문의로 세우지 않는다 |

⛔ **반대할 자리는 없다** — §0 「차이가 크다=셋째만」·A6 하나·`status_code` 3값·새 에러 코드 0건
(`UNIQUE_VIOLATION` 은 기존 값)·커버리지 250/487 은 전부 실측과 맞는다.

---

## 재수립 결과 — 5줄 요약

1. **I-1.md 수정 8건** — ① 020 재작성(대응표는 이미 있다: A-10 · 계약 주석 `target_id=lot_id`)
   ② 018 물음을 「I-2 에서 칸을 더할까」로 ③ e2e 승인요청 픽스처 규약(+PR④ 테스트 이름 정정)
   ④ PR 순서 ②↔③ ⑤ `PUT …/steps` 는 선례대로 `runVersioned`(부모 bump + ETag) ⑥ 빈 배열=`RANGE` /
   `:activate` 단계0=`LINE_REQUIRED` ⑦ 중복 활성 400=`UNIQUE_VIOLATION` · 201+ETag 재전송 규약
   ⑧ `displayName` 근거 정정 + 비-USER 표시명 키 생략.
2. **`plan.md` 반영** — §7 에 I-1 **3행**(018·019·021) · §1 PR 열 3→4 · §4 A6 에 「+`ix_approval_request_target`」
   · §6 배포 노트 「결재함 「대상 열기」 전 유형 비활성」.
3. **문의 최종 3건**(수는 같고 구성이 바뀐다): **018**(물음 교체) · **019**(유지·보강) · **021**(신설).
   ⛔ **020 은 내린다** — 전제가 계약 안에서 답이 난다. 잔여물(등록부 유일 제약·닫힌 `#74`)은 019 각주로.
4. **마이그레이션은 A6 한 항목 그대로**(부분 유일 인덱스 + 대상 축 인덱스, 같은 선행 커밋) —
   README §1-2 조건 1·2 는 안 걸린다. 순서·마일스톤·코어 시점 손댈 것 없음.
5. **결론**: 계약 실측은 정확하고 §2 적용도 대체로 옳다. 고칠 핵심은 셋 — 020 의 전제 오류,
   코어 PR 이 조회 PR 뒤에 선 순서, 자식 치환 PUT 의 **기존 선례를 못 본 것**.
