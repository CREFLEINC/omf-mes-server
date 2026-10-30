import { NotFoundException } from '@nestjs/common';

import { ConflictException, ContractException } from '../../common/errors';
import { PrismaService } from '../../prisma/prisma.service';
import {
  InspectionSheetTemplateCreate,
  InspectionSheetTemplateService,
} from './inspection-sheet-template.service';

/** omf-all-around#89 · 장부 P-102 — OA 제품 검사표 기준. */
const ACTOR = { userId: 7 };
const STEP_CODES = ['PROCESS_1', 'PROCESS_2', 'PROCESS_3', 'PROCESS_4', 'PROCESS_5', 'SHIPMENT', 'CROSS_CHECK', 'SAMPLING'];

const DETAIL_ROW = {
  inspection_sheet_template_id: 11n,
  item_id: 5n,
  template_version: 2,
  business_unit_id: 2n,
  form_layout_code: 'OP',
  status_code: 'DRAFT',
  material_text: null,
  structure_text: null,
  rohs_flag: true,
  product_name_text: null,
  power_text: null,
  motor_text: null,
  remarks: null,
  confirmed_by: null,
  confirmed_at: null,
  version_no: 3,
  item: { item_code: 'AAR4', item_name: 'AAR4 본체' },
  lot_sources: [],
  steps: [],
};

function input(overrides: Partial<InspectionSheetTemplateCreate> = {}): InspectionSheetTemplateCreate {
  return {
    itemId: 5,
    businessUnitId: 2,
    formLayoutCode: 'OP',
    rohsFlag: true,
    lotSources: [{ slotCode: 'PCB', itemId: 30 }],
    steps: [
      {
        stepCode: 'PROCESS_1',
        nameKo: '공정검사1',
        signRequired: true,
        items: [{ checkItemCode: 'S 403', nameKo: '배선의 감김(정리) 상태', methodCode: 'FULL' }],
      },
    ],
    ...overrides,
  };
}

