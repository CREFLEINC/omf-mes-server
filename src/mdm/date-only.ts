/**
 * `@db.Date` 는 시각이 없는 **날짜**다. Prisma 는 이것을 UTC 자정의 `Date` 로 준다.
 * `toISOString()` 은 UTC 기준이라 넣은 날짜가 그대로 나온다.
 *
 * **로컬 포맷(`getFullYear`/`toLocaleDateString`)을 쓰면 안 되는데, 여기서는 안 써도
 * 티가 안 난다.** UTC 자정을 양수 오프셋으로 읽으면 같은 날이 나오기 때문이다 —
 * 서버는 UTC, 개발기는 한국(+9), 공장은 하노이(+7)로 전부 양수다. 음수 오프셋에서만
 * 하루가 밀리므로, 틀리게 짜도 이 환경에서는 통과한다. 그래서 단위 테스트가 날짜가
 * 아니라 **UTC 로 포맷하는가**를 본다.
 *
 * 이 프로젝트의 `@db.Date` 는 41개다. `business_date` 도 같은 함정을 공유한다
 * (타임존 캐스팅 금지).
 */
export function toDateOnly(value: Date | null): string | null {
  return value === null ? null : value.toISOString().slice(0, 10);
}
