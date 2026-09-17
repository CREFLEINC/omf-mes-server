import { assertTsplSafe, clip, dots, fit, type LabelText, type QrModules } from './label-layout';

// qrcode has no bundled declarations in this workspace; only the module matrix is used here.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const QRCode = require('qrcode') as {
  create(value: string, options: { errorCorrectionLevel: 'M' }): { modules: QrModules };
};

/**
 * 위치 QR 라벨 100×60mm 배치 — TSPL·PNG 가 함께 쓴다.
 *
 * ⭐ 처음엔 80×30mm(자재 LOT 라벨과 같은 판)이었다. 2026-09-17 사용자가 100×60mm 로 바꿨다 —
 * 클라이언트 팀이 이미 100×60 화면·목업을 만들어 두어서(클라이언트 결정 16), 서버 렌디션을 그
 * 목업 배치에 맞춘다(선례: PR #645, 서버 렌디션을 클라이언트 목업 배치로 맞춘 자리). 라벨지는
 * 납품 라벨과 같은 100×60 을 쓴다.
 *
 * ⭐ 판은 새로 짠다 — 생산 LOT 라벨이 자재 라벨의 판을 그대로 재사용한 것과 다른 자리다
 * (`production-lot-label.ts`). 이유 둘:
 *   ⓐ QR 이 훨씬 크다 — 랙에 붙은 라벨을 **거리를 두고 촬영**해야 해서 자재 라벨(셀 3dot·
 *      약 9.4mm)보다 훨씬 큰 21mm 로 키웠다(2026-09-16 사용자 결정 · 목업과 같은 크기). 자재
 *      판의 여섯 줄 자리에는 이만한 2D 코드가 들어갈 칸이 없다.
 *   ⓑ 실을 값이 다르다 — 수량·날짜가 없고 창고·위치 축만 있다.
 *
 * ⭐ 2D 코드에 **`창고코드/위치코드`** 를 싣는다. 위치 코드만으로는 모자라다 — `uq_location`
 * 이 «창고 안에서만» 유일해서, 계약 예시값 `A-01-03` 처럼 창고마다 같은 코드가 반복될 수 있다.
 * 계약의 스캔 조회 축은 「창고는 적치 지시·화면 문맥이 준다」는 전제지만, 벽에 붙은 라벨은
 * 문맥 없이 혼자 읽히므로 그 전제가 서지 않는다.
 *
 * ⛔ 창고 «이름» 을 싣지 않는다 — 위치명 줄은 있어도 창고는 코드로 이미 특정된다.
 *
 * ⚠ 글자는 ASCII 로 제한하지 않는다 — 영문 입력은 **권고이지 제약이 아니다**(2026-09-16 사용자
 * 결정). 무엇을 왜 막는지는 `assertTsplSafe` 에 적었다. 자재 LOT 라벨도 같은 기준을 쓴다.
 */

export interface LocationLabelValues {
  warehouseCode: string;
  locationCode: string;
  /** 영문 «권고». 한글이어도 발행은 되고, 그 줄만 프린터에서 깨져 나온다. */
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

/** 거리를 두고 읽히려면 이만해야 한다(2026-09-16 결정 · 목업과 같은 21mm). 코드가 길어 모듈이
 *  늘면 여기서 줄인다. */
const QR_CELL_MAX = 8;
const ROWS = { warehouse: dots(4), code: dots(13), name: dots(30), issue: dots(40) };
const POINTS = { warehouse: 12, code: 28, name: 13, issue: 11 };

export function layoutLocationLabel(values: LocationLabelValues): LocationLabelLayout {
  [values.warehouseCode, values.locationCode, values.locationName].forEach(assertTsplSafe);
  const width = dots(100);
  const height = dots(60);
  const pad = dots(3);
  const left = pad + dots(2);
  const border = 3;

  const code = QRCode.create(locationQrPayload(values), { errorCorrectionLevel: 'M' });
  /**
   * 담기는 한 크게 하되 **사방 4모듈 여백(quiet zone)을 먼저 확보한다** — 그래서 나누는 값이
   * 모듈 수가 아니라 `모듈 + 8`(위 4 + 아래 4)이다. 나누는 대상은 라벨 전체 높이가 아니라
   * `ROWS.name - border` 다 — QR 과 그 위·아래 여백이 테두리와 위치명 줄 사이에 다 들어가야
   * 위치명 줄이 QR 을 깔고 앉지 않는다. 여백을 라벨 여백(3mm)으로 갈음하면 셀 8dot 에서 3모듈
   * 뿐이라 규격 미달인데, 이 라벨은 «거리를 두고» 찍는 것이 목적이라 여백이 인식률을 가른다.
   * 두 코드가 각각 `VarChar(50)` 이라 페이로드 최악이 101자(41모듈)이고 그때 셀 4 — 203dpi
   * 에서 0.5mm/모듈이라 아직 찍힌다. 그래서 「너무 길어 못 담는다」는 거절 가지가 없다.
   */
  const cell = Math.min(QR_CELL_MAX, Math.floor((ROWS.name - border) / (code.modules.size + 8)));
  const qrSize = code.modules.size * cell;
  const quiet = cell * 4;
  const qrX = width - Math.max(pad, quiet) - qrSize;
  // 기본은 목업과 같은 y=5mm(모듈 21개 표준값). 모듈이 늘어 QR 이 커지면 위치명 줄과의 아래
  // 여백(quiet)을 지키도록 끌어올린다.
  const qrY = Math.min(dots(5), ROWS.name - quiet - qrSize);

  // 창고·코드 줄은 QR 옆이라 그만큼 좁고, 위치명·회차 줄은 QR 아래라 전폭을 쓴다.
  const available = qrX - left - quiet;
  const fullWidth = width - left - pad;
  const placed = (row: number, point: number, content: string, lineWidth: number): LabelText => {
    const chosen = fit(content, point, lineWidth);
    return { x: left, y: row, point: chosen, width: lineWidth, content: clip(content, chosen, lineWidth) };
  };

  return {
    width,
    height,
    border,
    texts: [
      placed(ROWS.warehouse, POINTS.warehouse, `WH: ${values.warehouseCode}`, available),
      // 현장이 멀리서 읽는 줄이라 가장 크게 찍는다.
      placed(ROWS.code, POINTS.code, values.locationCode, available),
      placed(ROWS.name, POINTS.name, values.locationName, fullWidth),
      // 회차를 인쇄면에 넣는다(계약) — 데이터에만 있으면 몇 번째 출력물인지 현장이 못 가린다.
      placed(ROWS.issue, POINTS.issue, `ISSUE NO.: ${String(values.issueSeq)}`, fullWidth),
    ],
    qr: { x: qrX, y: qrY, cell, modules: code.modules },
  };
}
