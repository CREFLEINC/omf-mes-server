import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE, ErrorItem } from '../../common/errors';
import {
  Editability,
  Referrer,
  SEQ_PARKING_OFFSET,
  assertCodeValues,
  assertNotBlank,
  countReferences,
  optional,
  optionalDate,
  toDateString,
} from '../../common/master';
import { assertUpdated } from '../../common/optimistic-lock';
import { PrismaService } from '../../prisma/prisma.service';
import { TerminalQualityReadScope, terminalQualityWorkOrderWhere } from '../../auth/terminal-quality-read-scope';
import { REVISION_STATUS } from '../../planning/revision-status';

/** `quality.inspection_plan_version` 을 FK 로 가리키는 자리 전부. e2e 가 대조한다. */
export const PLAN_VERSION_REFERRERS: readonly Referrer[] = [
  ['quality.inspection_item_spec', 'inspection_plan_version_id'],
  ['quality.inspection_request', 'inspection_plan_version_id'],
];

/** 계약 `InspectionPlanVersion` 과 동형. */
interface VersionView {
  inspectionPlanVersionId: number;
  inspectionPlanId: number;
  planVersion: number;
  effectiveFrom: string;
  effectiveTo: string | null;
  samplingMethodCode: string;
  aqlValue: number | null;
  acceptanceNumber: number | null;
  rejectionNumber: number | null;
  inspectionFrequencyCode: string;
  frequencyIntervalValue: number | null;
  frequencyIntervalUomCode: string | null;
  statusCode: string;
  samplingRatio: number | null;
}

export interface VersionWrite {
  effectiveFrom: string;
  effectiveTo?: string | null;
  samplingMethodCode: string;
  aqlValue?: number | null;
  acceptanceNumber?: number | null;
  rejectionNumber?: number | null;
  inspectionFrequencyCode: string;
  frequencyIntervalValue?: number | null;
  frequencyIntervalUomCode?: string | null;
  samplingRatio?: number | null;
}

export interface VersionCreate extends VersionWrite {
  inspectionPlanId: number;
}

/** 계약 `InspectionItemSpec` 과 동형. */
interface ItemSpecView {
  inspectionItemSpecId: number;
  inspectionPlanVersionId: number;
  sequenceNo: number;
  inspectionItemCode: string;
  inspectionItemName: string;
  nameKo: string | null;
  nameVi: string | null;
  dataTypeCode: string;
  uomId: number | null;
  targetValue: number | null;
  lowerLimit: number | null;
  upperLimit: number | null;
  measurementCount: number;
  inspectionMethodCode: string | null;
  defaultInspectionEquipmentId: number | null;
  requiredFlag: boolean;
  automaticJudgment: boolean;
}

export interface ItemSpecUpsert {
  inspectionItemSpecId?: number;
  inspectionPlanVersionId: number;
  sequenceNo: number;
  inspectionItemCode: string;
  inspectionItemName: string;
  nameKo?: string | null;
  nameVi?: string | null;
  dataTypeCode: string;
  uomId?: number | null;
  targetValue?: number | null;
  lowerLimit?: number | null;
  upperLimit?: number | null;
  measurementCount: number;
  inspectionMethodCode?: string | null;
  defaultInspectionEquipmentId?: number | null;
  requiredFlag: boolean;
  automaticJudgment: boolean;
}

type VersionRow = Prisma.inspection_plan_versionGetPayload<object>;
type SpecRow = Prisma.inspection_item_specGetPayload<object>;

export interface VersionResult {
  inspectionPlanVersion: VersionView;
  editability: Editability;
  versionNo: number;
}

/** 검사기준 버전. 화면은 `W-06-02` 의 버전 목록·상세다. */
@Injectable()
export class InspectionPlanVersionService {
  constructor(private readonly prisma: PrismaService) {}

  /** 「최신이 위」 — Routing Rev 목록과 같은 형태다. 상태를 가리지 않고 전부 낸다. */
  async list(inspectionPlanId: number): Promise<VersionView[]> {
    const rows = await this.prisma.inspection_plan_version.findMany({
      where: { inspection_plan_id: inspectionPlanId },
      orderBy: { plan_version: 'desc' },
    });
    return rows.map(view);
  }

