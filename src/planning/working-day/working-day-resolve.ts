import { HttpStatus } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { resolveWorkingDays } from '../../app/policy/working-day-resolver';
import { ContractException, ERROR_CODE, ErrorItem } from '../../common/errors';
import { PlanningCalendarDay, daysBetween } from '../../core/calendar/working-day';

/** 묶음 하나의 기간 상한(양 끝 포함) — 계약과 같은 값. 묶음 수 상한은 계약 maxItems 가 막는다. */
const MAX_DAYS = 92;

export interface WorkingDayResolveBody {
  targets: { plantId: number; productionLineId?: number | null; from: string; to: string }[];
}

export interface WorkingDayResolveResult {
  items: { plantId: number; productionLineId: number | null; from: string; to: string; days: PlanningCalendarDay[] }[];
}

/** 범위 밖 공장은 없는 공장과 가르지 않는다 — 존재를 드러내지 않는다. */
export async function resolveTargets(
  client: Prisma.TransactionClient,
  body: WorkingDayResolveBody,
  scope: bigint[] | null,
): Promise<WorkingDayResolveResult> {
  const plantIds = [...new Set(body.targets.map((target) => BigInt(target.plantId)))];
  const lineIds = [...new Set(body.targets.flatMap((target) => (target.productionLineId == null ? [] : [BigInt(target.productionLineId)])))];
  const [plants, lines] = await Promise.all([
    client.plant.findMany({ where: { plant_id: { in: plantIds } }, select: { plant_id: true } }),
    lineIds.length === 0 ? [] : client.production_line.findMany({ where: { production_line_id: { in: lineIds } }, select: { production_line_id: true, plant_id: true } }),
  ]);
  const visible = new Set(plants.map((plant) => plant.plant_id).filter((id) => scope === null || scope.includes(id)));
  const plantOfLine = new Map(lines.map((line) => [line.production_line_id, line.plant_id]));

  const errors: ErrorItem[] = [];
  body.targets.forEach((target, index) => {
    const path = `targets[${index}]`;
    if (target.from > target.to) errors.push({ scope: 'field', field: `${path}.to`, code: ERROR_CODE.RANGE, message: '종료일이 시작일보다 앞입니다.' });
    else if (daysBetween(target.from, target.to) > MAX_DAYS) errors.push({ scope: 'field', field: `${path}.to`, code: ERROR_CODE.RANGE, message: `기간은 ${MAX_DAYS}일 이하로 나눠 물으세요.` });
    if (!visible.has(BigInt(target.plantId))) errors.push({ scope: 'field', field: `${path}.plantId`, code: ERROR_CODE.INVALID, message: '없는 공장입니다.' });
    else if (target.productionLineId != null && plantOfLine.get(BigInt(target.productionLineId)) !== BigInt(target.plantId)) {
      errors.push({ scope: 'field', field: `${path}.productionLineId`, code: ERROR_CODE.INVALID, message: '그 공장의 생산 라인이 아닙니다.' });
    }
  });
  if (errors.length > 0) throw new ContractException(HttpStatus.BAD_REQUEST, errors);

  const days = await resolveWorkingDays(client, body.targets.map((target) => ({
    plantId: BigInt(target.plantId),
    lineId: target.productionLineId == null ? null : BigInt(target.productionLineId),
    from: target.from,
    to: target.to,
  })));
  return {
    items: body.targets.map((target, index) => ({
      plantId: target.plantId,
      productionLineId: target.productionLineId ?? null,
      from: target.from,
      to: target.to,
      days: days[index],
    })),
  };
}
