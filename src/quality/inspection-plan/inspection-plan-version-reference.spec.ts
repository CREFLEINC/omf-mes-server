import { Prisma } from '@prisma/client';

import { isCollectionChannelItemReferenceError } from './inspection-plan-version.service';

function known(constraint: string): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('probe', {
    code: 'P2003',
    clientVersion: 'test',
    meta: { constraint, modelName: 'inspection_item_spec' },
  });
}

describe('inspection item collection-channel reference', () => {
  it('새 수집 채널 FK 위반만 삭제 경합으로 식별한다', () => {
    expect(
      isCollectionChannelItemReferenceError(
        known('collection_channel_inspection_item_id_fkey'),
      ),
    ).toBe(true);
  });

  it('기존 측정 FK와 다른 오류를 수집 채널 충돌로 바꾸지 않는다', () => {
    expect(
      isCollectionChannelItemReferenceError(
        known('inspection_measurement_inspection_item_spec_id_fkey'),
      ),
    ).toBe(false);
    expect(isCollectionChannelItemReferenceError(new Error('probe'))).toBe(false);
  });
});