  async get(versionId: number, scope?: TerminalQualityReadScope): Promise<VersionResult> {
    const row = await this.load(versionId, scope);
    const referenceCount = await countReferences(
      this.prisma,
      PLAN_VERSION_REFERRERS,
      row.inspection_plan_version_id,
    );
    return {
      inspectionPlanVersion: view(row),
      editability: {
        codeEditable: referenceCount === 0,
        reason: referenceCount === 0 ? 'EDITABLE' : 'REFERENCED',
        referenceCount,
      },
      versionNo: row.version_no,
    };
  }

  /** 「기준에 아직 버전이 하나도 없을 때만 쓴다」(계약). 두 번째부터는 `:new-revision`. */
  async create(input: VersionCreate): Promise<VersionView> {
    await this.assertWritable(input);
    const plan = await this.prisma.inspection_plan.findUnique({
      where: { inspection_plan_id: input.inspectionPlanId },
      select: { inspection_plan_id: true },
    });
    if (!plan) {
      throw new ContractException(HttpStatus.BAD_REQUEST, [
        {
          scope: 'field',
          field: 'inspectionPlanId',
          code: ERROR_CODE.INVALID,
          message: '없는 검사기준입니다.',
        },
      ]);
    }

    const existing = await this.prisma.inspection_plan_version.findFirst({
      where: { inspection_plan_id: input.inspectionPlanId },
      select: { inspection_plan_version_id: true },
    });
    if (existing) {
      throw new ContractException(HttpStatus.BAD_REQUEST, [
        {
          scope: 'field',
          field: 'inspectionPlanId',
          code: ERROR_CODE.UNIQUE_VIOLATION,
          uniqueScope: ['inspectionPlanId'],
          message: '이 기준에는 이미 버전이 있습니다. 신규 버전은 최신 확정 버전에서 발행합니다.',
        },
      ]);
    }

    return view(
      await this.prisma.inspection_plan_version.create({
        data: {
          inspection_plan_id: input.inspectionPlanId,
          plan_version: 1,
          status_code: REVISION_STATUS.DRAFT,
          ...writeData(input),
        },
      }),
    );
  }

  /** 「상태=작성중일 때만 허용한다」(계약 §5-4). */
  async update(versionId: number, version: number, input: VersionWrite): Promise<VersionResult> {
    await this.assertWritable(input);
    await this.assertDraft(versionId, '수정');

    const updated = await this.prisma.inspection_plan_version.updateMany({
      // ⛔ version_no 를 조건에 건다. 0행이면 그 사이 누가 먼저 저장했다.
      where: { inspection_plan_version_id: versionId, version_no: version },
      data: { ...writeData(input), version_no: { increment: 1 } },
    });
    await this.assertExists(versionId, updated.count);
    return this.get(versionId);
  }

  // ── 검사 항목 ───────────────────────────────────────────────────────────

  async listItems(versionId: number, scope?: TerminalQualityReadScope): Promise<ItemSpecView[]> {
    await this.load(versionId, scope);
    return this.readItems(versionId);
  }

  /**
   * ⛔ **행 교체가 아니다.** 계약이 이유를 적었다 — 「`inspection_measurement` 가 이 항목을
   * NOT NULL FK 로 참조하므로 서버는 기존 행을 유지하며 순서만 갱신해야 한다」.
   * 공정 라인(`routing_operation`)과 같은 형태이고 같은 수법을 쓴다.
   */
  async replaceItems(versionId: number, items: ItemSpecUpsert[]): Promise<ItemSpecView[]> {
    await this.assertDraft(versionId, '검사 항목을 저장');
    const existing = await this.prisma.inspection_item_spec.findMany({
      where: { inspection_plan_version_id: versionId },
      select: { inspection_item_spec_id: true },
    });
    const known = new Set(existing.map((row) => Number(row.inspection_item_spec_id)));

    assertItemShape(versionId, items, known);
    await this.assertItemTargets(items);

    const keep = new Set(
      items.map((item) => item.inspectionItemSpecId).filter((id): id is number => id !== undefined),
    );
    const removed = [...known].filter((id) => !keep.has(id));
    await this.assertRemovable(removed);

    try {
      await this.prisma.$transaction(async (tx) => {
        if (removed.length > 0) {
          await tx.inspection_item_spec.deleteMany({
            where: { inspection_item_spec_id: { in: removed } },
          });
        }
        if (keep.size > 0) {
          await tx.$executeRaw`
            UPDATE quality.inspection_item_spec
               SET sequence_no = sequence_no + ${SEQ_PARKING_OFFSET}
             WHERE inspection_plan_version_id = ${versionId}`;
        }
        for (const item of items) {
          if (item.inspectionItemSpecId === undefined) {
            await tx.inspection_item_spec.create({ data: itemData(versionId, item) });
            continue;
          }
          await tx.inspection_item_spec.update({
            where: { inspection_item_spec_id: item.inspectionItemSpecId },
            data: itemData(versionId, item),
          });
        }
      });
    } catch (error) {
      if (isCollectionChannelItemReferenceError(error)) throw itemReferenceLocked();
      throw error;
    }

    return this.readItems(versionId);
  }

