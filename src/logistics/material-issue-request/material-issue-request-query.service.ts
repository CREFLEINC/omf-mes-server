import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PagedResponse, pageRequest, pagedResponse } from '../../common/pagination';
import { PrismaService } from '../../prisma/prisma.service';
import {
  MaterialIssueRequestDetail,
  MaterialIssueRequestView,
  materialIssueRequestLineView,
  materialIssueRequestView,
} from './material-issue-request-view';

export interface MaterialIssueRequestQuery {
  workOrderId?: unknown;
  statusCode?: string;
  requiredAtFrom?: string;
  requiredAtTo?: string;
  q?: string;
  page?: unknown;
  size?: unknown;
}

/**
 * 자재 출고요청 목록·상세(화면 `M-01-08`).
 * ⚠ 질의 칸의 타입은 계약 검증 가드가 이미 강제·변환했다(`contract-validator.ts`).
 */
@Injectable()
export class MaterialIssueRequestQueryService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: MaterialIssueRequestQuery): Promise<PagedResponse<MaterialIssueRequestView>> {
    const page = pageRequest({ page: int(query.page), size: int(query.size) });
    const workOrderId = int(query.workOrderId);
    const where: Prisma.material_issue_requestWhereInput = {
      ...(workOrderId === undefined ? {} : { work_order_id: workOrderId }),
      // ⛔ 4값 대조를 걸지 않는다 — 필터에 값 목록을 걸면 값이 늘 때 조회가 400 을 낸다(§8-2).
      ...(query.statusCode === undefined ? {} : { status_code: query.statusCode }),
      ...requiredAtWhere(query.requiredAtFrom, query.requiredAtTo),
      ...(query.q === undefined
        ? {}
        : { issue_request_no: { contains: query.q, mode: 'insensitive' } }),
    };

    const [rows, total] = await Promise.all([
      this.prisma.material_issue_request.findMany({
        where,
        // 계약 침묵 — PK 역순이다(§8-1 · PK 가 유일해 페이지 경계가 흔들리지 않는다).
        orderBy: { material_issue_request_id: 'desc' },
        skip: page.skip,
        take: page.take,
      }),
      this.prisma.material_issue_request.count({ where }),
    ]);
    return pagedResponse(rows.map(materialIssueRequestView), total, page);
  }

  /** 없으면 404 다(계약 선언 · 출고 상세 선례). */
  async get(materialIssueRequestId: number): Promise<MaterialIssueRequestDetail> {
    const row = await this.prisma.material_issue_request.findUnique({
      where: { material_issue_request_id: materialIssueRequestId },
    });
    if (!row) throw new NotFoundException('없는 자재 출고요청입니다.');
    const lines = await this.prisma.material_issue_request_line.findMany({
      where: { material_issue_request_id: materialIssueRequestId },
      orderBy: { line_no: 'asc' },
    });
    return {
      materialIssueRequest: materialIssueRequestView(row),
      lines: lines.map(materialIssueRequestLineView),
    };
  }
}

/** `required_at` 도 질의도 `date-time` 이다 — 하루 경계를 풀 공장 축이 없으니 받은 시각을
 *  그대로 쓴다(CLAUDE.md 날짜 타임존 캐스팅 금지). */
function requiredAtWhere(from?: string, to?: string): Prisma.material_issue_requestWhereInput {
  if (from === undefined && to === undefined) return {};
  return {
    required_at: {
      ...(from === undefined ? {} : { gte: new Date(from) }),
      ...(to === undefined ? {} : { lte: new Date(to) }),
    },
  };
}

function int(value: unknown): number | undefined {
  return value === undefined || value === '' ? undefined : Number(value);
}
