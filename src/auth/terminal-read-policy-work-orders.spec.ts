import type { Request } from 'express';

import { assertTerminalReadScope } from './terminal-read-policy';

const pop = { terminalId: 1n, terminalCode: 'POP-1', plantId: 3n, terminalTypeCode: 'POP', equipmentId: 5n };
const popWithoutEquipment = { ...pop, equipmentId: null };
const KEY = 'GET /production/work-orders';

function request(query: Record<string, unknown>): Request {
  return { query, params: {} } as unknown as Request;
}

const read = (terminal: typeof pop | typeof popWithoutEquipment, query: Record<string, unknown>) =>
  assertTerminalReadScope({} as never, request(query), KEY, terminal);

describe('POP MES W/O 목록 범위', () => {
  it('설비 없는 POP 도 열린 W/O 목록을 본다 — 설비를 걸지 않을 때', async () => {
    await expect(read(popWithoutEquipment, { open: 'true' })).resolves.toBeUndefined();
  });

  it('설비 없는 POP 이 설비를 걸면 막는다', async () => {
    await expect(read(popWithoutEquipment, { open: 'true', plannedEquipmentId: '5' })).rejects.toMatchObject({ status: 401 });
  });

  it('설비 있는 POP 은 자기 설비만 걸 수 있고, 걸지 않아도 된다', async () => {
    await expect(read(pop, { open: 'true', plannedEquipmentId: '5', includeUnplannedEquipment: 'true' })).resolves.toBeUndefined();
    await expect(read(pop, { open: 'true' })).resolves.toBeUndefined();
    await expect(read(pop, { open: 'true', plannedEquipmentId: '6' })).rejects.toMatchObject({ status: 401 });
  });

  it('열린 W/O 가 아니면 막는다', async () => {
    await expect(read(popWithoutEquipment, {})).rejects.toMatchObject({ status: 401 });
  });
});
