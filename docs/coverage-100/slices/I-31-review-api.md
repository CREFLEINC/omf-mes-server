# I-31 독립 API 관점 재수립

대상: `.backend-dev/lane-b/I-31-draft.md` 753줄 전부. 독립 새 컨텍스트이며 다른 I-31 관점 보고서는 읽지 않았다. 브리프의 main `6bde921`·공식352/487·#306 계획 병합을 전달 기준으로 사용하며 coverage 재측정0이다. 계약 권위는 `contracts/COMMIT.txt`의 `a6a87e144116ebaa32c01df5a12a0fd2924427e7`뿐이다.

결론: **Blocker 0 / Major 1 / Minor 3 / Trivial 0**. 정상 미마감 POST/PUT와 GET4·발행·취소는 계속 진행할 수 있다. `closed=true` 거부는 지지한다. 다만 날짜 갱신을 뺀 `resetCounter=true` 성공안은 수정이 필요하다. 아래는 계획 판정이며 구현·검증 PASS 또는 PR 머지 판정이 아니다.

## 다섯 축 verdict

| 축 | API 독립 판정 |
| --- | --- |
| 1. ⭐ 실적 마감의 의미와 정상 성공 경계 | **지지.** 계약 :1356의 closed=true 조건과 :3888의 고객 확장 결과값 사이에 terminal 매핑이 없다. 미마감 lines 생략/[]·유효 확장코드 기록, O8 선택 필드 편집은 정상 본길이다. 상태/완료 집계 의미를 지어내지 않고 마감 분기만422로 거부한다. 화면의 완료 인수는 별도 미완이다. |
| 2. ⭐ A16~19 밖의 물리 결손과 구행 | **지지.** trigger1:N·count bigint, 결과 NN6 완화, worker/app_user 분리, FK쌍과 allNULL 구행 보존은 계약을 수용하는 선행물리다. required 결손500과 실제 미존재404를 분리하며 목록 행 제외로 total을 줄이면 안 된다. 개발0행은 운영 구행 문제가 없다는 증거가 아니다. |
| 3. ⭐ 대상·원천·부여·스냅샷 | **지지.** 한 대상·다중 촉발, 가장 가까운 부여층, MOLD 자유 이름을 유지한다. 툴에만 due 재판정을 적용하고 EQUIPMENT PM_DUE 입력을 툴 규칙으로 거부하지 않는다. stale snapshot 거부·누락nullable은 명시 후보로 남기고 후기 설계 문구로 확정하지 않는다. |
| 4. ⭐ tx·잠금·reset·날짜 | **부분 수정 — F1.** 같은 callback tx와 target→order→result 잠금, POST mold ETag/PUT result ETag 구분은 지지한다. reset의 누계·snapshot만 성공시키면서 마지막PM일자를 유보하는 안은 유지하지 않는다. reset 미요청 실적 기록·수정은 계속 가능하며 finishedAt를 마감/PM 날짜로 승격하지 않는다. |
| 5. ⭐ 예비품 참조·횡단 코어·실측 PR 크기 | **지지 + F2 보완.** 출고참조만 저장하고 quota·posting·자동출고0. 실제 두 도메인이 쓰는 최소 core와 준비/실제operation PR 분리를 지지한다. 목표350/상한400·core PR 전체200을 유지한다. 참조 출고의 issuedAt도 결과 시각 보존 범위에 포함시킨다. |

## 1. 버그 / 정확성

### F1 — Major: reset 성공에서 날짜 효과만 빼는 것은 미완 인수 표시만으로 해결되지 않는다

