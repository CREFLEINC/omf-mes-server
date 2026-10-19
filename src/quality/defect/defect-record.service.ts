import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { filter } from '../../common/master';
import { PagedResponse, pagedResponse, pageRequest } from '../../common/pagination';
import { PrismaService } from '../../prisma/prisma.service';
import { TerminalQualityReadScope } from '../../auth/terminal-quality-read-scope';
import {
  assertDetectedPeriodRequired,
  CONFIRMED_INSPECTION_ONLY,
  DefectRecordView,
  defectRecordView,
  detectedAtWhere,
} from './defect-view';

/**
 * 불량 실적 목록 — `quality.defect_record` 그대로(§2-2 · 결손 0). ⛔ 등록 경로는 두지 않는다
 * (계약 `x-internal-note` 「03 화면 7장에 불량코드 입력이 0건이다」) — e2e 가 prisma 로 직접 심는다.
 * ⛔ 발생 공정(occurrenceProcessId)과 검출 공정(detectionProcessId)은 다른 축이다 — 섞지 않는다.
 */
export interface DefectRecordListQuery {
  workOrderId?: number;
  lotId?: number;
  /** 그 검사 결과에 붙은 불량(omf-all-around#106 · P-42) — IQC 이력(S32)이 불합격 사유를 읽는다. */
  inspectionResultId?: number;
  defectCodeId?: number;
  occurrenceProcessId?: number;
  detectionProcessId?: number;
  sourceCode?: string;
  detectedFrom?: string;
  detectedTo?: string;
  page?: number;
  size?: number;
}

@Injectable()
export class DefectRecordService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: DefectRecordListQuery, scope?: TerminalQualityReadScope): Promise<PagedResponse<DefectRecordView>> {
    // 검사 결과 하나로 좁히면 기간이 필요 없다 — 한 결과의 불량은 많아야 몇 줄이다(P-42 · 완화).
    if (query.inspectionResultId === undefined) assertDetectedPeriodRequired(query);
    const page = pageRequest(query);
    const where: Prisma.defect_recordWhereInput = {
      ...buildDefectRecordWhere(query),
      ...(scope === undefined ? {} : { lot: { plant_id: scope.plantId } }),
      // 한 결과로 좁힌 조회는 작성중 회차의 사유도 돌려준다 — 판정 화면이 임시 저장한 사유를 되살린다(#122).
      ...(query.inspectionResultId === undefined ? CONFIRMED_INSPECTION_ONLY : {}),
    };
    // 기본 정렬 detected_at DESC 고정 — 계약에 sort 질의가 없다. 동률은 defect_record_id 로
    // 깬다(R-10 자리) — 안 그러면 반환 순서가 보장되지 않는다(I-24 선례).
    const orderBy: Prisma.defect_recordOrderByWithRelationInput[] = [{ detected_at: 'desc' }, { defect_record_id: 'desc' }];

    const [total, rows] = await Promise.all([
      this.prisma.defect_record.count({ where }),
      this.prisma.defect_record.findMany({ where, orderBy, skip: page.skip, take: page.take }),
    ]);
    return pagedResponse(rows.map(defectRecordView), total, page);
  }
}

export function buildDefectRecordWhere(query: DefectRecordListQuery): Prisma.defect_recordWhereInput {
  return {
    // ⛔ workOrderId 가 null 인 클레임 행도 나와야 한다 — 필터를 안 걸면(undefined) 자연히
    // 포함된다. `work_order` 를 조인하지 않는다 — 이 목록은 원천이 `defect_record` 한 표다.
    ...filter('work_order_id', query.workOrderId),
    ...filter('lot_id', query.lotId),
    ...filter('inspection_result_id', query.inspectionResultId),
    ...filter('defect_code_id', query.defectCodeId),
    ...filter('occurrence_process_id', query.occurrenceProcessId),
    ...filter('detection_process_id', query.detectionProcessId),
    ...(query.sourceCode === undefined ? {} : { source_type_code: query.sourceCode }),
    // 결과 하나로 좁힌 조회는 기간 없이 온다(P-42 완화) — 기간이 있을 때만 건다. 없는 채로 걸면 Invalid Date 로 500 이다.
    ...(query.detectedFrom === undefined || query.detectedTo === undefined
      ? {}
      : detectedAtWhere(query.detectedFrom, query.detectedTo)),
  };
}
