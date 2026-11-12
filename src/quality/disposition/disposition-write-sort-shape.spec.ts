import { NotFoundException } from '@nestjs/common';

import { ContractException } from '../../common/errors';
import { DocumentStateService } from '../../core/document-state';
import { LotHoldService, LotQualityStatusService } from '../../core/lot';
import { PrismaService } from '../../prisma/prisma.service';
import { DispositionWriteService } from './disposition-write.service';

/** FR-038 · R-14a — 수량 분할 선별은 없어졌다. 선별 판정은 저장·트랜잭션 없이 400, 없는 부적합은 404 가 먼저다. */
describe('DispositionWriteService — 선별(SORT)은 저장 없이 막는다', () => {
  const findUnique = jest.fn();
  const transaction = jest.fn();
  const service = new DispositionWriteService(
    { $transaction: transaction, nonconformance: { findUnique } } as unknown as PrismaService,
    {} as DocumentStateService,
    {} as LotQualityStatusService,
    {} as LotHoldService,
  );
  const body = { dispositionTypeCode: 'SORT', decisionQty: 100, uomId: 1, reason: '선별', acceptedQty: 70, rejectedQty: 30, businessDate: '2026-10-16' };

  it.each([
    ['R14a-1 자재 입하 IQC 부적합 — 수량 분할 선별', 'IQC', '수량으로 LOT 을 나누는 선별은 지원하지 않습니다'],
    ['R14a-1 OQC 부적합', 'OQC', '반품·OQC 부적합에는 선별이 없습니다'],
  ])('%s 은 트랜잭션 없이 400', async (_label, typeCode, message) => {
    findUnique.mockResolvedValueOnce({ inspection_request: { inspection_type_code: typeCode } });

    const error = await service.create(1, 1, body as never, 1).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ContractException);
    expect(JSON.stringify((error as ContractException).getResponse())).toContain(message);
    expect(transaction).not.toHaveBeenCalled();
  });

  it('R14a-1 반품 부적합(검사 요청 없음)도 400 · 없는 부적합은 404', async () => {
    findUnique.mockResolvedValueOnce({ inspection_request: null });
    await expect(service.create(1, 1, body as never, 1)).rejects.toBeInstanceOf(ContractException);
    findUnique.mockResolvedValueOnce(null);
    await expect(service.create(1, 1, body as never, 1)).rejects.toBeInstanceOf(NotFoundException);
    expect(transaction).not.toHaveBeenCalled();
  });
});
