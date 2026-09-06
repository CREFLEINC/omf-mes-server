import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ERROR_CODE, field, one } from '../../common/errors';
import { filter } from '../../common/master';
import { PagedResponse, pageRequest, pagedResponse } from '../../common/pagination';
import { PrismaService } from '../../prisma/prisma.service';
import {
  WORK_SESSION_EVENT_ORDER_BY,
  WORK_SESSION_WORKER_ORDER_BY,
  WorkSessionEventRow,
  WorkSessionEventView,
  WorkSessionView,
  WorkSessionWorkerView,
  reasonKey,
  workSessionEventView,
  workSessionView,
  workSessionWorkerView,
} from './work-session-view';

/** 계약 질의 8 전건 — 필수는 하나도 없다(§1-2). */
export interface WorkSessionListQuery {
  open?: boolean;
  workOrderId?: unknown;
  terminalId?: unknown;
  shiftId?: unknown;
  startedFrom?: string;
  startedTo?: string;
  page?: number;
  size?: number;
}

/** 정렬 키가 계약에 없다 ⇒ `work_session_id` 역순으로 고정한다(§8 · I-9 R-13 선례). */
export const WORK_SESSION_ORDER_BY: Prisma.work_sessionOrderByWithRelationInput[] = [
  { work_session_id: 'desc' },
];

/**
 * 작업 세션·통제 판정 조회 5건(I-11 PR ①). ⛔ ETag·403 미검사(계약 미선언) ·
 * 도메인 간 service 호출 0(Prisma 직접).
 */
@Injectable()
export class WorkSessionQueryService {
  constructor(private readonly prisma: PrismaService) {}

  /** `open ?? true` → `ended_at: null` / `false` → `{ not: null }`(여집합 — I-6 `held` 선례). */
  async list(query: WorkSessionListQuery): Promise<PagedResponse<WorkSessionView>> {
    const page = pageRequest(query);
    const open = query.open ?? true;
    const startedAt = {
      ...(query.startedFrom === undefined ? {} : { gte: new Date(query.startedFrom) }),
      ...(query.startedTo === undefined ? {} : { lt: new Date(query.startedTo) }),
    };
    const where: Prisma.work_sessionWhereInput = {
      // ⛔ `status_code` 로 거르지 않는다 — `STOPPED` 도 열린 것이다(§8 G-16).
      ended_at: open ? null : { not: null },
      ...filter('work_order_id', numeric('workOrderId', query.workOrderId)),
      ...filter('terminal_id', numeric('terminalId', query.terminalId)),
      ...filter('shift_id', numeric('shiftId', query.shiftId)),
      ...(Object.keys(startedAt).length === 0 ? {} : { started_at: startedAt }),
    };

    const [rows, total] = await Promise.all([
      this.prisma.work_session.findMany({ where, orderBy: WORK_SESSION_ORDER_BY, skip: page.skip, take: page.take }),
      this.prisma.work_session.count({ where }),
    ]);
    return pagedResponse(rows.map(workSessionView), total, page);
  }

  /** 없으면 404(계약 선언). */
  async detail(workSessionId: number): Promise<WorkSessionView> {
    return workSessionView(await this.loadSession(workSessionId));
  }

  /** 부모 404 뒤 배열(page 없음) — `approval-route.service.ts` `listSteps` 와 같은 모양. */
  async events(workSessionId: number, query: { eventTypeCode?: string }): Promise<WorkSessionEventView[]> {
    await this.loadSession(workSessionId);
    const rows = await this.prisma.work_session_event.findMany({
      where: {
        work_session_id: BigInt(workSessionId),
        ...(query.eventTypeCode === undefined ? {} : { event_type_code: query.eventTypeCode }),
      },
      orderBy: WORK_SESSION_EVENT_ORDER_BY,
    });
    const reasonNames = await this.loadReasonNames(rows);
    return rows.map((row) => workSessionEventView(row, reasonNames.get(reasonKey(row) ?? '')));
  }

  /** 세션 존재 확인 뒤 배열. `active ?? true` → `left_at: null`(여집합). */
  async workers(workSessionId: number, query: { active?: boolean }): Promise<WorkSessionWorkerView[]> {
    await this.loadSession(workSessionId);
    const active = query.active ?? true;
    const rows = await this.prisma.work_session_worker.findMany({
      where: { work_session_id: BigInt(workSessionId), left_at: active ? null : { not: null } },
      orderBy: WORK_SESSION_WORKER_ORDER_BY,
    });
    return rows.map(workSessionWorkerView);
  }

  private async loadSession(workSessionId: number) {
    const row = await this.prisma.work_session.findUnique({ where: { work_session_id: BigInt(workSessionId) } });
    if (row === null) throw new NotFoundException('없는 작업 세션입니다.');
    return row;
  }

  /**
   * `reasonName` 을 이벤트 목록 한 번에 모아 찾는다(N+1 방지, §8 ⭐). `code_value` 는 그룹을
   * `code_group.group_code` 관계로 갖는다 — 스칼라 칸이 아니다(`assertCodeValues` 실측).
   */
  private async loadReasonNames(rows: WorkSessionEventRow[]): Promise<Map<string, string>> {
    const keys = new Set(rows.map(reasonKey).filter((key): key is string => key !== undefined));
    if (keys.size === 0) return new Map();

    const found = await this.prisma.code_value.findMany({
      where: {
        OR: [...keys].map((key) => {
          const [groupCode, code] = key.split(':');
          return { code, code_group: { group_code: groupCode } };
        }),
      },
      select: { code: true, code_name: true, code_group: { select: { group_code: true } } },
    });
    return new Map(found.map((row) => [`${row.code_group.group_code}:${row.code}`, row.code_name]));
  }
}

/** 숫자 축에 글자가 섞이면 400 이다 — 넘기면 Prisma 검증 오류가 500 으로 샌다. */
function numeric(name: string, value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = Number(value);
  if (Number.isInteger(parsed) && parsed >= 0) return parsed;
  throw one(field(name, ERROR_CODE.INVALID, '숫자여야 합니다.'));
}
