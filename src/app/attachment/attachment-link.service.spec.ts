import { Prisma } from '@prisma/client';

import { ContractException } from '../../common/errors';
import { PrismaService } from '../../prisma/prisma.service';
import { AttachmentLinkService } from './attachment-link.service';

/** 검사 의뢰 첨부를 자재 관리 LOT 에 나중에 연결(omf-all-around#296). 지어낸 값만 쓴다. */
const source = (targetType = 'INSPECTION_REQUEST') => ({
  attachment_id: 31n, target_type_code: targetType, target_id: 501n, file_name: 'report.pdf',
  storage_key: 'inspection_request/2099/abc.pdf', mime_type: 'application/pdf', file_size: 2048n,
  checksum_sha256: 'f'.repeat(64), uploaded_by: 7n, uploaded_worker_id: null,
  uploaded_at: new Date('2099-11-11T01:00:00Z'),
});

const txOf = (row: ReturnType<typeof source> | null, owned: number, confirmedAt: Date | null = null) => {
  const created: Record<string, unknown>[] = [];
  const tx = {
    attachment: {
      findUnique: jest.fn().mockResolvedValue(row),
      create: jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => {
        created.push(data);
        return { ...data, attachment_id: BigInt(100 + created.length) };
      }),
      delete: jest.fn().mockResolvedValue(row),
    },
    inspection_request: { findUnique: jest.fn().mockResolvedValue({ inbound_lot_id: 9n, confirmed_at: confirmedAt }) },
    lot: { count: jest.fn().mockResolvedValue(owned) },
  };
  return { tx: tx as unknown as Prisma.TransactionClient, raw: tx, created };
};

describe('AttachmentLinkService.linkLots', () => {
  const service = new AttachmentLinkService({} as PrismaService);

  it('고른 LOT 마다 같은 파일의 LOT 첨부를 만들고 검사 의뢰 첨부는 지운다', async () => {
    const { tx, raw, created } = txOf(source(), 2);

    const result = await service.linkLots(tx, 31, { lotIds: [11, 12] });

    expect(created.map((row) => [row.target_type_code, row.target_id, row.storage_key, row.uploaded_at])).toEqual([
      ['LOT', 11n, 'inspection_request/2099/abc.pdf', new Date('2099-11-11T01:00:00Z')],
      ['LOT', 12n, 'inspection_request/2099/abc.pdf', new Date('2099-11-11T01:00:00Z')],
    ]);
    expect(raw.attachment.delete).toHaveBeenCalledWith({ where: { attachment_id: 31n } });
    expect(result.items.map((item) => item.targetId)).toEqual([11, 12]);
  });

  it('⛔ 검사 의뢰 첨부가 아니면 attachmentId 의 400 이고 아무것도 바꾸지 않는다', async () => {
    const { tx, raw } = txOf(source('LOT'), 1);

    await expect(service.linkLots(tx, 31, { lotIds: [11] })).rejects.toBeInstanceOf(ContractException);
    expect(raw.attachment.create).not.toHaveBeenCalled();
    expect(raw.attachment.delete).not.toHaveBeenCalled();
  });

  it('⛔ 이 검사 의뢰 밖의 LOT · 겹친 LOT 은 lotIds 의 400 이다', async () => {
    const foreign = txOf(source(), 1);
    await expect(service.linkLots(foreign.tx, 31, { lotIds: [11, 99] })).rejects.toBeInstanceOf(ContractException);
    expect(foreign.raw.attachment.create).not.toHaveBeenCalled();

    const twice = txOf(source(), 2);
    await expect(service.linkLots(twice.tx, 31, { lotIds: [11, 11] })).rejects.toBeInstanceOf(ContractException);
    expect(twice.raw.attachment.create).not.toHaveBeenCalled();
  });

  it('⛔ 판정이 확정된 검사 의뢰면 400 이고 아무것도 바꾸지 않는다', async () => {
    const { tx, raw } = txOf(source(), 1, new Date('2099-11-11T02:00:00Z'));

    await expect(service.linkLots(tx, 31, { lotIds: [11] })).rejects.toBeInstanceOf(ContractException);
    expect(raw.attachment.create).not.toHaveBeenCalled();
    expect(raw.attachment.delete).not.toHaveBeenCalled();
  });
});
