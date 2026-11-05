import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE } from '../../common/errors';
import { DocumentStateService } from '../../core/document-state';
import { PrismaService } from '../../prisma/prisma.service';
import { REVISION_STATUS } from '../revision-status';
import { recordRoutingAudit, recordRoutingChange } from './routing-audit';

/** 이 서비스가 다스리는 상태 칸. 전이표(`transitions.ts`)의 키와 같은 문자열이다. */
const STATE_COLUMN = 'planning.routing.status_code';

@Injectable()
export class RoutingRevisionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly documentState: DocumentStateService,
  ) {}

  /**
   * 작성중 → 확정. 「이후 in-place 수정은 불가하며 변경은 신규 Rev 로만 한다」(결정 07).
   * 「라인이 1건 이상이어야 한다」(계약 — 위반 시 400 `LINE_REQUIRED`).
   */
  async confirm(routingId: number, actorId?: number | null): Promise<number> {
    const row = await this.load(routingId);
    // ⛔ 계약이 이 자리에 409 를 «선언하지 않았다» — 400 으로 낸다.
    const transition = this.documentState.assertTransition(
      STATE_COLUMN,
      'routing-confirm',
      row.status_code,
      HttpStatus.BAD_REQUEST,
    );

    const lines = await this.prisma.routing_operation.count({ where: { routing_id: routingId } });
    if (lines === 0) {
      throw new ContractException(HttpStatus.BAD_REQUEST, [
        {
          scope: 'screen',
          code: ERROR_CODE.LINE_REQUIRED,
          message: '공정 라인이 한 줄도 없습니다. 라인을 저장한 뒤 확정하세요.',
        },
      ]);
    }

    const confirmedAt = new Date();
    await this.prisma.$transaction(async (tx) => {
      await tx.routing.update({
        where: { routing_id: routingId },
        // 확정 일시 — 이력 관리 표가 보인다(omf-all-around#231).
        data: { status_code: transition.to, confirmed_at: confirmedAt, version_no: { increment: 1 } },
      });
      await recordRoutingAudit(tx, {
        routingId,
        eventTypeCode: 'UPDATE',
        actorId,
        before: { statusCode: row.status_code },
        after: { statusCode: transition.to, confirmedAt: confirmedAt.toISOString() },
      });
    });
    return routingId;
  }

  /** 확정 → 폐기. ⛔ dead end 다 — 계약 §5-4 상태표가 「폐기 → (없음)」이라 적었다. */
  async obsolete(routingId: number, actorId?: number | null): Promise<number> {
    const row = await this.load(routingId);
    const transition = this.documentState.assertTransition(
      STATE_COLUMN,
      'routing-obsolete',
      row.status_code,
      HttpStatus.BAD_REQUEST,
    );

    await this.prisma.$transaction(async (tx) => {
      await tx.routing.update({
        where: { routing_id: routingId },
        data: { status_code: transition.to, version_no: { increment: 1 } },
      });
      await recordRoutingChange(
        tx,
        routingId,
        actorId,
        { statusCode: row.status_code },
        { statusCode: transition.to },
      );
    });
    return routingId;
  }

  /**
   * 확정 Rev 를 복사해 작성중 Rev 를 새로 만든다.
   *
   * ⛔ 전이표에 없다 — **원본 행의 상태를 안 바꾼다.** 「어느 상태에서 복사할 수 있는가」라
   * 여기서 직접 본다. 작성중 Rev 는 이미 있는 초안을 편집하면 되고, 폐기 Rev 는 이 전이
   * 자체가 불가하다(계약 §5-4).
   *
   * ⚠ 새 번호를 「원본 +1」이 아니라 **품목의 최댓값 +1** 로 잡는다. 계약은 「최신 Rev
   * 위에서 호출」을 전제하므로 대개 같은 값인데, 최신이 아닌 확정 Rev 에서 부르면 원본 +1
   * 이 이미 있어 `uq_routing` 이 깨진다. 최댓값 다음만이 언제나 비어 있다.
   *
   * ⚠ **선후행도 함께 복사한다.** 계약은 「헤더 속성과 공정 라인 전부」만 적었지만, 라인만
   * 옮기고 선후행을 버리면 새 Rev 가 공정 순서 관계를 잃은 채 열린다 — 복사의 뜻이 아니다.
   * 되돌림 §S-3 에 적었다.
   */
  async newRevision(routingId: number, actorId?: number | null): Promise<number> {
    const source = await this.load(routingId);
    if (source.status_code !== REVISION_STATUS.CONFIRMED) {
      throw new ContractException(HttpStatus.BAD_REQUEST, [
        {
          scope: 'screen',
          code: ERROR_CODE.STATE_LOCKED,
          message: '확정된 Rev 에서만 신규 Rev 를 발행할 수 있습니다.',
        },
      ]);
    }

    return this.prisma.$transaction(async (tx) => {
      const createdId = await copyRoutingRevision(tx, source, REVISION_STATUS.DRAFT);
      const created = await tx.routing.findUnique({ where: { routing_id: createdId } });

      await recordRoutingAudit(tx, {
        routingId: createdId,
        eventTypeCode: 'CREATE',
        actorId,
        after: {
          routingCode: created?.routing_code ?? source.routing_code,
          routingVersion: created?.routing_version,
          statusCode: created?.status_code ?? REVISION_STATUS.DRAFT,
          copiedFromRoutingId: routingId,
        },
      });

      return Number(createdId);
    });
  }

  /**
   * 작성중 Rev 취소(omf-all-around#231) — 작성중 Rev 와 그 공정 라인 · 선후행을 지운다. 잘못 발행한 신규 Rev 를
   * 되돌리는 길이다(검사기준 작성중 버전 취소와 같은 판단). 작성중 Rev 는 생산에 쓰이지 않아 상태를 늘리지 않고 지운다.
   * 첫 Rev 를 지우면 품목은 Routing 이 없는 상태로 돌아가 다시 등록할 수 있다 — 폐기는 그 길을 막는다.
   * 생산계획 · W/O · BOM · 검사기준이 가리키고 있으면 지우지 않는다(400 STATE_LOCKED).
   */
  async discard(routingId: number, actorId?: number | null): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      // ⛔ `FOR UPDATE` — 판정과 삭제 사이에 확정이 끼면 확정 Rev 가 지워진다.
      const rows = await tx.$queryRaw<
        { status_code: string; routing_version: number; routing_code: string }[]
      >`
        SELECT status_code, routing_version, routing_code
          FROM planning.routing
         WHERE routing_id = ${BigInt(routingId)}
           FOR UPDATE`;
      if (rows.length === 0) throw new NotFoundException('없는 Routing 입니다.');
      if (rows[0].status_code !== REVISION_STATUS.DRAFT) {
        throw discardLocked('작성중 Rev 만 취소할 수 있습니다. 확정 Rev 는 폐기를 쓰세요.');
      }

      const lineIds = (
        await tx.routing_operation.findMany({
          where: { routing_id: routingId },
          select: { routing_operation_id: true },
        })
      ).map((line) => line.routing_operation_id);
      const [plans, inspectionPlans, workOrders, components] = await Promise.all([
        tx.production_plan.count({ where: { routing_id: routingId } }),
        tx.inspection_plan.count({ where: { routing_id: routingId } }),
        tx.work_order.count({ where: { routing_operation_id: { in: lineIds } } }),
        tx.bom_component.count({ where: { routing_operation_id: { in: lineIds } } }),
      ]);
      if (plans + inspectionPlans + workOrders + components > 0) {
        throw discardLocked('이 Rev 를 쓰는 생산계획 · 작업지시 · BOM · 검사기준이 있어 취소할 수 없습니다.');
      }

      await tx.routing_operation_dependency.deleteMany({
        where: {
          OR: [
            { predecessor_operation_id: { in: lineIds } },
            { successor_operation_id: { in: lineIds } },
          ],
        },
      });
      await tx.routing_operation.deleteMany({ where: { routing_id: routingId } });
      await tx.routing.delete({ where: { routing_id: routingId } });
      await recordRoutingAudit(tx, {
        routingId,
        eventTypeCode: 'DELETE',
        actorId,
        before: {
          routingCode: rows[0].routing_code,
          routingVersion: Number(rows[0].routing_version),
          statusCode: rows[0].status_code,
        },
      });
    });
  }

  private async load(routingId: number): Promise<Prisma.routingGetPayload<object>> {
    const row = await this.prisma.routing.findUnique({ where: { routing_id: routingId } });
    if (!row) throw new NotFoundException('없는 Routing 입니다.');
    return row;
  }
}

