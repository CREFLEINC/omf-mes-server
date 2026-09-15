import { Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { createCanvas } from '@napi-rs/canvas';
// qrcode has no bundled declarations in this workspace; its encoder boundary is Buffer-in/Buffer-out.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const QRCode = require('qrcode') as {
  toDataURL(value: string, options: object): Promise<string>;
};

import { PrismaService } from '../../prisma/prisma.service';
import { LABEL_FONT } from './label-font';
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
    if (format === 'tspl') throw new UnprocessableEntityException('이 출력물의 TSPL 렌디션은 지원하지 않습니다.');
    if (issue.document_type_code === 'DELIVERY_LABEL') return this.deliveryLabel(issueId);
    throw new UnprocessableEntityException('이 출력물의 PNG 렌디션은 아직 지원하지 않습니다.');
  }

  private async deliveryLabel(issueId: number): Promise<Buffer> {
    const issue = await this.prisma.document_issue_log.findUnique({
      where: { document_issue_log_id: issueId },
      select: { target_type_code: true, target_id: true },
    });
    if (!issue || issue.target_type_code !== 'SHIPMENT_LOT_ALLOCATION')
      throw new UnprocessableEntityException('납품 라벨의 출하 배분 대상이 올바르지 않습니다.');
    const allocation = await this.prisma.shipment_lot_allocation.findUnique({
      where: { shipment_lot_allocation_id: issue.target_id },
      include: { lot: { include: { item: true } },
        shipment_line: { include: { shipment: true } } },
    });
    if (!allocation?.delivery_label_no)
      throw new UnprocessableEntityException('납품 라벨 번호가 배정되지 않았습니다.');
    const number = allocation.delivery_label_no;
    const canvas = createCanvas(800, 400);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, 800, 400);
    ctx.fillStyle = '#111';
    ctx.font = `bold 30px ${LABEL_FONT}`;
    ctx.fillText('DELIVERY LABEL', 32, 52);
    ctx.font = `bold 28px ${LABEL_FONT}`;
    ctx.fillText(number, 32, 100);
    ctx.font = `22px ${LABEL_FONT}`;
    ctx.fillText(`SHIPMENT  ${allocation.shipment_line.shipment.shipment_no}`, 32, 147);
    ctx.fillText(`ITEM  ${allocation.lot.item.item_code}`, 32, 187);
    ctx.fillText(`LOT  ${allocation.lot.lot_no}`, 32, 227);
    ctx.fillText(`QTY  ${String(allocation.allocated_qty)}`, 32, 267);
    const dataUrl = await QRCode.toDataURL(number, {
      errorCorrectionLevel: 'M', margin: 1, width: 170,
    });
    const image = await (await import('@napi-rs/canvas')).loadImage(dataUrl);
    ctx.drawImage(image, 610, 190, 170, 170);
    return canvas.toBuffer('image/png');
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
