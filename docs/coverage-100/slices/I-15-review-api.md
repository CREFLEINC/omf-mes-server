# I-15 계획 API 관점 검토

검토일 2026-09-09 · 계약 `a6a87e1` · 대상 `I-15.md`.

## 판정

**진행 가능. 중단 조건 없음.** 6개 경로, 요청·응답, 멱등, If-Match, ETag, 403 선언을 전수 대조했다.

- `POST` 201과 상세 GET 200만 ETag가 있다. PUT·close 응답에 버전 ETag를 추가하지 않는 계획이 맞다.
- PUT은 `IfMatchVersionOptional`, close는 필수다. PUT에 `runVersioned`를 쓰면 토큰 없음이 500이 되므로 `runIdempotent` 안에서 선택 대조해야 한다.
- 수동 권한 누락 2건은 계획과 일치한다. PUT은 M-01-11, close는 W-01-04다.
- `InventoryCountLine.required`에 `systemQty`가 있으면서 같은 스키마가 블라인드 시 생략하라고 적은 것은 계약 내부 모순이다. 더 구체적인 블라인드 규칙을 따르고 통보 273으로 문서 정정을 요청하는 결론에 동의한다.
- `counted`는 응답 필수지만 `x-source-column`이 없고 물리 칸도 없다. `counted_by` nullable과 수량 0 때문에 파생할 수 없으므로 명시 boolean 추가가 필요하다.
- 라인 GET의 404와 잘못된 조회 질의 400은 계약 미선언이다. 기존 서버 관례를 유지하되 새 응답 유형을 만들지 않는다.

## 보강 반영

1. 블라인드 미실사 행의 `varianceQty`를 실제 생성값으로 내리면 systemQty가 역산된다. 0으로 마스킹하도록 본문에 명시했다.
2. 차이 사유는 고객 확장 코드라 enum을 하드코딩하지 않고 활성 `VARIANCE_REASON`을 조회한다.
3. 마감 오류 문자열은 요약의 `closeBlockedReasonCode`와 동일하게 유지한다.
