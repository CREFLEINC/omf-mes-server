import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE } from '../../common/errors';
import { optionalDate, toDateString } from '../../common/master';
import { assertUpdated } from '../../common/optimistic-lock';
import { PagedResponse, pagedResponse, pageRequest } from '../../common/pagination';
import { PrismaService } from '../../prisma/prisma.service';
import {
  EffectiveView,
  PolicyCode,
  PolicyScope,
  PolicyValues,
  SCOPES,
  assertPolicyCode,
  assertValues,
  axisCandidates,
  scopeOf,
  scopeRank,
  unresolved,
} from './operation-policy-rules';

/**
 * 운영 정책 — 「무엇을 어느 범위에 적용하는가」. 화면은 `W-05-01` 이 소유한다.
 *
 * ⭐ 이 서비스의 값은 CRUD 가 아니라 **범위 해석**(`effective`)에 있다. 계약이 그렇게
 * 적었다 — 「범위 해석을 서버가 한다 — **화면이 우선순위를 다시 구현하지 않는다**」.
 * 규칙 자체는 `operation-policy-rules.ts` 가 갖는다.
 */

export interface PolicyCreate extends PolicyScope, PolicyValues {
  policyCode: string;
  effectiveFrom: string;
  effectiveTo?: string | null;
}

/** 계약 `OperationPolicyUpdate` — 범위와 코드는 못 바꾼다. 바꾸려면 새로 만든다. */
export interface PolicyUpdate extends PolicyValues {
  effectiveFrom: string;
  effectiveTo?: string | null;
}

export interface PolicyQuery extends PolicyScope {
  policyCode?: string;
  effectiveOn?: string;
  page?: number;
  size?: number;
}

export interface EffectiveQuery extends PolicyScope {
  policyCode?: string;
  on?: string;
}

/** 계약 `OperationPolicy` 와 동형. */
interface PolicyView {
  operationPolicyId: number;
  policyCode: string;
  businessUnitId: number | null;
  plantId: number | null;
  itemId: number | null;
  processId: number | null;
  valueText: string | null;
  valueNumeric: number | null;
  valueBoolean: boolean | null;
  effectiveFrom: string;
  effectiveTo: string | null;
}

export type PolicyResult = { policy: PolicyView; versionNo: number };

type PolicyRow = Prisma.operation_policyGetPayload<object>;

@Injectable()
export class OperationPolicyService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: PolicyQuery): Promise<PagedResponse<PolicyView>> {
    const page = pageRequest({ page: loose(query.page), size: loose(query.size) });
    const on =
      query.effectiveOn === undefined ? undefined : assertDate('effectiveOn', query.effectiveOn);

    const where: Prisma.operation_policyWhereInput = {
      ...optional('policy_code', query.policyCode),
      ...optional('business_unit_id', assertId('businessUnitId', query.businessUnitId)),
      ...optional('plant_id', assertId('plantId', query.plantId)),
      ...optional('item_id', assertId('itemId', query.itemId)),
      ...optional('process_id', assertId('processId', query.processId)),
      // 「비우면 끝난 것까지 함께 본다」(계약) — 유효기간 필터는 준 날에만 건다.
      ...(on === undefined
        ? {}
        : {
            effective_from: { lte: on },
            OR: [{ effective_to: null }, { effective_to: { gte: on } }],
          }),
    };

