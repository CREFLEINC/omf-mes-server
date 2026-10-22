import type { Prisma } from '@prisma/client';

import { ContractException } from '../../common/errors';
import { PrismaService } from '../../prisma/prisma.service';
import { fourMChangeView, prepareFourMChange, writeFourMChangeWithin } from './four-m-change';

/** omf-all-around#63 · 장부 P-86 — IQC 판정 때 자재 LOT 의 4M 변경품. #133 · P-105 — 변경 종류 선택, 비고 필수. */
function harness(request: { inspection_type_code: string; lot_id: bigint | null } | null, activeCodes = ['MATERIAL']) {
  return {
    inspection_request: { findUnique: jest.fn().mockResolvedValue(request) },
    code_value: {
      findMany: jest.fn().mockImplementation(({ where }: { where: { OR: { code: string }[] } }) =>
        Promise.resolve(
          where.OR.filter((c) => activeCodes.includes(c.code)).map((c) => ({
            code: c.code,
            code_group: { group_code: 'FOUR_M_CHANGE_TYPE' },
          })),
        ),
      ),
    },
  } as unknown as PrismaService;
}

const firstError = (error: unknown) => (error as ContractException).errors[0];

describe('prepareFourMChange', () => {
  it('생략하면 아무것도 읽지 않고 손대지 않는다', async () => {
    const prisma = harness({ inspection_type_code: 'IQC', lot_id: 20n });

    await expect(prepareFourMChange(prisma, 9n, undefined)).resolves.toBeUndefined();
    expect(prisma.inspection_request.findUnique).not.toHaveBeenCalled();
  });

  it('IQC 의뢰 LOT 에 변경 종류·비고를 싣는다', async () => {
    const prisma = harness({ inspection_type_code: 'IQC', lot_id: 20n });
    const value = { changeTypeCode: 'MATERIAL', remarks: '공급처 변경' };

    await expect(prepareFourMChange(prisma, 9n, value)).resolves.toEqual({
      lotId: 20n,
      inspectionRequestId: 9n,
      value,
    });
  });

  it('null 이면 변경품 해제로 준비한다(코드 대조 없음)', async () => {
    const prisma = harness({ inspection_type_code: 'IQC', lot_id: 20n });

    await expect(prepareFourMChange(prisma, 9n, null)).resolves.toMatchObject({ lotId: 20n, value: null });
    expect(prisma.code_value.findMany).not.toHaveBeenCalled();
  });

  it.each([
    ['OQC 의뢰', { inspection_type_code: 'OQC', lot_id: 20n }],
    ['LOT 없는 IQC 의뢰', { inspection_type_code: 'IQC', lot_id: null }],
  ])('%s 면 400 fourMChange INVALID 다', async (_label, request) => {
    const prisma = harness(request);
    const error = await prepareFourMChange(prisma, 9n, { remarks: '공급처 변경' }).catch((e: unknown) => e);

    expect(firstError(error)).toMatchObject({ field: 'fourMChange', code: 'INVALID' });
  });

  it('없는 변경 종류면 400 이다', async () => {
    const prisma = harness({ inspection_type_code: 'IQC', lot_id: 20n }, []);

    await expect(prepareFourMChange(prisma, 9n, { changeTypeCode: 'NOPE', remarks: 'x' })).rejects.toBeInstanceOf(
      ContractException,
    );
  });

  it('변경 종류 없이 비고만 받는다(코드 대조 없음 · #133)', async () => {
    const prisma = harness({ inspection_type_code: 'IQC', lot_id: 20n });
    const value = { remarks: '공급처 변경' };

    await expect(prepareFourMChange(prisma, 9n, value)).resolves.toMatchObject({ lotId: 20n, value });
    expect(prisma.code_value.findMany).not.toHaveBeenCalled();
  });

  it('비고가 공백뿐이면 400 fourMChange.remarks REQUIRED 다(#133)', async () => {
    const prisma = harness({ inspection_type_code: 'IQC', lot_id: 20n });
    const error = await prepareFourMChange(prisma, 9n, { changeTypeCode: 'MATERIAL', remarks: '  ' }).catch(
      (e: unknown) => e,
    );

    expect(firstError(error)).toMatchObject({ field: 'fourMChange.remarks', code: 'REQUIRED' });
  });
});

describe('writeFourMChangeWithin', () => {
  const tx = () =>
    ({
      lot_four_m_change: { upsert: jest.fn(), deleteMany: jest.fn() },
    }) as unknown as Prisma.TransactionClient & {
      lot_four_m_change: { upsert: jest.Mock; deleteMany: jest.Mock };
    };

  it('값이면 LOT 한 줄을 갈아 끼우고, 비고 앞뒤 공백을 뺀다', async () => {
    const client = tx();
    await writeFourMChangeWithin(
      client,
      { lotId: 20n, inspectionRequestId: 9n, value: { changeTypeCode: 'MAN', remarks: ' 작업자 변경 ' } },
      7,
    );

    expect(client.lot_four_m_change.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { lot_id: 20n },
        create: expect.objectContaining({ change_type_code: 'MAN', remarks: '작업자 변경', created_by: 7 }),
        update: expect.objectContaining({ change_type_code: 'MAN', remarks: '작업자 변경', updated_by: 7 }),
      }),
    );
  });

  it('변경 종류가 없으면 종류 칸을 비운다(#133)', async () => {
    const client = tx();
    await writeFourMChangeWithin(client, { lotId: 20n, inspectionRequestId: 9n, value: { remarks: '공급처 변경' } }, 7);

    expect(client.lot_four_m_change.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ change_type_code: null, remarks: '공급처 변경' }),
        update: expect.objectContaining({ change_type_code: null, remarks: '공급처 변경' }),
      }),
    );
  });

  it('null 이면 그 LOT 의 줄을 지운다', async () => {
    const client = tx();
    await writeFourMChangeWithin(client, { lotId: 20n, inspectionRequestId: 9n, value: null }, 7);

    expect(client.lot_four_m_change.deleteMany).toHaveBeenCalledWith({ where: { lot_id: 20n } });
    expect(client.lot_four_m_change.upsert).not.toHaveBeenCalled();
  });

  it('준비가 없으면(생략) 쓰지 않는다', async () => {
    const client = tx();
    await writeFourMChangeWithin(client, undefined, 7);

    expect(client.lot_four_m_change.upsert).not.toHaveBeenCalled();
    expect(client.lot_four_m_change.deleteMany).not.toHaveBeenCalled();
  });
});

describe('fourMChangeView', () => {
  it('줄이 없으면 칸이 없고, 비고가 없으면 비고 칸이 없다', () => {
    expect(fourMChangeView(null)).toBeUndefined();
    expect(fourMChangeView({ change_type_code: 'METHOD', remarks: null })).toEqual({ changeTypeCode: 'METHOD' });
  });

  it('변경 종류가 없으면 종류 칸이 없다(#133)', () => {
    expect(fourMChangeView({ change_type_code: null, remarks: '공급처 변경' })).toEqual({ remarks: '공급처 변경' });
  });
});
