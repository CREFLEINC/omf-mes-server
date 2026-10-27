import type { Request } from 'express';

import { assertTerminalReadScope } from './terminal-read-policy';

const pop = { terminalId: 1n, terminalCode: 'POP-1', plantId: 3n, terminalTypeCode: 'POP', equipmentId: 5n };
const popWithoutEquipment = { ...pop, equipmentId: null };
const KEY = 'GET /production/work-orders';

function request(query: Record<string, unknown>): Request {
  return { query, params: {} } as unknown as Request;
}

/** 공장 3 의 설비는 5·6 이고, 7 은 다른 공장 설비다. */
const prisma = {
  equipment: {
    findFirst: ({ where }: { where: { equipment_id: bigint; plant_id: bigint } }) =>
      Promise.resolve(where.plant_id === 3n && [5n, 6n].includes(where.equipment_id) ? { equipment_id: where.equipment_id } : null),
  },
};

const read = (terminal: typeof pop | typeof popWithoutEquipment, query: Record<string, unknown>) =>
  assertTerminalReadScope(prisma as never, request(query), KEY, terminal);

describe('POP MES W/O 목록 범위', () => {
  it('설비 없는 POP 도 열린 W/O 목록을 본다 — 설비를 걸지 않을 때', async () => {
    await expect(read(popWithoutEquipment, { open: 'true' })).resolves.toBeUndefined();
  });

  it('POP 은 단말 공장의 어느 설비든 걸 수 있다 — 옆 설비의 W/O 를 찾는다, 걸지 않아도 된다', async () => {
    await expect(read(pop, { open: 'true', plannedEquipmentId: '5', includeUnplannedEquipment: 'true' })).resolves.toBeUndefined();
    await expect(read(pop, { open: 'true', plannedEquipmentId: '6' })).resolves.toBeUndefined();
    await expect(read(popWithoutEquipment, { open: 'true', plannedEquipmentId: '6' })).resolves.toBeUndefined();
    await expect(read(pop, { open: 'true' })).resolves.toBeUndefined();
  });

  it('다른 공장 설비·없는 설비·형식이 틀린 id(중복 키·int64 초과 포함)는 같은 401 이다', async () => {
    await expect(read(pop, { open: 'true', plannedEquipmentId: '7' })).rejects.toMatchObject({ status: 401 });
    await expect(read(pop, { open: 'true', plannedEquipmentId: '999' })).rejects.toMatchObject({ status: 401 });
    await expect(read(pop, { open: 'true', plannedEquipmentId: 'x' })).rejects.toMatchObject({ status: 401 });
    await expect(read(pop, { open: 'true', plannedEquipmentId: ['5', '6'] })).rejects.toMatchObject({ status: 401 });
    await expect(read(pop, { open: 'true', plannedEquipmentId: '9223372036854775808' })).rejects.toMatchObject({ status: 401 });
  });

  it('열린 W/O 가 아니면 막는다', async () => {
    await expect(read(popWithoutEquipment, {})).rejects.toMatchObject({ status: 401 });
  });
});
