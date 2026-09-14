import { UnprocessableEntityException } from '@nestjs/common';
// qrcode has no bundled declarations in this workspace; only the module matrix is used here.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const QRCode = require('qrcode') as {
  create(value: string, options: { errorCorrectionLevel: 'M' }): { modules: QrModules };
};

/**
 * 자재 LOT 표준 라벨 80×30mm 배치 — TSPL·PNG 가 함께 쓴다.
 *
 * ⭐ 좌표·글자 크기·줄임 규칙은 클라이언트 목업(`omf-mes-client` `tools/mock/label-tspl.mjs`
 * `renderLotTspl`)과 같다. POP 셸은 명령 내용을 보지 않고 바이트 시그니처(`SIZE `)만 보므로,
 * 목업 배치에 맞추면 클라이언트를 고치지 않고 개발 모드와 같은 라벨이 나온다.
 *
 * 목업과 일부러 다른 곳 셋:
 * - 2D 코드는 **QR 에 LOT 번호를 그대로** 싣는다(통보 277). 목업의 DMATRIX `L1|…` 묶음은
 *   값 안의 `|` 를 공백으로 바꿔, 스캔해도 LOT 번호가 나오지 않는다.
 * - 품명 줄이 없다(277 결정 5).
 * - 날짜 줄 오른쪽에 회차를 찍는다(계약 — 회차를 인쇄면에 넣는다).
 */

export interface MaterialLotLabelValues {
  type: string;
  status: string;
  partNo: string;
  qty: string;
  lotNo: string;
  mfgDt: string;
  issueSeq: number;
}

export interface QrModules {
  size: number;
  get(row: number, col: number): number | boolean;
}

export interface LabelText {
  x: number;
  y: number;
  point: number;
  /** 이 줄이 쓸 수 있는 폭(dot). */
  width: number;
  content: string;
}

export interface MaterialLotLabelLayout {
  width: number;
  height: number;
  border: number;
  texts: LabelText[];
  qr: { x: number; y: number; cell: number; modules: QrModules };
}

export const DPI = 203;

/** 목업(`label-canvas.mjs` 의 `mm`)과 같은 반올림 — 8 dots/mm 로 갈음하면 80mm 에서 한 점 어긋난다. */
export const dots = (millimetres: number): number => Math.round((millimetres / 25.4) * DPI);

/** 203dpi 에서 이 아래는 읽히지 않는다(라벨 사양서 §4.2). */
const MIN_POINT = 7;
const QR_CELL = 3;
const ROWS = { head: 14, partNo: 48, qty: 122, lot: 164, date: 200 };

/** 내장 폰트 자폭을 잴 수 없어 point 의 0.5 배로 어림한다 — 목업·POP 셸과 같은 어림이다. */
const charWidth = (point: number): number => point * 0.5 * (DPI / 72);

function fit(content: string, point: number, available: number): number {
  let chosen = point;
  while (chosen > MIN_POINT && content.length * charWidth(chosen) > available) chosen -= 1;
  return chosen;
}

/** TSPL 은 넘쳐도 잘라 주지 않아 옆 칸 위로 찍힌다 — 잘린 것이 보이게 `~` 를 남긴다. */
function clip(content: string, point: number, available: number): string {
  const room = Math.floor(available / charWidth(point));
  return content.length <= room ? content : `${content.slice(0, Math.max(room - 1, 1))}~`;
}

/**
 * 따옴표·역슬래시는 TSPL 문자열을 끊는다. 목업은 `\"` 로 벗기지만 실기 펌웨어에서 확인한 적이
 * 없어, 값을 바꿔 찍을 위험 대신 거절한다.
 */
function printable(value: string): void {
  if (!/^[\x20-\x7E]*$/.test(value) || value.includes('"') || value.includes('\\')) {
    throw new UnprocessableEntityException('라벨 값에 TSPL로 출력할 수 없는 문자가 있습니다.');
  }
}

export function layoutMaterialLotLabel(values: MaterialLotLabelValues): MaterialLotLabelLayout {
  [values.type, values.status, values.partNo, values.qty, values.lotNo, values.mfgDt].forEach(printable);
  const width = dots(80);
  const height = dots(30);
  const pad = dots(2);
  const left = pad + dots(1.5);
  const matrixX = width - pad - dots(12);
  /** 2D 코드 옆을 지나는 줄의 폭과, 그 아래로 내려가 라벨 폭을 다 쓰는 줄의 폭. */
  const beside = matrixX - left - dots(2);
  const below = width - left - pad;
  const half = below / 2;

  const placed = (x: number, y: number, point: number, content: string, available: number): LabelText => ({
    x, y, point, width: available, content: clip(content, point, available),
  });
  const fitted = (y: number, content: string, point: number, available: number): LabelText =>
    placed(left, y, fit(content, point, available), content, available);

  const dateText = `MFG DT: ${values.mfgDt}`;
  // 회차는 날짜와 같은 크기로 찍는다 — 목업의 추가 항목(`extra`) 자리와 같은 규칙이다.
  const datePoint = fit(dateText, 8, half);
  const code = QRCode.create(values.lotNo, { errorCorrectionLevel: 'M' });
  const qrSize = code.modules.size * QR_CELL;

  return {
    width,
    height,
    border: 2,
    texts: [
      fitted(ROWS.head, `${values.type}  ${values.status}`, 10, beside),
      fitted(ROWS.partNo, `PART NO.: ${values.partNo}`, 12, beside),
      fitted(ROWS.qty, `QTY: ${values.qty}`, 12, below),
      fitted(ROWS.lot, `LOT NO.: ${values.lotNo}`, 10, below),
      placed(left, ROWS.date, datePoint, dateText, half),
      placed(left + Math.round(half), ROWS.date, datePoint, `ISSUE NO.: ${String(values.issueSeq)}`, half),
    ],
    // 오른쪽 여백에 붙인다 — LOT 이 길어 QR 버전이 커져도 BOX 밖으로 나가지 않는다.
    qr: { x: width - pad - qrSize, y: pad + dots(1), cell: QR_CELL, modules: code.modules },
  };
}