  // ── 상태 전이 ───────────────────────────────────────────────────────────

  /** 작성중 → 확정. 「검사 항목이 1건 이상이어야 한다」(계약 — 400 `LINE_REQUIRED`). */
  async confirm(versionId: number): Promise<number> {
    const row = await this.load(versionId);
    if (row.status_code !== REVISION_STATUS.DRAFT) throw locked('확정');

    const items = await this.prisma.inspection_item_spec.count({
      where: { inspection_plan_version_id: versionId },
    });
    if (items === 0) {
      throw new ContractException(HttpStatus.BAD_REQUEST, [
        {
          scope: 'screen',
          code: ERROR_CODE.LINE_REQUIRED,
          message: '검사 항목이 한 줄도 없습니다. 항목을 저장한 뒤 확정하세요.',
        },
      ]);
    }

    await this.prisma.inspection_plan_version.update({
      where: { inspection_plan_version_id: versionId },
      data: { status_code: REVISION_STATUS.CONFIRMED, version_no: { increment: 1 } },
    });
    return versionId;
  }

  /** 확정 → 폐기. ⛔ 되돌릴 수 없다(계약). */
  async obsolete(versionId: number): Promise<number> {
    const row = await this.load(versionId);
    if (row.status_code !== REVISION_STATUS.CONFIRMED) throw locked('폐기');

    await this.prisma.inspection_plan_version.update({
      where: { inspection_plan_version_id: versionId },
      data: { status_code: REVISION_STATUS.OBSOLETE, version_no: { increment: 1 } },
    });
    return versionId;
  }

  /**
   * 확정 버전을 복사해 작성중 버전을 새로 만든다 — 샘플링·판정 설정과 검사 항목 전부.
   *
   * ⚠ 새 번호는 「원본 +1」이 아니라 **기준의 최댓값 +1** 이다. 최신이 아닌 확정 버전에서
   * 부르면 원본 +1 이 이미 있어 `uq_inspection_plan_version` 이 깨진다(Routing 과 같은 판단 ·
   * 되돌림 §S-4).
   */
  async newRevision(versionId: number): Promise<number> {
    const source = await this.load(versionId);
    if (source.status_code !== REVISION_STATUS.CONFIRMED) {
      throw new ContractException(HttpStatus.BAD_REQUEST, [
        {
          scope: 'screen',
          code: ERROR_CODE.STATE_LOCKED,
          message: '확정된 버전에서만 신규 버전을 발행할 수 있습니다.',
        },
      ]);
    }

    return this.prisma.$transaction(async (tx) => {
      const latest = await tx.inspection_plan_version.aggregate({
        where: { inspection_plan_id: source.inspection_plan_id },
        _max: { plan_version: true },
      });
      const created = await tx.inspection_plan_version.create({
        data: {
          inspection_plan_id: source.inspection_plan_id,
          plan_version: (latest._max.plan_version ?? source.plan_version) + 1,
          status_code: REVISION_STATUS.DRAFT,
          effective_from: source.effective_from,
          effective_to: source.effective_to,
          sampling_method_code: source.sampling_method_code,
          sampling_qty: source.sampling_qty,
          sampling_ratio: source.sampling_ratio,
          aql_value: source.aql_value,
          acceptance_number: source.acceptance_number,
          rejection_number: source.rejection_number,
          inspection_frequency_code: source.inspection_frequency_code,
          frequency_interval_value: source.frequency_interval_value,
          frequency_interval_uom_code: source.frequency_interval_uom_code,
        },
      });

      const items = await tx.inspection_item_spec.findMany({
        where: { inspection_plan_version_id: versionId },
        orderBy: { sequence_no: 'asc' },
      });
      for (const item of items) {
        await tx.inspection_item_spec.create({
          data: { ...specData(item), inspection_plan_version_id: created.inspection_plan_version_id },
        });
      }

      return Number(created.inspection_plan_version_id);
    });
  }

  // ── 읽기·검사 ───────────────────────────────────────────────────────────

