import { createCanvas } from '@napi-rs/canvas';
import type { Prisma } from '@prisma/client';

import { LABEL_FONTS } from './label-font';
import { DPI } from './label-layout';
import { layoutMaterialLotLabel, type MaterialLotLabelValues } from './material-lot-label-layout';

export interface MaterialLotLabelRow {
  issue_seq: number;
  issued_at: Date;
  lot: {
    lot_no: string;
    lot_type_code: string;
    status_code: string;
    initial_qty: Prisma.Decimal;
    manufactured_at: Date | null;
    item: { item_code: string };
    uom: { uom_code: string };
    plant: { timezone_code: string };
    /** 패키징(피처 005) — 셋이 다 있을 때만 라벨에 찍는다. 없는 행(이전 LOT)은 지금 출력 그대로다. */
    package_count?: number | null;
    qty_per_package?: Prisma.Decimal | null;
    package_uom?: { uom_name: string } | null;
  };
}

export function materialLotLabelValues(issue: MaterialLotLabelRow): MaterialLotLabelValues {
  const { lot } = issue;
  return {
    type: lot.lot_type_code === 'MATERIAL' ? 'RAW' : 'WIP',
    status: lot.status_code,
    partNo: lot.item.item_code,
    qty: labelQty(lot.initial_qty, lot.uom.uom_code),
    lotNo: lot.lot_no,
    mfgDt: labelDateTime(lot.manufactured_at ?? issue.issued_at, lot.plant.timezone_code),
    issueSeq: issue.issue_seq,
    ...packageText(lot),
  };
}

/** 「봉지 10 × 100」 — 단위 이름은 패키징 단위, 패키징당 수량은 기본 단위 수량이다(단위는 QTY 줄에 있다). */
function packageText(lot: MaterialLotLabelRow['lot']): { package?: string } {
  const { package_count: count, qty_per_package: perPackage, package_uom: uom } = lot;
  if (count === undefined || count === null || perPackage === undefined || perPackage === null || !uom) return {};
  return { package: `${uom.uom_name} ${String(count)} × ${labelQty(perPackage, '').trimEnd()}` };
}

/** 천 단위를 끊되 반올림하지 않는다 — 목업의 `toLocaleString` 은 소수 넷째 자리부터 버린다. */
export function labelQty(qty: Prisma.Decimal, uomCode: string): string {
  const [whole, fraction] = qty.toFixed().split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${grouped}${fraction === undefined ? '' : `.${fraction}`} ${uomCode}`;
}

/** 라벨 사양의 `YY-MM-DD HH:mm` — 서버는 UTC 라 공장 시간대로 푼다. */
export function labelDateTime(at: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone, year: '2-digit', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(at);
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((candidate) => candidate.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')}`;
}

/** TSPL 과 같은 배치를 203dpi 그림으로 — 1px 이 프린터 한 점이다. */
export function materialLotLabelPng(values: MaterialLotLabelValues): Buffer {
  const layout = layoutMaterialLotLabel(values);
  const { width, height, border, qr } = layout;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#000';
  // TSPL BOX 의 두께는 테두리 안쪽으로 찬다.
  ctx.fillRect(0, 0, width, border);
  ctx.fillRect(0, height - border, width, border);
  ctx.fillRect(0, 0, border, height);
  ctx.fillRect(width - border, 0, border, height);
  ctx.textBaseline = 'top';
  for (const text of layout.texts) {
    ctx.font = `${String(Math.round((text.point * DPI) / 72))}px ${LABEL_FONTS}`;
    // 실제 글꼴 폭은 어림보다 넓을 수 있다 — 칸을 넘으면 가로로 줄여 옆 칸을 덮지 않는다.
    ctx.fillText(text.content, text.x, text.y, text.width);
  }
  for (let row = 0; row < qr.modules.size; row += 1) {
    for (let col = 0; col < qr.modules.size; col += 1) {
      if (qr.modules.get(row, col)) ctx.fillRect(qr.x + col * qr.cell, qr.y + row * qr.cell, qr.cell, qr.cell);
    }
  }
  return canvas.toBuffer('image/png');
}
