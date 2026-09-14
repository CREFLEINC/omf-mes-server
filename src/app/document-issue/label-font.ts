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

const fontPath = join(__dirname, 'fonts', 'LiberationSans-Regular.ttf');

// 등록에 실패하면 부팅을 멈춘다 — 빈 라벨을 조용히 내보내는 것보다 배포 헬스체크에서 걸리는 편이 낫다.
if (GlobalFonts.registerFromPath(fontPath, LABEL_FONT) === null) {
  throw new Error(`라벨 글꼴을 등록하지 못했습니다: ${fontPath}`);
}