  private async readItems(versionId: number): Promise<ItemSpecView[]> {
    const rows = await this.prisma.inspection_item_spec.findMany({
      where: { inspection_plan_version_id: versionId },
      orderBy: { sequence_no: 'asc' },
    });
    return rows.map(itemView);
  }

  private async load(versionId: number, scope?: TerminalQualityReadScope): Promise<VersionRow> {
    const row = await this.prisma.inspection_plan_version.findFirst({
      where: { inspection_plan_version_id: versionId,
        ...(scope === undefined ? {} : { inspection_request: {
          some: { work_order: terminalQualityWorkOrderWhere(scope) },
        } }) },
    });
    if (!row) throw new NotFoundException('없는 검사기준 버전입니다.');
    return row;
  }

  private async assertDraft(versionId: number, action: string): Promise<void> {
    const row = await this.load(versionId);
    if (row.status_code === REVISION_STATUS.DRAFT) return;
    throw locked(action);
  }

  private async assertWritable(input: VersionWrite): Promise<void> {
    await assertCodeValues(this.prisma, [
      {
        field: 'samplingMethodCode',
        value: input.samplingMethodCode,
        groupCode: 'INSPECTION_SAMPLING_METHOD',
      },
      {
        field: 'inspectionFrequencyCode',
        value: input.inspectionFrequencyCode,
        groupCode: 'INSPECTION_FREQUENCY',
      },
    ]);
    if (input.effectiveTo != null && input.effectiveTo < input.effectiveFrom) {
      throw new ContractException(HttpStatus.BAD_REQUEST, [
        {
          scope: 'field',
          field: 'effectiveTo',
          code: ERROR_CODE.PAIR,
          message: '유효 종료일은 시작일보다 앞설 수 없습니다.',
        },
      ]);
    }
  }

  private async assertItemTargets(items: ItemSpecUpsert[]): Promise<void> {
    await assertCodeValues(
      this.prisma,
      items.flatMap((item, index) => [
        {
          field: `items[${index}].dataTypeCode`,
          value: item.dataTypeCode,
          groupCode: 'INSPECTION_ITEM_SPEC_DATA_TYPE',
        },
        {
          field: `items[${index}].inspectionMethodCode`,
          value: item.inspectionMethodCode,
          groupCode: 'INSPECTION_ITEM_SPEC_METHOD',
        },
      ]),
    );

    const uomIds = [...new Set(items.map((i) => i.uomId).filter((v): v is number => v != null))];
    const equipmentIds = [
      ...new Set(
        items.map((i) => i.defaultInspectionEquipmentId).filter((v): v is number => v != null),
      ),
    ];
    const [uoms, equipments] = await Promise.all([
      uomIds.length === 0
        ? []
        : this.prisma.uom.findMany({ where: { uom_id: { in: uomIds } }, select: { uom_id: true } }),
      equipmentIds.length === 0
        ? []
        : this.prisma.equipment.findMany({
            where: { equipment_id: { in: equipmentIds } },
            select: { equipment_id: true },
          }),
    ]);
    const knownUoms = new Set(uoms.map((row) => Number(row.uom_id)));
    const knownEquipments = new Set(equipments.map((row) => Number(row.equipment_id)));

    const errors: ItemError[] = items.flatMap((item, index) => {
      const found: ItemError[] = [];
      if (item.uomId != null && !knownUoms.has(item.uomId)) {
        found.push(invalid(`items[${index}].uomId`, '없는 단위입니다.'));
      }
      if (
        item.defaultInspectionEquipmentId != null &&
        !knownEquipments.has(item.defaultInspectionEquipmentId)
      ) {
        found.push(invalid(`items[${index}].defaultInspectionEquipmentId`, '없는 설비입니다.'));
      }
      return found;
    });
    if (errors.length > 0) throw new ContractException(HttpStatus.BAD_REQUEST, errors);
  }

  /** ⛔ 측정 기록이나 수집 채널이 붙은 항목은 뺄 수 없다. */
  private async assertRemovable(removed: number[]): Promise<void> {
    if (removed.length === 0) return;
    const [measured, mapped] = await Promise.all([
      this.prisma.inspection_measurement.count({
        where: { inspection_item_spec_id: { in: removed } },
      }),
      this.prisma.collection_channel.count({
        where: { inspection_item_id: { in: removed } },
      }),
    ]);
    if (measured === 0 && mapped === 0) return;
    throw itemReferenceLocked();
  }

