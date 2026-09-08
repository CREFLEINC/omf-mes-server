# I-33 독립 재수립 — 통합 관점

대상은 `.backend-dev/lane-b/I-33-draft.md` 756줄이다. 다섯 축을 그대로 판정했으며 다른 관점의 I-33 보고서는 읽지 않았다. **Blocker 0 / Major 2 / Minor 2 / Nit(Trivial) 0**. Major를 R표에 반영한 뒤 계획을 확정할 것을 권고한다. 이것은 계획 리뷰이며 구현 PR 승인·게이트 PASS가 아니다.

## 최초 기준과 읽은 범위

- 최초 기준: root 통지 main `6bde921`, 공식 **352/487**, contracts `a6a87e144116ebaa32c01df5a12a0fd2924427e7`. I-32 #306은 계획 병합이고 helper 구현은 아니다. B DB55는 후속 통지이며 I-33 DB 원문이 기록한 과거54개 시점 관측을 소급 변경하지 않았다. 종료 전 root가 main `d5979ca`/#307·공식353을 통지했다. 최초 기준과 구 관측은 그대로 보존하며 I-30 DB lease에는 접근하지 않았다.
- 브리프86줄·초안756줄·DB 관측 원문 전체를 읽었다. CLAUDE·README(§2 전문 포함)·lanes·lane-B·server-architecture·기존 구현 도메인 규칙, I-24 계획 전체, 통합 정본 I-33/A20~22/M-g/V/T·기존 S24/U36~38/I-33 절을 읽었다. 고정 12operation·연결 입력/응답 schema·공통 헤더/오류를 직접 대조했다. I-32 R2/R14·§4-1·P0t는 읽기 재사용했다.
- CREFLE `pr-review`·`coding-rules` SKILL 및 checklist/severity/review-comment/TypeScript/commit-convention 참조를 완독했다. 정확성→보안→테스트→컨벤션 순서, 근거·실패예·권고·심각도 형식을 적용했다. 외부 댓글·merge 절차는 이번 위임 범위가 아니다.
- 추가로 기존 production 작업지시/작업세션 writer, 실제 FK DDL, MDM mold/equipment CAS, quality 항목 교체/Rev, 코드값 변경, 멱등·오류·CORS·모듈을 읽었다. W-05-07 전체 및 P-05-01/W-05-01/W-05-10 관련 문언과 현재 client 관측/환산 소비자를 직접 읽었다. 현재 client는 고정 계약을 바꿀 권위가 아니다.
- 실측 부록의 행·칼럼·제약·인덱스·주석 숫자를 재측정하지 않았다. 아래 새 접점은 부록 값을 뒤집지 않는다. DB·E2E·게이트·git/gh 실행0, source/DDL 쓰기0, 새 에이전트0이다.

## 다섯 축 verdict

| 초안의 축 | 독립 판정과 최초 근거 |
|---|---|
| ① 툴 사용 입력·시각·누계 | **핵심 채택, 잠금강도 수정(M1).** A20 추가4/완화2·required 결손 명시·증분 누계와 단말시각 분리·현재정책 재적용0을 지지한다. 계약 POST의 서버 가산/기준시각은 0단계. 같은 mold 직렬화/version 증가는 실제 MDM CAS와 맞는다. 다만 W/O FK가 도입하는 잠금을 빠뜨렸다. |
| ② 검교정·차단·해소 | **채택.** 기본 PASS/ADJUSTED/FAIL은 seed의 기존 값 정의와 계약의 합격 계열 의무를 연결하는 구체 권고로 사용할 수 있다. 이력유형에서 시스템이 이름으로 지목하는 값이 CALIBRATION 하나라는 문장은 결과코드 전체의 의미 연결 금지가 아니다. 확장 CAL만 거부하는 최초 기준은 2단계①(마스터 상태 미작성), 오류 표현은②. nonCAL 본길까지 유보하지 않는다. V 추가0/단일행 clear/마스터 같은 tx를 지지한다. |
| ③ 수집 채널 5칸·NULL 유일 | **채택.** 고정 POST/PUT의 네 축 유일·조건별 공존은 0단계이며 활성 상태를 범위에 더하지 않는다. 추가5/옛 필수3완화·key/code 비동치·구 uq 보존과 새 식 unique는 타당하다. NULL 비트와 COALESCE를 함께 쓰므로 실제 id=0도 NULL과 충돌하지 않는다. quality 삭제 보호는 실제 FK와 서비스 경합까지 보완(N1). |
| ④ 관측의 실제 원천 | **분리 채택, 필터 수정(M2).** T 신설은 이미 `plan.md:20`의 구체 통합 권고이며 새표 이름만 보고 기존표를 못 쓴다고 판단한 것이 아니다. 최근 채널명 목록+lastValue를 위한 설비/key별 최신 projection은 채택 가능한 구현 권고다. 다만 등록 여부를 그대로 `unmappedOnly`에 재사용하면 고정 문언의 미매핑을 숨긴다. 수집기 인수·동일시각 tie는 여전히 미완이다. |
| ⑤ 원자성·예산·배포 | **채택, 회귀 범위 보강.** 전달 tx를 쓰는 멱등·actor/worker 지문·성공 재생 선행·과거행/구 writer 배포검사·10조각 재산정을 지지한다. 기존 서비스 wrapper를 복사하지 않는다. W1에 production 교차잠금 회귀를 추가하고 M2에 quality 참조경합을 반영한다. I-31 reset 성공은 현재 승인 전제가 아니다(N2). |

