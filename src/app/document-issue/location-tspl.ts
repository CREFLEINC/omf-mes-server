import { layoutLocationLabel, locationQrPayload, type LocationLabelValues } from './location-label-layout';

/** Command-only rendition. 배치는 `location-label-layout.ts` 가 정한다. */
export function locationTspl(values: LocationLabelValues): Buffer {
  const layout = layoutLocationLabel(values);
  const { qr } = layout;
  return Buffer.from([
    // 대지는 지금 걸린 용지로 적는다(자재 LOT 라벨과 같다). POP 셸은 이 세 줄을 단말 설정으로 갈아 끼운다.
    'SIZE 100 mm,60 mm',
    'GAP 2 mm,0 mm',
    'DIRECTION 1',
    'CLS',
    `BOX 0,0,${String(layout.width - 1)},${String(layout.height - 1)},${String(layout.border)}`,
    ...layout.texts.map((text) =>
      `TEXT ${String(text.x)},${String(text.y)},"0",0,${String(text.point)},${String(text.point)},"${text.content}"`),
    `QRCODE ${String(qr.x)},${String(qr.y)},M,${String(qr.cell)},A,0,M2,S7,"${locationQrPayload(values)}"`,
    'PRINT 1',
  ].join('\r\n') + '\r\n', 'ascii');
}
