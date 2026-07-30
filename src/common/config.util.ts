/**
 * `ConfigService` 는 환경변수를 **문자열로** 돌려준다. `get<number>()` 의 제네릭은
 * TypeScript 힌트일 뿐이고 런타임 타입을 바꾸지 않는다.
 *
 * 문자열을 그대로 쓰면 조용히 틀리는 곳이 있다. 대표적으로 jsonwebtoken 의
 * `expiresIn` 은 문자열을 `ms()` 로 해석해서 **밀리초로 읽는다**:
 *
 *     expiresIn: 28800     →  8시간
 *     expiresIn: '28800'   →  28800밀리초 = 28.8초   ← 설정은 맞는데 토큰이 28초 만료
 *
 * 그래서 숫자로 쓸 설정값은 반드시 이 함수를 통과시킨다.
 *
 * 테스트가 이 버그를 못 잡은 이유도 같다 — `ConfigService` 를
 * `(key, dflt) => dflt` 로 목킹하면 항상 숫자 기본값을 받아서
 * 문자열 경로를 한 번도 지나지 않는다.
 */
export function toPositiveInt(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  // 빈 문자열·null 은 Number()가 0으로 바꾸고, 잘못된 값은 NaN이 된다.
  // 둘 다 만료 시간으로 쓰면 위험하므로 기본값으로 되돌린다.
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
