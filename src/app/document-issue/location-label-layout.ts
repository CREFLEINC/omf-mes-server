import { DPI, assertTsplSafe, clip, dots, fit, type LabelText, type QrModules } from './label-layout';

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
 * ⭐ 2D 코드에는 **위치 코드만** 싣는다(2026-09-17 사용자 결정 — 처음엔 `창고코드/위치코드`였다).
 * 이 라벨을 읽는 곳은 적치 위치 검증이고, 모바일 화면들(적치·임시 적치·제품 입고·재고 이동·
 * 실물 카운트)은 스캔 값을 **그대로** `GET /mdm/locations?warehouseId=&locationCode=` 에 넣는다 —
 * 창고는 작업이 준다. 창고를 붙이면 그 조회가 0건이라 검증이 막힌다(개발 서버 실측).
 * ⚠ 대가: `uq_location` 은 «창고 안에서만» 유일하므로 QR 만으로는 창고가 풀리지 않는다 — 다른
 * 창고에 붙은 같은 코드의 라벨은 작업 창고의 위치로 읽힌다. 창고는 면의 `WH:` 줄로 사람이 본다.
 *
 * ⚠ 글자는 ASCII 로 제한하지 않는다 — 영문 입력은 **권고이지 제약이 아니다**(2026-09-16 사용자
 * 결정). 무엇을 왜 막는지는 `assertTsplSafe` 에 적었다. 자재 LOT 라벨도 같은 기준을 쓴다.
 */

export interface LocationLabelValues {
  warehouseCode: string;
  /** ERP 창고명 — 한글이면 프린터(TSPL)에서는 그 줄만 깨진다. PNG 는 한글 글꼴로 그린다. */
  warehouseName: string;
  locationCode: string;
  /** 사람이 읽는 이름 — 별칭이 있으면 별칭, 없으면 위치명. */
  locationName: string;
  /** 위치 단계(ZONE·RACK·LEVEL·CELL). 넷보다 깊던 옛 위치는 null — 띠를 그리지 않는다. */
  levelCode: string | null;
  issueSeq: number;
}

export interface LocationLabelLayout {
  width: number;
  height: number;
  border: number;
  texts: LabelText[];
  qr: { x: number; y: number; cell: number; modules: QrModules };
}

/** 2D 코드에 싣는 값 — 스캔 화면이 위치 코드 조회에 그대로 넣는 값이어야 한다(위 머리말). */
export const locationQrPayload = (values: LocationLabelValues): string => values.locationCode;

/**
 * 2026-10-29 배치 개편(사용자 지시 「QR 을 키우고 전문적으로」) — QR 을 왼쪽에 라벨 높이로 크게, 오른쪽에 단계 ·
 * 위치 코드(가장 크게) · 이름 · 창고와 회차 네 줄을 QR 의 위 끝부터 아래 끝 사이에 고르게 둔다. 영문 머리말(`WH:`·`ISSUE NO.:`)은 뺀다.
 * 셀 12dot 이면 모듈 21개에서 31.5mm(종전 21mm) — 오른쪽에 15자 셀 코드가 20pt 로 한 줄에 들어가는 만큼이다.
 */
const QR_CELL_MAX = 12;
const POINTS = { level: 11, code: 40, name: 18, footer: 11 };

export function layoutLocationLabel(values: LocationLabelValues): LocationLabelLayout {
  [values.warehouseCode, values.warehouseName, values.locationCode, values.locationName].forEach(assertTsplSafe);
  const width = dots(100);
  const height = dots(60);
  const pad = dots(3);
  const border = 3;

  const code = QRCode.create(locationQrPayload(values), { errorCorrectionLevel: 'M' });
  // 위·아래 4모듈 여백(quiet zone)이 테두리 안에 들어가는 만큼 키운다 — 거리를 두고 찍는 라벨이라 여백이 인식률을 가른다.
  // 위치 코드 최악(한글 50자 · 49모듈)에도 셀 8 · 49mm 로 담긴다.
  const cell = Math.min(QR_CELL_MAX, Math.floor((height - 2 * border) / (code.modules.size + 8)));
  const qrSize = code.modules.size * cell;
  const quiet = cell * 4;
  const qrX = border + quiet;
  const qrY = Math.floor((height - qrSize) / 2);

  const left = qrX + qrSize + quiet;
  const lineWidth = width - pad - left;
  const lines = [
    ...(values.levelCode === null ? [] : [{ point: POINTS.level, content: values.levelCode }]),
    // 현장이 멀리서 읽는 줄이라 가장 크게 찍는다.
    { point: POINTS.code, content: values.locationCode },
    { point: POINTS.name, content: values.locationName },
    // 회차를 인쇄면에 넣는다(계약) — 데이터에만 있으면 몇 번째 출력물인지 현장이 못 가린다. 구분은 ASCII(`|`) —
    // 프린터 내장 글꼴이 못 찍는 기호를 쓰지 않는다.
    { point: POINTS.footer, content: `${values.warehouseCode} | ${values.warehouseName} | #${String(values.issueSeq)}` },
  ].map(({ point, content }) => {
    const chosen = fit(content, point, lineWidth);
    return { point: chosen, content: clip(content, chosen, lineWidth), tall: Math.round((chosen * DPI) / 72) };
  });
  // 코드가 짧으면 아주 크게 찍혀 줄 사이가 붙는다 — 줄 간격 3mm 가 남을 때까지 코드 줄만 줄인다.
  const codeLine = lines[lines.length - 3];
  const room = (): number => qrSize - lines.reduce((sum, line) => sum + line.tall, 0) - dots(3) * (lines.length - 1);
  while (room() < 0 && codeLine.point > POINTS.name) {
    codeLine.point -= 1;
    codeLine.tall = Math.round((codeLine.point * DPI) / 72);
  }
  // 줄들을 QR 의 위 끝과 아래 끝 사이에 고르게 놓는다 — 첫 줄은 QR 위 끝, 마지막 줄은 QR 아래 끝에 맞닿는다.
  const gap = (qrSize - lines.reduce((sum, line) => sum + line.tall, 0)) / (lines.length - 1);
  let y = qrY;
  const texts = lines.map((line): LabelText => {
    const text = { x: left, y: Math.round(y), point: line.point, width: lineWidth, content: line.content };
    y += line.tall + gap;
    return text;
  });
  return { width, height, border, texts, qr: { x: qrX, y: qrY, cell, modules: code.modules } };
}
