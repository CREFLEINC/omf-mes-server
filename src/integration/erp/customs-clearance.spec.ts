import { PrismaService } from '../../prisma/prisma.service';
import { CustomsClearance, CustomsClearances, CustomsLine } from './customs-clearance';

function line(over: Partial<CustomsLine> = {}, orderType: string | null = 'PO'): CustomsLine {
  return {
    purchase_order_line_id: 7n,
    line_no: 1,
    erp_customs_clearance_no: null,
    erp_customs_clearance_seq: null,
    purchase_order: { erp_purchase_order_no: 'PO2606027', erp_order_type_code: orderType },
    ...over,
  };
}

function setup(found: CustomsClearance[] | null) {
  const update = jest.fn().mockResolvedValue({});
  const prisma = { purchase_order_line: { update } } as unknown as PrismaService;
  const find = jest.fn().mockResolvedValue(found ?? []);
  return { update, find, customs: new CustomsClearances(prisma, found === null ? null : { find }) };
}

describe('CustomsClearances — 구매입고에 실을 통관번호', () => {
  it('외자 라인 — 적어 둔 통관번호를 그대로 싣고 ERP 에 묻지 않는다', async () => {
    const { customs, find } = setup([{ no: 'CC-OTHER', seq: 9 }]);

    const got = await customs.forReceipt(line({ erp_customs_clearance_no: 'CC2606-0001', erp_customs_clearance_seq: 1 }));

    expect(got).toEqual({ no: 'CC2606-0001', seq: 1 });
    expect(find).not.toHaveBeenCalled();
  });

  it('외자 라인 — 적어 둔 값이 없으면 함수 결과 하나를 싣고 발주 라인에 적는다', async () => {
    const { customs, find, update } = setup([{ no: 'CC2606-0001', seq: 1 }]);

    expect(await customs.forReceipt(line())).toEqual({ no: 'CC2606-0001', seq: 1 });
    expect(find).toHaveBeenCalledWith('PO2606027', 1);
    expect(update).toHaveBeenCalledWith({
      where: { purchase_order_line_id: 7n },
      data: expect.objectContaining({ erp_customs_clearance_no: 'CC2606-0001', erp_customs_clearance_seq: 1 }),
    });
  });

  it('⛔ 외자 라인 — 결과가 없으면 던져 그 메시지만 실패로 남긴다', async () => {
    const { customs, update } = setup([]);

    await expect(customs.forReceipt(line())).rejects.toThrow(
      '외자 발주 PO2606027 라인 1 — ERP 에 통관번호가 없다(통관 전이거나 마감·전량 입고)',
    );
    expect(update).not.toHaveBeenCalled();
  });

  it('⛔ 외자 라인 — 결과가 둘이면 고르지 않고 던진다(나눠 통관하지 않는다는 전제가 깨졌다)', async () => {
    const { customs, update } = setup([
      { no: 'CC2606-0001', seq: 5 },
      { no: 'CC2606-0002', seq: 1 },
    ]);

    await expect(customs.forReceipt(line())).rejects.toThrow(
      '외자 발주 PO2606027 라인 1 — 통관번호가 2개(CC2606-0001/5, CC2606-0002/1)다. 나눠 통관된 라인이라 확인이 필요하다',
    );
    expect(update).not.toHaveBeenCalled();
  });

  it('⛔ 함수가 준 통관번호가 구매입고 칸(18자)보다 길면 적지 않고 던진다', async () => {
    const { customs, update } = setup([{ no: 'X'.repeat(19), seq: 1 }]);

    await expect(customs.forReceipt(line())).rejects.toThrow('18자보다 길다');
    expect(update).not.toHaveBeenCalled();
  });

  it('내자 라인 — 함수를 부르지 않고 빈 값·0 이다', async () => {
    const { customs, find } = setup([{ no: 'CC2606-0001', seq: 1 }]);

    expect(await customs.forReceipt(line({}, 'DO'))).toEqual({ no: '', seq: 0 });
    expect(find).not.toHaveBeenCalled();
  });

  it('함수가 설정되지 않았으면 외자도 빈 값·0 이다 — 적어 둔 값은 그대로 싣는다', async () => {
    const { customs } = setup(null);

    expect(await customs.forReceipt(line())).toEqual({ no: '', seq: 0 });
    expect(
      await customs.forReceipt(line({ erp_customs_clearance_no: 'CC2606-0001', erp_customs_clearance_seq: 1 })),
    ).toEqual({ no: 'CC2606-0001', seq: 1 });
  });
});
