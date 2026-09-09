import { Prisma } from '@prisma/client';

import { lockMoldForWrite } from './mold-write-lock';

describe('툴 코드 수정 부모 잠금 (I-27 TOOL)', () => {
  it('발행과 같은 mold 행을 NO KEY UPDATE로 먼저 잠근다', async () => {
    const row = {
      mold_id: 7n,
      plant_id: 3n,
      mold_code: 'M-7',
      status_code: 'IN_SERVICE',
    };
    const queryRaw = jest.fn().mockResolvedValue([row]);

    await expect(lockMoldForWrite({ $queryRaw: queryRaw } as unknown as Prisma.TransactionClient, 7)).resolves.toBe(
      row,
    );

    const query = queryRaw.mock.calls[0][0] as Prisma.Sql;
    expect(query.strings.join('?')).toMatch(/FROM mdm\.mold[\s\S]*WHERE mold_id=\?[\s\S]*FOR NO KEY UPDATE/);
    expect(query.values).toEqual([7n]);
  });

  it('없는 툴은 후속 참조·발행 검사를 하지 않도록 404다', async () => {
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([]),
    } as unknown as Prisma.TransactionClient;

    await expect(lockMoldForWrite(tx, 404)).rejects.toMatchObject({
      status: 404,
    });
  });
});
