import { Prisma } from '@prisma/client';

import { ContractException, ErrorItem } from '../../common/errors';
import { NumberingService } from '../../core/numbering';
import { PrismaService } from '../../prisma/prisma.service';
import { ShopfloorReceiptCreate, ShopfloorReceiptService } from './shopfloor-receipt.service';

interface Created {
  header: Record<string, unknown>;
  lines: Record<string, unknown>[];
}

interface StubOptions {
  issueStatus?: string | null;
  issueMissing?: boolean;
  workOrderMissing?: boolean;
  locationMissing?: boolean;
  reasonCodes?: string[];
  goodsIssueLine?: { goods_issue_line_id: bigint; item_id: bigint; lot_id: bigint; uom_id: bigint; issue_qty: number };
  auditFails?: boolean;
}

/** 출고 라인 하나(id=1 · itemId=10 · lotId=20 · uomId=30 · issueQty=100) + W/O 공장 1 + 위치 실재. */
function stub(options: StubOptions = {}) {
  const created: Created = { header: {}, lines: [] };
  const calls: string[] = [];
  let committed = false;
  const line =
    options.goodsIssueLine ?? { goods_issue_line_id: 1n, item_id: 10n, lot_id: 20n, uom_id: 30n, issue_qty: 100 };

  const prisma = {
    goods_issue: {
      findUnique: async () => {
        calls.push('goods_issue');
        if (options.issueMissing) return null;
        return {
          status_code: options.issueStatus ?? 'POSTED',
          goods_issue_line: [{ ...line, issue_qty: new Prisma.Decimal(line.issue_qty) }],
        };
      },
    },
    work_order: {
      findUnique: async () =>
        options.workOrderMissing ? null : { production_plan: { production_order: { plant_id: 1n } } },
    },
    location: { count: async () => (options.locationMissing ? 0 : 1) },
    code_value: {
      findMany: async () =>
        (options.reasonCodes ?? []).map((code) => ({ code, code_group: { group_code: 'VARIANCE_REASON' } })),
    },
    $transaction: async (work: (tx: unknown) => Promise<unknown>) => {
      calls.push('transaction');
      const result = await work({
        worker: { findFirst: async () => ({ worker_id: 8n }) },
        terminal: { findFirst: async () => ({ terminal_id: 4n }) },
        audit_event: { create: async () => {
          calls.push('audit');
          if (options.auditFails) throw new Error('audit unavailable');
          return {};
        } },
        $queryRaw: async () => [{ status_code: 'POSTED' }],
        shopfloor_receipt: {
          count: async () => 0,
          create: async ({ data }: { data: Record<string, unknown> }) => {
            created.header = data;
            return { shopfloor_receipt_id: 501n, ...data };
          },
          findUniqueOrThrow: async () => ({
            shopfloor_receipt_id: 501n,
            shopfloor_receipt_no: created.header.shopfloor_receipt_no,
            goods_issue_id: created.header.goods_issue_id,
            work_order_id: created.header.work_order_id,
            destination_location_id: created.header.destination_location_id,
            received_at: created.header.received_at,
            received_by: created.header.received_by,
            status_code: created.header.status_code,
            shopfloor_receipt_line: created.lines.map((row, index) => ({
              shopfloor_receipt_line_id: BigInt(index + 1),
              shopfloor_receipt_id: 501n,
              goods_issue_line_id: BigInt(row.goods_issue_line_id as number),
              item_id: BigInt(row.item_id as number),
              lot_id: BigInt(row.lot_id as number),
              item: { item_code: 'SR-IT', item_name: '생산창고입고검사품목' },
              lot: { lot_no: 'SR-LOT' },
              issued_qty: new Prisma.Decimal(row.issued_qty as number),
              received_qty: new Prisma.Decimal(row.received_qty as number),
              variance_qty: new Prisma.Decimal((row.issued_qty as number) - (row.received_qty as number)),
              uom_id: BigInt(row.uom_id as number),
              variance_reason_code: row.variance_reason_code,
            })),
          }),
        },
        shopfloor_receipt_line: {
          createMany: async ({ data }: { data: Record<string, unknown>[] }) => {
            created.lines = data;
            return { count: data.length };
          },
        },
      });
      committed = true;
      return result;
    },
  };

  const periods: string[] = [];
  const numbering = {
    next: async (_type: string, _plantId: bigint, periodDate: string) => {
      calls.push('numbering');
      periods.push(periodDate);
      return 'SR-20260907-0001';
    },
  };

  return {
    service: new ShopfloorReceiptService(prisma as unknown as PrismaService, numbering as unknown as NumberingService),
    created,
    calls,
    periods,
    committed: () => committed,
  };
}