function harness(row: { status_code: string; business_unit_id: bigint } | null = null, stepCount = 1) {
  const tx = {
    inspection_sheet_template: {
      aggregate: jest.fn().mockResolvedValue({ _max: { template_version: 1 } }),
      create: jest.fn().mockResolvedValue({ inspection_sheet_template_id: 11n }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findMany: jest.fn().mockResolvedValue([]),
      delete: jest.fn(),
    },
    inspection_sheet_template_lot_source: { createMany: jest.fn(), deleteMany: jest.fn() },
    inspection_sheet_template_step: { create: jest.fn(), deleteMany: jest.fn(), findMany: jest.fn().mockResolvedValue([]) },
    inspection_sheet_template_item: { deleteMany: jest.fn() },
    inspection_sheet: { count: jest.fn().mockResolvedValue(0) },
    audit_event: { create: jest.fn() },
    $queryRaw: jest.fn().mockResolvedValue(row === null ? [] : [{ status_code: row.status_code, template_version: 2 }]),
  };
  const prisma = {
    inspection_sheet_template: {
      findUnique: jest.fn().mockImplementation(({ include }: { include?: unknown }) =>
        Promise.resolve(
          include === undefined
            ? row && { item_id: 5n, form_layout_code: 'OP', ...row }
            : DETAIL_ROW,
        ),
      ),
    },
    inspection_sheet_template_step: { count: jest.fn().mockResolvedValue(stepCount) },
    code_value: {
      findMany: jest.fn().mockImplementation(({ where }: { where: { OR: { code: string }[] } }) =>
        Promise.resolve(
          where.OR.filter((c) => STEP_CODES.includes(c.code)).map((c) => ({
            code: c.code,
            code_group: { group_code: 'INSPECTION_SHEET_STEP' },
          })),
        ),
      ),
    },
    $transaction: jest.fn().mockImplementation((work: (client: typeof tx) => unknown) => work(tx)),
  };
  return { service: new InspectionSheetTemplateService(prisma as unknown as PrismaService), prisma, tx };
}

const failure = (error: unknown) => error as ContractException;

describe('InspectionSheetTemplateService', () => {
  it('생성은 같은 모델의 다음 판 번호로 작성중 기준을 세우고 단계·항목·LOT 칸을 함께 쓴다', async () => {
    const { service, tx } = harness();

    await service.create(input(), ACTOR);

    expect(tx.inspection_sheet_template.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ item_id: 5, template_version: 2, created_by: 7 }) }),
    );
    expect(tx.inspection_sheet_template_lot_source.createMany).toHaveBeenCalled();
    expect(tx.inspection_sheet_template_step.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        step_code: 'PROCESS_1',
        sequence_no: 1,
        sign_required: true,
        items: { create: [expect.objectContaining({ sequence_no: 1, check_item_code: 'S 403', method_code: 'FULL' })] },
      }),
    });
  });



  it('확정된 기준은 고칠 수 없다 — 400 STATE_LOCKED', async () => {
    const { service, tx } = harness({ status_code: 'CONFIRMED', business_unit_id: 2n });
    const error = await service.update(11, 3, input(), ACTOR).catch((e: unknown) => e);

    expect(failure(error).errors[0]).toMatchObject({ code: 'STATE_LOCKED' });
    expect(tx.inspection_sheet_template.updateMany).not.toHaveBeenCalled();
  });

  it('작성중 기준의 수정은 하위 줄을 지우고 다시 쓴다', async () => {
    const { service, tx } = harness({ status_code: 'DRAFT', business_unit_id: 2n });

    await service.update(11, 3, input(), ACTOR);

    expect(tx.inspection_sheet_template.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { inspection_sheet_template_id: 11, version_no: 3, status_code: 'DRAFT' } }),
    );
    expect(tx.inspection_sheet_template_step.deleteMany).toHaveBeenCalled();
    expect(tx.inspection_sheet_template_step.create).toHaveBeenCalledTimes(1);
  });

  it('잠금 버전이 다르면 409 다', async () => {
    const { service, tx } = harness({ status_code: 'DRAFT', business_unit_id: 2n });
    tx.inspection_sheet_template.updateMany.mockResolvedValue({ count: 0 });

    await expect(service.update(11, 2, input(), ACTOR)).rejects.toBeInstanceOf(ConflictException);
  });

  it('같은 단계를 두 번 두면 400 이다', async () => {
    const { service } = harness();
    const step = input().steps[0];
    const error = await service.create(input({ steps: [step, step] }), ACTOR).catch((e: unknown) => e);

    expect(failure(error).errors[0]).toMatchObject({ field: 'steps[1].stepCode', code: 'UNIQUE_VIOLATION' });
  });

  it('양식에 칸이 없는 단계는 400 이다 — PP 양식에 공정검사4', async () => {
    const { service } = harness();
    const steps = [{ ...input().steps[0], stepCode: 'PROCESS_4' }];
    const error = await service.create(input({ formLayoutCode: 'PP', steps }), ACTOR).catch((e: unknown) => e);

    expect(failure(error).errors[0]).toMatchObject({ field: 'steps[0].stepCode', code: 'INVALID' });
  });

  it('단계 코드가 공통코드에 없으면 400 이다', async () => {
    const { service, prisma } = harness();
    prisma.code_value.findMany.mockResolvedValue([]);

    await expect(service.create(input(), ACTOR)).rejects.toBeInstanceOf(ContractException);
  });

  it('단계가 없으면 확정할 수 없다 — 400 steps REQUIRED', async () => {
    const { service } = harness({ status_code: 'DRAFT', business_unit_id: 2n }, 0);
    const error = await service.confirm(11, 3, ACTOR).catch((e: unknown) => e);

    expect(failure(error).errors[0]).toMatchObject({ field: 'steps', code: 'REQUIRED' });
  });

  it('확정은 같은 모델의 앞 확정본을 폐기로 내리고 확정자를 남긴다', async () => {
    const { service, tx } = harness({ status_code: 'DRAFT', business_unit_id: 2n });

    await service.confirm(11, 3, ACTOR);

    expect(tx.inspection_sheet_template.updateMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ where: { item_id: 5n, status_code: 'CONFIRMED' }, data: expect.objectContaining({ status_code: 'OBSOLETE' }) }),
    );
    expect(tx.inspection_sheet_template.updateMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ data: expect.objectContaining({ status_code: 'CONFIRMED', confirmed_by: 7 }) }),
    );
  });

  describe('변경 이력 · 작성 취소 · 폐기 (omf-all-around#214)', () => {
    const audits = (tx: ReturnType<typeof harness>['tx']) =>
      (tx.audit_event.create.mock.calls as [{ data: Record<string, unknown> }][]).map(([arg]) => arg.data);

    it('생성은 CREATE 이력을 남긴다 — 대상은 검사표 기준 버전', async () => {
      const { service, tx } = harness();

      await service.create(input(), ACTOR);

      expect(audits(tx)).toEqual([
        expect.objectContaining({
          target_type_code: 'INSPECTION_SHEET_TEMPLATE',
          target_id: 11n,
          event_type_code: 'CREATE',
          performed_by: 7n,
          after_value: { templateVersion: 2, formLayoutCode: 'OP', statusCode: 'DRAFT' },
        }),
      ]);
    });

    it('수정은 바뀐 키만 남긴다 — 단계는 배열 통째로', async () => {
      const { service, tx } = harness({ status_code: 'DRAFT', business_unit_id: 2n });

      await service.update(11, 3, input({ remarks: '비고' }), ACTOR);

      const [data] = audits(tx);
      expect(data).toMatchObject({ event_type_code: 'UPDATE' });
      expect(Object.keys(data.after_value as object).sort()).toEqual(['lotSources', 'remarks', 'steps']);
      expect(data.before_value).toMatchObject({ remarks: null, steps: [], lotSources: [] });
    });

    it('내용이 같으면 수정 이력을 남기지 않는다', async () => {
      const { service, tx } = harness({ status_code: 'DRAFT', business_unit_id: 2n });

      await service.update(11, 3, input({ steps: [], lotSources: [] }), ACTOR);

      expect(tx.audit_event.create).not.toHaveBeenCalled();
    });

    it('확정은 앞 확정본의 폐기와 이 버전의 확정을 이력으로 남긴다', async () => {
      const { service, tx } = harness({ status_code: 'DRAFT', business_unit_id: 2n });
      tx.inspection_sheet_template.findMany.mockResolvedValue([{ inspection_sheet_template_id: 9n }]);

      await service.confirm(11, 3, ACTOR);

      expect(audits(tx)).toEqual([
        expect.objectContaining({ target_id: 9n, before_value: { statusCode: 'CONFIRMED' }, after_value: { statusCode: 'OBSOLETE' } }),
        expect.objectContaining({ target_id: 11n, before_value: { statusCode: 'DRAFT' }, after_value: { statusCode: 'CONFIRMED' } }),
      ]);
    });

    it('폐기는 확정본만 — 상태를 내리고 이력을 남긴다', async () => {
      const { service, tx } = harness({ status_code: 'CONFIRMED', business_unit_id: 2n });

      await service.obsolete(11, 3, ACTOR);

      expect(tx.inspection_sheet_template.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { inspection_sheet_template_id: 11, version_no: 3, status_code: 'CONFIRMED' },
          data: expect.objectContaining({ status_code: 'OBSOLETE' }),
        }),
      );
      expect(audits(tx)).toEqual([expect.objectContaining({ after_value: { statusCode: 'OBSOLETE' } })]);
    });

    it('작성중 기준은 폐기할 수 없다 — 400 STATE_LOCKED', async () => {
      const { service, tx } = harness({ status_code: 'DRAFT', business_unit_id: 2n });
      const error = await service.obsolete(11, 3, ACTOR).catch((e: unknown) => e);

      expect(failure(error).errors[0]).toMatchObject({ code: 'STATE_LOCKED' });
      expect(tx.inspection_sheet_template.updateMany).not.toHaveBeenCalled();
    });

    it('작성 취소는 하위 줄과 기준을 지우고 DELETE 이력을 남긴다', async () => {
      const { service, tx } = harness({ status_code: 'DRAFT', business_unit_id: 2n });

      await service.discard(11, ACTOR);

      expect(tx.inspection_sheet_template_item.deleteMany).toHaveBeenCalled();
      expect(tx.inspection_sheet_template_step.deleteMany).toHaveBeenCalled();
      expect(tx.inspection_sheet_template_lot_source.deleteMany).toHaveBeenCalled();
      expect(tx.inspection_sheet_template.delete).toHaveBeenCalledWith({ where: { inspection_sheet_template_id: 11 } });
      expect(audits(tx)).toEqual([
        expect.objectContaining({ event_type_code: 'DELETE', before_value: { templateVersion: 2, statusCode: 'DRAFT' } }),
      ]);
    });

    it('확정 · 폐기 버전은 작성 취소할 수 없다 — 400 STATE_LOCKED', async () => {
      for (const status of ['CONFIRMED', 'OBSOLETE']) {
        const { service, tx } = harness({ status_code: status, business_unit_id: 2n });
        const error = await service.discard(11, ACTOR).catch((e: unknown) => e);

        expect(failure(error).errors[0]).toMatchObject({ code: 'STATE_LOCKED' });
        expect(tx.inspection_sheet_template.delete).not.toHaveBeenCalled();
      }
    });

    it('이 기준으로 만든 검사표가 있으면 작성 취소할 수 없다', async () => {
      const { service, tx } = harness({ status_code: 'DRAFT', business_unit_id: 2n });
      tx.inspection_sheet.count.mockResolvedValue(1);
      const error = await service.discard(11, ACTOR).catch((e: unknown) => e);

      expect(failure(error).errors[0]).toMatchObject({ code: 'STATE_LOCKED' });
      expect(tx.inspection_sheet_template.delete).not.toHaveBeenCalled();
    });

    it('없는 기준의 작성 취소는 404 다', async () => {
      const { service } = harness(null);

      await expect(service.discard(11, ACTOR)).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
