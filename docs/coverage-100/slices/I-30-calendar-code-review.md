# I-30 PR⓪ 공장 달력일 helper — 독립 코드 리뷰

대상: `feat/coverage-100-b-i30-0`, 기준 HEAD `8a895c27762516c81011f826512170d4bd301ba7`.
검토 범위: 새 `maintenance-calendar.ts` 156줄·spec 234줄 전부와 최종 주석 변경.
비테스트 diff +156/-0: root 재배정 예산200·일반 상한400 충족. operation 증분0, 공식348/487 유지.
소스 SHA256 `85e4019283bf9a4063fe71e4f00e143febb914e0089da19f694fef4d4fdb6c89`.
spec SHA256 `5706d9c99be27f7f7ef7e68093f08a510e59baf32c4875739db8a12f349367a9`.

| Blocker | Major | Minor | Nit |
|---:|---:|---:|---:|
| 0 | 0 | 0 | 0 |

## 1. 버그 / 정확성

- 정본 I-30 R-13·§4-1 및 승인된 존재일/비연속일 의미와 일치한다. 발견한 실제 결함 없음.
- `maintenance-calendar.ts:11`은 형식·실재 달력일 왕복을 검사한다. :23은 UTC 달력 날짜를 증가시켜 다음날을 계산하며 실제 UTC 끝을 시작+24h로 도출하지 않는다.
- :29는 Gregorian AD/BC와 0~99년을 명시 처리한다. 명시 zone·gregory·latn·h23 때문에 서버 TZ/날짜 문자열 표시순서에 의존하지 않는다.
- :51은 일정 offset 구간과 목표 달력일의 교집합을 합친다. :65의 연속성 검사로 Goose_Bay 1988-10-30의 분리된 두 구간을 거부한다.
- Sao_Paulo 2018-11-04 시작03Z(현지01시), Havana 2020-11-01 반복자정의 앞04Z를 반환한다. 전이를 이분 탐색하고 시작/직전/끝 직전/끝의 현지 시각을 재검증한다.
- :127은 양끝 undefined에서 formatter 생성 전 `{}`를 반환한다. 한쪽 경계만 있으면 그 키만 반환한다.
- :150은 To 자체의 존재·연속성을 검사한 뒤 다음 달력일의 시작을 구한다. Apia skipped 입력일 및 skipped 익일을 보정하지 않는다.
- From > To 입력은 `gte >= lt`인 경계를 유지한다. 호출자가 빈 집합으로 처리할 수 있고 임의 기본 기간을 만들지 않는다.
- Intl/불변식 오류는 Error로 전파한다. 기존 `src/common/errors/error.filter.ts:68`이 INTERNAL_ERROR 봉투로 처리하므로 새 코드/UTC 대체/행 숨김이 없다.

## 2. 보안

특이사항 없음. DB·SQL·네트워크·HTTP 등록·권한·계약·저장 날짜 변경0, 새 의존성0.
입력 날짜/zone 오류의 내부 문자열은 기존 오류 필터가 응답에 노출하지 않는다.
단위 테스트의 자식 프로세스는 고정된 로컬 모듈 경로·고정 TZ만 사용한다.

## 3. 테스트

- 독립 실행: `node_modules/.bin/jest --runInBand --no-colors` → **exit0, 93/93 suites, 892/892 tests, failed0, 5.194초**.
- 계약 커버리지 출력 **348/487**. helper spec은47 cases이며 skipped 테스트0.
- UTC/하노이·NY23/25h·Lord_Howe23.5/24.5h·분/초 offset·월/연/윤년·0000/0099/9999년·잘못된 날짜/zone·자정 전이·skipped/비연속일·optional/역전/소수초 경계를 단언한다.
- 별도 Node 프로세스 UTC/Seoul/New_York에서 실제 서버 offset이 달라져도 공장 경계가 동일함을 확인한다. 기대 UTC 시각은 helper 재계산값이 아닌 리터럴이다.
- 추가 순수 관측: Kwajalein 1969-09-30은47h, Apia 1892-07-04는48h, Kiritimati 1994-12-31은 명시 오류. 이 관측은 정식 테스트 수에 합산하지 않는다.
- 구현자 보고 ESLint 전체/tsc(all)/unit 전체 exit0를 확인했고 리뷰어는 lint/tsc를 중복 실행하지 않았다. 최종 변경은 근거 주석뿐이다.
- 순수 helper이므로 E2E/DB 연결/SELECT0. 제품 source 수정0.

### 시간대 샘플링 전제 — 리뷰어가 수행한 독립 네이티브 감사

