import type { Request } from 'express';

import { assertTerminalReadScope } from './terminal-read-policy';

const terminal = {
  terminalId: 1n,
  terminalCode: 'POP-1',
  plantId: 3n,
  terminalTypeCode: 'POP',
  equipmentId: 1n,
};

function request(query: Record<string, unknown>): Request {
  return { query, params: {} } as unknown as Request;
}

describe('POP worker lookup scope', () => {
  it('accepts the exact worker lookup and forces the terminal plant', async () => {
    const req = request({ workerNo: '900028', includeInactive: 'true', size: '2' });
    await assertTerminalReadScope({} as never, req, 'GET /mdm/workers', terminal);
    expect(req.query).toMatchObject({ workerNo: '900028', plantId: 3 });
  });

  it('accepts the canonical same-plant directory request', async () => {
    const req = request({ plantId: '3', includeInactive: 'false', page: '1', size: '500' });
    await assertTerminalReadScope({} as never, req, 'GET /mdm/workers', terminal);
    expect(req.query).toMatchObject({ plantId: 3 });
  });

  it('rejects other plants and an unscoped directory request', async () => {
    for (const query of [{ plantId: '4' }, { includeInactive: 'false' }]) {
      await expect(assertTerminalReadScope({} as never, request(query),
        'GET /mdm/workers', terminal)).rejects.toMatchObject({ status: 401 });
    }
  });
});
