import { requestFingerprint } from './fingerprint';

describe('requestFingerprint', () => {
  const body = { warehouseCode: 'WH-01', plantId: 1 };

  it('같은 요청은 같은 지문이다', () => {
    expect(requestFingerprint('POST', '/api/mdm/warehouses', body)).toBe(
      requestFingerprint('POST', '/api/mdm/warehouses', body),
    );
  });

  it('키 순서가 달라도 같은 지문이다 — JSON.stringify 는 삽입 순서를 따른다', () => {
    // 같은 요청인데 400 이 나면 안 된다.
    expect(requestFingerprint('POST', '/x', { a: 1, b: 2 })).toBe(
      requestFingerprint('POST', '/x', { b: 2, a: 1 }),
    );
  });

  it('중첩 객체의 키 순서도 정규화한다', () => {
    expect(requestFingerprint('POST', '/x', { o: { a: 1, b: 2 } })).toBe(
      requestFingerprint('POST', '/x', { o: { b: 2, a: 1 } }),
    );
  });

  it('배열 순서는 다르면 다른 지문이다 — 순서가 의미를 갖는다', () => {
    expect(requestFingerprint('POST', '/x', { a: [1, 2] })).not.toBe(
      requestFingerprint('POST', '/x', { a: [2, 1] })
    );
  });

  it.each([
    ['본문이 한 글자 다르면', 'POST', '/x', { c: 'A' }, 'POST', '/x', { c: 'B' }],
    ['경로가 다르면', 'POST', '/x', { c: 'A' }, 'POST', '/y', { c: 'A' }],
    ['메서드가 다르면', 'POST', '/x', { c: 'A' }, 'PUT', '/x', { c: 'A' }],
  ])('%s 다른 지문이다', (_l, m1, p1, b1, m2, p2, b2) => {
    expect(requestFingerprint(m1 as string, p1 as string, b1)).not.toBe(
      requestFingerprint(m2 as string, p2 as string, b2),
    );
  });

  it('메서드 대소문자는 무시한다', () => {
    expect(requestFingerprint('post', '/x', body)).toBe(requestFingerprint('POST', '/x', body));
  });

  it('undefined 필드는 없는 것으로 본다 — JSON 으로 나가지 않는 값이다', () => {
    expect(requestFingerprint('POST', '/x', { a: 1, b: undefined })).toBe(
      requestFingerprint('POST', '/x', { a: 1 }),
    );
  });

  it('본문이 없어도 지문을 만든다', () => {
    expect(requestFingerprint('POST', '/x', undefined)).toEqual(expect.any(String));
  });
});
