import { UnprocessableEntityException } from '@nestjs/common';

/**
 * 라벨 «판»(자재 LOT·생산 LOT 등 배치 자체)이 아니라, 판들이 공유하는 도구다.
 * 203dpi 점(dot) 환산과 TSPL 로 찍을 수 있는 문자 제약이 여기 있다.
 */

export const DPI = 203;

/** 목업(`label-canvas.mjs` 의 `mm`)과 같은 반올림 — 8 dots/mm 로 갈음하면 80mm 에서 한 점 어긋난다. */
export const dots = (millimetres: number): number => Math.round((millimetres / 25.4) * DPI);

/** 203dpi 에서 이 아래는 읽히지 않는다(라벨 사양서 §4.2). */
const MIN_POINT = 7;

/** 내장 폰트 자폭을 잴 수 없어 point 의 0.5 배로 어림한다 — 목업·POP 셸과 같은 어림이다. */
const charWidth = (point: number): number => point * 0.5 * (DPI / 72);

export function fit(content: string, point: number, available: number): number {
  let chosen = point;
  while (chosen > MIN_POINT && content.length * charWidth(chosen) > available) chosen -= 1;
  return chosen;
}

/** TSPL 은 넘쳐도 잘라 주지 않아 옆 칸 위로 찍힌다 — 잘린 것이 보이게 `~` 를 남긴다. */
export function clip(content: string, point: number, available: number): string {
  const room = Math.floor(available / charWidth(point));
  return content.length <= room ? content : `${content.slice(0, Math.max(room - 1, 1))}~`;
}

/**
 * 막는 것은 **명령을 깨는 글자뿐**이다 — 「이상하게 찍힌다」가 아니라 「다른 것이 찍히거나
 * 인쇄가 깨진다」인 것들이다.
 *
 * - 따옴표·역슬래시 — TSPL 은 값을 `"…"` 로 감싸 보내므로, 값 안의 따옴표가 그 문자열을 미리
 *   닫아 **뒤쪽이 명령으로 잘못 읽힌다.** 목업은 `\"` 로 벗기지만 실기 펌웨어에서 확인한 적이
 *   없어, 값을 바꿔 찍을 위험 대신 거절한다.
 * - 제어 문자 — TSPL 은 **CRLF 로 명령을 가른다.** 값 안의 줄바꿈은 거기서 새 «명령 줄» 을 만든다.
 *
 * ⚠ **ASCII 밖 글자는 막지 않는다**(2026-09-16 사용자 결정). 프린터 내장 폰트(`TEXT` 의 폰트
 * `"0"`)에 한글·베트남어 글리프가 없어 그 줄은 깨져 나오지만, 그건 «모양» 문제이고 라벨의 일
 * (2D 코드·코드 줄로 대상을 특정하는 것)은 그대로 된다. 값을 지우거나 대체값을 끼우지도 않는다 —
 * 그대로 보내고, 어떻게 찍힐지는 프린터 폰트가 정한다. 실제로 ERP 품목 코드에 전각 괄호가 섞인
 * 값이 있어(`FS-536（SD）`), ASCII 를 강제하면 그 품목의 라벨을 아예 못 찍었다.
 */
export function assertTsplSafe(value: string): void {
  // 제어 문자는 정규식이 아니라 글자로 가린다 — 정규식에 넣으면 `no-control-regex` 가 막는다.
  const hasControl = [...value].some((char) => char < ' ' || char === '\u007F');
  if (value.includes('"') || value.includes('\\') || hasControl) {
    throw new UnprocessableEntityException('라벨 값에 따옴표·역슬래시·줄바꿈을 쓸 수 없습니다.');
  }
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
