import { Prisma } from '@prisma/client';

import { ConflictException } from './conflict.exception';
import { isOverlap, overlapsAsConflict } from './overlap-conflict';

const known = (code: string, meta?: Record<string, unknown>) =>
  new Prisma.PrismaClientKnownRequestError('boom', { code, clientVersion: 'test', meta });

describe('overlapsAsConflict — DB 가 끊은 겹침만 409 로', () => {
  it('교착(40P01)·직렬화 실패(40001)·P2034 는 겹침이다', () => {
    expect(isOverlap(known('P2034'))).toBe(true);
    expect(isOverlap(known('P2010', { code: '40P01' }))).toBe(true);
    expect(isOverlap({ code: '40001' })).toBe(true);
  });

  it('다른 오류는 그대로 던진다', async () => {
    const other = known('P2002', { target: ['x'] });
    await expect(overlapsAsConflict(() => Promise.reject(other))).rejects.toBe(other);
  });

  it('겹침은 다시 하라는 409 다', async () => {
    await expect(overlapsAsConflict(() => Promise.reject(known('P2034')))).rejects.toBeInstanceOf(ConflictException);
  });
});
