import { createHash } from 'node:crypto';

/**
 * 같은 키로 **다른** 요청이 오는 것을 잡기 위한 지문.
 *
 * 키만 보고 저장된 응답을 돌려주면, 클라이언트가 키를 재사용하는 버그가 있을 때
 * 「창고 B 를 등록했는데 창고 A 가 돌아오는」 상황을 아무도 모른다.
 *
 * 사용자는 넣지 않는다 — 키가 전역이라(PK) 다른 사용자가 같은 키를 쓰면 이미 충돌한다.
 */
export function requestFingerprint(method: string, path: string, body: unknown): string {
  return createHash('sha256')
    .update(`${method.toUpperCase()} ${path}\n${canonical(body)}`)
    .digest('base64');
}

/**
 * 키 순서가 달라도 같은 지문이 나오게 정규화한다. JSON.stringify 는 삽입 순서를
 * 따르므로 `{a,b}` 와 `{b,a}` 가 다른 문자열이 된다 — 같은 요청인데 400 이 난다.
 */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`);

  return `{${entries.join(',')}}`;
}
