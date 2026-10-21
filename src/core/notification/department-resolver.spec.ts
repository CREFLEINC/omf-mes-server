import { Prisma } from '@prisma/client';

import { resolveByLine, resolveByUser } from './department-resolver';

type Department = { department_id: bigint; is_active: boolean } | null;

function fakeTx(lines: Record<string, Department>, users: Record<string, Department> = {}) {
  const lookedUp: bigint[] = [];
  const tx = {
    production_line: {
      findUnique: async (args: { where: { production_line_id: bigint } }) => {
        lookedUp.push(args.where.production_line_id);
        const key = String(args.where.production_line_id);
        return key in lines ? { department: lines[key] } : null;
      },
    },
    app_user: {
      findUnique: async (args: { where: { app_user_id: bigint } }) => {
        const key = String(args.where.app_user_id);
        return key in users ? { department: users[key] } : null;
      },
    },
  };
  return { tx: tx as unknown as Prisma.TransactionClient, lookedUp };
}

describe('department-resolver', () => {
  it('US6-2 라인에 활성 부서가 있으면 그 부서다', async () => {
    const { tx } = fakeTx({ '10': { department_id: 7n, is_active: true } });
    await expect(resolveByLine(tx, 10n)).resolves.toBe(7n);
  });

  it('US6-4 라인 없음·없는 라인·부서 없음·부서 비활성이면 null 이다', async () => {
    const { tx } = fakeTx({ '10': null, '11': { department_id: 7n, is_active: false } });
    await expect(resolveByLine(tx, null)).resolves.toBeNull();
    await expect(resolveByLine(tx, 99n)).resolves.toBeNull();
    await expect(resolveByLine(tx, 10n)).resolves.toBeNull();
    await expect(resolveByLine(tx, 11n)).resolves.toBeNull();
  });

  it('상위 라인 부서를 상속하지 않는다 — 노드 자신만 한 번 읽는다', async () => {
    const { tx, lookedUp } = fakeTx({ '20': null, '10': { department_id: 7n, is_active: true } });
    await expect(resolveByLine(tx, 20n)).resolves.toBeNull();
    expect(lookedUp).toEqual([20n]);
  });

  it('결재자는 app_user.department_id 로 판정한다', async () => {
    const { tx } = fakeTx({}, { '5': { department_id: 3n, is_active: true }, '6': null });
    await expect(resolveByUser(tx, 5n)).resolves.toBe(3n);
    await expect(resolveByUser(tx, 6n)).resolves.toBeNull();
  });
});
