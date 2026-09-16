import { createCanvas } from '@napi-rs/canvas';

import { LABEL_FONT } from './label-font';
import { DPI } from './label-layout';
import { layoutLocationLabel, type LocationLabelValues } from './location-label-layout';

/** 이 라벨이 읽는 칸만. 창고는 «코드»만 쓴다 — 이름은 한글이라 라벨에 못 싣는다. */
export interface LocationLabelRow {
  issue_seq: number;
  location_code: string;
  location_name: string;
  warehouse: { warehouse_code: string };
}

export function locationLabelValues(row: LocationLabelRow): LocationLabelValues {
  return {
    warehouseCode: row.warehouse.warehouse_code,
    locationCode: row.location_code,
    locationName: row.location_name,
    issueSeq: row.issue_seq,
  };
}

/** TSPL 과 같은 배치를 203dpi 그림으로 — 1px 이 프린터 한 점이다. */
export function locationLabelPng(values: LocationLabelValues): Buffer {
  const layout = layoutLocationLabel(values);
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
    ctx.font = `${String(Math.round((text.point * DPI) / 72))}px ${LABEL_FONT}`;
    // 실제 글꼴 폭은 어림보다 넓을 수 있다 — 칸을 넘으면 가로로 줄여 QR 을 덮지 않는다.
    ctx.fillText(text.content, text.x, text.y, text.width);
  }
  for (let row = 0; row < qr.modules.size; row += 1) {
    for (let col = 0; col < qr.modules.size; col += 1) {
      if (qr.modules.get(row, col)) ctx.fillRect(qr.x + col * qr.cell, qr.y + row * qr.cell, qr.cell, qr.cell);
    }
  }
  return canvas.toBuffer('image/png');
}
