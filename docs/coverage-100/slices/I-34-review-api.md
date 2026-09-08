# I-34 독립 리뷰 — **API 설계** 관점

> 대상: `.backend-dev/lane-a2/I-34-draft.md` 461줄 전문 · 브리프: `.backend-dev/lane-a2/brief-I-34-review.md`
> 계약 사본 `contracts/COMMIT.txt` = **a6a87e144116ebaa32c01df5a12a0fd2924427e7** — 읽기 전용 · 직접 파싱(python `json.load`)
> ⛔ `-review-uiux.md`·`-review-integration.md` 는 **열지 않았다**. 워크트리 밖 경로 접근 0 · 수정 0 · DB 쓰기 0 · `git`/`gh` 쓰기 0 · `pnpm exec` 0 · 게이트 재실행 0.
> 판정 항목은 브리프 §1(= 초안 §0 다섯)을 **그대로** 썼다. 손으로 다시 세우지 않았다.

---

## ① 무엇을 직접 읽었나

### 계약 (파싱 · 인용 대조)

| 확인 | 결과 | 자리 |
|---|---|---|
| `GET /app/attachments` 전문 | 파라미터 **`targetTypeCode`·`targetId` 둘뿐** · **둘 다 `required` 없음** · 선언 응답 **`200` 하나** · 200 스키마 인라인 객체 `required:["items"]` · `items: Attachment[]` · **`PageMeta`·`page`·`size` 0** | `app-공통.json:3269-3324` |
| `Attachment` | required **7**(`attachmentId`·`targetTypeCode`·`targetId`·`fileName`·`contentType`·`byteSize`·`uploadedAt`) · 프로퍼티 **8** · `uploadedBy` = `["integer","null"]` required 밖 · **`storageKey` 없음** · `additionalProperties` 없음 | `:5871-5940` |
| `Attachment.targetTypeCode` | `enum:["WAREHOUSE","NOTICE"]` · `x-code-key: CD-ATTACHMENT-TARGET-TYPE` · **응답 쪽에도 enum 이 걸려 있다** | `:5875~` |
| `GET /app/document-issues` | 오퍼레이션 `description` **과** `targetTypeCode` `description` 둘 다 짝을 요구 · **「하나만 주면 400 이다」** · 응답 **200·400** · `page`(기본 1)·`size`(기본 50 · 최대 200) | `:1052`·**`:1099`** |
| `GET /app/approval-requests` | `targetTypeCode` description = 「업무 화면이 자기 문서의 승인 상태를 찾을 때 **targetId 와 함께 쓴다**」 · 400 **미선언**(응답 200·**403**) · ⭐ **`page`(기본 1)·`size`(기본 50) 를 «갖는다»** | `:612~` |
| `POST /app/attachments` | `multipart/form-data` · `requestBody.required:true` · required 3(`targetTypeCode`·`targetId`·**`file` binary**) · 응답 **201·400·403·413** · `IdempotencyKey` | `:3179-3268` |
| `GET /app/attachments/{attachmentId}/content` | 200 content **셋**(`application/octet-stream`·`image/png`·`image/jpeg`) · 스키마 `string/binary` · 404 · `x-internal-note` 「application/json 이 아닌 **두 번째** 응답 … 첫째는 출력물 rendition」 | `:3325-3390` |
| `POST /maintenance/breakdowns/{id}/attachments` | `multipart/form-data` · required `file` · 「**최대 세 장**」 · 응답 201·400·403·404·422 · `IdempotencyKey`+`WorkerNo` | `equipment-05:624~` |
| `BreakdownAttachment` | required **2** = `attachmentId`·**`storageKey`** · 프로퍼티 **4**(+`mimeType`·`uploadedAt`) | `equipment-05:3278` |
| **전수** — 7개 계약의 `413` 선언 | **1건뿐** — `POST /app/attachments` | (전 파일 파싱) |
| **전수** — `multipart/form-data` | **4건** — `molds:import`·`spare-parts:import`·`breakdowns/{id}/attachments`·`POST /app/attachments` | 〃 |
| **전수** — `application/json` 아닌 응답 | **2 오퍼레이션뿐** — `attachments/{id}/content` · `document-issues/{id}/rendition` | 〃 |
| **전수** — 상한이 «하나도» 없는 목록 GET(required 0 · 경로 축 0 · page 0) | **5건** — `/app/attachments` · `/app/notification-events` · `/app/notification-subscriptions` · `/maintenance/collection-channels/observations` · ⭐ **`/mdm/judgment-type-controls`(이미 구현됨)** | 〃 |