/**
 * Rev 를 복사해 품목의 최댓값 +1 번 Rev 를 만든다 — 라인 · 선후행까지(`newRevision` 의 규칙).
 * `adjustLine` 은 복사하는 라인 칸을 고친다 — PQC 기준 연동이 확정 Rev 를 새 Rev 로 바꿀 때 쓴다.
 * 새 Rev 는 기본 Rev 를 빼앗지 않는다 — 넘길 일이면 부르는 쪽이 한다.
 */
export async function copyRoutingRevision(
  tx: Prisma.TransactionClient,
  source: Prisma.routingGetPayload<object>,
  statusCode: string,
  adjustLine: (line: Prisma.routing_operationGetPayload<object>) => Partial<Prisma.routing_operationUncheckedCreateInput> = () => ({}),
): Promise<bigint> {
  const latest = await tx.routing.aggregate({
    where: { item_id: source.item_id },
    _max: { routing_version: true },
  });
  const created = await tx.routing.create({
    data: {
      item_id: source.item_id,
      routing_code: source.routing_code,
      routing_version: (latest._max.routing_version ?? source.routing_version) + 1,
      status_code: statusCode,
      effective_from: source.effective_from,
      effective_to: source.effective_to,
    },
  });

  const lines = await tx.routing_operation.findMany({
    where: { routing_id: source.routing_id },
    orderBy: { operation_seq: 'asc' },
  });
  // 원본 라인 id → 새 라인 id. 선후행을 옮기려면 이 대응이 필요하다.
  const moved = new Map<bigint, bigint>();
  for (const line of lines) {
    const copy = await tx.routing_operation.create({
      data: { ...lineData(line), ...adjustLine(line), routing_id: created.routing_id },
    });
    moved.set(line.routing_operation_id, copy.routing_operation_id);
  }

  const dependencies = await tx.routing_operation_dependency.findMany({
    where: { predecessor_operation_id: { in: [...moved.keys()] } },
  });
  if (dependencies.length > 0) {
    await tx.routing_operation_dependency.createMany({
      data: dependencies.map((dependency) => ({
        predecessor_operation_id: moved.get(dependency.predecessor_operation_id) as bigint,
        successor_operation_id: moved.get(dependency.successor_operation_id) as bigint,
        dependency_type_code: dependency.dependency_type_code,
      })),
    });
  }
  return created.routing_id;
}

/** 복제할 라인 칸만 고른다 — id·감사 칸·버전은 새 행이 스스로 갖는다. */
function lineData(
  line: Prisma.routing_operationGetPayload<object>,
): Omit<Prisma.routing_operationUncheckedCreateInput, 'routing_id'> {
  return {
    operation_seq: line.operation_seq,
    process_id: line.process_id,
    operation_name: line.operation_name,
    name_ko: line.name_ko,
    name_vi: line.name_vi,
    mes_managed: line.mes_managed,
    material_input_managed: line.material_input_managed,
    production_result_managed: line.production_result_managed,
    inspection_managed: line.inspection_managed,
    is_subcontract: line.is_subcontract,
    output_lot_required: line.output_lot_required,
    equipment_required: line.equipment_required,
    mold_required: line.mold_required,
    standard_cycle_time_sec: line.standard_cycle_time_sec,
    standard_yield_rate: line.standard_yield_rate,
  };
}

function discardLocked(message: string): ContractException {
  return new ContractException(HttpStatus.BAD_REQUEST, [
    { scope: 'screen', code: ERROR_CODE.STATE_LOCKED, message },
  ]);
}
