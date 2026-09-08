# I-26 후속 계획 준비 메모 — 미판정

아직 계획·구현 착수가 아니다. 선행 I-7은 완료, 공식 대상은 assignment.tsv의 2건이다.
고정 계약 a6a87e1, 준비 기준 main 771c541. I-30/I-28와 파일·문의 번호를 공유하지 않는다.
계획 착수 시 README·lanes·lane-B·CLAUDE·I-24 예시·server-architecture와 관련 계획/계약/화면을 읽는다.

## 확인한 자료

- `contracts/production-02생산실행.json`: GET/POST `/trace/serial-numbers` 및 연결 스키마.
- `.design-reference/omf-mes/design/wiki/screens/02/P-02-05-인식표발행부착.md` 전체 195줄.
- `prisma/schema.prisma:3677` serial_number, `src/core/numbering/numbering.service.ts`.
- `src/trace/lot/lot-progress.ts`, `src/trace/lot/lot-complete.service.ts`의 LOT별 양품 집계.
- plan-api S17, plan-integration I-26, trace.module.ts.

## 반드시 판정할 다섯 축

1. POST 입력에 없고 응답·물리에 필수인 statusCode. 계약/화면은 코드 그룹을 세우지 말라고
   명시하고 품질/생애 축도 정하지 않았다. 기존 값·기본값 근거를 조사하되 NORMAL/ACTIVE/GOOD 등을
   임의 생성하거나 LOT 상태를 조용히 상속하지 않는다. 값이 없다는 사실과 본길 판정을 구분한다.
   특히 문의053/I-7/I-10은 계약의 "서버가 정한다" 위임을 근거로 표시 전용 상수를 골랐다.
   I-26에도 그 위임이 실제 있는지 대조한다. 전이0·required라는 사실만으로 위임이 같다고 보지 않는다.
2. serialNo 전역 UNIQUE + LOT/공장 구분 + 배치 원자성. 화면은 채번을 서버 몫으로 남겼다.
   CoreNumberingService에 SERIAL 프리셋이 없다. 새 코어 키/채번 규칙 필요 여부, 별도 코어 트랜잭션의
   번호 소모와 배치 전량 롤백·재전송 경계를 구체화한다. 미리보기 API를 새로 만들지 않는다.
3. 미발행 양품 수량의 정본. 화면은 production_result.good_qty 누적을 말하지만 이는 작업지시 축이며
   실제 I-7 LOT 마감은 production_result_lot_allocation.allocated_qty를 합산한다. 중복 LOT 할당,
   기발번 수량, 소수 수량, 동일 LOT 병렬 요청을 잠금/집계와 함께 검토한다.
4. 두 API의 경계. POST serial-numbers는 document_issue_log를 만들지 않는다. ① 개체 N개 성공 후
   ② 발행기록 실패는 개체 유지/발행만 재시도다. 출력·rendition·프린터 I/O는 범위 밖.
   계약의 Idempotency-Key·If-MatchOptional·Worker-No 및 400/403/409 봉투를 전건 대조한다.
5. 공용 TraceModule 자기 등록만, PR 350줄 예산(상한400, 코어200). 유사 파일 실측으로 나눈다.
   runIdempotent 공용 래퍼의 tx 전달/actor·query fingerprint를 확인하고 원자성이 필요하면
   기존 IdempotencyService.run의 tx 직접 사용을 검토한다. 다른 레인 공용 구현은 임의 수정하지 않는다.

본길 미정이면 README §2대로 해당 오퍼레이션 구현 유보·문의 후보를 적는다.
반드시 3관점 재수립 후 판정하고, 유보 핸들러로 커버리지를 올리지 않는다.
문의번호는 통합자가 실제 파일과 대역090~119를 확인해 배정한다.
DB는 전용 B 로컬 환경, 최초 시드 완료. 이 준비 메모 작업은 DB 읽기만 한다.
