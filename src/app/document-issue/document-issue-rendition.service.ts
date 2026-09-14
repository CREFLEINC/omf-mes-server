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