계약 인용 **행 번호 전건 확인**: `:3178`=`"/app/attachments"` · `:3179`=`"post"` · `:3269`=`"get"` · `:3277`=`targetTypeCode` · `:3300`=`responses` · `:3325`=content 경로 · `:5871`=`Attachment` · `:1099`=「하나만 주면 400」 · `equipment:624`·`equipment:3278`. **전부 맞다.**

### 코드·물리

`src/app/approval/approval-request.service.ts:145-151`(독립 필터 두 줄 실측) · `src/common/permissions/permission.guard.ts:10-24·33-40·47-53·68-72`(`declaresForbidden`) · `src/common/permissions/operation-permissions.spec.ts` 전문 · `src/common/permissions/derived-permissions.ts:19·146·190` · `src/common/contract/contract-validator.ts:107-127·134-142·196-215` · `src/common/contract/contract-validation.guard.ts` 전문 · `src/common/contract/validation-error.mapper.ts` 전문 · `src/common/pagination/pagination.ts:13` · `src/app/notification/notification-query.service.ts:40-44` · `src/app/notice/notice.service.ts:136-140` · `src/quality/lot-hold/lot-hold-query.service.ts:43-47` · `src/trace/serial-number/serial-number-query.service.ts:45-49` · `src/trace/lot/lot-status-event.service.ts:29-36` · `src/mdm/mold/mold.controller.ts:122-148` · `src/mdm/partner/judgment-type-control.service.ts:35-60` · `src/common/http/omit-empty.ts:1-6` · `prisma/schema.prisma:168-183` · `prisma/migrations/20260727000000_baseline_physical_model_v3/migration.sql:2630-2641` · `test/app-notice.e2e-spec.ts:1-70` · `test/trace-lot-status-event.e2e-spec.ts:60-95·195-240` · `docs/coverage-100/README.md:38-95` · `docs/coverage-100/plan.md:147-200` · `docs/coverage-100/plan-api.md:314-333·710-718`.

전수 스캔 둘: **@Contract 바인딩 391키** 추출 후 형제 구현 여부 대조 · **`findMany({…})` 중 `take` 없는 호출 184건** 식별.

---

## ② §0 다섯 자리 판정

| # | 자리 | 초안 판정 | **내 판정** |
|:-:|---|---|---|
| **1** | 짝 강제 여부 | 독립 필터 둘 · 400 없음 | ✅ **PASS**(결론) · 근거 문장 **2건 수정 필요**(M-10 · m-9) |
| **2** | 질의 0개의 상한 | 전건 · 상한 0 | ⚠ **조건부 PASS** — 결론은 계약 문자대로 맞다. **근거 둘이 모두 어긋나고**(M-4) **이 갈래를 지켜본다는 e2e 가 실제로 못 지켜본다**(M-1) |
| **3** | 정렬 축 | `uploaded_at desc, attachment_id desc` | ✅ **PASS**(결론) · **픽스처가 물리 기본값에 무력화된다**(M-2) |
| **4** | 인덱스 마이그 | 세우지 않는다 — 마이그 0 | ✅ **PASS**(API 관점) — 계약이 필터 축을 required 로 요구하지 않는다. 베이스라인 DDL 2630-2641 에 `CREATE INDEX` 0 · 마이그 grep 3줄 전부 베이스라인 ⇒ 「PK 하나뿐」과 **정합** |
| **5** | 파일 배치·공용 등록부 | `src/app/attachment/` 신설 + module +4 | ⬜ **미판정** — 내 관점 밖(통합·구조). 계약 쪽에서 뒤집을 근거 **0**. 실측 확인만: `src/app/` = 디렉터리 5 + `app-domain.module.ts` 1 |

