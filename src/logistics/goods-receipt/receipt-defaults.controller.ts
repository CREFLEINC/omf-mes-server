import { Controller, Get, HttpStatus, Query, Req } from '@nestjs/common';
import type { Request } from 'express';

import { loginRequired } from '../../auth/authentication.guard';
import { attachSession, SessionResolver } from '../../auth/session-resolver.service';
import { ContractException, ERROR_CODE, field } from '../../common/errors';
import { assertOperationPermission } from '../../common/permissions';
import { ReceiptDefaults, ReceiptDefaultsService } from './receipt-defaults.service';

/** 입고 칸을 채우는 사람과 같은 권한이다 — 입고 처리 화면(W-01-10·W-04-06)이 부른다. */
const OPERATION = 'POST /logistics/goods-receipts';
const MAX_LOTS = 100;

/**
 * 입고 기본값(장부 P-150). ⛔ 계약 사본에 없는 경로라 `@Contract` 를 달 수 없고 인증·권한 가드가 이 핸들러를 보지 않는다 —
 * 가드가 쓰는 같은 함수를 여기서 부른다(P-58·P-81 과 같은 길). 단말(M-04-04) 세션은 아직 받지 않는다.
 */
@Controller('logistics')
export class ReceiptDefaultsController {
  constructor(
    private readonly resolver: SessionResolver,
    private readonly defaults: ReceiptDefaultsService,
  ) {}

  @Get('goods-receipts\\:defaults')
  async list(@Req() request: Request, @Query('lotIds') raw: unknown): Promise<{ items: ReceiptDefaults[] }> {
    const session = await this.resolver.resolve(request);
    if (session === null) throw loginRequired();
    attachSession(request, session);
    assertOperationPermission(session, OPERATION);
    return { items: await this.defaults.of(parseLotIds(raw)) };
  }
}

/** `lotIds=1,2,3` — 같은 id 는 한 번만 낸다. 틀린 값을 무시하면 빠진 LOT 이 없는 것처럼 보인다. */
function parseLotIds(raw: unknown): bigint[] {
  const invalid = (message: string): ContractException =>
    new ContractException(HttpStatus.BAD_REQUEST, [field('lotIds', ERROR_CODE.INVALID, message)]);
  if (typeof raw !== 'string' || raw.trim() === '') throw invalid('lotIds 는 쉼표로 이은 LOT id 입니다.');
  const parts = raw.split(',').map((part) => part.trim());
  if (parts.some((part) => !/^[1-9]\d{0,17}$/u.test(part))) throw invalid('lotIds 는 양의 정수만 받습니다.');
  const ids = [...new Set(parts)].map((part) => BigInt(part));
  if (ids.length > MAX_LOTS) throw invalid(`lotIds 는 한 번에 ${MAX_LOTS}개까지입니다.`);
  return ids;
}
