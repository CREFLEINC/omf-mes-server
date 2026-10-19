import { ContractException } from '../../common/errors';
import { DocumentStateService } from '../../core/document-state';
import { LotHoldService, LotQualityStatusService } from '../../core/lot';
import { NumberingService } from '../../core/numbering';
import { PrismaService } from '../../prisma/prisma.service';
import { DispositionSortService } from './disposition-sort';
import { DispositionWriteService } from './disposition-write.service';

/** #108 리뷰 m4 — 선별 형식이 틀린 저장은 부적합 번호를 뽑기 «전»에 400 이다. */
describe('DispositionWriteService — 선별 형식 검사가 채번 앞이다', () => {
  const numbering = { next: jest.fn() };
  const transaction = jest.fn();
  const service = new DispositionWriteService(
    { $transaction: transaction } as unknown as PrismaService,
    {} as DocumentStateService,
    {} as LotQualityStatusService,
    {} as DispositionSortService,
    numbering as unknown as NumberingService,
    {} as LotHoldService,
  );

  it.each([
    ['양품 + 불량 ≠ 판정 수량', { acceptedQty: 70, rejectedQty: 20, businessDate: '2026-10-16' }],
    ['업무 일자 없음', { acceptedQty: 70, rejectedQty: 30 }],
  ])('%s 이면 채번·트랜잭션 없이 400', async (_label, sort) => {
    const body = { dispositionTypeCode: 'SORT', decisionQty: 100, uomId: 1, reason: '선별', ...sort };

    const error = await service.create(1, 1, body as never, 1).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ContractException);
    expect(numbering.next).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });
});