### 자리 1 — 왜 PASS 인가 (계약 문자 직접 대조)

셋의 계약 문자는 **정확히 이렇다**:

| | 짝을 말하는 문장 | 400 선언 | 403 선언 | page·size | 구현 |
|---|---|:-:|:-:|:-:|:-:|
| `GET /app/document-issues` | **「targetId 와 함께 준다. 하나만 주면 400 이다」**(`:1099`) + 오퍼레이션 description 에도 「함께 준다 — targetId 만으로는 유형이 갈리지 않는다」 | **✓** | ✕ | ✓ | **✕ 미구현** |
| `GET /app/approval-requests` | 「… targetId 와 **함께 쓴다**」(권유) | ✕ | **✓** | **✓** | **✓ 구현** |
| `GET /app/attachments` | ⭐ **한 글자도 없다** | ✕ | ✕ | ✕ | (이번) |

⇒ 400 을 강제할 계약 근거는 **`document-issues` 에만** 있고, 그 문장은 그 오퍼레이션의 `targetTypeCode` description 과 오퍼레이션 description **두 곳에** 적혀 있다. `attachments` 에는 그 문장이 **두 자리 모두 없다** — 즉 이 오퍼레이션은 `approval-requests` 보다도 **더 느슨하다**(짝을 «권하는» 문장조차 없다). 초안의 결론(독립 필터 둘)은 **계약 문자로 선다.**
⛔ 초안이 만드는 400 은 **0건이 맞다** — 서비스에 짝 검사 분기가 없다. e2e #8·#9 의 400 은 서비스가 아니라 `ContractValidationGuard`(`contract-validation.guard.ts:40-42`)가 내는 형식 400 으로, **계약 전건에 걸리는 프레임워크 동작**이다(선례: `/trace/lot-status-events` 는 200 만 선언하는데 `test/trace-lot-status-event.e2e-spec.ts:81-88` 이 enum 밖 값에 400 을 단언한다). 다만 초안의 «문장»이 이 구분을 안 해서 자기모순으로 읽힌다 → **m-10**.

### 자리 2 — 왜 조건부인가

계약 실측은 초안이 맞다: `PageMeta` 없음 · `page`·`size` 없음 · required 질의 0 · 200 하나. **전건을 내는 것 말고 계약이 허용하는 다른 답이 없다.**
그런데 초안이 댄 **근거 둘이 다 어긋나고**(M-4), 그 결론을 지켜본다는 **e2e #6 이 실제로는 아무것도 안 지켜본다**(M-1). 결론이 맞아도 **되돌려도 초록**이면 I-18 이 세 번 잡힌 그 모양이다.

---

## ③ Findings — **Blocker 0 · Major 5 · Minor 5 · Nit 5**

### 🔴 Major

