import { Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';
import { locationLabelPng, locationLabelValues } from './location-label';
import type { LocationLabelValues } from './location-label-layout';
import { locationTspl } from './location-tspl';
import { materialLotLabelPng, materialLotLabelValues } from './material-lot-label';
import type { MaterialLotLabelValues } from './material-lot-label-layout';
import { materialLotTspl } from './material-lot-tspl';
import { productionLotLabelValues } from './production-lot-label';

@Injectable()
export class DocumentIssueRenditionService {
  constructor(private readonly prisma: PrismaService) {}

  async rendition(issueId: number, format: 'png' | 'tspl' = 'png'): Promise<Buffer> {
    const issue = await this.prisma.document_issue_log.findUnique({
      where: { document_issue_log_id: issueId },
      select: { document_type_code: true },
    });
    if (!issue) throw new NotFoundException('없는 발행 기록입니다.');
    if (issue.document_type_code === 'MATERIAL_LOT_LABEL') {
      return format === 'tspl' ? this.materialLotLabelTspl(issueId) : this.materialLotLabel(issueId);
    }
    // ⭐ 생산 LOT 라벨도 자재 라벨과 «같은 판»으로 낸다(D5) — P-02-04 가 라벨을 찍어 그것을
    //    스캔하는 것이 마감 입력이라, 렌디션이 없으면 사슬이 끊긴다.
    if (issue.document_type_code === 'PRODUCTION_LOT_LABEL') {
      const values = await this.productionLotLabelValues(issueId);
      return format === 'tspl' ? materialLotTspl(values) : materialLotLabelPng(values);
    }
    // ⭐ 위치 라벨은 «판이 다르다» — 랙에 붙은 것을 거리를 두고 찍어야 해서 QR 이 훨씬 크다
    //    (`location-label-layout.ts`). 그래서 자재 판을 재사용한 생산 LOT 라벨과 달리 따로 그린다.
    if (issue.document_type_code === 'LOCATION_LABEL') {
      const values = await this.locationLabelValues(issueId);
      return format === 'tspl' ? locationTspl(values) : locationLabelPng(values);
    }
    if (format === 'tspl') throw new UnprocessableEntityException('이 출력물의 TSPL 렌디션은 지원하지 않습니다.');
    // ⛔ 납품 라벨은 **서버가 그리지 않는다**(SHIP-UNIT-01 · 통보 277 §4 의 원칙). POP 이
    //    출하 단위 상세의 값으로 그린다 — 여기 오면 422 다.
    //    ⚠ 종전에는 출하 LOT 배분을 대상으로 서버가 PNG 를 그렸는데, 그 대상이 발행 허용
    //      쌍에서 빠져(④) 새 기록이 설 수 없고 기존 기록도 0행이라 도달 불가 코드가 됐다.
    //      그 그리기가 배분의 `delivery_label_no` 를 읽던 마지막 자리이기도 하다(P-27).
    throw new UnprocessableEntityException('이 출력물의 PNG 렌디션은 아직 지원하지 않습니다.');
  }

  async materialLotLabelTspl(issueId: number): Promise<Buffer> {
    return materialLotTspl(await this.materialLotLabelValues(issueId));
  }

  async materialLotLabel(issueId: number): Promise<Buffer> {
    return materialLotLabelPng(await this.materialLotLabelValues(issueId));
  }

  /**
   * 발행 기록 → LOT → 품목·단위·공장, 그리고 실적 배분과 원천 W/O 를 푼다.
   * ⛔ 값이 없어도 422 로 막지 않는다 — 발행은 이미 됐고, 빈 칸으로 그리는 것이 규약이다.
   */
  private async productionLotLabelValues(issueId: number): Promise<MaterialLotLabelValues> {
    const issue = await this.prisma.document_issue_log.findUnique({
      where: { document_issue_log_id: issueId },
      include: { lot: { include: { item: true, uom: true, plant: true } } },
    });
    if (!issue) throw new NotFoundException('없는 발행 기록입니다.');
    const { lot } = issue;
    if (issue.document_type_code !== 'PRODUCTION_LOT_LABEL' || lot === null) {
      throw new UnprocessableEntityException('생산 LOT 라벨 발행 기록만 렌더링할 수 있습니다.');
    }
    const [allocated, latest, workOrder] = await Promise.all([
      this.prisma.production_result_lot_allocation.aggregate({
        where: { lot_id: lot.lot_id },
        _sum: { allocated_qty: true },
      }),
      this.prisma.production_result_lot_allocation.findFirst({
        where: { lot_id: lot.lot_id },
        orderBy: { production_result_lot_allocation_id: 'desc' },
        select: { production_result: { select: { occurred_at: true } } },
      }),
      // 생산 LOT 의 원천은 W/O 다(`source_type_code = 'WORK_ORDER'`).
      lot.source_type_code === 'WORK_ORDER'
        ? this.prisma.work_order.findUnique({
            where: { work_order_id: lot.source_id },
            select: { work_order_no: true },
          })
        : Promise.resolve(null),
    ]);
    return productionLotLabelValues({
      issue_seq: issue.issue_seq,
      issued_at: issue.issued_at,
      lot,
      allocation: {
        qty: allocated._sum.allocated_qty,
        occurredAt: latest?.production_result.occurred_at ?? null,
      },
      workOrderNo: workOrder?.work_order_no ?? '',
    });
  }

  private async locationLabelValues(issueId: number): Promise<LocationLabelValues> {
    const issue = await this.prisma.document_issue_log.findUnique({
      where: { document_issue_log_id: issueId },
      select: { issue_seq: true, target_type_code: true, target_id: true },
    });
    if (!issue) throw new NotFoundException('없는 발행 기록입니다.');
    if (issue.target_type_code !== 'LOCATION') {
      throw new UnprocessableEntityException('위치 라벨의 대상이 올바르지 않습니다.');
    }
    const location = await this.prisma.location.findUnique({
      where: { location_id: issue.target_id },
      select: { location_code: true, location_name: true, warehouse: { select: { warehouse_code: true } } },
    });
    // 발행 뒤 위치가 지워졌을 수 있다 — 기록은 남아 있어도 그릴 값이 없다.
    if (!location) throw new UnprocessableEntityException('없는 위치입니다.');
    return locationLabelValues({ ...location, issue_seq: issue.issue_seq });
  }

  private async materialLotLabelValues(issueId: number): Promise<MaterialLotLabelValues> {
    const issue = await this.prisma.document_issue_log.findUnique({
      where: { document_issue_log_id: issueId },
      include: { lot: { include: { item: true, uom: true, plant: true } } },
    });
    if (!issue) throw new NotFoundException('없는 발행 기록입니다.');
    const { lot } = issue;
    if (issue.document_type_code !== 'MATERIAL_LOT_LABEL' || lot === null) {
      throw new UnprocessableEntityException('자재 LOT 라벨 발행 기록만 렌더링할 수 있습니다.');
    }
    return materialLotLabelValues({ ...issue, lot });
  }
}
