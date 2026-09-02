import { generateTemporaryPassword, hashPassword, verifyPassword } from './password';

describe('임시 비밀번호', () => {
  it('12자이고 헷갈리는 글자를 쓰지 않는다 — 관리자가 읽어 주고 받아 적는 값이다', () => {
    for (let i = 0; i < 200; i += 1) {
      const generated = generateTemporaryPassword();

      expect(generated).toHaveLength(12);
      // 0·O·1·l·I 가 섞이면 「비밀번호가 틀리다」가 실제 오류와 구분되지 않는다.
      expect(generated).toMatch(/^[A-HJ-NP-Za-km-z2-9]{12}$/);
    }
  });

  it('같은 값이 두 번 나오지 않는다 — 초기화가 계정마다 달라야 한다', () => {
    const seen = new Set(Array.from({ length: 500 }, () => generateTemporaryPassword()));

    expect(seen.size).toBe(500);
  });

  it('⭐ 알파벳이 고르게 나온다 — 나머지 연산으로 자르면 앞쪽 글자가 더 자주 뽑힌다', () => {
    const counts = new Map<string, number>();
    for (let i = 0; i < 3000; i += 1) {
      for (const ch of generateTemporaryPassword()) {
        counts.set(ch, (counts.get(ch) ?? 0) + 1);
      }
    }

    // 알파벳 56자 · 36000 글자 → 기대 642. 편향이 있으면 앞쪽 글자가 뒤쪽의 두 배가 된다
    // (256 % 56 = 32 이므로 앞 32자만 5번, 나머지는 4번 뽑힐 기회를 갖는다).
    const values = [...counts.values()];
    expect(counts.size).toBe(56);
    expect(Math.max(...values) / Math.min(...values)).toBeLessThan(1.5);
  });

  it('해시로 저장해도 그 값으로 검증된다', async () => {
    const generated = generateTemporaryPassword();

    expect(await verifyPassword(generated, await hashPassword(generated))).toBe(true);
  });
});
