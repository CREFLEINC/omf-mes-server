import { createCanvas } from '@napi-rs/canvas';

import { LABEL_FONTS } from './label-font';

function draw(text: string): number[] {
  const ctx = createCanvas(64, 64).getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, 64, 64);
  ctx.fillStyle = '#000';
  ctx.textBaseline = 'top';
  ctx.font = `48px ${LABEL_FONTS}`;
  ctx.fillText(text, 4, 4);
  return [...ctx.getImageData(0, 0, 64, 64).data];
}

describe('라벨 글꼴', () => {
  it('⭐ 한글이 제 모양으로 그려진다 — 글꼴에 없으면 모든 글자가 같은 □ 로 찍힌다', () => {
    const [gu, yeok] = [draw('구'), draw('역')];

    expect(gu.some((value, index) => index % 4 === 0 && value < 128)).toBe(true);
    expect(gu).not.toEqual(yeok);
  });
});