**M-1. e2e #6 이 「상한 0」(자리 2 · 스스로 «본길»이라 부른 자리)을 반증하지 못한다. §6-3 변이 여섯에 「상한 추가」가 아예 없다.**
§6-1 픽스처는 **7행**이고 #6 은 「7건 전건」을 단언한다. 이 저장소의 페이지 기본값은 **`DEFAULT_SIZE = 50`**(`src/common/pagination/pagination.ts:13`).
**실패 예** — 구현자가 §5-2 지시대로 형제 목록을 복제하다가 `src/app/notice/notice.service.ts:138-140` 의 `orderBy` 아래 두 줄(`skip: page.skip, take: page.take`)을 함께 가져온다 → `GET /app/attachments` 가 **51번째 행부터 조용히 자른다** → e2e **11건 전부 초록**(7 ≤ 50) · 단위 5건도 초록(`buildAttachmentWhere`·`ATTACHMENT_ORDER_BY` 는 안 바뀐다) · §6-3 변이 여섯에도 이 변이가 **없다** → 화면은 잘린 목록을 「전부」로 읽는다. 초안이 §0 자리 2 에서 「`take: N` 을 넣으면 화면은 「전부」로 읽고 잘린 것을 모른다」고 **정확히 예언한 그 결과**가, 그 예언을 막겠다는 테스트를 통과한 채 일어난다.
**처방** — ⓐ §5-2 가 이미 `buildAttachmentWhere`·`ATTACHMENT_ORDER_BY` 를 내보내니 **조회 인자 전체**(`ATTACHMENT_FIND_ARGS` 류)를 내보내고, 단위 spec 에 「`take`·`skip` **키가 없다**」를 단언(§6-2 를 5 → 6). ⓑ §6-3 에 변이 ⑦ **「`take: 50` 추가」 → 그 단위 단언이 빨개진다** 를 넣는다. ⛔ 픽스처를 51행으로 늘리는 것은 답이 아니다(다음 사람이 `take: 200` 을 넣으면 또 초록).

**M-2. e2e #2 의 동률 픽스처가 물리 기본값 `clock_timestamp()` 에 지워진다 — 2차 키(자리 3)를 지워도 초록이 된다.**
`app.attachment.uploaded_at` 은 **`timestamptz NOT NULL DEFAULT clock_timestamp()`**(`migration.sql:2640` · `schema.prisma:179`). `clock_timestamp()` 는 `now()` 와 달리 **같은 문(statement) 안에서도 행마다 다른 값**을 낸다. §6-1 의 「⛔ 픽스처가 지켜야 하는 물리 제약 **셋**」(`storage_key` NOT NULL · `uploaded_by` NOT NULL FK · `file_size` CHECK≥0)에 **이 기본값이 없다.**
**실패 예** — 구현자가 `prisma.attachment.createMany` 에서 F·G 의 `uploaded_at` 을 생략한다(제약 목록에 없으니 생략해도 된다고 읽는다) → 두 행의 시각이 마이크로초 단위로 갈린다 → **동률이 사라진다** → 정렬을 `[{uploaded_at:'desc'}]` 로 줄여(2차 키 삭제 = §6-3 변이 ④) 돌려도 #2 가 **초록** → 초안이 ⛔ 로 못 박은 「**이 픽스처가 없으면 2차 키는 지워도 초록이다**」가 그대로 실현된다.
**처방** — 제약 목록에 **넷째**로 「`uploaded_at` 은 DB 기본값이 `clock_timestamp()` 다 ⇒ **7행 전부 리터럴을 명시**하고, F·G 는 «같은» 리터럴을 쓴다」를 넣는다.

