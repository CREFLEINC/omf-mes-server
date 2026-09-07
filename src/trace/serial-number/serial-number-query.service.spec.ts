import { Prisma } from '@prisma/client';

import { SerialNumberQueryService, serialNumberWhere } from './serial-number-query.service';
import { serialNumberView } from './serial-number-view';

describe('제품 개체 목록 조회 (I-26)', () => {
  it('serialNumberView omits absent producedAt and preserves raw statusCode', () => {
    const view = serialNumberView({
      serial_number_id: 11n,
      serial_no: 'SN-11',
      item_id: 21n,
      lot_id: 31n,
      status_code: 'fixture 상태 그대로',
      produced_at: null,
      created_at: new Date(0),
      created_by: null,
      updated_at: new Date(0),
      updated_by: null,
      version_no: 7,
    });

    expect(view).toEqual({
      serialNumberId: 11,
      serialNo: 'SN-11',
      itemId: 21,
      lotId: 31,
      statusCode: 'fixture 상태 그대로',
      versionNo: 7,
    });
  });

  it('serialNumberWhere combines all filters and uses half-open times', () => {
    expect(
      serialNumberWhere({
        lotId: 31,
        itemId: 21,
        statusCode: 'RAW',
        q: 'sn-',
        producedFrom: '2026-09-07T00:00:00.0000001Z',
        producedTo: '2026-09-08T00:00:00.9999991Z',
      }),
    ).toEqual({
      lot_id: 31,
      item_id: 21,
      status_code: 'RAW',
      serial_no: { contains: 'sn-', mode: 'insensitive' },
      produced_at: {
        gte: '2026-09-07T00:00:00.000001Z',
        lt: '2026-09-08T00:00:01.000000Z',
      },
    });
  });

  it('serialNumberList uses identical where and RepeatableRead for rows and total', async () => {
    const rows = [
      {
        serial_number_id: 1n,
        serial_no: 'SN-1',
        item_id: 2n,
        lot_id: 3n,
        status_code: 'RAW',
        produced_at: null,
        created_at: new Date(0),
        created_by: null,
        updated_at: new Date(0),
        updated_by: null,
        version_no: 1,
      },
    ];
    const findMany = jest.fn().mockReturnValue('rows-query');
    const count = jest.fn().mockReturnValue('count-query');
    const $transaction = jest.fn().mockResolvedValue([rows, 4]);
    const service = new SerialNumberQueryService({
      serial_number: { findMany, count },
      $transaction,
    } as never);

    await expect(service.list({ lotId: 3, page: 2, size: 1 })).resolves.toMatchObject({
      items: [{ serialNumberId: 1 }],
      page: { page: 2, size: 1, total: 4 },
    });
    expect(findMany).toHaveBeenCalledWith({
      where: { lot_id: 3 },
      orderBy: { serial_number_id: 'asc' },
      skip: 1,
      take: 1,
    });
    expect(count).toHaveBeenCalledWith({ where: { lot_id: 3 } });
    expect($transaction).toHaveBeenCalledWith(['rows-query', 'count-query'], {
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
    });
  });
});