## 1. 버그·정확성

### M1 — Major: mold 잠금 뒤 W/O FK 확인은 기존 writer와 역순 교착한다

**대상:** 초안 `:392`, 테스트 `:529`~`:532`. **새 근거:** `src/production/work-session/work-session.service.ts:54`는 W/O를 `FOR UPDATE`로 잠그고 `:69`~`:75`에서 mold FK를 가진 세션을 INSERT한다. `src/production/work-order/work-order-write.service.ts:174`·`:189`·`:212`도 W/O 잠금 뒤 planned_mold_id를 변경한다. FK는 baseline migration `:801`·`:857`, I-33의 W/O FK는 v4 migration `:797`이다. `lockWorkOrder`의 실제 잠금은 `work-order-write.service.ts:68`~`:73`이다.

실패 순서: 세션 트랜잭션 S가 W/O를 잠금 → 사용입력 T가 mold를 잠금 → S의 INSERT가 mold FK의 KEY SHARE를 기다림 → T의 tool_usage INSERT가 W/O FK의 KEY SHARE를 기다림. FK 존재 SELECT는 잠금을 획득하지 않으므로 초안의 `tx 안 FK확인`만으로 이 고리가 사라지지 않는다. DB가 한 트랜잭션을 중단하며, 현재 멱등/오류 처리에는 이를 정상 재시도로 흡수하는 정책이 없다. I-31과의 mold CAS만 시험하면 놓친다. 이는 소스·DDL에 근거한 경합 분석이고 DB 재현 실측이라고 쓰지 않는다.