**M-3. §4 P1 의 「⛔ `manual-permissions.ts` 에 줄을 더하면 빨개진다」는 사실이 아니다 — 아무 단언도 그 갈래를 안 본다.**
`PermissionGuard.canActivate` 는 `declaresForbidden(key)`(`permission.guard.ts:68-72` — 계약 responses 에 `'403'` 이 있는가)가 거짓이면 **`OPERATION_PERMISSIONS` 를 아예 읽지 않고 통과**한다(`:40`). `GET /app/attachments` 는 403 미선언이다. 그리고 `operation-permissions.spec.ts` 의 5건 중 **「403 미선언인데 표에 등재됐다」를 막는 것은 하나도 없다** — 실제로 `derived-permissions.ts:19` 의 `GET /app/attachments/{attachmentId}/content` 가 **403 미선언인데 이미 등재돼 있고 아무도 안 잡는다**(초안 §1-1 「덤」이 그 사실을 적어 놓고도 P1 의 판정에 반영하지 않았다).
**실패 예** — 구현자가 `manual-permissions.ts` 에 `'GET /app/attachments': ['W-CO-08']` 을 더한다 → `operation-permissions.spec.ts` 5건 전부 초록(키가 계약에 실재 · 코드가 117 안 · 비어 있지 않음 · 도출표와 안 겹침) → 가드는 표를 안 봄 → e2e **#11(권한 0 세션 200)도 초록** → 죽은 줄이 영구히 남는데 §4 에는 「단언이 지켜본다」고 적혀 있다.
**처방** — P1 의 오른쪽 칸을 사실대로 고친다: 「**#11 은 컨트롤러에 `@UseGuards`/수동 403 을 넣는 변이만 잡는다. 권한표 등재는 어떤 단언도 안 잡는다** — 그래서 「0줄」은 테스트가 아니라 **규칙**이다(`permission.guard.ts:68-72`)」. ⛔ 이 자리를 위해 새 테스트를 만들 필요는 없다(등재해도 런타임 동작이 안 바뀐다 — 죽은 줄일 뿐이다). 고칠 것은 **문장**이다.

**M-4. 자리 2 의 근거 둘이 «모두» 어긋난다 — 하나는 거짓 실측, 하나는 오인용.(결론은 유지)**
ⓐ **거짓** — §0-재수립 「다른 점 1」의 「⭐ **상한이 하나도 없는 목록 GET 은 이 저장소에 처음이다**」. 전수 대조 결과 **`GET /mdm/judgment-type-controls`** 가 이미 있다: 계약에 **파라미터가 0개** · 응답 `{items}` `required:["items"]` · `PageMeta` 0 (`mdm-기준정보.json`), 그리고 **이미 구현돼 있으며**(`@Contract` 바인딩 실재) 구현이 **`take` 없이 전건을 낸다**(`src/mdm/partner/judgment-type-control.service.ts:43-49`). README §2 **0단계**는 선례에 「**이미 구현된 다른 전표**」를 명시한다(`README.md:40`) ⇒ **0단계에서 닫히는 자리를 2단계까지 끌고 갔다.**
ⓑ **오인용** — `plan.md` §5 **규칙 10** 의 실제 문장은 「**집계는 서버가** — 목록을 접지 않는다(L-1·L-2). `UNDETERMINABLE` 을 0/정상으로 접지 않는다」(`plan.md:158`)다. 병렬절이 「`UNDETERMINABLE` 을 0 으로 접지 않는다」인 데서 보이듯 **「접다」 = 「요약으로 접다」**이지 **「잘라내다」가 아니다.** 페이지네이션 상한의 근거가 아니다.
**실패 예** — 같은 질문은 곧 다시 열린다: `GET /app/notification-events`·`GET /app/notification-subscriptions` 도 **계약에 `page`·`size` 가 0**이고 미구현이다. 그 슬라이스가 이 계획안을 인용하면 「전례 없음 → 2단계 기준 4」를 **또** 밟고, 통보 155 를 받은 설계팀이 인용된 규칙 10 을 열어 보면 관계없는 규칙이 근거로 걸려 있다 ⇒ 통보 전체의 신뢰가 깎인다.
**처방** — ⓐ 를 「**0단계 선례: `GET /mdm/judgment-type-controls`** — 계약이 상한을 안 주면 전건을 낸다는 답이 이미 구현돼 있다(`judgment-type-control.service.ts:43-49`)」로 바꾸고, ⓑ 를 지운다(또는 §5 규칙 7·기준 4 만 남긴다). §0-재수립의 「처음이다」는 「**이 저장소에 선례가 하나 있고, 그 선례는 코드 값 마스터라 도메인상 유한한 반면 첨부는 무한 증가하는 업무 표다**」로 고쳐 적으면 재수립 근거는 오히려 더 단단해진다.

