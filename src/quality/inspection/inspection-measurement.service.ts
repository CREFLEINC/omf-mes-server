import { Injectable, NotFoundException } from '@nestjs/common';
import { inspection_measurement, Prisma } from '@prisma/client';

import { omitEmpty } from '../../common/http/omit-empty';
import { filter } from '../../common/master';
import { PagedResponse, pageRequest } from '../../common/pagination';
import { PrismaService } from '../../prisma/prisma.service';
import { CalibrationExpiredFilter, CalibrationIndex } from './calibration';

export interface MeasurementListQuery {
  inspectionItemSpecId?: number;
  calibrationExpired?: CalibrationExpiredFilter;
  page?: number;
  size?: number;
}

/** 항목 요약이 그리는 행 하나에 필요한 전부 — 항목 규격과 장비를 한 질의로 끌어온다(N+1 금지). */
const SUMMARY_JOIN = {
  inspection_item_spec: {
    select: {
      inspection_item_spec_id: true,
      inspection_item_name: true,
      data_type_code: true,
      lower_limit: true,
      upper_limit: true,
      uom: { select: { uom_code: true } },
    },
  },
  equipment: { select: { equipment_name: true, calibration_due_date: true } },
} satisfies Prisma.inspection_measurementInclude;
type SummaryRow = Prisma.inspection_measurementGetPayload<{ include: typeof SUMMARY_JOIN }>;

/** 규격 밖 예시는 **최대 10건**만 내린다(계약 · `plan-uiux.md` §7-2). 「외 N건」은 화면이 뺀다. */
const OUT_OF_SPEC_SAMPLE = 10;

/**
 * 측정치 2건 — 목록(3계층의 3층)·항목별 요약.
 * ⭐ 측정치는 **135,000 자릿수**다(계약 `/measurements` 설명). 목록은 반드시 페이지로 끊고,
 * 요약은 **결과 하나 안에서** 접는다 — 화면이 페이지를 받아 합산하면 틀린 요약이 된다(L-1).
 * ⛔ 자식 컬렉션 GET 이라 ETag 를 안 낸다(B-1-1) · 멱등도 없다.
 */
@Injectable()
export class InspectionMeasurementService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * ⭐ 없는 결과 id 는 **빈 목록 + `total=0`** 이다 — 계약이 이 자리에 404 를 선언하지 않았다(§1-1).
   * 정렬은 `항목 → 표본`(계약 침묵 · 화면이 그 축의 표다 · §4-3).
   */
  async list(inspectionResultId: number, query: MeasurementListQuery): Promise<PagedResponse<MeasurementView>> {
    const calibration = await CalibrationIndex.load(this.prisma);
    const where: Prisma.inspection_measurementWhereInput = {
      inspection_result_id: inspectionResultId,
      ...filter('inspection_item_spec_id', query.inspectionItemSpecId),
      ...calibration.measurementScope(query.calibrationExpired),
    };
    const page = pageRequest(query);
    const [total, rows] = await Promise.all([
      this.prisma.inspection_measurement.count({ where }),
      this.prisma.inspection_measurement.findMany({
        where,
        orderBy: [{ inspection_item_spec_id: 'asc' }, { sample_no: 'asc' }],
        skip: page.skip,
        take: page.take,
      }),
    ]);

    return { items: rows.map((row) => measurementView(row, calibration)), page: { page: page.page, size: page.size, total } };
  }

  /** ⭐ 항목 단위로 접는다. 없는 결과 id 는 **404**(이 자리는 계약이 선언했다 · §1-1). */
  async itemSummary(inspectionResultId: number) {
    const result = await this.prisma.inspection_result.findUnique({
      where: { inspection_result_id: inspectionResultId },
      select: { inspection_result_id: true },
    });
    if (!result) throw new NotFoundException('없는 검사 결과입니다.');

    const calibration = await CalibrationIndex.load(this.prisma);
    const rows = await this.prisma.inspection_measurement.findMany({
      where: { inspection_result_id: inspectionResultId },
      orderBy: [{ inspection_item_spec_id: 'asc' }, { sample_no: 'asc' }],
      include: SUMMARY_JOIN,
    });

    const groups = new Map<string, SummaryRow[]>();
    for (const row of rows) {
      const key = row.inspection_item_spec_id.toString();
      groups.set(key, [...(groups.get(key) ?? []), row]);
    }
    return { asOf: new Date().toISOString(), items: [...groups.values()].map((group) => itemSummaryOf(group, calibration)) };
  }
}

export type MeasurementView = ReturnType<typeof measurementView>;

