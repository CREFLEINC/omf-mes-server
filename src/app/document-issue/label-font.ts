import { join } from 'node:path';

import { GlobalFonts } from '@napi-rs/canvas';

/**
 * 라벨 PNG 가 쓰는 글꼴 이름.
 *
 * ⚠ 운영 이미지(`node:22-bookworm-slim`)에는 시스템 글꼴이 하나도 없어 `sans-serif` 로 그리면
 * 오류 없이 글자만 빠진 PNG 가 나간다(맥에서는 시스템 글꼴로 찍혀 보이지 않는다). 그래서 저장소에
 * 넣은 글꼴을 등록해 쓴다 — 파일은 `nest-cli.json` assets 로 dist 에 따라간다.
 */
export const LABEL_FONT = 'OmfLabelSans';
/** 한글 — Liberation 에는 한글 글자가 없어 별칭·이름이 □ 로 찍혔다(2026-10-29). */
export const LABEL_FONT_KR = 'OmfLabelSansKr';
/**
 * `ctx.font` 에 넣는 글꼴 목록. 라틴(베트남어 포함)은 Liberation, 거기 없는 글자(한글)는 Noto Sans KR 로 넘어간다.
 */
export const LABEL_FONTS = `${LABEL_FONT}, ${LABEL_FONT_KR}`;

// 등록에 실패하면 부팅을 멈춘다 — 빈 라벨을 조용히 내보내는 것보다 배포 헬스체크에서 걸리는 편이 낫다.
for (const [file, family] of [['LiberationSans-Regular.ttf', LABEL_FONT], ['NotoSansKR-Regular.otf', LABEL_FONT_KR]]) {
  const fontPath = join(__dirname, 'fonts', file);
  if (GlobalFonts.registerFromPath(fontPath, family) === null) {
    throw new Error(`라벨 글꼴을 등록하지 못했습니다: ${fontPath}`);
  }
}
