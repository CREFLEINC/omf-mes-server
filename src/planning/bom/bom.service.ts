import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ConflictCause, ContractException, ERROR_CODE, ErrorItem } from '../../common/errors';
import { Editability, toDateString } from '../../common/master';
import { assertUpdated } from '../../common/optimistic-lock';
import { PrismaService } from '../../prisma/prisma.service';
import { REVISION_STATUS } from '../revision-status';

/**
 * ⛔ BOM 은 **ERP 정본**이다(QA #3). 헤더는 전 필드 읽기 전용이고, 구성품도 원본 열은
 * 잠긴다 — **참조 건수로 갈리지 않는다.** 계약이 그렇게 못박았다.
 */
const RECEIVED: Editability = {
  codeEditable: false,
  reason: 'RECEIVED_FROM_ERP',
  referenceCount: null,
};

/** 계약 `Bom` 과 동형. */
interface BomView {
  bomId: number;
  parentItemId: number;
  bomCode: string;
  bomVersion: number;
  statusCode: string;
  isDefault: boolean;
  effectiveFrom: string;
  effectiveTo: string | null;
  baseQty: number;
  baseUomId: number;
}

/** 계약 `BomComponent` 와 동형. ERP 원본 열과 MES 확장 열이 한 행에 섞인다(§4-F). */
interface BomComponentView {
  bomComponentId: number;
  bomId: number;
  componentItemId: number;
  routingOperationId: number | null;
  actualUseProcessId: number | null;
  requiredQty: number;
  uomId: number;
  scrapRate: number;
  isMandatory: boolean;
  lotTraceRequired: boolean;
  backflushAllowed: boolean;
  sequenceNo: number;
}

/** 「편집 가능한 것은 넷뿐이다」(계약). 나머지는 ERP 원본이라 이 API 로 바꾸지 않는다. */
export interface BomComponentUpdate {
  routingOperationId?: number | null;
  actualUseProcessId?: number | null;
  lotTraceRequired: boolean;
  backflushAllowed: boolean;
}

export interface BomQuery {
  parentItemId: number;
  bomCode?: string;
  usableOnly?: boolean;
}

type BomRow = Prisma.bomGetPayload<object>;
type ComponentRow = Prisma.bom_componentGetPayload<object>;

export interface ComponentResult {
  bomComponent: BomComponentView;
  editability: Editability;
  versionNo: number;
}

