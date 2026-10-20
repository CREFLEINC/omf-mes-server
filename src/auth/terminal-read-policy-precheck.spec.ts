import type { Request } from 'express';

import { PrismaService } from '../prisma/prisma.service';
import { assertTerminalReadScope } from './terminal-read-policy';

const pop = { terminalId: 1n, terminalCode: 'POP-1', plantId: 3n, terminalTypeCode: 'POP', equipmentId: 5n };
const bare = { ...pop, equipmentId: null };

/** 단말 공장(3)의 설비는 5·8 이고 9 는 다른 공장 설비다. */
const prisma = {
  equipment: {
    findFirst: jest.fn(async ({ where }: { where: { equipment_id: bigint; plant_id: bigint } }) =>
      ([5n, 8n].includes(where.equipment_id) && where.plant_id === 3n ? { equipment_id: where.equipment_id } : null)),
  },
} as unknown as PrismaService;

const read = (terminal: typeof pop | typeof bare, key: string, query: Record<string, unknown>, params: Record<string, string> = {}) =>
  assertTerminalReadScope(prisma, { query, params } as unknown as Request, key, terminal);

describe('작업 전 점검 게이트의 설비 읽기 — POP 단말 범위', () => {
  const gate = [
    (terminal: typeof pop | typeof bare, id: string) => read(terminal, 'GET /maintenance/breakdowns', { equipmentId: id, openOnly: 'true' }),
    (terminal: typeof pop | typeof bare, id: string) => read(terminal, 'GET /maintenance/inspections', { equipmentId: id }),
    (terminal: typeof pop | typeof bare, id: string) => read(terminal, 'GET /mdm/equipments/{equipmentId}/inspection-items', {}, { equipmentId: id }),
  ];

  it('설비 없는 POP 은 단말 공장 안의 설비를 읽는다 — 다른 공장 설비는 막는다', async () => {
    for (const call of gate) {
      await expect(call(bare, '8')).resolves.toBeUndefined();
      await expect(call(bare, '9')).rejects.toMatchObject({ status: 401 });
    }
  });

  it('설비 있는 POP 은 그대로 자기 설비만 읽는다', async () => {
    for (const call of gate) {
      await expect(call(pop, '5')).resolves.toBeUndefined();
      await expect(call(pop, '8')).rejects.toMatchObject({ status: 401 });
    }
  });

  it('점검 게이트 밖의 설비 읽기(비가동)는 설비 없는 POP 에게 열지 않는다', async () => {
    await expect(read(bare, 'GET /maintenance/downtimes', { equipmentId: '8' })).rejects.toMatchObject({ status: 401 });
  });
});