`node -p 'JSON.stringify(process.versions)'`: Node25.6.0 / ICU78.2 / tzdb2025c.
`otool -L /opt/homebrew/Cellar/node/25.6.0/lib/libnode.141.dylib`에서
`/opt/homebrew/opt/icu4c@78/lib/libicui18n.78.dylib` 및 `libicuuc.78.dylib` 연결을 확인했다.
Node가 실제 사용하는 같은 ICU 라이브러리의 전이 API를 사용해 Intl 시간 샘플링과 독립적으로 검사했다.

검토용 원문: `/private/tmp/i30-tz-review.8gKOIX/transitions.c`(제품에 추가하지 않음).
`ucal_openTimeZoneIDEnumeration(UCAL_ZONE_TYPE_ANY)`로 이름 전부를 열고 각 달력에 대해
`ucal_setMillis`→`ucal_getTimeZoneTransitionDate(UCAL_TZ_TRANSITION_NEXT)`를 반복했다.
각 전이의 전/후 및 최초 시점 offset을 `UCAL_ZONE_OFFSET + UCAL_DST_OFFSET`으로 읽었다.
모든 API 오류·전이 비증가를 실패로 처리하고 이름별 인접 전이 간격·정수초 여부를 집계했다.

```sh
clang /private/tmp/i30-tz-review.8gKOIX/transitions.c -I/opt/homebrew/opt/icu4c@78/include -L/opt/homebrew/opt/icu4c@78/lib -licui18n -licuuc -o /private/tmp/i30-tz-review.8gKOIX/transitions
/private/tmp/i30-tz-review.8gKOIX/transitions
```

범위는 epoch ms `-62167392000000`부터 `253402560000000`까지다. Node ISO 변환으로 각각
**-000001-12-30T00:00:00Z ~ +010000-01-04T00:00:00Z**를 확인했다.
0000..9999년 입력과 To 익일 및 탐색 여유 전체를 포함하며, 미래 구간은 현재 ICU 규칙의 확장이다.

| 결과 | 실측 |
|---|---|
| 시간대 / 전이 | 638 / 3,468,221 |
| 인접 전이 간격 ≤1시간 | 0쌍 |
| 최소 간격 | 597,600초(6일22시간) |
| 최소 사례 | America/Cambridge_Bay, 2000-10-29T07Z → 2000-11-05T05Z |
| 최초 고정 구간 포함 최대 offset 절댓값 | 57,368초(15:56:08), 24h 이내 |
| 소수초 전이 / offset | 0 / 0 |
| 최종 네이티브 감사 | exit0 |

따라서 **이 런타임·이 데이터·검사 범위**에서는 시간당 샘플 사이의 두 상쇄 전이 누락 전제를 해소했다.
근거는 데이터 실측이며 “IANA는 항상 시간당 전이가 한 번 이하”라는 규범적 보장을 주장하지 않는다.
[ICU 공식 API](https://unicode-org.github.io/icu-docs/apidoc/released/icu4c/ucal_8h.html)는 다음 전이 직접 조회를 제공한다.
[IANA 2025c 이론 문서](https://data.iana.org/time-zones/tzdb-2025c/theory.html)는 규칙·offset의 변동성과 과거 자료 한계를 설명하며 최소 전이 간격을 약속하지 않는다.

배포 한계: Dockerfile:10은 `node:22-bookworm-slim`, package.json은 Node>=20이다.
그 이미지의 실제 ICU/tzdb 전수 감사는 이번에 수행하지 않았다. source:71의 다른/미래 tzdb 재감사 조건을 유지해야 한다.
이 한계는 현재 발견한 오동작이나 Major로 계산하지 않으며, 현지 시간 변경·런타임 교체 시 같은 데이터 전제를 재확인할 근거다.
현재 Node의 Temporal은 undefined이고 Intl에는 전이 열거 API가 없다. 제품에 네이티브 바인딩/새 의존성을 넣는 변경은 범위 밖이다.

## 4. 컨벤션 / 가독성

coding-rules·TypeScript·commit-convention 및 pr-review의 체크리스트/심각도/양식을 직접 대조했다.
명시 반환타입·Error 전파·도메인 내 순수 helper·공개 경계 의미가 적절하다. 범용 시간대 프레임워크로 확대하지 않았다.
`dayBounds`는50줄 분리 검토 신호를 넘지만 탐색·교집합·검증이 같은 불변식을 다루므로 추가 추상화 요구 없음.
브랜치 B 접두어는 저장소 규칙에 맞고 신규 커밋/PR 작성은 통합자 소관이다.

## 판정

**코드 승인 기준 충족: Blocker0 / Major0. 로컬 독립 단위 전체 PASS.**
위 버전별 시간대 데이터 한계를 인계한다. PR 발행·동기화·병합 안전 조건의 최종 판정은 통합자가 수행한다.
리뷰어가 Git/PR/외부 댓글·등록부·다른 작업 파일을 변경한 것은 없다.
