import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE } from '../../common/errors';
import { assertUpdated } from '../../common/optimistic-lock';
import { PrismaService } from '../../prisma/prisma.service';
import { assertCodeValues } from '../../common/master';

/**
 * 판정유형별 물류 통제. 결정 10 「출고·출하·Picking 차단 판정은 **이 단일 지점**을
 * 본다」를 되살린 자원이다(2026-08-30).
 *
 * ⛔ 판정유형은 `code_value`(`JUDGMENT_TYPE`)이고, 이 표는 그 행에 속성 6종을 «덧붙인다»
 * — 기본키가 `code_value_id` 다. 그래서 새로 만드는 경로가 없고 편집만 있다.
 * 통제 행이 아직 없는 판정유형은 「전부 거짓」으로 시작한 것으로 읽는다.
 */
interface ControlView {
  codeValueId: number;
  blocksIssue: boolean;
  blocksShipment: boolean;
  blocksPicking: boolean;
  requiresApproval: boolean;
  approverRoleId: number | null;
  lotStatusCode: string | null;
  versionNo: number;
}

export interface ControlUpdate {
  blocksIssue: boolean;
  blocksShipment: boolean;
  blocksPicking: boolean;
  requiresApproval: boolean;
  approverRoleId?: number | null;
  lotStatusCode?: string | null;
}

type ControlRow = Prisma.judgment_type_controlGetPayload<object>;

@Injectable()
export class JudgmentTypeControlService {
  constructor(private readonly prisma: PrismaService) {}

  /** `JUDGMENT_TYPE` 코드 값 전부를 낸다 — 통제 행이 없는 것도 기본값으로 함께. */
  async list(): Promise<ControlView[]> {
    const values = await this.prisma.code_value.findMany({
      where: { code_group: { group_code: 'JUDGMENT_TYPE' } },
      orderBy: [{ display_order: 'asc' }, { code: 'asc' }],
      select: { code_value_id: true },
    });
    if (values.length === 0) return [];

    const controls = await this.prisma.judgment_type_control.findMany({
      where: { code_value_id: { in: values.map((v) => v.code_value_id) } },
    });
    const byId = new Map(controls.map((row) => [Number(row.code_value_id), row]));

    return values.map((value) => {
      const row = byId.get(Number(value.code_value_id));
      return row === undefined ? empty(Number(value.code_value_id)) : view(row);
    });
  }

  /**
   * 「전사 고정 축 — 편집하면 상태 전이도·물류 통제 규칙이 함께 바뀐다」(계약 W-06-04 §5-1).
   *
   * 통제 행이 없으면 만든다(upsert) — 판정유형 자체는 코드 값이 낳고, 이 표는 그 위에
   * 얹히는 속성이라 「없으면 기본값」과 「만든다」가 같은 뜻이다.
   */
  async update(codeValueId: number, version: number, input: ControlUpdate): Promise<ControlView> {
    await this.assertJudgmentType(codeValueId);
    if (input.lotStatusCode != null) {
      await assertCodeValues(this.prisma, [
        { field: 'lotStatusCode', value: input.lotStatusCode, groupCode: 'LOT_STATUS' },
      ]);
    }
    if (input.approverRoleId != null) {
      const role = await this.prisma.role.findUnique({
        where: { role_id: input.approverRoleId },
        select: { role_id: true },
      });
      if (!role) {
        throw new ContractException(HttpStatus.BAD_REQUEST, [
          {
            scope: 'field',
            field: 'approverRoleId',
            code: ERROR_CODE.INVALID,
            message: '없는 역할입니다.',
          },
        ]);
      }
    }

    // ⛔ ck_judgment_type_control_approver — 「requires_approval 이거나 승인 역할이 없거나」.
    // 계약도 「requiresApproval 이 참일 때만 의미가 있다」로 적었다. 승인이 필요 없는데
    // 승인 역할이 남아 있으면 「누가 승인하는가」가 아무 데도 안 쓰이는 채로 남는다.
    if (!input.requiresApproval && input.approverRoleId != null) {
      throw new ContractException(HttpStatus.BAD_REQUEST, [
        {
          scope: 'field',
          field: 'approverRoleId',
          code: ERROR_CODE.PAIR,
          message: '승인이 필요하지 않으면 승인 역할을 둘 수 없습니다.',
        },
      ]);
    }

    const existing = await this.prisma.judgment_type_control.findUnique({
      where: { code_value_id: codeValueId },
      select: { version_no: true },
    });
    // ⛔ 여섯 칸을 «통째로» 바꾸는 편집이다. 안 보낸 칸은 「그대로 두라」가 아니라
    // 「비우라」다 — 그렇게 안 보면 승인이 꺼진 뒤에도 승인 역할이 남아 CHECK 가 깨진다.
    const data = {
      blocks_issue: input.blocksIssue,
      blocks_shipment: input.blocksShipment,
      blocks_picking: input.blocksPicking,
      requires_approval: input.requiresApproval,
      approver_role_id: input.approverRoleId ?? null,
      lot_status_code: input.lotStatusCode ?? null,
    };

    if (existing === undefined || existing === null) {
      // 아직 통제 행이 없다 — 목록이 낸 기본값(version 1)을 들고 온 것이 맞는지 본다.
      if (version !== 1) assertUpdated(0);
      await this.prisma.judgment_type_control.create({
        data: { code_value_id: codeValueId, ...data },
      });
      return this.get(codeValueId);
    }

    const updated = await this.prisma.judgment_type_control.updateMany({
      // ⛔ version_no 를 조건에 건다. 0행이면 그 사이 누가 먼저 저장했다.
      where: { code_value_id: codeValueId, version_no: version },
      data: { ...data, version_no: { increment: 1 } },
    });
    assertUpdated(updated.count);
    return this.get(codeValueId);
  }

  async get(codeValueId: number): Promise<ControlView> {
    const row = await this.prisma.judgment_type_control.findUnique({
      where: { code_value_id: codeValueId },
    });
    return row === null ? empty(codeValueId) : view(row);
  }

  /** 판정유형이 아닌 코드 값에 통제를 붙이면 아무 데서도 안 읽힌다. */
  private async assertJudgmentType(codeValueId: number): Promise<void> {
    const value = await this.prisma.code_value.findUnique({
      where: { code_value_id: codeValueId },
      select: { code_group: { select: { group_code: true } } },
    });
    if (!value || value.code_group.group_code !== 'JUDGMENT_TYPE') {
      throw new NotFoundException('없는 판정유형입니다.');
    }
  }
}

/** 통제 행이 없는 판정유형 — 「아무것도 막지 않는다」가 기본이다. */
function empty(codeValueId: number): ControlView {
  return {
    codeValueId,
    blocksIssue: false,
    blocksShipment: false,
    blocksPicking: false,
    requiresApproval: false,
    approverRoleId: null,
    lotStatusCode: null,
    versionNo: 1,
  };
}

function view(row: ControlRow): ControlView {
  return {
    codeValueId: Number(row.code_value_id),
    blocksIssue: row.blocks_issue,
    blocksShipment: row.blocks_shipment,
    blocksPicking: row.blocks_picking,
    requiresApproval: row.requires_approval,
    approverRoleId: row.approver_role_id === null ? null : Number(row.approver_role_id),
    lotStatusCode: row.lot_status_code,
    versionNo: row.version_no,
  };
}
