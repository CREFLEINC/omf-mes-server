import type { Prisma } from '@prisma/client';

import { ContractException } from '../../common/errors';
import { InspectionSheetService } from './inspection-sheet.service';

/** omf-all-around#89 · 장부 P-102 — 시리얼로 검사표를 열고, 없으면 머리 값을 채워 만든다. */
const SERIAL = {
  item_id: 5n,
  lot_id: 40n,
  item: { item_code: 'AAR4WY1SJ4', erp_spec: 'WY5' },
  lot: { source_type_code: 'WORK_ORDER', source_id: 70n },
};
const TEMPLATE = {
  inspection_sheet_template_id: 11n,
  material_text: '방청 처리',
  structure_text: '(673)×(826)×(1085) 46kg',
  rohs_flag: true,
  product_name_text: null,
  power_text: null,
  motor_text: null,
  lot_sources: [
    { slot_code: 'PCB', item_id: 31n },
    { slot_code: 'SD', item_id: 32n },
  ],
};

function tx(
  options: { existing?: boolean; template?: unknown; consumptions?: unknown[]; inserted?: number; sameWorkOrderTemplate?: bigint } = {},
) {
  return {
    inspection_sheet: {
      findUnique: jest.fn().mockResolvedValue(options.existing ? { inspection_sheet_id: 9n } : null),
      findFirst: jest
        .fn()
        .mockResolvedValue(
          options.sameWorkOrderTemplate === undefined ? null : { inspection_sheet_template_id: options.sameWorkOrderTemplate },
        ),
      createMany: jest.fn().mockResolvedValue({ count: options.inserted ?? 1 }),
      findUniqueOrThrow: jest.fn().mockResolvedValue({ inspection_sheet_id: 9n }),
    },
    serial_number: { findUniqueOrThrow: jest.fn().mockResolvedValue(SERIAL) },
    inspection_sheet_template: {
      findFirst: jest.fn().mockResolvedValue(options.template === undefined ? TEMPLATE : options.template),
    },
    material_consumption: {
      findMany: jest.fn().mockResolvedValue(
        options.consumptions ?? [
          { item_id: 31n, lot: { lot_no: 'PCB-1' } },
          { item_id: 32n, lot: { lot_no: 'SD-1' } },
          { item_id: 32n, lot: { lot_no: 'SD-2' } },
        ],
      ),
    },
  };
}

const run = (client: ReturnType<typeof tx>) =>
  new InspectionSheetService().getOrCreateBySerial(client as unknown as Prisma.TransactionClient, 3n, { workerId: 8n });

describe('InspectionSheetService.getOrCreateBySerial', () => {
  it('이미 있으면 그 검사표를 돌려주고 만들지 않는다', async () => {
    const client = tx({ existing: true });

    await expect(run(client)).resolves.toEqual({ inspectionSheetId: 9n, created: false });
    expect(client.inspection_sheet.createMany).not.toHaveBeenCalled();
  });

  it('머리 값을 채워 만든다 — Model 은 품목 코드, 사양은 ERP SPEC, 고정 문구는 기준, 작성자는 단말 작업자', async () => {
    const client = tx();

    await expect(run(client)).resolves.toEqual({ inspectionSheetId: 9n, created: true });
    expect(client.inspection_sheet.createMany).toHaveBeenCalledWith({
      skipDuplicates: true,
      data: [
        expect.objectContaining({
          serial_number_id: 3n,
          inspection_sheet_template_id: 11n,
          lot_id: 40n,
          work_order_id: 70n,
          model_text: 'AAR4WY1SJ4',
          spec_text: 'WY5',
          material_text: '방청 처리',
          rohs_flag: true,
          written_worker_id: 8n,
        }),
      ],
    });
  });

  it('LOT 칸은 W/O 투입 LOT 이 하나일 때만 채우고, 여럿이면 비워 둔다', async () => {
    const client = tx();

    await run(client);

    expect(client.material_consumption.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { work_order_id: 70n, item_id: { in: [31n, 32n] } } }),
    );
    expect(client.inspection_sheet.createMany.mock.calls[0][0].data[0]).toMatchObject({
      pcb_lot_no: 'PCB-1',
      sd_lot_no: null,
      staple_lot_no: null,
    });
  });

  it('두 단말이 동시에 열어 유일 색인에 걸리면 먼저 선 검사표를 읽는다', async () => {
    const client = tx({ inserted: 0 });

    await expect(run(client)).resolves.toEqual({ inspectionSheetId: 9n, created: false });
  });

  it('모델의 확정 기준이 없으면 400 serialNo STATE_LOCKED 다', async () => {
    const client = tx({ template: null });
    const error = await run(client).catch((e: unknown) => e);

    expect((error as ContractException).errors[0]).toMatchObject({ field: 'serialNo', code: 'STATE_LOCKED' });
    expect(client.inspection_sheet.createMany).not.toHaveBeenCalled();
  });

  it('같은 W/O 의 두 번째 시리얼은 첫 검사표의 판을 쓴다 — 그 판이 폐기됐어도', async () => {
    const client = tx({ sameWorkOrderTemplate: 7n });

    await run(client);

    expect(client.inspection_sheet.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { work_order_id: 70n } }));
    expect(client.inspection_sheet_template.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { inspection_sheet_template_id: 7n } }),
    );
  });

  it('새 W/O 의 첫 시리얼은 그때의 확정판을 쓴다', async () => {
    const client = tx();

    await run(client);

    expect(client.inspection_sheet_template.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { item_id: 5n, status_code: 'CONFIRMED' } }),
    );
  });
});