function body(overrides: Partial<ShopfloorReceiptCreate> = {}): ShopfloorReceiptCreate {
  return {
    goodsIssueId: 1,
    workOrderId: 5,
    destinationLocationId: 9,
    receivedAt: '2026-09-07T03:00:00.000Z',
    businessDate: '2026-09-07',
    occurredAt: '2026-09-07T02:00:00.000Z',
    lines: [{ goodsIssueLineId: 1, itemId: 10, lotId: 20, uomId: 30, issuedQty: 100, receivedQty: 100 }],
    ...overrides,
  };
}

async function errorsOf(work: Promise<unknown>): Promise<ErrorItem[]> {
  try {
    await work;
  } catch (error) {
    if (error instanceof ContractException) return error.errors;
    throw error;
  }
  throw new Error('400 이 나지 않았다');
}

describe('생산창고 입고 등록', () => {
  const terminalActor = { workerId: 8n, terminalAudit: {
    workerId: 8n, workerNo: 'W001', terminalId: 4n, plantId: 1n,
    correlationId: 'shopfloor-1', operationKey: 'POST /logistics/shopfloor-receipts',
  } };

  it('연결 계정 없는 작업자 입고도 같은 트랜잭션 감사가 있어야 커밋한다', async () => {
    const ok = stub();
    await ok.service.create(body(), terminalActor, 'W001');
    expect(ok.created.header).toMatchObject({ created_by: null, received_by: null });
    expect(ok.calls).toContain('audit');
    expect(ok.committed()).toBe(true);

    const failed = stub({ auditFails: true });
    await expect(failed.service.create(body(), terminalActor, 'W001')).rejects.toThrow('audit unavailable');
    expect(failed.committed()).toBe(false);
  });
  it('lines 가 비면 400 LINE_REQUIRED', async () => {
    // ⭐ 계약에 minItems 가 없어 가드가 안 막는다 — 서비스가 유일한 방어다(§1-3).
    const { service } = stub();

    const errors = await errorsOf(service.create(body({ lines: [] }), 3, 'W001'));

    expect(errors[0]).toMatchObject({ field: 'lines', code: 'LINE_REQUIRED' });
  });

  it('출고 라인을 빠뜨리면 400 LINE_REQUIRED', async () => {
    // R-1 — 본문 라인 = 그 출고의 goods_issue_line 전건. 여기선 라인 자체가 1건뿐이라
    // «다른 라인 id 를 보내» 전건 밖으로 만든다.
    const { service } = stub();

    const errors = await errorsOf(
      service.create(
        body({ lines: [{ goodsIssueLineId: 999, itemId: 10, lotId: 20, uomId: 30, issuedQty: 100, receivedQty: 100 }] }),
        3,
        'W001',
      ),
    );

    expect(errors).toContainEqual(expect.objectContaining({ field: 'lines', code: 'LINE_REQUIRED' }));
  });

  it('본문에 같은 goodsIssueLineId 가 두 번 오면 400 INVALID', async () => {
    const { service } = stub();

    const errors = await errorsOf(
      service.create(
        body({
          lines: [
            { goodsIssueLineId: 1, itemId: 10, lotId: 20, uomId: 30, issuedQty: 100, receivedQty: 100 },
            { goodsIssueLineId: 1, itemId: 10, lotId: 20, uomId: 30, issuedQty: 100, receivedQty: 100 },
          ],
        }),
        3,
        'W001',
      ),
    );

    expect(errors).toContainEqual(
      expect.objectContaining({ field: 'lines[1].goodsIssueLineId', code: 'INVALID' }),
    );
  });

  it('issuedQty 가 출고 라인의 issue_qty 와 다르면 400 INVALID', async () => {
    // 대조이지 덮어쓰기가 아니다 — 설계 미정 — 문의 049(R-3·R-6 재부여).
    const { service } = stub();

    const errors = await errorsOf(
      service.create(
        body({ lines: [{ goodsIssueLineId: 1, itemId: 10, lotId: 20, uomId: 30, issuedQty: 90, receivedQty: 90 }] }),
        3,
        'W001',
      ),
    );

    expect(errors).toContainEqual(expect.objectContaining({ field: 'lines[0].issuedQty', code: 'INVALID' }));
  });

  it('itemId·lotId·uomId 가 출고 라인과 다르면 400 INVALID', async () => {
    const { service } = stub();

    const errors = await errorsOf(
      service.create(
        body({
          lines: [{ goodsIssueLineId: 1, itemId: 11, lotId: 21, uomId: 31, issuedQty: 100, receivedQty: 100 }],
        }),
        3,
        'W001',
      ),
    );

    expect(errors).toContainEqual(expect.objectContaining({ field: 'lines[0].itemId', code: 'INVALID' }));
    expect(errors).toContainEqual(expect.objectContaining({ field: 'lines[0].lotId', code: 'INVALID' }));
    expect(errors).toContainEqual(expect.objectContaining({ field: 'lines[0].uomId', code: 'INVALID' }));
  });

  it('receivedQty 가 issuedQty 를 넘으면 400 RANGE', async () => {
    const { service } = stub();

    const errors = await errorsOf(
      service.create(
        body({
          lines: [{ goodsIssueLineId: 1, itemId: 10, lotId: 20, uomId: 30, issuedQty: 100, receivedQty: 120 }],
        }),
        3,
        'W001',
      ),
    );

    expect(errors[0]).toMatchObject({ field: 'lines[0].receivedQty', code: 'RANGE' });
  });

  it('차이가 0 이 아닌데 varianceReasonCode 가 없으면 400 REQUIRED', async () => {
    const { service } = stub();

    const errors = await errorsOf(
      service.create(
        body({
          lines: [{ goodsIssueLineId: 1, itemId: 10, lotId: 20, uomId: 30, issuedQty: 100, receivedQty: 60 }],
        }),
        3,
        'W001',
      ),
    );

    expect(errors[0]).toMatchObject({ field: 'lines[0].varianceReasonCode', code: 'REQUIRED' });
  });

  it('차이가 0 인데 varianceReasonCode 가 오면 400 INVALID', async () => {
    // 계약 미기재 갈래 — 알려둘 것 ⓟ(R-5).
    const { service } = stub();

    const errors = await errorsOf(
      service.create(
        body({
          lines: [
            {
              goodsIssueLineId: 1,
              itemId: 10,
              lotId: 20,
              uomId: 30,
              issuedQty: 100,
              receivedQty: 100,
              varianceReasonCode: 'SPILL',
            },
          ],
        }),
        3,
        'W001',
      ),
    );

    expect(errors[0]).toMatchObject({ field: 'lines[0].varianceReasonCode', code: 'INVALID' });
  });

  it('varianceReasonCode 가 VARIANCE_REASON 밖이면 400 INVALID', async () => {
    const { service } = stub({ reasonCodes: ['SPILL'] });

    const errors = await errorsOf(
      service.create(
        body({
          lines: [
            {
              goodsIssueLineId: 1,
              itemId: 10,
              lotId: 20,
              uomId: 30,
              issuedQty: 100,
              receivedQty: 60,
              varianceReasonCode: 'NO_SUCH',
            },
          ],
        }),
        3,
        'W001',
      ),
    );

    expect(errors[0]).toMatchObject({ field: 'lines[0].varianceReasonCode', code: 'INVALID' });

    const ok = stub({ reasonCodes: ['SPILL'] });
    await expect(
      ok.service.create(
        body({
          lines: [
            {
              goodsIssueLineId: 1,
              itemId: 10,
              lotId: 20,
              uomId: 30,
              issuedQty: 100,
              receivedQty: 60,
              varianceReasonCode: 'SPILL',
            },
          ],
        }),
        3,
        'W001',
      ),
    ).resolves.toBeDefined();
  });

  it('출고가 POSTED 가 아니면 400 STATE_LOCKED', async () => {
    for (const status of ['REGISTERED', 'CANCEL_REQUESTED', 'CANCELLED']) {
      const { service } = stub({ issueStatus: status });

      const errors = await errorsOf(service.create(body(), 3, 'W001'));

      expect(errors[0]).toMatchObject({ field: 'goodsIssueId', code: 'STATE_LOCKED' });
    }
  });

  it('X-Worker-No 가 없으면 400 REQUIRED 이고 저장하지 않는다', async () => {
    const { service, calls } = stub();

    const errors = await errorsOf(service.create(body(), 3, undefined));

    expect(errors[0]).toMatchObject({ field: 'X-Worker-No', code: 'REQUIRED' });
    // 부재 판정이 DB 왕복보다 먼저다 — 조회조차 안 나간다.
    expect(calls).toEqual([]);
  });

  it('businessDate 는 형식만 본다 — 저장 칸이 없다', async () => {
    const { service } = stub();

    const errors = await errorsOf(service.create(body({ businessDate: '2026-13-39' }), 3, 'W001'));
    expect(errors[0]).toMatchObject({ field: 'businessDate', code: 'INVALID' });

    const passing = stub();
    await passing.service.create(body({ businessDate: '2026-09-07' }), 3, 'W001');
    expect(passing.periods).toEqual(['2026-09-07']);
    expect(Object.keys(passing.created.header)).not.toContain('business_date');
  });

  it('번호를 $transaction 밖에서 뽑는다', async () => {
    const { service, calls } = stub();

    await service.create(body(), 3, 'W001');

    expect(calls.indexOf('numbering')).toBeLessThan(calls.indexOf('transaction'));
  });

  it('status_code 는 REGISTERED 로 태어난다', async () => {
    const { service, created } = stub();

    await service.create(body(), 3, 'W001');

    expect(created.header).toMatchObject({ status_code: 'REGISTERED', received_by: 3 });
  });
});
