import { UnprocessableEntityException } from '@nestjs/common';

/**
 * 라벨 «판»(자재 LOT·생산 LOT 등 배치 자체)이 아니라, 판들이 공유하는 도구다.
 * 203dpi 점(dot) 환산과 TSPL 로 찍을 수 있는 문자 제약이 여기 있다.
 */

export const DPI = 203;

/** 목업(`label-canvas.mjs` 의 `mm`)과 같은 반올림 — 8 dots/mm 로 갈음하면 80mm 에서 한 점 어긋난다. */
export const dots = (millimetres: number): number => Math.round((millimetres / 25.4) * DPI);

/** 203dpi 에서 이 아래는 읽히지 않는다(라벨 사양서 §4.2). */
export const MIN_POINT = 7;

/** 내장 폰트 자폭을 잴 수 없어 point 의 0.5 배로 어림한다 — 목업·POP 셸과 같은 어림이다. */
export const charWidth = (point: number): number => point * 0.5 * (DPI / 72);

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
 * 따옴표·역슬래시는 TSPL 문자열을 끊는다. 목업은 `\"` 로 벗기지만 실기 펌웨어에서 확인한 적이
 * 없어, 값을 바꿔 찍을 위험 대신 거절한다.
 */
export function printable(value: string): void {
  if (!/^[\x20-\x7E]*$/.test(value) || value.includes('"') || value.includes('\\')) {
    throw new UnprocessableEntityException('라벨 값에 TSPL로 출력할 수 없는 문자가 있습니다.');
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
