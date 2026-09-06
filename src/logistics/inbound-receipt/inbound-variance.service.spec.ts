import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE } from '../../common/errors';
import { PrismaService } from '../../prisma/prisma.service';
import { InboundVarianceService } from './inbound-variance.service';

type Args = Record<string, unknown>;

const SEEDED = [
  'INBOUND_VARIANCE_TYPE SHORTAGE',
  'INBOUND_VARIANCE_TYPE ITEM_MISMATCH',
  'INBOUND_VARIANCE_TYPE UNREGISTERED_ITEM',
  'INBOUND_VARIANCE_REASON DAMAGED',
];

function fake() {
  const codes = new Set(SEEDED);
  const recorded = { created: {} as Args };

  const prisma = {
    inbound_receipt_line: {
      findUnique: async () => ({ inbound_receipt_line_id: 900n }),
    },
    code_value: {
      findMany: async ({ where }: { where: { OR: { code: string; code_group: { group_code: string } }[] } }) =>
        where.OR.filter((check) => codes.has(`${check.code_group.group_code} ${check.code}`)).map(
          (check) => ({ code: check.code, code_group: { group_code: check.code_group.group_code } }),
        ),
    },
    inbound_variance: {
      create: async ({ data }: { data: Args }) => {
        recorded.created = data;
        return {
          ...data,
          inbound_variance_id: 700n,
          variance_qty: new Prisma.Decimal(data.variance_qty as number),
          uom_id: BigInt(data.uom_id as number),
          approval_request_id: null,
        };
      },
    },
  };

  return { service: new InboundVarianceService(prisma as unknown as PrismaService), recorded };
}

describe('InboundVarianceService.create', () => {
  it('차이 — reasonCode 가 없어도 등록된다(계약이 「선택이다」라 적었다)', async () => {
    const { service, recorded } = fake();

    const view = await service.create(900, { varianceTypeCode: 'SHORTAGE', varianceQty: 5, uomId: 50 }, 99);

    expect(recorded.created.reason_code).toBeNull();
    expect(view.reasonCode).toBeNull();
    // 계약 `InboundVariance` 가 nullable 로 열어 둔 칸이라 «키를 생략하지 않는다».
    expect(view).toHaveProperty('approvalRequestId', null);
  });

  it('차이 — varianceTypeCode 가 시드 3값 밖이면 400 이다', async () => {
    const { service } = fake();

    const error = await service
      .create(900, { varianceTypeCode: 'OVER_DELIVERY', varianceQty: 5, uomId: 50 }, 99)
      .catch((thrown: unknown) => thrown);

    expect((error as ContractException).errors[0]).toMatchObject({
      field: 'varianceTypeCode',
      code: ERROR_CODE.INVALID,
    });
  });

  it('차이 — varianceQty 상한을 두지 않는다(비교할 축이 무발주 라인에 없다)', async () => {
    const { service, recorded } = fake();

    const view = await service.create(
      900,
      { varianceTypeCode: 'SHORTAGE', varianceQty: 999_999, uomId: 50 },
      99,
    );

    expect(recorded.created.variance_qty).toBe(999_999);
    expect(view.varianceQty).toBe(999_999);
  });
});
