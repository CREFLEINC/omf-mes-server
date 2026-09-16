import { Prisma } from '@prisma/client';

import { NumberingService } from '../../core/numbering/numbering.service';
import { groupOqcLines, prepareOqcRequests, writeOqcRequests } from './shipment-oqc-request';

const line = (
  itemId: number,
  allocatedQty: number,
  shippingInspectionRequired = true,
  uomId = 1,
) => ({ itemId, uomId, allocatedQty, shippingInspectionRequired });

describe('출하검사 의뢰 묶기', () => {
  it('검사 필수 라인만 품목별로 합친다', () => {
    const grouped = groupOqcLines([
      line(10, 100),
      line(10, 50),
      line(20, 7),
      line(30, 999, false),
    ]);

    expect([...grouped.entries()]).toEqual([
      [10, { uomId: 1, qty: 150 }],
      [20, { uomId: 1, qty: 7 }],
    ]);
  });

  it('필수 라인이 하나도 없으면 빈 묶음이다', () => {
    expect(groupOqcLines([line(10, 100, false)]).size).toBe(0);
  });

  /**
   * ⚠ 한 품목이 라인마다 다른 단위로 오면 «첫» 라인의 단위로 합친다. 막을 근거가 계약에
   * 없어 이렇게 두었다 — 실제로 섞여 들어오면 검사 수량이 뜻을 잃으므로, 그때 단위별
   * 분할을 더해야 한다. 지금 동작이 무엇인지를 여기 박아 둔다.
   */
  it('같은 품목의 단위가 섞이면 첫 라인의 단위로 합친다(알려진 거친 자리)', () => {
    const grouped = groupOqcLines([line(10, 100, true, 1), line(10, 2, true, 9)]);

    expect(grouped.get(10)).toEqual({ uomId: 1, qty: 102 });
  });
});

describe('출하검사 의뢰 준비', () => {
  const numbering = {
    nextMany: jest.fn().mockResolvedValue(['IRQ-20260916-0001', 'IRQ-20260916-0002']),
  } as unknown as NumberingService;
  const prisma = {
    inspection_plan_version: {
      findMany: jest.fn().mockResolvedValue([{ inspection_plan_version_id: 77n }]),
    },
  } as unknown as Prisma.TransactionClient;

  beforeEach(() => jest.clearAllMocks());

  it('품목마다 번호와 기준 버전을 붙여 돌려준다', async () => {
    const prepared = await prepareOqcRequests(
      prisma,
      numbering,
      [line(20, 5), line(10, 100), line(10, 50)],
      '2026-09-16',
    );

    // 품목 오름차순 — 번호가 붙는 순서를 결정론으로 둔다.
    expect(prepared).toEqual([
      { requestNo: 'IRQ-20260916-0001', itemId: 10, uomId: 1, targetQty: 150, planVersionId: 77n },
      { requestNo: 'IRQ-20260916-0002', itemId: 20, uomId: 1, targetQty: 5, planVersionId: 77n },
    ]);
    expect(numbering.nextMany).toHaveBeenCalledWith('INSPECTION_REQUEST', null, '2026-09-16', 2);
  });

  it('필수 라인이 없으면 채번도 기준 조회도 하지 않는다', async () => {
    expect(await prepareOqcRequests(prisma, numbering, [line(10, 1, false)], '2026-09-16')).toEqual([]);
    expect(numbering.nextMany).not.toHaveBeenCalled();
    expect(prisma.inspection_plan_version.findMany).not.toHaveBeenCalled();
  });

  it('⛔ 유효한 기준이 없으면 400 STATE_LOCKED 로 편성을 막는다', async () => {
    (prisma.inspection_plan_version.findMany as jest.Mock).mockResolvedValueOnce([]);

    await expect(
      prepareOqcRequests(prisma, numbering, [line(10, 1)], '2026-09-16'),
    ).rejects.toMatchObject({ status: 400 });
    // 막힌 뒤에는 번호를 태우지 않는다.
    expect(numbering.nextMany).not.toHaveBeenCalled();
  });

  it('⛔ 기준이 둘이면 서버가 고르지 않고 막는다', async () => {
    (prisma.inspection_plan_version.findMany as jest.Mock).mockResolvedValueOnce([
      { inspection_plan_version_id: 77n },
      { inspection_plan_version_id: 78n },
    ]);

    await expect(
      prepareOqcRequests(prisma, numbering, [line(10, 1)], '2026-09-16'),
    ).rejects.toMatchObject({ status: 400 });
  });
});

describe('출하검사 의뢰 쓰기', () => {
  const prepared = [
    { requestNo: 'IRQ-1', itemId: 10, uomId: 1, targetQty: 150, planVersionId: 77n },
    { requestNo: 'IRQ-2', itemId: 20, uomId: 1, targetQty: 5, planVersionId: 78n },
  ];
  const tx = (existing: { item_id: bigint }[] = []) => ({
    inspection_request: {
      findMany: jest.fn().mockResolvedValue(existing),
      create: jest.fn().mockResolvedValue({ inspection_request_id: 1n }),
    },
  }) as unknown as Prisma.TransactionClient;

  it('헤더 대상 · lot_id 없이 · REQUESTED 로 세운다', async () => {
    const client = tx();
    await writeOqcRequests(client, 555n, prepared, 9, new Date('2026-09-16T00:00:00Z'));

    expect(client.inspection_request.create).toHaveBeenCalledTimes(2);
    const [[first]] = (client.inspection_request.create as jest.Mock).mock.calls;
    expect(first.data).toMatchObject({
      inspection_request_no: 'IRQ-1',
      inspection_type_code: 'OQC',
      inspection_plan_version_id: 77n,
      target_type_code: 'SHIPMENT_REQUEST',
      target_id: 555n,
      item_id: 10n,
      lot_id: null,
      target_qty: 150,
      uom_id: 1n,
      status_code: 'REQUESTED',
      created_by: 9,
    });
  });

  /** ⛔ OQC 에는 IQC 의 `uq_iqc_inspection_request_lot` 같은 DB 제약이 없다 — 서버가 지킨다. */
  it('같은 대상·품목에 REQUESTED 의뢰가 이미 있으면 그 품목만 건너뛴다', async () => {
    const client = tx([{ item_id: 10n }]);
    await writeOqcRequests(client, 555n, prepared, 9, new Date());

    expect(client.inspection_request.create).toHaveBeenCalledTimes(1);
    const [[only]] = (client.inspection_request.create as jest.Mock).mock.calls;
    expect(only.data.item_id).toBe(20n);
  });

  it('준비된 것이 없으면 조회조차 하지 않는다', async () => {
    const client = tx();
    await writeOqcRequests(client, 555n, [], 9, new Date());

    expect(client.inspection_request.findMany).not.toHaveBeenCalled();
  });
});
