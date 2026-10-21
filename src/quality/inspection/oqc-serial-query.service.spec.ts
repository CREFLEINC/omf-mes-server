import { NotFoundException } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';
import { OqcSerialQueryService } from './oqc-serial-query.service';

/** 시리얼 OQC 조회(omf-all-around#68 · 장부 P-101). */
const RECORD = {
  first_judgment_code: 'NG', final_judgment_code: 'OK',
  inspected_at: new Date('2026-10-21T03:00:00Z'),
  inspected_worker: { worker_name: '검사자' },
  inspection_result: { inspection_result_id: 90n, inspection_round: 2 },
};

const RECORD_VIEW = {
  firstJudgmentCode: 'NG', finalJudgmentCode: 'OK', inspectedAt: '2026-10-21T03:00:00.000Z',
  inspectorName: '검사자', inspectionResultId: 90, inspectionRound: 2,
};

function prismaFor(options: { serial?: boolean; record?: boolean; released?: boolean } = {}) {
  return {
    serial_number: {
      findUnique: jest.fn().mockResolvedValue(options.serial === false ? null : {
        serial_number_id: 11n, serial_no: 'SN-11', item_id: 7n, lot_id: 50n, produced_at: null,
        item: { item_code: 'AAR4', item_name: '오토 리와인더' },
        lot: { lot_no: 'L-50', source_type_code: 'WORK_ORDER', source_id: 5n },
        oqc_serial_result: options.record ? RECORD : null,
      }),
    },
    inventory_reservation: {
      findMany: jest.fn().mockResolvedValue([
        { source_document_id: 40n, reserved_qty: 5, released_qty: options.released ? 5 : 0 },
      ]),
    },
    shipment_request_line: { findMany: jest.fn().mockResolvedValue([{ shipment_request_id: 30n }]) },
    inspection_request: {
      findMany: jest.fn().mockResolvedValue([{ inspection_request_id: 1n, inspection_request_no: 'IRQ-1', target_id: 30n, status_code: 'COMPLETED' }]),
    },
    oqc_serial_result: {
      findMany: jest.fn().mockResolvedValue([
        { ...RECORD, serial_number: { serial_number_id: 11n, serial_no: 'SN-11', lot_id: 50n, lot: { lot_no: 'L-50' } } },
      ]),
    },
  } as unknown as PrismaService;
}

describe('OqcSerialQueryService.scan', () => {
  it('시리얼·LOT·W/O, 그 LOT 을 피킹한 OQC 의뢰를 상태와 함께 낸다 — 완료된 의뢰도(재검 Q4)', async () => {
    const prisma = prismaFor();
    await expect(new OqcSerialQueryService(prisma).scan('SN-11')).resolves.toEqual({
      serialNumberId: 11, serialNo: 'SN-11', itemId: 7, itemCode: 'AAR4', itemName: '오토 리와인더',
      lotId: 50, lotNo: 'L-50', workOrderId: 5,
      pickedRequests: [{ inspectionRequestId: 1, inspectionRequestNo: 'IRQ-1', shipmentRequestId: 30, statusCode: 'COMPLETED' }],
    });
    expect((prisma.inspection_request.findMany as jest.Mock).mock.calls[0][0].where).toMatchObject({
      inspection_type_code: 'OQC', target_type_code: 'SHIPMENT_REQUEST', target_id: { in: [30n] }, item_id: 7n,
      status_code: { in: ['REQUESTED', 'IN_PROGRESS', 'COMPLETED'] },
    });
  });

  it('지금의 OQC 기록을 함께 낸다 — 화면이 1차 OK 를 NG 로 바꾸는 것을 미리 막는다', async () => {
    const view = await new OqcSerialQueryService(prismaFor({ record: true })).scan('SN-11');
    expect(view.shipmentStep).toEqual(RECORD_VIEW);
  });

  it('예약을 다 푼 LOT 은 피킹 LOT 이 아니다 — 의뢰가 없다', async () => {
    const prisma = prismaFor({ released: true });
    await expect(new OqcSerialQueryService(prisma).scan('SN-11')).resolves.toMatchObject({ pickedRequests: [] });
    expect(prisma.shipment_request_line.findMany).not.toHaveBeenCalled();
  });

  it('없는 시리얼은 404', async () => {
    await expect(new OqcSerialQueryService(prismaFor({ serial: false })).scan('X')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('OqcSerialQueryService.ofRequest', () => {
  it('의뢰의 회차들이 쓴 시리얼 판정을 시리얼 번호순으로 낸다', async () => {
    const prisma = prismaFor();
    await expect(new OqcSerialQueryService(prisma).ofRequest(1)).resolves.toEqual({
      items: [{ serialNumberId: 11, serialNo: 'SN-11', lotId: 50, lotNo: 'L-50', ...RECORD_VIEW }],
    });
    expect((prisma.oqc_serial_result.findMany as jest.Mock).mock.calls[0][0].where).toEqual({
      inspection_result: { inspection_request_id: 1 },
    });
  });
});