- 근거: 초안 :437·:443·:497~505의 누계치환 후 last_pm_date 미갱신 성공. 고정 `W-05-03-툴PM실적등록.md` :6은 **리셋 시 마지막 PM 일자와 누계 갱신**, :142는 시행일이 마지막 PM 일자, :162~179는 마스터 현재 기준 갱신을 명시한다. 계약 `equipment-05설비툴.json:4166`의 resetCounter도 독립 계수 정정이 아닌 툴 예방보전 행위다.
- 실패 예시: DATE/BOTH 툴에서 reset=true·closed=false를 저장해 누계는0, 날짜는 오래된 기준 그대로 두면201 뒤에 같은 PM이 날짜 축으로 계속 도래한다. 이 성공 응답은 누계와 차기 기준이 함께 갱신되는 행위를 일부만 수행한 결과다. 단순 보고서에서 UI 미완이라고 적어도 실제 저장 효과는 바뀌지 않는다.
- §2 판정: 0단계는 고정 화면의 결합 효과를 인용한다. **시행일의 API 원천 및 나눠시행 시점이 아직 정해지지 않았다는 판단은 유지**한다. 1단계에서 O7 전체가 아니라 reset=true의 특정 조건이다. 2단계 최초①에 따라 해당 입력의 업무 쓰기 전건을 하지 않고 **422 INVALID / field resetCounter**로 명시 거부한다. 부분 상태 쓰기를 한 뒤 나머지만 유보하지 않는다.
- 권고: `MAINTENANCE_RESET_POLICY='REJECT_UNRESOLVED_PM_DATE'` 같은 로컬 정책명과 기존 오류 봉투를 사용한다(새 ERROR_CODE0). reset=false/생략·closed=false/생략의 EQUIPMENT 및 MOLD 정상 실적은 유지한다. 계약 입력에 새 시행일을 추가하거나 startedAt/finishedAt/baseDate/now를 임의 선택하지 않는다. root가 R에서 시행일·적용시점·역행 정책을 근거와 함께 확정하면 reset 분기를 열 수 있다.
- PR/테스트 영향: W2의 +1은 정상 nonreset201이 있으므로 가능하다. W2p를 조건부 reset 준비로 바꾸고 W2에서 reset 성공 인수를 완료로 세지 않는다. E-R21/23/24는 조건부 성공 단언으로 분리, E-R28은 `reset 날짜원천 미정이면 header/line/part/mold/version 모두0`으로 변경한다. E-R01/03/06/17·PUT 정상200은 그대로 필수다. 문의번호는 root가 PM 주기 후보에 배정한다.

### F2 — Minor: 참조 출고의 µs 시각도 명시적으로 보존해야 한다

- 새 source 경계: 초안 :411의 정밀도 설명은 result 시작/종료가 중심이고 :461은 GI 헤더 조인이라고만 한다. 실제 `prisma/schema.prisma:745`는 `goods_issue.issued_at @db.Timestamptz(6)`, 기존 `src/logistics/goods-issue/goods-issue-view.ts:61`은 Date.toISOString()이다. 계약 :3939의 part.issuedAt는 출고 시각 원문이지 화면 날짜가 아니다. 기존 mapper를 재사용하면 ms 아래가 없어진다.
- 실패 예시: 출고시각 `.123456Z`를 가진 참조를 붙인 실적의 상세/POST/재생에서 `.123Z`만 반환하는 경로. 시작/종료 E-Q10만 통과해도 이 손실은 남는다. 실제 DB에서 이 사례를 실행하지 않았으며 가능 경로의 코드 근거다.
- §2/권고: 0단계 계약 date-time과 물리µs, 정본 I-32 :325~351의 동일순간 보존 선례를 재사용한다. 새 업무정책이나 스키마는 필요 없다. Q2p에서 GI issuedAt도 epochµs projection→같은 formatter로 반환하며 물류 service/mapper를 직접 부르지 않는다. 구행 응답범위 초과는500, null은null이다.
- PR/테스트 영향: T/Q2p 비용과 E-Q02·E-Q10·E-R12에 `GI issuedAt .123456 및 음수epoch가 상세/쓰기/재생에 보존됨`을 추가한다. 물류 API 자체의 정밀도 수정을 I-31에 포함하지 않는다. 문의109의 정밀도 연결이면 충분하다.

### F3 — Minor: 발행 뒤 툴 폐기와 reset 자격을 별도 경계로 남겨야 한다

- 새 source 경계: `src/mdm/mold/mold.service.ts:234~254`의 dispose는 툴 상태/version을 갱신하며 열린 보전 지시를 읽지 않는다. 따라서 지시가 ISSUED라고 툴도 사용가능하다고 추론할 수 없다. 초안 :409·:435~437에는 order의 PREVENTIVE/미마감 및 버전 검사가 있지만 reset 대상 툴의 현재 폐기 상태 판정은 구체적으로 없다. 고정 W-05-03 :211은 폐기 툴 오더를 후보에서 제외한다.
- 실패 예시: 오더 발행→툴 dispose→최신 툴 ETag 재조회→reset 요청은 stale409로 잡히지 않는다. 미래 reset 성공을 활성화할 때 order 상태만 검사하면 폐기 자산 누계를 치환한다. 현재 F1 거부를 채택하면 실행 위험은 잠복하므로 별도 Major로 중복 계수하지 않는다.
- §2/권고: 0단계는 실제 dispose writer·고정 후보 제외를 인용한다. 1단계에서 **폐기 후 reset**이라는 특정 조건, 2단계 최초①로 계수상태를 쓰지 않는 **400 STATE_LOCKED** 후보를 R에 명시한다. target lock 후 상태 검사, 성공 replay는 최초 응답 재생이다. 과거 nonreset 실적의 사후 기록/노트 수정까지 현재 활성조건으로 막을 근거는 없으므로 이 제한을 일반화하지 않는다.
- PR/테스트 영향: 조건부 W2p의 guard와 `폐기 후 최신ETag reset도 거부`, `dispose/reset 경합은 mold 잠금 순서로 선형화`, `기존 성공키 재생은 후속 폐기에 영향받지 않음`을 추가한다. MDM dispose를 I-31에서 바꾸지 않으며 필요하다면 root가 해당 소유자에게 인계한다.