**최소 권고:** O3의 `mold FOR UPDATE`를 **`FOR NO KEY UPDATE`**로 바꾼다. O3가 쓰는 누계/version/감사값은 키가 아니므로 다른 누계·MDM 변경과는 여전히 직렬화하면서 기존 production FK의 KEY SHARE는 허용한다. 따라서 S가 mold 참조를 완료하고 W/O를 풀 수 있다. 이 호환성은 [PostgreSQL 공식 잠금표](https://www.postgresql.org/docs/current/explicit-locking.html#LOCKING-ROWS)로 대조했다. 앞서 검토한 `work_order FOR KEY SHARE → mold FOR UPDATE`도 해당 고리를 끊지만 추가 참조잠금이 필요하므로 이번 비키 가산의 최소안으로는 택하지 않는다. W/O에 새 상태/배정 검사를 추가하지 않으며 없는 W/O는 기존 계획의400 INVALID다. 기존 production writer 수정·새 코어 없이 I-33 내부에서 해결한다. I-31의 maintenance_order와 production.work_order를 같은 표로 취급하지 않는다.

**README/단언/PR:** 0단계 기존 writer의 실제 잠금/FK가 최초 근거이고, 비키 가산에 맞춘 잠금 강도는 이번 구체 통합 권고이지 기존 코드에 이미 있는 선택이라고 주장하지 않는다. 업무 의미 추측은 아니다. `TOOL_USAGE_REFERENCE_LOCK_COMPATIBILITY`에 이름을 붙인다. W1에 `작업세션 생성이 W/O를 먼저 잡아도 툴증분과 교착하지 않는다`, `작업지시 툴배정 변경과 증분이 서로 대기 고리를 만들지 않는다`를 제어된 두 연결/barrier로 추가한다. 기존 E-T12도 유지한다. 잠금문 교체와 회귀를 W1≤350 안에서 재배정하고 실제400을 넘으면 분리한다.

### M2 — Major: 관측의 미매핑 필터가 등록 여부와 같은 뜻으로 바뀐다

**대상:** 초안 `:463`~`:464`·E-O02/03. **근거:** 고정 contract `equipment-05설비툴.json:2636`는 아직 연결되지 않은 신호를 포함하며 `:2654`의 unmappedOnly는 “연결 안 된 것만”이다. 같은 고정 PUT `:2537`은 비활성 채널이 적용되지 않아 미매핑과 같아진다고 규정한다. W-05-07 §5-2(`:94`)는 검사항목 없는 등록 채널을 명시적으로 미매핑이라고 정의한다. 현재 client도 `packages/i18n/src/ko/collection-channel.ts:169`의 “아직 잇지 않은 것만”과 `:171`의 “이미 등록됨”을 구별한다.

실패예: 설비 E/key K 관측이 있고 채널은 등록됐지만 inspection_item_id=NULL인 경우다. 초안은 alreadyMapped=true를 만들고 unmappedOnly=true에서 K를 제외한다. 사용자는 연결할 곳이 없어 버려지는 신호를 요청했는데 서버가 숨긴다. inactive 행만 있는 경우도 같다. `alreadyMapped`를 import 중복생성 방지용 등록 여부로 두는 근거가 `unmappedOnly`의 의미까지 바꾸지는 않는다.

**권고:** 두 술어를 분리한다. `alreadyMapped=같은 설비/key 등록행 EXISTS`는 표시·선택제어 권고로 유지하고, `unmappedOnly`는 같은 설비/key에 활성이고 대상 검사항목이 연결된 행이 없는 조건으로 정의한다. 품목/공정 조건행은 등록/연결의 존재를 평가할 뿐 실제 생산 조건에 적용 가능한지 판정하지 않는다(그 입력 축이 O6에 없다). 연결된 행과 미연결 행이 혼재한 경우의 집합 의미는 이 정의와 예제로 문의에 남긴다. 최소한 단일 NULL/비활성 사례를 등록됨이라는 이유로 제외해서는 안 된다.

**README/단언/PR:** NULL 대상·비활성의 “미매핑”은 0단계 문언이 먼저다. 그와 다른 모든 호출의 의미를 current client 선택제어로 새로 세우는 것은 1단계 본길 추측이므로 채택하지 않는다. `OBSERVATION_REGISTERED_EXISTS`와 `OBSERVATION_UNMAPPED_FILTER`를 별도 이름으로 두고 E-O02/03에 `등록됐지만 미연결인 관측은 미매핑 필터에도 남고 alreadyMapped는 true다`, `비활성 연결만 있으면 미매핑이다`, `조건행 혼재를 실제 생산 적용 판정으로 바꾸지 않는다`를 추가한다. Q4의 EXISTS 조건 교체이며 새 물리/코어는 불필요하다.

### N1 — Minor: quality 사전 참조검사 뒤 경합도 삭제용 오류로 설명해야 한다

**대상:** 초안 `:454`·E-M04. `inspection-plan-version.service.ts:229`의 assertRemovable는 tx 밖이며 실제 DELETE는 `:234`다. 채널 FK 사전검사만 더해도 그 사이 새 채널이 붙을 수 있다. DB FK는 삭제를 막으므로 데이터 유실은 없지만, 공통 `prisma-error.ts:33`은 DELETE의 P2003도 “참조하는 대상이 없습니다”로 낸다. 이것은 “내 항목을 채널이 사용 중”이라는 실제 실패 사유와 다르다.

quality 소유자에게 기존 measurement 검사 유지+채널 참조검사와 함께 **새 FK의 정확한 P2003를 tx 바깥에서 STATE_LOCKED400으로 번역**할 것을 인계한다. 이 리뷰가 A 코드를 수정하지 않는다. README 0단계 FK/기존 참조거부, 원자성·오류 보완이며 새 정책이 아니다. E-M04에 `참조검사 뒤 채널이 연결돼도 항목 삭제는 롤백되고 사용 중 오류를 낸다`를 넣고 M2 조율예산에 포함한다. 직접 FK 없는 PLAN_VERSION_REFERRERS 추가는 필요 없다.

## 2. 보안

신규 보안 finding0. actor·raw worker 지문 분리와 parameter binding·whitelist·기존403 네 건은 타당하다. worker 헤더는 귀속이며 인증으로 승격하지 않는다. CORS/세션 한계는 `cors.ts:39`, 고정 WorkerNo 문언과 실제 POP 소비자의 환경 인수 항목이며 이 계획이 이미 적었다. 이를 이유로 O3의 신규 인증모델을 만들거나 I-33에서 공용 파일을 임의 수정하지 않는다.

## 3. 검증·접점 판정

- MDM의 기존 mold PUT/setActive/dispose는 `mold.service.ts:196`·`:225`·`:250`의 version CAS를 사용한다. O3 version 증가가 기존 토큰을 낡게 하는 것이 맞다. equipment PUT `equipment.service.ts:187`은 교정 날짜2칸을 입력/UPDATE하지 않으므로 O11의 단독 writer와 양립한다. 기존 MDM wrapper의 tx 결손까지 I-33에서 고치는 범위 확장은 없다.
- calibration 기본값 의미는 seed `:307`~`:309`의 정의를 코드값에 연결하는 권고다. `code.service.ts:256`은 고객 코드/이름 변경을 실제 허용하므로 **현재 번역/이름 파싱으로 분류하지 않는다**. 변경된 코드가 기존 기본값 밖이면 unknown CAL 거부가 적용된다. nonCAL은 활성 registry라는 선행 S24 권고대로 정상 진행한다. 이력+master+멱등 동일 tx, clear 다른 차단 보존, 기한 null/과거 입력 literal 치환을 지지한다.
- 최신 Rev는 `inspection-plan-version.service.ts:116`의 상태무관 “최신이 위”와 `:319`의 plan별 max+1이 기존 선례다. `MAX_VERSION_ALL_STATUS`는 새 확정상태 판정의 발명이 아니라 해당 Rev 번호의 최신 여부다. DRAFT가 생겼을 때 이전 확정본 경고, 다른 plan 격리, FK null 묶음 단언을 유지한다.
- CONVERTED의 제출 shotCount 보존은 지지한다. 고정 POST `:2224`의 “이번 타발수”와 P-05-01 §5-2(`:140`)의 “정하는 것은 화면(증분), 반영하는 것은 서버(누적)”가 **0단계 입력 권한 근거**다. 이를 “미정인데 최초④로 거부보다 허용을 택함”이라고 설명하면 README 순서가 뒤집힌다. 서버 자체 반올림/현재 정책 재산정0을 유지하고, 임시 client Math.round를 승인된 서버 계산식으로 인용하지 않는다.
- T 신설·최근 채널별 projection·무페이지 전체응답은 별개의 판단이다. 신설은 통합 정본 권고, 채널별 최신값은 W-05-07 §5-4 채널명 추출 목록+계약 lastValue에 맞는 **이번 통합 권고**, 무페이지는 고정 query2/optional page의 literal 구현이다. 소스 timestamp가 발생/수신 중 무엇인지·동률 값 선택·writer 인수는 이 권고로 자동 해결되지 않는다. 이를 확정하지 못하면 O6만 유보하고 T를 영원한 빈 결과 stub로 올리지 않는다. 구표/payload 자동복사0.
- M2의 새 equipment/process FK를 referrer 목록과 실제 FK 대조 E2E에 함께 넣는 계획은 맞다. item은 `item.service.ts:65`의 ERP 잠금/referenceCount=null이므로 가짜 카운트 목록을 신설하지 않는다. 구 writer가 legacy 필수만 채우면 새 required 결손이 다시 생기므로 환경별 writer 전환 확인은 migration 성공과 별도 완료 조건이다.

## 4. 컨벤션·문서

### N2 — Minor: 폐기된 재수립 기준과 미승인 reset 성공 시나리오를 현재 기준으로 고친다

초안 `:18`의 옛 세 조건 논증은 README `:25`의 2026-09-07 기본 재수립으로 교체한다. 이것은 설계 finding과 별도다. 초안 `:396`·E-T13/14의 reset 성공은 **현재 root가 reset=true 거부, 미마감 nonreset 본길 유지로 재수립 중인 I-31의 승인 결과가 아니다**. 성공 reset 교차회귀를 미래 조건부로 명시하고 현재 필수 회귀는 `reset=true 거부가 누계·이력·버전을 바꾸지 않는다`와 두 증분/MDM CAS로 둔다. I-31 nonreset 업무를 I-33이 축소하거나 lastPM 미갱신을 승인하지 않는다.

## PR 인계와 종료

일반 브리프≤350·실제 비테스트400, core를 건드리는 경우 그 PR 전체200을 유지한다. M1~3/Q1~4/W1~3의 10조각은 구현 후보이며 실제 diff 측정이 아니다. Q4는 M2 finding의 필터 뜻을 먼저 확정한다. W1은 M1의 production 교차잠금 회귀를 포함한다. M2는 quality 소유자 조율과 FK 회귀까지 담되 조율 확대 시 A21/T를 분리한다. I-32 P0t150의 실제 helper·IdempotencyModule 배선 선행을 확인한 뒤 import한다. I-26 #307은 타 작업이므로 읽기·쓰기 대상으로 삼지 않았다.

미완: R1~8 통합판정/root 문의 배정·canonical 계획, I-31 현재 재수립, 관측 writer/동률/시각 인수, POP 환경·clear UI 인수, 구현·DB·테스트·게이트·실제 PR 예산 검증은 **미수행**이다. 이번 독립 통합 리뷰와 지정 파일 작성은 완료했다. 추가 SQL 요청0, 공식coverage 증가0. `.backend-dev/lane-b/I-33-review-integration.md` **파일 소유를 root에 반환**하며 이후 임의 수정하지 않는다.