**M-5. §3-1 증거표의 둘째 행이 건너뜀 사유가 아니다 — 같은 저장소에 반증이 이미 구현돼 있다.**
초안이 든 「계약 검증기가 그 본문을 **볼 수 없다**」(`contract-validator.ts:139`)는 **검증 공백**이지 **구현 불가**가 아니다. 실제로 **`POST /mdm/molds:import` 가 multipart 파일 업로드로 이미 구현돼 있다** — `@Contract('POST /mdm/molds:import')` + `@UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD_BYTES } }))` + 검증기가 안 보는 만큼 `if (file === undefined)` 로 **손수 400** 을 낸다(`src/mdm/mold/mold.controller.ts:139-148`).
**실패 예** — 통보 156 을 받은 설계팀이 「몰드 엑셀도 `multipart` 인데 그건 올렸다. 첨부만 왜 못 하나」라고 되물으면 **계획안에 답이 준비돼 있지 않다** — 루틴 끝 보고에 실리는 산출물에서 가장 나쁜 자리다.
**⭐ 그런데 그 답이 이미 같은 파일에 문장으로 있다**: 「엑셀 대장 올리기. 전 계약에서 처음 두는 파일 올리기 경로다 — **첨부와 «다른 자리»다(첨부는 «보관되는» 파일이고 이것은 «읽고 버리는» 입력이다 · 계약 x-internal-note)**」(`mold.controller.ts:136-137`).
**처방** — 둘째 행을 **삭제**하고 그 자리에 `mold.controller.ts:136-137` 을 「**보관 vs 읽고 버림**」 근거로 넣는다. 나머지 네 행(바이너리 칸 0 · `storage_key varchar(500) NOT NULL` · `checksum_sha256` · 413)만으로도 결론은 선다 — **결론은 안 바뀐다. 바뀌는 것은 반박 가능성이다.**

### 🟡 Minor

**m-6. e2e #4 의 기대 배열이 계획안 자신의 정렬 규칙·픽스처와 어긋난다.**
§6-1 #4 는 `?targetTypeCode=WAREHOUSE` **만** 의 기대를 `[D,B,A,…]` 로 적었다. 픽스처의 WAREHOUSE 행은 A(1001,T1)·B(1001,T3)·D(2002,T4)·F(3003,**T6**)·G(3003,**T6**)이고 정렬은 `uploaded_at desc` ⇒ 정답은 **`[G, F, D, B, A]`** 다. D 가 맨 앞일 수 없다.
**실패 예** — 그대로 옮겨 적으면 **올바른 구현에서 #4 가 빨개진다** → 구현자가 정렬(자리 3)을 의심해 손대기 시작한다.

