import { UnprocessableEntityException } from '@nestjs/common';

interface MaterialLotLabelValues {
  itemCode: string;
  lotNo: string;
  quantity: string;
  issueSequence: string;
}

/** Command-only rendition. Reject values that could split a quoted TSPL field or command. */
export function materialLotTspl(values: MaterialLotLabelValues): Buffer {
  const item = safe(values.itemCode, 48);
  const lot = safe(values.lotNo, 64);
  const qty = safe(values.quantity, 20);
  const issue = safe(values.issueSequence, 10);
  return Buffer.from([
    'SIZE 100 mm, 60 mm',
    'GAP 2 mm, 0 mm',
    'DIRECTION 1',
    'CLS',
    'TEXT 32,32,"0",0,12,12,"MATERIAL LOT LABEL"',
    `TEXT 32,104,"0",0,9,9,"ITEM ${item}"`,
    `TEXT 32,160,"0",0,8,8,"LOT ${lot}"`,
    `TEXT 32,216,"0",0,9,9,"QTY ${qty}  ISSUE ${issue}"`,
    `QRCODE 600,175,L,5,A,0,M2,S7,"${lot}"`,
    'PRINT 1,1',
    '',
  ].join('\r\n'), 'ascii');
}

// `|` 는 통보 277 자재 LOT 번호 구분자다 — TSPL 따옴표 안 리터럴 문자라 명령을 쪼개지 않는다.
function safe(value: string, maximum: number): string {
  if (value.length === 0 || value.length > maximum || !/^[A-Za-z0-9._|-]+$/.test(value)) {
    throw new UnprocessableEntityException('라벨 값에 TSPL로 출력할 수 없는 문자가 있습니다.');
  }
  return value;
}
