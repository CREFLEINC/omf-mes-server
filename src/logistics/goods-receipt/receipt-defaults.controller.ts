import { Controller, Get, Query } from '@nestjs/common';

import { Contract } from '../../common/contract';
import { ReceiptDefaults, ReceiptDefaultsService } from './receipt-defaults.service';

/** 입고 기본값(장부 P-150). 단말 범위 표에 없어 단말 토큰은 401 이다. */
@Controller('logistics')
export class ReceiptDefaultsController {
  constructor(private readonly defaults: ReceiptDefaultsService) {}

  /** `lotIds` 는 가드가 쉼표 목록을 배열로 나누고 형·범위·개수를 계약대로 본 값이다. */
  @Get('goods-receipts\\:defaults')
  @Contract('GET /logistics/goods-receipts:defaults')
  async list(@Query('lotIds') lotIds: number[]): Promise<{ items: ReceiptDefaults[] }> {
    return { items: await this.defaults.of(parseLotIds(lotIds)) };
  }
}

/** 같은 id 는 한 번만 낸다. */
function parseLotIds(lotIds: number[]): bigint[] {
  return [...new Set(lotIds)].map((id) => BigInt(id));
}