@Injectable()
export class BomService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: BomQuery): Promise<BomView[]> {
    const rows = await this.prisma.bom.findMany({
      where: {
        parent_item_id: query.parentItemId,
        ...(query.bomCode === undefined ? {} : { bom_code: query.bomCode }),
        ...(query.usableOnly ? usableWhere() : {}),
      },
      orderBy: [{ bom_code: 'asc' }, { bom_version: 'desc' }],
    });
    return rows.map(view);
  }

  async get(bomId: number): Promise<{ bom: BomView; editability: Editability }> {
    const row = await this.prisma.bom.findUnique({ where: { bom_id: bomId } });
    if (!row) throw new NotFoundException('없는 BOM 입니다.');
    return { bom: view(row), editability: RECEIVED };
  }

  async listComponents(bomId: number): Promise<BomComponentView[]> {
    await this.assertBom(bomId);
    const rows = await this.prisma.bom_component.findMany({
      where: { bom_id: bomId },
      orderBy: { sequence_no: 'asc' },
    });
    return rows.map(componentView);
  }

  async getComponent(bomId: number, bomComponentId: number): Promise<ComponentResult> {
    const row = await this.loadComponent(bomId, bomComponentId);
    return { bomComponent: componentView(row), editability: RECEIVED, versionNo: row.version_no };
  }

  /**
   * MES 확장 네 칸만 고친다.
   *
   * ⚠ 「BOM 헤더는 기간계에서 받아 오므로 이 시스템이 상태를 바꾸지 않는다 — 확장 네 칸의
   * 편집을 **헤더 상태로 막지 않는다**」(계약). 그래서 작성중·확정을 가리지 않는다.
   */
  async updateComponent(
    bomId: number,
    bomComponentId: number,
    version: number,
    input: BomComponentUpdate,
    actorId?: number,
  ): Promise<ComponentResult> {
    const current = await this.loadComponent(bomId, bomComponentId);
    await this.assertExtensionTargets(bomId, input);

    const updated = await this.prisma.bom_component.updateMany({
      // ⛔ version_no 를 조건에 건다. 0행이면 그 사이 누가 먼저 저장했다.
      where: { bom_component_id: bomComponentId, version_no: version },
      data: {
        // ⛔ 네 칸을 «통째로» 바꾸는 편집이다 — 안 보낸 칸은 「그대로」가 아니라 「비우라」다.
        // 그렇게 안 보면 공정 연결을 지우려고 보낸 요청이 조용히 무시된다.
        routing_operation_id: input.routingOperationId ?? null,
        actual_use_process_id: input.actualUseProcessId ?? null,
        lot_trace_required: input.lotTraceRequired,
        backflush_allowed: input.backflushAllowed,
        version_no: { increment: 1 },
        // ⛔ 누가 고쳤는지를 남긴다. 이 칸이 비어 있으면 「사람이 안 고쳤다」로 읽히고,
        // 그것이 아래 충돌 원인 판정의 근거다 — 안 채우면 판정이 언제나 erpSync 가 된다.
        updated_by: actorId ?? null,
      },
    });
    // ⛔ 원인을 가른다. 계약이 이유를 적었다 — 「erpSync 는 ERP 재동기화 배치가 같은 BOM 을
    // 갱신했을 가능성이 높다. 구분 없이 내려주면 화면이 「다른 사용자가 먼저 수정했습니다」
    // 라는 사실과 다른 안내를 하게 된다」.
    assertUpdated(updated.count, causeOf(current));

    return this.getComponent(bomId, bomComponentId);
  }

  /**
   * 「서버가 한 트랜잭션으로 처리한다 — 지정한 BOM 을 `isDefault=true` 로 세우는 동시에
   * 같은 품목의 기존 기본 BOM 을 `isDefault=false` 로 내린다」(계약 · `A-6`).
   *
   * ⛔ 화면이 해제→설정 두 번을 부르지 않는 이유가 계약에 있다 — 「그 사이 기본 BOM 0개」
   * 상태를 만들지 않기 위함이다.
   */
  async setDefault(bomId: number): Promise<BomView> {
    const row = await this.prisma.bom.findUnique({
      where: { bom_id: bomId },
      select: { parent_item_id: true },
    });
    if (!row) throw new NotFoundException('없는 BOM 입니다.');

    await this.prisma.$transaction(async (tx) => {
      await tx.bom.updateMany({
        where: { parent_item_id: row.parent_item_id, is_default: true, bom_id: { not: bomId } },
        data: { is_default: false, version_no: { increment: 1 } },
      });
      await tx.bom.update({
        where: { bom_id: bomId },
        data: { is_default: true, version_no: { increment: 1 } },
      });
    });

    return (await this.get(bomId)).bom;
  }

  private async assertBom(bomId: number): Promise<void> {
    const row = await this.prisma.bom.findUnique({
      where: { bom_id: bomId },
      select: { bom_id: true },
    });
    if (!row) throw new NotFoundException('없는 BOM 입니다.');
  }

  /** 구성품은 «그 BOM 의» 것이어야 한다 — 남의 행을 경로만 바꿔 고칠 수 있으면 안 된다. */
  private async loadComponent(bomId: number, bomComponentId: number): Promise<ComponentRow> {
    const row = await this.prisma.bom_component.findUnique({
      where: { bom_component_id: bomComponentId },
    });
    if (!row || Number(row.bom_id) !== bomId) {
      throw new NotFoundException('없는 BOM 구성품입니다.');
    }
    return row;
  }

  /**
   * 확장 두 칸이 가리키는 곳이 실재하는지 본다.
   *
   * ⛔ 공정 라인은 **같은 품목의 Routing** 에서 고른다 — 계약이 「`routingOperationId`
   * 선택은 Routing 등록(`W-06-01`)이 선행돼야 한다」로 적었고, 다른 품목의 공정을 걸면
   * 투입 시점에 짝이 맞지 않는다. 계약에 없고 서버가 정했다.
   */
  private async assertExtensionTargets(bomId: number, input: BomComponentUpdate): Promise<void> {
    const errors: ErrorItem[] = [];

    if (input.routingOperationId != null) {
      const bom = await this.prisma.bom.findUniqueOrThrow({
        where: { bom_id: bomId },
        select: { parent_item_id: true },
      });
      const operation = await this.prisma.routing_operation.findFirst({
        where: {
          routing_operation_id: input.routingOperationId,
          routing: { item_id: bom.parent_item_id },
        },
        select: { routing_operation_id: true },
      });
      if (!operation) {
        errors.push(invalid('routingOperationId', '이 품목의 Routing 공정이 아닙니다.'));
      }
    }

    if (input.actualUseProcessId != null) {
      const process = await this.prisma.process.findUnique({
        where: { process_id: input.actualUseProcessId },
        select: { process_id: true },
      });
      if (!process) errors.push(invalid('actualUseProcessId', '없는 공정입니다.'));
    }

    if (errors.length > 0) throw new ContractException(HttpStatus.BAD_REQUEST, errors);
  }
}

