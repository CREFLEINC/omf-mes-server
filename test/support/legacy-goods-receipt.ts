import { HttpException, INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

import { GoodsReceiptService } from '../../src/logistics/goods-receipt/goods-receipt.service';
import { GoodsReceiptCreate } from '../../src/logistics/goods-receipt/receipt-posting';

/**
 * 배포 전(피처 009 이전) 관리웹 입고 처리로 생긴 구매 입고 — 입고 전표 + 적치 대기 자리 재고 + 라인마다 적치 지시.
 * 지금 `POST /logistics/goods-receipts` 는 구매 입하 LOT 을 409 `USE_PDA_PUTAWAY` 로 막으므로(research R-2) 그 API 가
 * 부르던 서비스를 직접 부른다. 행위자는 세션 쿠키의 계정이고, 결과는 API 와 같은 모양(상태·JSON 본문)으로 돌려준다.
 */
export async function legacyGoodsReceipt(
  app: INestApplication, cookie: string | string[], body: object,
): Promise<{ status: number; body: any }> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const token = [cookie].flat()[0].split(';')[0].split('=').slice(1).join('=');
  const { sub } = app.get(JwtService).decode<{ sub: number }>(token);
  try {
    const detail = await app.get(GoodsReceiptService).create(body as GoodsReceiptCreate, Number(sub));
    return { status: 201, body: JSON.parse(JSON.stringify(detail)) };
  } catch (error) {
    if (!(error instanceof HttpException)) throw error;
    return { status: error.getStatus(), body: error.getResponse() };
  }
}

/** `legacyGoodsReceipt` 가 201 이 아니면 던진다 — 재고를 세우는 시험 준비가 쓴다. */
export async function legacyGoodsReceiptOk(app: INestApplication, cookie: string | string[], body: object): Promise<{ status: number; body: any }> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const response = await legacyGoodsReceipt(app, cookie, body);
  if (response.status !== 201) throw new Error(`배포 전 입고 재현이 ${String(response.status)} 이다: ${JSON.stringify(response.body)}`);
  return response;
}

/** supertest 처럼 `.expect(상태)` 로 받는 모양 — 상태로 갈리는 시험(IQC 입고 문)이 쓴다. */
export function legacyGoodsReceiptCall(app: INestApplication, cookie: string | string[], body: object): { expect: (status: number) => Promise<{ status: number; body: any }> } { // eslint-disable-line @typescript-eslint/no-explicit-any
  const pending = legacyGoodsReceipt(app, cookie, body);
  return {
    expect: async (status) => {
      const response = await pending;
      if (response.status !== status) throw new Error(`배포 전 입고 재현이 ${String(response.status)} 이다(기대 ${String(status)}): ${JSON.stringify(response.body)}`);
      return response;
    },
  };
}