    const [rows, total] = await Promise.all([
      this.prisma.operation_policy.findMany({
        where,
        orderBy: [
          { policy_code: 'asc' },
          { effective_from: 'desc' },
          { operation_policy_id: 'desc' },
        ],
        skip: page.skip,
        take: page.take,
      }),
      this.prisma.operation_policy.count({ where }),
    ]);
    return pagedResponse(rows.map(view), total, page);
  }

  async get(operationPolicyId: number): Promise<PolicyResult> {
    const row = await this.prisma.operation_policy.findUnique({
      where: { operation_policy_id: operationPolicyId },
    });
    if (!row) throw new NotFoundException('없는 운영 정책입니다.');
    return { policy: view(row), versionNo: row.version_no };
  }

  async create(input: PolicyCreate): Promise<PolicyView> {
    const code = assertPolicyCode(input.policyCode);
    assertValues(code, input);

    return view(
      await this.prisma.operation_policy.create({
        data: {
          policy_code: code,
          effective_from: assertDate('effectiveFrom', input.effectiveFrom),
          ...optional('business_unit_id', input.businessUnitId ?? undefined),
          ...optional('plant_id', input.plantId ?? undefined),
          ...optional('item_id', input.itemId ?? undefined),
          ...optional('process_id', input.processId ?? undefined),
          ...optionalDate('effective_to', input.effectiveTo),
          ...valueData(input),
        },
      }),
    );
  }

  async update(
    operationPolicyId: number,
    version: number,
    input: PolicyUpdate,
  ): Promise<PolicyResult> {
    const current = await this.get(operationPolicyId);
    // ⛔ 코드는 바꿀 수 없으므로(계약) 값 검사는 «저장된» 코드로 한다.
    assertValues(current.policy.policyCode as PolicyCode, input);

    const updated = await this.prisma.operation_policy.updateMany({
      where: { operation_policy_id: operationPolicyId, version_no: version },
      data: {
        effective_from: assertDate('effectiveFrom', input.effectiveFrom),
        ...optionalDate('effective_to', input.effectiveTo),
        ...valueData(input),
        version_no: { increment: 1 },
      },
    });
    assertUpdated(updated.count);
    return this.get(operationPolicyId);
  }

  /**
   * 이 범위에 «적용되는» 정책 하나. 좁은 범위가 이긴다.
   *
   * ⛔ 못 찾으면 값을 지어내지 않고 `resolved: false` 로 내린다 — 화면이 기본값을 만들지
   * 않게 하는 것이 이 칸의 뜻이다(계약).
   */
  async effective(query: EffectiveQuery): Promise<EffectiveView> {
    const code = assertPolicyCode(query.policyCode);
    const scope: PolicyScope = {
      businessUnitId: assertId('businessUnitId', query.businessUnitId),
      plantId: assertId('plantId', query.plantId),
      itemId: assertId('itemId', query.itemId),
      processId: assertId('processId', query.processId),
    };
    const on = query.on === undefined ? await this.today(scope.plantId) : assertDate('on', query.on);

    const rows = await this.prisma.operation_policy.findMany({
      where: {
        policy_code: code,
        effective_from: { lte: on },
        AND: [
          { OR: [{ effective_to: null }, { effective_to: { gte: on } }] },
          ...SCOPES.map(({ column }) => ({
            OR: [{ [column]: null }, ...axisCandidates(column, scope)],
          })),
        ],
      },
    });
    if (rows.length === 0) return unresolved(code);

    // 좁은 축이 이기고, 같으면 늦게 시작한 것 → 나중에 만든 것 순이다. 겹치는 정책을
    // 물리가 막지 않으므로 «결정적으로» 고르는 것이 서버 몫이다.
    const winner = [...rows].sort(
      (a, b) =>
        scopeRank(a) - scopeRank(b) ||
        b.effective_from.getTime() - a.effective_from.getTime() ||
        Number(b.operation_policy_id - a.operation_policy_id),
    )[0];

    return {
      policyCode: code,
      resolved: true,
      operationPolicyId: Number(winner.operation_policy_id),
      valueText: winner.value_text,
      valueNumeric: winner.value_numeric === null ? null : Number(winner.value_numeric),
      valueBoolean: winner.value_boolean,
      matchedScopeCode: scopeOf(winner),

    };
  }

  /**
   * 판정 기준일. 공장을 알면 **그 공장의 로컬 오늘**이다 — 하노이는 UTC+7 이라 서버
   * 날짜로 보면 저녁 이후 하루가 어긋난다(CLAUDE.md · `plant.timezone_code`).
   * ⚠ 공장을 안 주면 풀 근거가 없어 UTC 오늘로 둔다.
   */
  private async today(plantId: number | null | undefined): Promise<Date> {
    const plant =
      plantId == null
        ? null
        : await this.prisma.plant.findUnique({
            where: { plant_id: plantId },
            select: { timezone_code: true },
          });
    const local = new Intl.DateTimeFormat('en-CA', {
      timeZone: plant?.timezone_code ?? 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
    return new Date(`${local}T00:00:00.000Z`);
  }
}

/** 세 칸을 통째로 싣는다 — 안 보낸 칸을 비우는 것이 「이 코드는 그 칸을 안 쓴다」다. */
function valueData(input: PolicyValues): Record<string, unknown> {
  return {
    value_text: input.valueText ?? null,
    value_numeric: input.valueNumeric ?? null,
    value_boolean: input.valueBoolean ?? null,
  };
}

function view(row: PolicyRow): PolicyView {
  return {
    operationPolicyId: Number(row.operation_policy_id),
    policyCode: row.policy_code,
    businessUnitId: id(row.business_unit_id),
    plantId: id(row.plant_id),
    itemId: id(row.item_id),
    processId: id(row.process_id),
    valueText: row.value_text,
    valueNumeric: row.value_numeric === null ? null : Number(row.value_numeric),
    valueBoolean: row.value_boolean,
    effectiveFrom: toDateString(row.effective_from) as string,
    effectiveTo: toDateString(row.effective_to),
  };
}

function id(value: bigint | null): number | null {
  return value === null ? null : Number(value);
}

function optional<T>(column: string, value: T | undefined): Record<string, unknown> {
  return value === undefined ? {} : { [column]: value };
}

/** 쪽·크기는 관대하게 본다 — 계약이 기본값을 정해 두었다. */
function loose(value: unknown): number | undefined {
  if (value === undefined || value === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** 숫자 식별자 축 — 글자가 섞이면 400 이다(그냥 넘기면 Prisma 검증 오류가 500 으로 샌다). */
function assertId(field: string, value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = Number(value);
  if (Number.isInteger(parsed) && parsed >= 0) return parsed;
  throw new ContractException(HttpStatus.BAD_REQUEST, [
    { scope: 'field', field, code: ERROR_CODE.INVALID, message: '숫자 식별자여야 합니다.' },
  ]);
}

function assertDate(field: string, value: string): Date {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const date = new Date(`${value}T00:00:00.000Z`);
    if (!Number.isNaN(date.getTime())) return date;
  }
  throw new ContractException(HttpStatus.BAD_REQUEST, [
    { scope: 'field', field, code: ERROR_CODE.INVALID, message: 'YYYY-MM-DD 형식입니다.' },
  ]);
}
