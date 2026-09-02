import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE } from '../../common/errors';
import { DocumentStateService } from '../../core/document-state';
import { PrismaService } from '../../prisma/prisma.service';
import { ROUTING_STATUS } from './routing-status';

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
  async confirm(routingId: number): Promise<number> {
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

    await this.prisma.routing.update({
      where: { routing_id: routingId },
      data: { status_code: transition.to, version_no: { increment: 1 } },
    });
    return routingId;
  }

  /** 확정 → 폐기. ⛔ dead end 다 — 계약 §5-4 상태표가 「폐기 → (없음)」이라 적었다. */
  async obsolete(routingId: number): Promise<number> {
    const row = await this.load(routingId);
    const transition = this.documentState.assertTransition(
      STATE_COLUMN,
      'routing-obsolete',
      row.status_code,
      HttpStatus.BAD_REQUEST,
    );

    await this.prisma.routing.update({
      where: { routing_id: routingId },
      data: { status_code: transition.to, version_no: { increment: 1 } },
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
  async newRevision(routingId: number): Promise<number> {
    const source = await this.load(routingId);
    if (source.status_code !== ROUTING_STATUS.CONFIRMED) {
      throw new ContractException(HttpStatus.BAD_REQUEST, [
        {
          scope: 'screen',
          code: ERROR_CODE.STATE_LOCKED,
          message: '확정된 Rev 에서만 신규 Rev 를 발행할 수 있습니다.',
        },
      ]);
    }

    return this.prisma.$transaction(async (tx) => {
      const latest = await tx.routing.aggregate({
        where: { item_id: source.item_id },
        _max: { routing_version: true },
      });
      const created = await tx.routing.create({
        data: {
          item_id: source.item_id,
          routing_code: source.routing_code,
          routing_version: (latest._max.routing_version ?? source.routing_version) + 1,
          status_code: ROUTING_STATUS.DRAFT,
          effective_from: source.effective_from,
          effective_to: source.effective_to,
          // 새 초안이 기본 Rev 를 빼앗지 않는다 — 지정은 `:set-default` 가 한다.
        },
      });

      const lines = await tx.routing_operation.findMany({
        where: { routing_id: routingId },
        orderBy: { operation_seq: 'asc' },
      });
      // 원본 라인 id → 새 라인 id. 선후행을 옮기려면 이 대응이 필요하다.
      const moved = new Map<bigint, bigint>();
      for (const line of lines) {
        const copy = await tx.routing_operation.create({
          data: { ...lineData(line), routing_id: created.routing_id },
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

      return Number(created.routing_id);
    });
  }

  private async load(routingId: number): Promise<Prisma.routingGetPayload<object>> {
    const row = await this.prisma.routing.findUnique({ where: { routing_id: routingId } });
    if (!row) throw new NotFoundException('없는 Routing 입니다.');
    return row;
  }
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