/**
 * 「지금 새 작업지시에 걸 수 있는 개정만」 — 확정이고 유효 기간 안이다.
 * ⚠ 「지금」을 UTC 날짜로 읽는다. Routing 과 같은 자리이고 같은 한계다(되돌림 §S-2).
 */
function usableWhere(): Prisma.bomWhereInput {
  const today = new Date(new Date().toISOString().slice(0, 10));
  return {
    status_code: REVISION_STATUS.CONFIRMED,
    AND: [
      { effective_from: { lte: today } },
      { OR: [{ effective_to: null }, { effective_to: { gte: today } }] },
    ],
  };
}

/**
 * 저장 충돌의 원인을 가른다.
 *
 * ⛔ `updated_by` 가 비어 있으면 사람이 고친 것이 아니다 — ERP 연계는 세션 없이 쓰므로
 * 그 칸을 채울 수 없다. 완벽한 판정은 아니지만(연계가 언제 돌았는지는 여기서 모른다)
 * 계약이 요구한 구분을 **가진 정보로** 하는 유일한 길이다.
 */
function causeOf(row: ComponentRow): ConflictCause {
  return row.updated_by === null ? 'erpSync' : 'user';
}

function invalid(field: string, message: string): ErrorItem {
  return { scope: 'field', field, code: ERROR_CODE.INVALID, message };
}

function view(row: BomRow): BomView {
  return {
    bomId: Number(row.bom_id),
    parentItemId: Number(row.parent_item_id),
    bomCode: row.bom_code,
    bomVersion: row.bom_version,
    statusCode: row.status_code,
    isDefault: row.is_default,
    effectiveFrom: toDateString(row.effective_from) ?? '',
    effectiveTo: toDateString(row.effective_to),
    baseQty: Number(row.base_qty),
    baseUomId: Number(row.base_uom_id),
  };
}

function componentView(row: ComponentRow): BomComponentView {
  return {
    bomComponentId: Number(row.bom_component_id),
    bomId: Number(row.bom_id),
    componentItemId: Number(row.component_item_id),
    routingOperationId: row.routing_operation_id === null ? null : Number(row.routing_operation_id),
    actualUseProcessId:
      row.actual_use_process_id === null ? null : Number(row.actual_use_process_id),
    requiredQty: Number(row.required_qty),
    uomId: Number(row.uom_id),
    scrapRate: Number(row.scrap_rate),
    isMandatory: row.is_mandatory,
    lotTraceRequired: row.lot_trace_required,
    backflushAllowed: row.backflush_allowed,
    sequenceNo: row.sequence_no,
  };
}