function measurementView(row: inspection_measurement, calibration: CalibrationIndex) {
  return omitEmpty({
    inspectionMeasurementId: Number(row.inspection_measurement_id),
    inspectionItemSpecId: Number(row.inspection_item_spec_id),
    sampleNo: row.sample_no,
    numericValue: row.numeric_value === null ? undefined : Number(row.numeric_value),
    textValue: row.text_value ?? undefined,
    booleanValue: row.boolean_value ?? undefined,
    judgmentCode: row.judgment_code,
    measuredAt: row.measured_at.toISOString(),
    inspectionEquipmentId: row.inspection_equipment_id === null ? undefined : Number(row.inspection_equipment_id),
    // ⭐ 서버가 판정한다(L-2). 장비가 없는 행은 **키를 생략**한다 — false 와 뜻이 다르다.
    calibrationExpiredAtMeasurement: calibration.expiredAt(row.inspection_equipment_id, row.measured_at),
  });
}

function itemSummaryOf(rows: SummaryRow[], calibration: CalibrationIndex) {
  const spec = rows[0].inspection_item_spec;
  const outOfSpec = rows.flatMap((row) => outOfSpecOf(spec, row.numeric_value) ?? []);
  // 화면 행에 장비 칸이 하나다(`W-03-05` §3) — 만료된 장비가 있으면 그것을 대표로 세운다.
  // 표본마다 장비가 갈리는 데이터에서도 ⚠ 경고가 사라지지 않게 하는 쪽이다(L-8).
  const measured = rows.filter((row) => row.equipment !== null);
  const equipmentRow = measured.find((row) => calibration.expiredAt(row.inspection_equipment_id, row.measured_at) === true) ?? measured[0];

  return omitEmpty({
    inspectionItemSpecId: Number(spec.inspection_item_spec_id),
    itemName: spec.inspection_item_name,
    specText: specTextOf(spec),
    measuredCount: rows.filter((row) => !isUnmeasured(row)).length,
    acceptedCount: rows.filter((row) => row.judgment_code === 'ACCEPTED').length,
    rejectedCount: rows.filter((row) => row.judgment_code === 'REJECTED').length,
    // ⭐ 값 세 칸이 **전부 빈** 행이다(`W-03-05` §6 「미측정」) — 0 으로 접지 않는다.
    unmeasuredCount: rows.filter(isUnmeasured).length,
    outOfSpecValues: outOfSpec.slice(0, OUT_OF_SPEC_SAMPLE),
    // ⛔ `rejectedCount` 로 역산하지 않는다 — 규격 밖이어도 자동 불합격이 아니다(계약 명시).
    outOfSpecTotalCount: outOfSpec.length,
    equipmentName: equipmentRow?.equipment?.equipment_name,
    equipmentCalibrationExpired: equipmentRow === undefined ? undefined : calibration.expiredAt(equipmentRow.inspection_equipment_id, equipmentRow.measured_at),
    // ⚠ 만료 «판정»은 검교정 이력이 지배할 수 있다(§4-4) — 이 칸은 계약이 「차기 검교정
    //   예정일」로 적은 마스터 값 그대로다(경고 문구용).
    equipmentCalibrationDueDate: equipmentRow?.equipment?.calibration_due_date?.toISOString().slice(0, 10),
  });
}

/** 값 세 칸이 전부 비면 「미측정」이다 — `ck_measurement_single_value` 가 그 갈래를 허용한다. */
const isUnmeasured = (row: { numeric_value: Prisma.Decimal | null; text_value: string | null; boolean_value: boolean | null }): boolean =>
  row.numeric_value === null && row.text_value === null && row.boolean_value === null;

/** ⭐ 규격 밖 판정은 **NUMERIC 항목에만** 선다 — 문자·불리언 항목에는 상·하한이 뜻이 없다(계약 `omf-mes#179`). */
function outOfSpecOf(spec: SummaryRow['inspection_item_spec'], value: Prisma.Decimal | null): string | undefined {
  if (spec.data_type_code !== 'NUMERIC' || value === null) return undefined;
  const below = spec.lower_limit !== null && value.lessThan(spec.lower_limit);
  const above = spec.upper_limit !== null && value.greaterThan(spec.upper_limit);
  return below || above ? value.toString() : undefined;
}

/**
 * 계약 「하한·상한·단위를 서버가 조립한다」 — 예시 `11.95 ~ 12.05 mm`. 한쪽만 있으면 그 자리를
 * 비운다(`11.95 ~`) — 없는 말을 지어 채우지 않는다. 둘 다 없으면 **키를 생략**한다.
 */
function specTextOf(spec: SummaryRow['inspection_item_spec']): string | undefined {
  if (spec.lower_limit === null && spec.upper_limit === null) return undefined;
  const range = `${spec.lower_limit?.toString() ?? ''} ~ ${spec.upper_limit?.toString() ?? ''}`.trim();
  return spec.uom === null ? range : `${range} ${spec.uom.uom_code}`;
}
