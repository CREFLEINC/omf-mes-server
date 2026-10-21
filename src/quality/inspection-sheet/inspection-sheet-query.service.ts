import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PagedResponse, pageRequest, pagedResponse } from '../../common/pagination';
import { PrismaService } from '../../prisma/prisma.service';

/** 계약 `InspectionSheetListQuery`. 기간은 작성 시각(UTC) 기준이다. */
export interface InspectionSheetListQuery {
  serialNo?: string;
  lotNo?: string;
  workOrderId?: number;
  itemId?: number;
  statusCode?: string;
  createdFrom?: string;
  createdTo?: string;
  page?: number;
  size?: number;
}

/** 계약 `InspectionSheetSummary` — 목록 한 줄. */
export interface InspectionSheetSummaryView {
  inspectionSheetId: number;
  serialNo: string;
  itemCode: string;
  itemName: string;
  lotNo: string;
  workOrderNo: string | null;
  statusCode: string;
  recordedStepCount: number;
  stepCount: number;
  ngStepCount: number;
  writtenWorkerName: string | null;
  approvedByName: string | null;
  checkedByName: string | null;
  createdAt: string;
}

const SUMMARY_INCLUDE = {
  serial_number: { select: { serial_no: true } },
  item: { select: { item_code: true, item_name: true } },
  lot: { select: { lot_no: true } },
  work_order: { select: { work_order_no: true } },
  written_worker: { select: { worker_name: true } },
  app_user_inspection_sheet_approved_byToapp_user: { select: { user_name: true } },
  app_user_inspection_sheet_checked_byToapp_user: { select: { user_name: true } },
  template: { select: { _count: { select: { steps: true } } } },
  step_results: { select: { first_judgment_code: true } },
} satisfies Prisma.inspection_sheetInclude;

/** 제품 검사표 목록(관리웹 W-03-13 · 장부 P-102) — LOT·시리얼·W/O 로 찾는다. 후속 공정·품질 부서 조회(S36 ②). */
@Injectable()
export class InspectionSheetQueryService {
  constructor(private readonly prisma: PrismaService) {}

  /** `plants` — 요청이 쓸 수 있는 OA 공장. 그 공장 LOT 의 검사표만 돌려준다. */
  async list(query: InspectionSheetListQuery, plants: readonly bigint[]): Promise<PagedResponse<InspectionSheetSummaryView>> {
    const page = pageRequest(query);
    const where: Prisma.inspection_sheetWhereInput = {
      lot: { plant_id: { in: [...plants] } },
      ...(query.serialNo ? { serial_number: { serial_no: { contains: query.serialNo, mode: 'insensitive' } } } : {}),
      ...(query.lotNo ? { lot: { plant_id: { in: [...plants] }, lot_no: { contains: query.lotNo, mode: 'insensitive' } } } : {}),
      ...(query.workOrderId === undefined ? {} : { work_order_id: query.workOrderId }),
      ...(query.itemId === undefined ? {} : { item_id: query.itemId }),
      ...(query.statusCode ? { status_code: query.statusCode } : {}),
      ...(query.createdFrom || query.createdTo
        ? {
            created_at: {
              ...(query.createdFrom ? { gte: new Date(query.createdFrom) } : {}),
              ...(query.createdTo ? { lt: new Date(query.createdTo) } : {}),
            },
          }
        : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.inspection_sheet.findMany({
        where,
        include: SUMMARY_INCLUDE,
        orderBy: { inspection_sheet_id: 'desc' },
        skip: page.skip,
        take: page.take,
      }),
      this.prisma.inspection_sheet.count({ where }),
    ]);
    return pagedResponse(
      rows.map((row) => ({
        inspectionSheetId: Number(row.inspection_sheet_id),
        serialNo: row.serial_number.serial_no,
        itemCode: row.item.item_code,
        itemName: row.item.item_name,
        lotNo: row.lot.lot_no,
        workOrderNo: row.work_order?.work_order_no ?? null,
        statusCode: row.status_code,
        recordedStepCount: row.step_results.length,
        stepCount: row.template._count.steps,
        ngStepCount: row.step_results.filter((r) => r.first_judgment_code === 'NG').length,
        writtenWorkerName: row.written_worker?.worker_name ?? null,
        approvedByName: row.app_user_inspection_sheet_approved_byToapp_user?.user_name ?? null,
        checkedByName: row.app_user_inspection_sheet_checked_byToapp_user?.user_name ?? null,
        createdAt: row.created_at.toISOString(),
      })),
      total,
      page,
    );
  }
}