**m-7. 픽스처가 `createMany` 인데 단언이 「배열 통째 **id**」다 — id 를 얻을 길이 없다.**
Prisma 의 `createMany` 는 **`{ count }` 만** 돌려준다. §6-1 의 #1·#2·#3·#5 는 `[B.id, A.id]` 처럼 **행 id** 를 쓴다. 복제 원본인 I-18 은 이 문제를 **id 가 아니라 `reason` 마커 문자열로 단언**해 피했다(`test/trace-lot-status-event.e2e-spec.ts:210-235` → `items.map(i => i.reason)`).
**처방** — `file_name` 을 마커(`A.png`…`G.png`)로 삼아 **`items.map(i => i.fileName)` 통째 단언**으로 바꾼다(부수 효과: #10 의 V2 `fileName` 대조와 합쳐진다). `createManyAndReturn` 도 가능하나 이 저장소는 이미 「⛔ **반환 «순서»에 기대지 마라**」를 못 박아 두었다(`src/planning/production-plan/expand.ts:41`).

**m-8. 자리 2 의 계약 대조가 절반이다 — `page`·`size` 를 갖는 형제는 «둘»이다.**
초안은 §0 자리 2·§1-2·「알려둘 것」ⓐ 에서 일관되게 「형제 `document-issues` 는 갖는데 **이쪽만** 없다」로 적었다. 실측: **`GET /app/approval-requests` 도 `page`(기본 1)·`size`(기본 50)를 갖는다** — 초안이 자리 1 의 **0단계 선례로 삼은 바로 그 오퍼레이션**이다. 정확한 문장은 「**같은 다형 쌍을 쓰는 형제 셋 중 `attachments` «만» 상한이 없다**」.
**왜 중요한가** — 통보 155 ⓑ 를 읽는 설계팀이 「의도인가 누락인가」를 판단하는 데 이 한 줄이 결정적이다. 형제가 하나만 갖는 것과 **둘 다 갖는 것**은 다른 신호다.

**m-9. 자리 1 의 「동형」이 두 축에서만 참이다 — 그 좁힘을 본문이 안 적었다.**
`approval-requests` 는 **403 을 선언**하고 `page`·`size` 를 갖는다. `attachments` 는 둘 다 없다. 초안의 괄호(「400 미선언 · 짝 강제 문장 없음」)로 좁히면 참이지만, 리뷰·설계팀이 「동형이 아니다」로 되받을 여지를 남긴다.
**처방** — 「**두 축에서 동형이다**(400 미선언 · 짝을 «강제하는» 문장 없음). 나머지는 오히려 `attachments` 가 더 느슨하다 — `approval-requests` 에는 짝을 «권하는» 문장이라도 있는데 `attachments` 에는 **한 글자도 없다**」로 적으면 결론이 더 강해진다.

**m-10. 「계약이 선언하지 않은 400 을 우리가 만든다」가 자기 e2e #8·#9 와 충돌한다.**
`GET /app/attachments` 는 400 을 **선언하지 않았는데** #8(`?targetTypeCode=BREAKDOWN`)·#9(`?targetId=abc`)는 400 을 기대한다. 그 400 은 `ContractValidationGuard`(`contract-validation.guard.ts:40-42`)가 계약 **전건**에 대해 내는 형식 400 이고, 같은 모양의 선례가 있다 — `/trace/lot-status-events` 는 **200 만** 선언하는데 `test/trace-lot-status-event.e2e-spec.ts:81-88` 이 enum 밖 값에 400 을 단언한다.
**실패 예** — 리뷰어·구현자가 문장을 그대로 읽으면 「그럼 #8·#9 도 계약 위반 아닌가」로 막히거나, 반대로 「가드도 400 을 내니 짝 강제 400 도 괜찮다」로 뒤집는다.
**처방** — 「**서비스가 «업무 규칙»으로 400 을 만들지 않는다** — 가드가 내는 형식 400(타입·enum)은 계약 전건에 걸리는 프레임워크 동작이라 별개다(선례 `trace-lot-status-event.e2e-spec.ts:81-88`)」로 한 줄 고친다.

### ⚪ Nit

**n-11.** §3-1 의 「413 은 이 계약에서 **몇 안 되는** 자리다」 → 전수 파싱 결과 **7개 계약 전체에서 유일한 1건**이다. 근거를 실제보다 약하게 적었다. 「**전 계약에서 413 을 선언한 유일한 오퍼레이션이다**」로 강화할 수 있다.

**n-12.** 통보 156 ⓒ 보강 — 두 계약이 어긋나는 칸이 `storageKey` 하나가 아니다. **같은 물리 `mime_type` 을 app 은 `contentType`, equipment 는 `mimeType` 으로 부른다**(`BreakdownAttachment` 프로퍼티 4 = `attachmentId`·`storageKey`·`mimeType`·`uploadedAt`). 「반대로 읽는다」가 한 칸이 아니라 두 칸이다.

**n-13.** §1-4·통보 156 ⓑ 의 「**값은 우리가 고르지 않는다**」에 계약 문자 근거가 빠졌다. 계약이 스스로 적어 두었다 — 「⛔ 다형 참조 판별자라 값이 «우리 계약의 대상 표 이름»이다 — 고객이 늘릴 수 없고, **붙일 곳이 늘면 계약을 고친다**(공유계약 A-10 · A-16)」. 이 문장이 **세 자리(GET 질의 · POST 본문 · `Attachment` 스키마) 전부에** 있다. 통보 156 ⓑ 의 가장 강한 한 줄이다.

**n-14.** §1-3 이 **응답 쪽** `Attachment.targetTypeCode` 에도 `enum:["WAREHOUSE","NOTICE"]` 가 걸려 있다는 것을 적지 않았다(질의 축에만 적었다). 오늘 writer 0 이라 위험 0 이지만, DB 에 enum 밖 값이 들어오면 **응답이** 계약을 어긴다 — e2e #10 의 ajv 가 그때 잡는다(요청 가드는 응답을 안 본다).

**n-15.** 인용 오차 1행 — `model attachment` 는 `prisma/schema.prisma` **169~183행**이다(초안 `:170-184`). 내용은 정확. 그 밖의 계약·코드 인용은 **전건 정확**했다(위 ① 표).

---

## ④ 미수행

- **게이트 재실행 0**(브리프 §5) — `jest`·`tsc`·`eslint`·`contract-coverage` 미실행. ⇒ **커버리지 401 → 402/487 은 검증하지 않았다.**
- **DB 관측 0** — `psql` 안 돌렸다. §11 부록의 DB 실측값(마이그 64건 · `app.attachment` 0행 · `code_group %ATTACH%` 0행 · `pg_indexes` PK 하나)은 **재측정하지 않았다.** 단 「인덱스가 PK 하나뿐」은 베이스라인 DDL(`migration.sql:2630-2641`)에 `CREATE INDEX` 가 없고 `grep -rn attachment prisma/migrations/` 가 **3줄(2479 주석·2630·2631)** 뿐이라는 것으로 **정합만** 확인했다.
- **자리 5(파일 배치·공용 등록부)** — 내 관점 밖. 계약 쪽 반증 근거가 0이라 뒤집지 않았고, `src/app/` 구성만 실측했다.
- **UI/UX·통합 항목 전부 미판정** — 화면 정본 · `plan-uiux.md` · `lanes.md` · `plan-integration.md` §I-34 · 이슈 #335 · `assignment.tsv` · `lane-B.md` · `slices/I-30.md` 는 **열지 않았다**(`plan.md`·`plan-api.md`·`README.md` 는 초안이 §0·§3·§7 의 근거로 «인용»한 자리라 그 인용 대조 목적으로만 열었다).
- ⛔ `-review-uiux.md`·`-review-integration.md` **미열람**.
- 참고(판정 아님) — `plan-api.md:714` 는 `POST /maintenance/breakdowns/{id}/attachments` 를 **S23** 소유로 적었고 `plan.md` §6 은 **I-34** 로 적었다. 소유 배정은 통합 관점의 몫이라 판정하지 않았다.

---

## ⑤ 한 줄 결론

**다섯 자리의 «판정»은 계약 문자로 전부 선다(자리 5 는 미판정) — 그러나 자리 2 의 «근거» 둘이 다 어긋나고(0단계 선례 실재 · 규칙 10 오인용), 자리 2·3 을 지켜본다는 e2e 둘과 §4 P1 의 단언이 «되돌려도 초록»이라, I-18 이 세 번 잡힌 바로 그 모양이 계획 단계에 그대로 남아 있다 — Blocker 0 · Major 5 · Minor 5 · Nit 5, 다섯 Major 를 반영하면 PR 1 · 비테스트 ~111 은 그대로 두고 단위 spec 1건(+`take`·`skip` 부재 단언)·픽스처 제약 1줄·문장 셋만 고치면 된다.**