### F4 — Minor: I-32 정본 상태와 코드 유효일 설명을 정확히 갱신한다

- 근거: 초안 :411·:509·:641 및 실측부록의 I-32 ignored-only 문구는 #306 이전 이력이다. 현재 `docs/coverage-100/slices/I-32.md:39,:325~351`의 R14는 canonical이며 helper 구현이 완료됐다는 뜻은 아니다. 날짜 입력의 year0000/+23:59/윤초 경계를 미결 후보처럼 다시 선택하지 말고 정본 R14를 그대로 인수한다.
- 별도 문구 정정: 초안 :417의 `assertCodeValues` 유효일 활용 선례는 실제 `src/common/master/code-reference.ts:33~38`과 다르다. 이 조회는 value.is_active와 group_code만 검사하며 effective_from/to 또는 group.is_active는 평가하지 않는다. 미래 유효일 코드가 있는 경우 다른 구현자가 자의로 startedAt/서버오늘로 검증할 여지가 있다.
- §2/권고: 둘 다 0단계 실제 정본/기존 구현 인용으로 수정한다. 코드 유효일 평가일은 새로 정하지 않고 현재 활성값 선례와 날짜유효성 미정 범위를 분리해 문의 흔적에 넣는다. normal writes 전건을 추가 거부하지 않는다.
- PR/테스트 영향: 계획 문구와 P2의 code checker 단위에서 현재 규칙을 정확히 명시한다. T는 canonical 설계를 공유하되 실제 병합 함수가 없으면 구현 선행으로 남긴다. 새 PR·DB 재측정이 필요한 발견은 아니다.

## 2. 보안

추가 보안 finding0. actor를 수행자/담당자와 분리하고 actor/body/path 지문, 쓰기4 권한과 O8 수동등록을 적용하는 방향을 지지한다. GET에 미선언403을 넣거나 사번을 새 인증수단으로 요구하지 않는다. raw SQL 값은 바인딩만 사용해야 하며 이번 검토는 코드 구현 보안 검증을 대신하지 않는다.

## 3. 테스트 / 4. 컨벤션

기존 전필드·배열교체·nullable/optional·오류봉투·취소경합 테스트 계획을 지지한다. 추가 테스트는 F1~F4의 PR 책임에 붙인다. source 읽기는 테스트 PASS가 아니며 DB/E2E/게이트 실행0이다. CREFLE pr-review의 정확성→보안→테스트→컨벤션 순서와 severity, coding-rules의 TS·commit reference를 적용했다. 실제 코드 diff가 없어 lint/style 통과 판정은 하지 않는다. 리뷰는 지정 파일에만 남기며 외부 댓글0이다.

## source-read 및 반환

- 직접 전체 읽기: 브리프, CLAUDE, README(§2 포함), lanes/lane-B, server-architecture, 기존-구현-도메인-규칙, I-31 753줄, DB 관측 원문256줄, pr-review/coding-rules SKILL과 필수 checklist/severity/template/TypeScript/commit reference.
- 계약 직접 읽기: COMMIT, 8operation 전체(:902~1580), 연결 parameter/ErrorItem/ErrorResponse, Item/Input/Trigger/Order/Create/ResultLine/Part/Result/Create/Update/PageMeta/ConflictResponse 전체. 부록 값 재계수·DB 중복측정0.
- 추가 직접 읽기: 고정 a6a87e1 W-05-03 전체(최초 추정 파일명 조회 실패 뒤 실제 파일명으로 읽음), I-32 canonical R/µs/summary 해당 절, mold update/activate/dispose, assignment 읽기·writer 경계, numbering, master-write/code checker, GI schema/view/query/update의 관련 경계, 현재 src 누계 writer 검색. 현재 client 차이는 브리프/계획자의 관찰을 재사용했으며 이 리뷰에서 client를 새로 실측했다고 주장하지 않는다.
- DB 원문은 2026-09-07 10:54:30 UTC의 역사적 관측이다. 당시54와 이후 root 전달55migration/generate6.19.3/drift0를 구분한다. 후속 CHECK는 quality.inspection_result이며 I-31 보전DDL 검증 증거가 아니다. 운영 구행·정상 고객 코드/출고 fixture·reset 날짜 의미는 여전히 미확인/미해소다.
- **소유 반환:** `/root/i31_review_api`는 이 보고서 한 파일로 종료한다. 코드/DB/계약/공용문서/git/gh write0, E2E/gates0, 문의번호배정0, 외부전송0, 하위agent0. R 통합·문의 배정·정본 PR·조건부 reset 범위 확정·구현 배정은 root 소유다.
