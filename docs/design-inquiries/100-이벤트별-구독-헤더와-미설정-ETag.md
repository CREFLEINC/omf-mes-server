# 100. 이벤트별 구독 헤더와 미설정 ETag

| 칸 | 내용 |
|---|---|
| 걸리는 오퍼레이션 | GET/PUT `/app/notification-subscriptions` |
| 구현 상태 | **조건부 계획만 확정. 099 해소 전 마이그·구독 구현0** |
| 판정 | 0단계 이벤트별 잠금 계약; 미설정/과거행/Zalo생략은 가장자리→2단계① 기존 상태를 쓰지 않는 쪽, 3단계 이름·단언·본 요청서 |
| 되돌릴 때 | 초기값/GET응답/PUT생략 처리의 해당 분기와 테스트 변경. 과거 사용자채널 행은 보존하므로 자동 변환을 되돌릴 작업 없음 |

계약 `app-공통.json:2049,2074,5082`는 이벤트별 토큰과 recipients 전체 치환을 요구한다. 실제 `notification_subscription`은 사용자·채널 NOT NULL, 사용자/이벤트/채널 유일, version 기본1이다(`schema.prisma:3863`).

조건부 구조는 사용자/채널을 nullable로 완화하고 **둘 다 NULL**인 이벤트 헤더만 부분 유일로 묶는다. 헤더가 Zalo·version을 소유하고 새 자식표가 ROLE/USER 규칙을 보존한다. 둘 다 nonnull인 옛 행은 읽어 합치거나 수정/삭제/백필하지 않는다. SQL 전문과 새 FK4개 NoAction은 `I-28.md` §2에 있다. 현재 적용0이다.

미설정인 **정본 이벤트**의 GET은 쓰기 없이 `recipients:[]`, `zaloEnabled:false`, `INITIAL_NOTIFICATION_SUBSCRIPTION_VERSION=1`이다. 첫 PUT만 삽입1→잠금→비교→저장2. 수신자0명이어도 헤더를 보존한다. Zalo 생략은 기존값 유지, 처음만false다. 정본에 없는 입력은 GET빈목록·토큰없음, PUT400 INVALID다.

**확인 요청: 위 이벤트별 물리 경계와 미설정/생략 판정에 다른 요구가 있는가?** 099의 코드 정본이 확인되면 이 가장자리의 별도 답을 필수로 기다리지 않고 R-4에 따라 진행한다.

알려둘 것: 전체 GET의 명시적 ETag 금지는 Express 자동 weak까지 국소 차단한다. 알려진 단일 GET만 숫자 토큰이며 PUT의 ETag 미선언은 새 버전 토큰 미발행이지 모든 HTTP 헤더 금지가 아니다. GET 헤더·규칙은 같은 스냅샷이고 GET→PUT→GET으로 다음 편집 토큰을 얻는다.

흔적: `I-28.md` R-2~R-4, §8-3·8-4. `정본 이벤트의 미설정 GET은 쓰기 없이 같은 초기 ETag`, `동시 최초 PUT은 하나만 성공`, `수신자 전부 제거 뒤 토큰 유지`, `zaloEnabledOmittedPreservesCurrentSetting`에 문의100 주석을 둔다.