  /** 0행이 「없다」인지 「낡았다」인지 가른다 — 화면이 받는 상태 코드가 갈린다. */
  private async assertExists(versionId: number, count: number): Promise<void> {
    if (count > 0) return;
    const exists = await this.prisma.inspection_plan_version.findUnique({
      where: { inspection_plan_version_id: versionId },
      select: { inspection_plan_version_id: true },
    });
    if (!exists) throw new NotFoundException('없는 검사기준 버전입니다.');
    assertUpdated(0);
  }
}

type ItemError = ErrorItem;

const COLLECTION_CHANNEL_ITEM_FK = 'collection_channel_inspection_item_id_fkey';

export function isCollectionChannelItemReferenceError(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2003') {
    return false;
  }
  const meta = (error.meta ?? {}) as Record<string, unknown>;
  return meta.constraint === COLLECTION_CHANNEL_ITEM_FK;
}

function itemReferenceLocked(): ContractException {
  return new ContractException(HttpStatus.BAD_REQUEST, [
    {
      scope: 'screen',
      code: ERROR_CODE.STATE_LOCKED,
      message: '측정 기록 또는 수집 채널이 연결된 검사 항목은 뺄 수 없습니다.',
    },
  ]);
}

function locked(action: string): ContractException {
  // ⛔ 400 이다 — 계약이 이 자리들에 409 를 «선언하지 않았다»(Routing 과 같다).
  return new ContractException(HttpStatus.BAD_REQUEST, [
    {
      scope: 'screen',
      code: ERROR_CODE.STATE_LOCKED,
      message: `지금 상태에서는 ${action}할 수 없습니다.`,
    },
  ]);
}

function invalid(field: string, message: string): ErrorItem {
  return { scope: 'field', field, code: ERROR_CODE.INVALID, message };
}

type VersionColumns = Omit<
  Prisma.inspection_plan_versionUncheckedCreateInput,
  'inspection_plan_id' | 'plan_version' | 'status_code'
>;

function writeData(input: VersionWrite): VersionColumns {
  return {
    effective_from: new Date(input.effectiveFrom),
    ...optionalDate('effective_to', input.effectiveTo),
    sampling_method_code: input.samplingMethodCode,
    inspection_frequency_code: input.inspectionFrequencyCode,
    ...optional('aql_value', input.aqlValue),
    ...optional('acceptance_number', input.acceptanceNumber),
    ...optional('rejection_number', input.rejectionNumber),
    ...optional('frequency_interval_value', input.frequencyIntervalValue),
    ...optional('frequency_interval_uom_code', input.frequencyIntervalUomCode),
    // ⛔ 백분율이다(0 초과 100 이하) — 비율이 아니다. 선행 마이그레이션이 CHECK 를 고쳤다.
    ...optional('sampling_ratio', input.samplingRatio),
  } as VersionColumns;
}

function itemData(
  versionId: number,
  item: ItemSpecUpsert,
): Prisma.inspection_item_specUncheckedCreateInput {
  return {
    inspection_plan_version_id: versionId,
    sequence_no: item.sequenceNo,
    inspection_item_code: item.inspectionItemCode,
    inspection_item_name: item.inspectionItemName,
    data_type_code: item.dataTypeCode,
    measurement_count: item.measurementCount,
    required_flag: item.requiredFlag,
    automatic_judgment: item.automaticJudgment,
    ...optional('name_ko', item.nameKo),
    ...optional('name_vi', item.nameVi),
    ...optional('uom_id', item.uomId),
    ...optional('target_value', item.targetValue),
    ...optional('lower_limit', item.lowerLimit),
    ...optional('upper_limit', item.upperLimit),
    ...optional('inspection_method_code', item.inspectionMethodCode),
    ...optional('default_inspection_equipment_id', item.defaultInspectionEquipmentId),
  };
}

/** 복제할 항목 칸만 고른다 — id·감사 칸은 새 행이 스스로 갖는다. */
function specData(item: SpecRow): Omit<
  Prisma.inspection_item_specUncheckedCreateInput,
  'inspection_plan_version_id'
> {
  return {
    sequence_no: item.sequence_no,
    inspection_item_code: item.inspection_item_code,
    inspection_item_name: item.inspection_item_name,
    name_ko: item.name_ko,
    name_vi: item.name_vi,
    data_type_code: item.data_type_code,
    uom_id: item.uom_id,
    target_value: item.target_value,
    lower_limit: item.lower_limit,
    upper_limit: item.upper_limit,
    measurement_count: item.measurement_count,
    inspection_method_code: item.inspection_method_code,
    default_inspection_equipment_id: item.default_inspection_equipment_id,
    required_flag: item.required_flag,
    automatic_judgment: item.automatic_judgment,
  };
}

