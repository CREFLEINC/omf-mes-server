import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ERROR_CODE, field, one } from '../../common/errors';
import { filter } from '../../common/master';
import { PagedResponse, pageRequest, pagedResponse } from '../../common/pagination';
import { PrismaService } from '../../prisma/prisma.service';
import { TerminalListScope } from '../terminal-list-scope';
import { PutawayTaskView, TASK_INCLUDE, taskView } from './putaway-task-view';

/** 계약 검증 가드가 이미 int64/boolean 을 캐스트한다 — page·size·temporaryOnly 는 그 값을 믿는다. */
export interface PutawayTaskQuery {
  assignedWorkerId?: unknown; warehouseId?: unknown; lotId?: unknown; goodsReceiptId?: unknown;
  statusCode?: string; temporaryOnly?: boolean;
  page?: number; size?: number;
}

/** 적치 지시 조회 2건 — 화면 `M-01-05`·`M-01-07` 소유. 완료·임시 적재는 PR ② 몫, 도메인 간 service 호출 0. */
@Injectable()
export class PutawayTaskService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: PutawayTaskQuery, terminal?: TerminalListScope): Promise<PagedResponse<PutawayTaskView>> {
    const page = pageRequest(query);
    const where = putawayTaskWhere(query, terminal);

    const [rows, total] = await Promise.all([
      this.prisma.putaway_task.findMany({
        where,
        include: TASK_INCLUDE,
        orderBy: [{ priority_no: 'asc' }, { putaway_task_id: 'asc' }],
        skip: page.skip,
        take: page.take,
      }),
      this.prisma.putaway_task.count({ where }),
    ]);
    return pagedResponse(rows.map(taskView), total, page);
  }

  async get(putawayTaskId: number): Promise<{ view: PutawayTaskView; versionNo: number }> {
    const row = await this.prisma.putaway_task.findUnique({
      where: { putaway_task_id: putawayTaskId },
      include: TASK_INCLUDE,
    });
    if (!row) throw new NotFoundException('없는 적치 지시입니다.');
    return { view: taskView(row), versionNo: row.version_no };
  }
}

/** 숫자 축에 글자가 섞이면 400 이다 — 넘기면 Prisma 검증 오류가 500 으로 샌다(피킹 목록 선례). */
function numeric(name: string, value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = Number(value);
  if (Number.isInteger(parsed) && parsed >= 0) return parsed;
  throw one(field(name, ERROR_CODE.INVALID, '숫자여야 합니다.'));
}

/**
 * 적치 지시 목록의 조건 — 단말 작업 수가 같은 함수로 센다(배지 = 목록 · omf-all-around#190).
 * ⭐ AND — 겹치는 statusCode·temporaryOnly 모순은 빈 목록(400 아니다). warehouseId 는
 *   응답과 같은 칸(goods_receipt.warehouse_id)으로 거른다. 단말에 창고가 있으면 그 창고만.
 */
export function putawayTaskWhere(query: PutawayTaskQuery, terminal?: TerminalListScope): Prisma.putaway_taskWhereInput {
  const goodsReceiptId = numeric('goodsReceiptId', query.goodsReceiptId);
  const warehouseId = numeric('warehouseId', query.warehouseId);
  return {
    AND: [
      filter('assigned_worker_id', numeric('assignedWorkerId', query.assignedWorkerId)),
      filter('lot_id', numeric('lotId', query.lotId)),
      query.statusCode === undefined ? {} : { status_code: query.statusCode },
      query.temporaryOnly === true ? { status_code: 'COMPLETED_TEMPORARY' } : {},
      goodsReceiptId === undefined ? {} : { goods_receipt_line: { goods_receipt_id: goodsReceiptId } },
      warehouseId === undefined ? {} : { goods_receipt_line: { goods_receipt: { warehouse_id: warehouseId } } },
      terminal === undefined ? {} : { goods_receipt_line: { goods_receipt: { plant_id: terminal.plantId } } },
      terminal?.warehouseId == null ? {} : { goods_receipt_line: { goods_receipt: { warehouse_id: terminal.warehouseId } } },
    ],
  };
}
