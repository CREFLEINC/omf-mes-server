import { clip, dots, fit, printable, type LabelText, type QrModules } from './label-layout';

// qrcode has no bundled declarations in this workspace; only the module matrix is used here.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const QRCode = require('qrcode') as {
  create(value: string, options: { errorCorrectionLevel: 'M' }): { modules: QrModules };
};

/**
 * 위치 QR 라벨 80×30mm 배치 — TSPL·PNG 가 함께 쓴다. 라벨지는 자재 LOT 라벨과 같다.
 *
 * ⭐ 판은 **새로 짠다.** 생산 LOT 라벨이 자재 라벨의 판을 그대로 재사용한 것과 다른 자리다
 * (`production-lot-label.ts`). 이유 둘:
 *   ⓐ QR 이 훨씬 크다 — 랙에 붙은 라벨을 **거리를 두고 촬영**해야 해서 자재 라벨(셀 3dot·
 *      약 9.4mm)의 약 2.2배인 셀 8dot·약 21mm 로 키웠다(2026-09-16 사용자 결정). 자재 판의
 *      여섯 줄 자리에는 이만한 2D 코드가 들어갈 칸이 없다.
 *   ⓑ 실을 값이 다르다 — 수량·날짜가 없고 창고·위치 축만 있다.
 *
 * ⭐ 2D 코드에 **`창고코드/위치코드`** 를 싣는다. 위치 코드만으로는 모자라다 — `uq_location`
 * 이 «창고 안에서만» 유일해서, 계약 예시값 `A-01-03` 처럼 창고마다 같은 코드가 반복될 수 있다.
 * 계약의 스캔 조회 축은 「창고는 적치 지시·화면 문맥이 준다」는 전제지만, 벽에 붙은 라벨은
 * 문맥 없이 혼자 읽히므로 그 전제가 서지 않는다.
 *
 * ⛔ 창고 «이름» 을 싣지 않는다 — 이름은 한글·베트남어라 프린터 내장 폰트로 못 찍는다
 * (`printable` 이 422 로 막는다). 창고는 코드로만 적고, 영문으로 입력한 위치명을 그 아래 둔다.
 */

export interface LocationLabelValues {
  warehouseCode: string;
  locationCode: string;
  /** 영문이어야 한다 — 한글·베트남어면 `printable` 이 422 로 막는다. */
  locationName: string;
  issueSeq: number;
}

export interface LocationLabelLayout {
  width: number;
  height: number;
  border: number;
  texts: LabelText[];
  qr: { x: number; y: number; cell: number; modules: QrModules };
}

/**
 * 2D 코드에 싣는 값. 첫 `/` 가 창고와 위치를 가른다 — 창고 코드에는 `/` 를 쓰지 않는다는
 * 전제이며, 읽는 쪽도 **첫 `/` 기준**으로 가른다.
 */
export const locationQrPayload = (values: LocationLabelValues): string =>
  `${values.warehouseCode}/${values.locationCode}`;

/** 거리를 두고 읽히려면 이만해야 한다(2026-09-16 결정). 코드가 길어 모듈이 늘면 여기서 줄인다. */
const QR_CELL_MAX = 8;
const ROWS = { warehouse: 24, code: 60, name: 128, issue: 172 };
const POINTS = { warehouse: 10, code: 20, name: 10, issue: 8 };

export function layoutLocationLabel(values: LocationLabelValues): LocationLabelLayout {
  [values.warehouseCode, values.locationCode, values.locationName].forEach(printable);
  const width = dots(80);
  const height = dots(30);
  const pad = dots(2);
  const left = pad + dots(1.5);

  const code = QRCode.create(locationQrPayload(values), { errorCorrectionLevel: 'M' });
  /**
   * 담기는 한 크게 하되 **사방 4모듈 여백(quiet zone)을 먼저 확보한다** — 그래서 나누는 값이
   * 모듈 수가 아니라 `모듈 + 8`(위 4 + 아래 4)이다. 여백을 라벨 여백(2mm)으로 갈음하면 셀 8dot
   * 에서 2모듈뿐이라 규격 미달인데, 이 라벨은 «거리를 두고» 찍는 것이 목적이라 여백이 인식률을
   * 가른다. 두 코드가 각각 `VarChar(50)` 이라 페이로드 최악이 101자(41모듈)이고 그때 셀 4 —
   * 203dpi 에서 0.5mm/모듈이라 아직 찍힌다. 그래서 「너무 길어 못 담는다」는 거절 가지가 없다.
   */
  const cell = Math.min(QR_CELL_MAX, Math.floor(height / (code.modules.size + 8)));
  const qrSize = code.modules.size * cell;
  const quiet = cell * 4;
  const qrX = width - Math.max(pad, quiet) - qrSize;

  // 글자 칸은 QR 과 그 여백이 차지하고 남은 폭이다 — 좁아지면 `fit` 이 글자를 줄인다.
  const available = qrX - left - quiet;
  const placed = (row: number, point: number, content: string): LabelText => {
    const chosen = fit(content, point, available);
    return { x: left, y: row, point: chosen, width: available, content: clip(content, chosen, available) };
  };

  return {
    width,
    height,
    border: 2,
    texts: [
      placed(ROWS.warehouse, POINTS.warehouse, `WH: ${values.warehouseCode}`),
      // 현장이 멀리서 읽는 줄이라 가장 크게 찍는다.
      placed(ROWS.code, POINTS.code, values.locationCode),
      placed(ROWS.name, POINTS.name, values.locationName),
      // 회차를 인쇄면에 넣는다(계약) — 데이터에만 있으면 몇 번째 출력물인지 현장이 못 가린다.
      placed(ROWS.issue, POINTS.issue, `ISSUE NO.: ${String(values.issueSeq)}`),
    ],
    // 세로 가운데에 둔다 — 글자 네 줄과 달리 QR 은 높이를 거의 다 쓴다.
    qr: { x: qrX, y: Math.round((height - qrSize) / 2), cell, modules: code.modules },
  };
}
