import { Prisma } from '@prisma/client';

import { ContractException, ErrorItem } from '../../common/errors';
import { NumberingService } from '../../core/numbering';
import { PrismaService } from '../../prisma/prisma.service';
import {
  MaterialIssueRequestCreate,
  MaterialIssueRequestService,
} from './material-issue-request.service';

interface Created {
  header: Record<string, unknown>;
  lines: Record<string, unknown>[];
}

/** W/O 한 행 + 마스터 전건 실재 + 사유 코드 한 값만 답하는 최소 스텁. */
function stub(options: { status?: string; reasonCodes?: string[] } = {}) {
  const created: Created = { header: {}, lines: [] };
  const header = {
    material_issue_request_id: 77n,
    issue_request_no: 'MIR-20260907-0001',
    work_order_id: 5n,
    destination_location_id: 9n,
    required_at: null,
    status_code: 'REGISTERED',
    requested_by: 3n,
    reason_code: null,
    remarks: null,
  };
  const prisma = {
    work_order: {
      findUnique: async () => ({
        status_code: options.status ?? 'RELEASED',
        production_plan: { production_order: { plant_id: 1n } },
      }),
    },
    location: { count: async () => 1 },
    item: { findMany: async () => [{ item_id: 10n }] },
    uom: { findMany: async () => [{ uom_id: 20n }] },
    bom_component: { findMany: async () => [] },
    code_value: {
      findMany: async () =>
        (options.reasonCodes ?? []).map((code) => ({
          code,
          code_group: { group_code: 'MATERIAL_ISSUE_REQUEST_REASON' },
        })),
    },
    $transaction: async (work: (tx: unknown) => Promise<unknown>) =>
      work({
        material_issue_request: {
          create: async ({ data }: { data: Record<string, unknown> }) => {
            created.header = data;
            return header;
          },
        },
        material_issue_request_line: {
          createMany: async ({ data }: { data: Record<string, unknown>[] }) => {
            created.lines = data;
            return { count: data.length };
          },
          findMany: async () =>
            created.lines.map((line, index) => ({
              material_issue_request_line_id: BigInt(index + 1),
              material_issue_request_id: 77n,
              line_no: line.line_no,
              bom_component_id: line.bom_component_id,
              item_id: BigInt(line.item_id as number),
              requested_qty: new Prisma.Decimal(line.requested_qty as number),
              issued_qty: new Prisma.Decimal(0),
              uom_id: BigInt(line.uom_id as number),
            })),
        },
      }),
  };
  const periods: string[] = [];
  const numbering = {
    next: async (_type: string, _plantId: bigint, periodDate: string) => {
      periods.push(periodDate);
      return 'MIR-20260907-0001';
    },
  };
  return {
    service: new MaterialIssueRequestService(
      prisma as unknown as PrismaService,
      numbering as unknown as NumberingService,
    ),
    created,
    periods,
  };
}

function body(overrides: Partial<MaterialIssueRequestCreate> = {}): MaterialIssueRequestCreate {
  return {
    workOrderId: 5,
    destinationLocationId: 9,
    lines: [{ itemId: 10, requestedQty: 12, uomId: 20 }],
    businessDate: '2026-09-07',
    occurredAt: '2026-09-07T03:00:00.000Z',
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

describe('자재 출고요청 발행', () => {
  it('lines 가 비면 400 LINE_REQUIRED', async () => {
    const { service } = stub();

    const errors = await errorsOf(service.create(body({ lines: [] }), 3));

    expect(errors[0]).toMatchObject({ field: 'lines', code: 'LINE_REQUIRED' });
  });

  it('requestedQty 가 0 이면 400 RANGE', async () => {
    const { service } = stub();

    const errors = await errorsOf(
      service.create(body({ lines: [{ itemId: 10, requestedQty: 0, uomId: 20 }] }), 3),
    );

    // 오류가 짚는 자리는 배열 안이다 — 화면이 그 줄을 붉힌다.
    expect(errors[0]).toMatchObject({ field: 'lines[0].requestedQty', code: 'RANGE' });
  });

  it('reasonCode 는 필수가 아니다', async () => {
    const { service, created } = stub();

    const detail = await service.create(body(), 3);

    expect(created.header).toMatchObject({ reason_code: null, status_code: 'REGISTERED' });
    // 주체는 세션 계정이다(R-12) · 라인 번호는 서버가 1..M 으로 매긴다.
    expect(created.header).toMatchObject({ requested_by: 3 });
    expect(created.lines[0]).toMatchObject({ line_no: 1, bom_component_id: null });
    expect(detail.materialIssueRequest.statusCode).toBe('REGISTERED');
  });

  it('reasonCode 값이 목록 밖이면 400', async () => {
    const { service } = stub({ reasonCodes: ['URGENT_WO_RESPONSE'] });

    const errors = await errorsOf(service.create(body({ reasonCode: 'NO_SUCH' }), 3));

    expect(errors[0]).toMatchObject({ field: 'reasonCode', code: 'INVALID' });
    await expect(service.create(body({ reasonCode: 'URGENT_WO_RESPONSE' }), 3)).resolves.toBeDefined();
  });

  it('취소된 W/O 면 400 STATE_LOCKED', async () => {
    for (const status of ['CANCELLED', 'CLOSED']) {
      const { service } = stub({ status });

      const errors = await errorsOf(service.create(body(), 3));

      expect(errors[0]).toMatchObject({ field: 'workOrderId', code: 'STATE_LOCKED' });
    }
  });

  it('COMPLETED 인 W/O 에는 요청이 선다', async () => {
    // 마감 전이라 정정 출고가 선다 — 거부하면 업무를 없앤다(R-13).
    const { service, created } = stub({ status: 'COMPLETED' });

    await service.create(body(), 3);

    expect(created.header).toMatchObject({ work_order_id: 5 });
  });

  it('businessDate 는 형식만 본다', async () => {
    const { service } = stub();

    const errors = await errorsOf(service.create(body({ businessDate: '2026-13-39' }), 3));
    expect(errors[0]).toMatchObject({ field: 'businessDate', code: 'INVALID' });

    // ⛔ 형식이 맞으면 그대로 채번의 기간 축이 되고 «저장은 안 된다» — 담을 칸이 없다(C-8).
    const passing = stub();
    await passing.service.create(body({ businessDate: '2026-09-07' }), 3);
    expect(passing.periods).toEqual(['2026-09-07']);
    expect(Object.keys(passing.created.header)).not.toContain('business_date');
  });
});