/** 요청 안에서 먼저 본다 — DB 까지 가면 500 이고 계약은 여기에 400 을 요구한다. */
function assertItemShape(
  versionId: number,
  items: ItemSpecUpsert[],
  known: ReadonlySet<number>,
): void {
  const errors: ErrorItem[] = [];
  const seenSeq = new Map<number, number>();

  items.forEach((item, index) => {
    assertNotBlank([
      [`items[${index}].inspectionItemCode`, item.inspectionItemCode],
      [`items[${index}].inspectionItemName`, item.inspectionItemName],
    ]);
    if (item.inspectionPlanVersionId !== versionId) {
      errors.push(invalid(`items[${index}].inspectionPlanVersionId`, '경로의 버전과 다릅니다.'));
    }
    if (item.inspectionItemSpecId !== undefined && !known.has(item.inspectionItemSpecId)) {
      errors.push(invalid(`items[${index}].inspectionItemSpecId`, '이 버전의 항목이 아닙니다.'));
    }
    const first = seenSeq.get(item.sequenceNo);
    if (first === undefined) seenSeq.set(item.sequenceNo, index);
    else {
      errors.push({
        scope: 'field',
        field: `items[${index}].sequenceNo`,
        code: ERROR_CODE.UNIQUE_VIOLATION,
        uniqueScope: ['inspectionPlanVersionId', 'sequenceNo'],
        message: `${first + 1}번째와 같은 순서입니다.`,
      });
    }
    if (item.sequenceNo >= SEQ_PARKING_OFFSET) {
      errors.push(
        invalid(`items[${index}].sequenceNo`, `${SEQ_PARKING_OFFSET} 보다 작아야 합니다.`),
      );
    }
    // ck_inspection_limits — 둘 다 있을 때만 본다.
    if (item.lowerLimit != null && item.upperLimit != null && item.upperLimit < item.lowerLimit) {
      errors.push({
        scope: 'field',
        field: `items[${index}].upperLimit`,
        code: ERROR_CODE.PAIR,
        message: '상한은 하한보다 작을 수 없습니다.',
      });
    }
  });

  if (errors.length > 0) throw new ContractException(HttpStatus.BAD_REQUEST, errors);
}

function view(row: VersionRow): VersionView {
  return {
    inspectionPlanVersionId: Number(row.inspection_plan_version_id),
    inspectionPlanId: Number(row.inspection_plan_id),
    planVersion: row.plan_version,
    effectiveFrom: toDateString(row.effective_from) ?? '',
    effectiveTo: toDateString(row.effective_to),
    samplingMethodCode: row.sampling_method_code,
    aqlValue: row.aql_value === null ? null : Number(row.aql_value),
    acceptanceNumber: row.acceptance_number,
    rejectionNumber: row.rejection_number,
    inspectionFrequencyCode: row.inspection_frequency_code,
    frequencyIntervalValue:
      row.frequency_interval_value === null ? null : Number(row.frequency_interval_value),
    frequencyIntervalUomCode: row.frequency_interval_uom_code,
    statusCode: row.status_code,
    samplingRatio: row.sampling_ratio === null ? null : Number(row.sampling_ratio),
  };
}

function itemView(row: SpecRow): ItemSpecView {
  return {
    inspectionItemSpecId: Number(row.inspection_item_spec_id),
    inspectionPlanVersionId: Number(row.inspection_plan_version_id),
    sequenceNo: row.sequence_no,
    inspectionItemCode: row.inspection_item_code,
    inspectionItemName: row.inspection_item_name,
    nameKo: row.name_ko,
    nameVi: row.name_vi,
    dataTypeCode: row.data_type_code,
    uomId: row.uom_id === null ? null : Number(row.uom_id),
    targetValue: row.target_value === null ? null : Number(row.target_value),
    lowerLimit: row.lower_limit === null ? null : Number(row.lower_limit),
    upperLimit: row.upper_limit === null ? null : Number(row.upper_limit),
    measurementCount: row.measurement_count,
    inspectionMethodCode: row.inspection_method_code,
    defaultInspectionEquipmentId:
      row.default_inspection_equipment_id === null
        ? null
        : Number(row.default_inspection_equipment_id),
    requiredFlag: row.required_flag,
    automaticJudgment: row.automatic_judgment,
  };
}
