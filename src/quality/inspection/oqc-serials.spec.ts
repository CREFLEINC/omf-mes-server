import type { Prisma } from '@prisma/client';

import { ContractException } from '../../common/errors';
import { PrismaService } from '../../prisma/prisma.service';
import type { InspectionResultCreate } from './inspection-result-write-input';
import { prepareOqcSerials, recordOqcSerialsWithin } from './oqc-serials';

/** 시리얼 OQC(omf-all-around#68 · 장부 P-101) — 확정 저장에 실린 시리얼을 `oqc_serial_result` 로. */
const BODY: InspectionResultCreate = {
  inspectionRequestId: 1,
  inspectedQty: 5,
  acceptedQty: 4,
  rejectedQty: 1,
  heldQty: 0,
  uomId: 1,
  overallJudgmentCode: 'ACCEPTED',
  inspectedAt: '2026-10-21T03:00:00Z',
  statusCode: 'CONFIRMED',
  serials: [
    { serialNumberId: 11, judgmentCode: 'OK' },
    { serialNumberId: 12, judgmentCode: 'NG' },
  ],
};

function prismaFor(options: { type?: string; lots?: bigint[]; serialItem?: bigint; unpicked?: boolean } = {}) {
  const lots = options.lots ?? [50n, 51n];
  return {
    inspection_request: {
      findUniqueOrThrow: jest.fn().mockResolvedValue({
        inspection_type_code: options.type ?? 'OQC', target_type_code: 'SHIPMENT_REQUEST', target_id: 30n, item_id: 7n,
      }),
    },
    serial_number: {
      findMany: jest.fn().mockResolvedValue([
        { serial_number_id: 11n, serial_no: 'SN-11', item_id: options.serialItem ?? 7n, lot_id: 50n },
        { serial_number_id: 12n, serial_no: 'SN-12', item_id: 7n, lot_id: 51n },
      ]),
    },
    shipment_request_line: {
      findMany: jest.fn().mockResolvedValue([{ shipment_request_line_id: 40n, line_no: 1, allocated_qty: 5 }]),
    },
    inventory_reservation: {
      findMany: jest.fn().mockResolvedValue(
        lots.map((lot) => ({ source_document_id: 40n, lot_id: lot, reserved_qty: options.unpicked ? 1 : 5 / lots.length, released_qty: 0 })),
      ),
    },
  } as unknown as PrismaService;
}

const errorOf = async (promise: Promise<unknown>) => {
  const error = await promise.then(() => undefined, (e: unknown) => e);
  if (!(error instanceof ContractException)) throw new Error(`ContractException 이 아니다: ${String(error)}`);
  return error.errors[0];
};

describe('prepareOqcSerials', () => {
  it('시리얼이 없으면 null — 지금 저장 그대로다', async () => {
    await expect(prepareOqcSerials(prismaFor(), { ...BODY, serials: undefined })).resolves.toBeNull();
    await expect(prepareOqcSerials(prismaFor(), { ...BODY, serials: [] })).resolves.toBeNull();
  });

  it('피킹 LOT 의 같은 품목 시리얼을 판정과 함께 돌려준다', async () => {
    await expect(prepareOqcSerials(prismaFor(), BODY)).resolves.toEqual([
      { serialNumberId: 11n, serialNo: 'SN-11', judgment: 'OK' },
      { serialNumberId: 12n, serialNo: 'SN-12', judgment: 'NG' },
    ]);
  });

  it.each([
    ['작성중 저장', { statusCode: 'DRAFT' }, '확정 저장에서만'],
    ['같은 시리얼 두 번', { serials: [{ serialNumberId: 11, judgmentCode: 'OK' }, { serialNumberId: 11, judgmentCode: 'OK' }] }, '두 번'],
    ['시리얼 수 > 검사 수량', { inspectedQty: 1 }, '검사 수량보다'],
    ['NG 수 > 불합격 수량', { rejectedQty: 0, acceptedQty: 5 }, '불합격 수량보다'],
  ])('⛔ %s → 400 serials·INVALID', async (_name, patch, message) => {
    const error = await errorOf(prepareOqcSerials(prismaFor(), { ...BODY, ...patch }));
    expect(error).toMatchObject({ field: 'serials', code: 'INVALID' });
    expect(error.message).toContain(message);
  });

  it('⛔ 출하작업지시 OQC 가 아니면 400', async () => {
    const error = await errorOf(prepareOqcSerials(prismaFor({ type: 'PQC' }), BODY));
    expect(error.message).toContain('출하작업지시 OQC');
  });

  it('⛔ 다른 품목 · 피킹하지 않은 LOT 의 시리얼은 400 — 시리얼 번호를 문구에 싣는다', async () => {
    expect((await errorOf(prepareOqcSerials(prismaFor({ serialItem: 8n }), BODY))).message).toContain('SN-11 은 이 의뢰의 품목이 아닙니다');
    expect((await errorOf(prepareOqcSerials(prismaFor({ lots: [50n] }), BODY))).message).toContain('SN-12 의 LOT 은');
  });

  it('⛔ 피킹이 덜 끝났으면 LOT 판정과 같은 400 STATE_LOCKED', async () => {
    expect(await errorOf(prepareOqcSerials(prismaFor({ unpicked: true }), BODY))).toMatchObject({ code: 'STATE_LOCKED' });
  });
});

describe('recordOqcSerialsWithin', () => {
  const at = { inspectionResultId: 90n, inspectedAt: new Date('2026-10-21T03:00:00Z'), workerId: 8n, appUserId: 1n };

  function run(previous: { first_judgment_code: string } | null, judgment: 'OK' | 'NG') {
    const upsert = jest.fn();
    const tx = { oqc_serial_result: { findUnique: jest.fn().mockResolvedValue(previous), upsert } };
    const promise = recordOqcSerialsWithin(
      tx as unknown as Prisma.TransactionClient,
      [{ serialNumberId: 11n, serialNo: 'SN-11', judgment }],
      at,
    );
    return { upsert, promise };
  }

  it('첫 기록은 1차 = 최종 = 판정, 결과 id·검사자·시각과 함께 쓴다', async () => {
    const { upsert, promise } = run(null, 'NG');
    await promise;
    const call = upsert.mock.calls[0][0];
    expect(call.where).toEqual({ serial_number_id: 11n });
    expect(call.create).toMatchObject({
      serial_number_id: 11n, first_judgment_code: 'NG', final_judgment_code: 'NG',
      inspection_result_id: 90n, inspected_worker_id: 8n, inspected_at: at.inspectedAt, created_by: 1n,
    });
  });

  it('⭐ 재검 회차는 1차를 건드리지 않고 최종·회차만 바꾼다 (Q4)', async () => {
    const { upsert, promise } = run({ first_judgment_code: 'NG' }, 'OK');
    await promise;
    const update = upsert.mock.calls[0][0].update;
    expect(update).toMatchObject({ final_judgment_code: 'OK', inspection_result_id: 90n, version_no: { increment: 1 } });
    expect(update).not.toHaveProperty('first_judgment_code');
  });

  it('⛔ 1차 OK 를 NG 로 바꾸려 하면 400 serials·INVALID', async () => {
    const { upsert, promise } = run({ first_judgment_code: 'OK' }, 'NG');
    expect(await errorOf(promise)).toMatchObject({ field: 'serials', code: 'INVALID' });
    expect(upsert).not.toHaveBeenCalled();
  });
});
