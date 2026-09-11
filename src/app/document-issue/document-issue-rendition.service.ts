import { Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { createCanvas } from '@napi-rs/canvas';
// qrcode has no bundled declarations in this workspace; its encoder boundary is Buffer-in/Buffer-out.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const QRCode = require('qrcode') as {
  toDataURL(value: string, options: object): Promise<string>;
};

import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class DocumentIssueRenditionService {
  constructor(private readonly prisma: PrismaService) {}

  async materialLotLabel(issueId: number): Promise<Buffer> {
    const issue = await this.prisma.document_issue_log.findUnique({
      where: { document_issue_log_id: issueId },
      include: { lot: { include: { item: true } } },
    });
    if (!issue) throw new NotFoundException('없는 발행 기록입니다.');
    if (issue.document_type_code !== 'MATERIAL_LOT_LABEL' || issue.lot === null) {
      throw new UnprocessableEntityException('자재 LOT 라벨 발행 기록만 렌더링할 수 있습니다.');
    }
    const canvas = createCanvas(800, 400);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, 800, 400);
    ctx.fillStyle = '#111';
    ctx.font = 'bold 30px sans-serif';
    ctx.fillText('MATERIAL LOT LABEL', 32, 52);
    ctx.font = '24px sans-serif';
    ctx.fillText(`ITEM  ${issue.lot.item.item_code}`, 32, 105);
    ctx.fillText(issue.lot.item.item_name.slice(0, 42), 32, 140);
    ctx.fillText(`LOT   ${issue.lot.lot_no}`, 32, 185);
    ctx.fillText(`QTY   ${String(issue.lot.initial_qty)}   ISSUE ${String(issue.issue_seq)}`, 32, 225);
    const dataUrl = await QRCode.toDataURL(issue.lot.lot_no, {
      errorCorrectionLevel: 'M',
      margin: 1,
      width: 150,
    });
    const image = await (await import('@napi-rs/canvas')).loadImage(dataUrl);
    ctx.drawImage(image, 610, 210, 150, 150);
    return canvas.toBuffer('image/png');
  }
}
