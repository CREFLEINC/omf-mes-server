import { ContractException, ERROR_CODE } from '../../common/errors';
import { ProductionResultApprovalService } from './production-result-approval.service';

describe('생산 실적 정정 상신', () => {
  it('더 받지 않는다 — 400 이고 정정 화면에서 바로 저장하라고 알린다', async () => {
    const caught = await new ProductionResultApprovalService().requestApproval().catch((e: unknown) => e);

    expect(caught).toBeInstanceOf(ContractException);
    expect((caught as ContractException).errors).toEqual([{
      scope: 'screen', code: ERROR_CODE.INVALID,
      message: '수량 정정은 승인 없이 사유만으로 저장합니다 — 정정 화면에서 바로 저장하세요.',
    }]);
  });
});
