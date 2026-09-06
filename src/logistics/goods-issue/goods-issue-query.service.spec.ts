import { NotFoundException } from '@nestjs/common';

import { ContractException } from '../../common/errors';
import { PrismaService } from '../../prisma/prisma.service';
import { GoodsIssueQueryService } from './goods-issue-query.service';

type Args = Record<string, unknown>;

/** `list()` 하나가 필요로 하는 만큼만 답하는 최소 prisma 스텁 — 넘어온 `where` 를 그대로 잡는다. */
function listStub(overrides: { rows?: Args[] } = {}) {
  const calls: { where?: Args } = {};
  const prisma = {
    goods_issue: {
      findMany: async ({ where }: { where: Args }) => {
        calls.where = where;
        return overrides.rows ?? [];
      },
      count: async () => (overrides.rows ?? []).length,
      findUnique: async () => null,
    },
  };
  return { prisma: prisma as unknown as PrismaService, calls };
}

describe('GoodsIssueQueryService', () => {
  describe('list', () => {
    it('목록 — supplierId 는 destinationTypeCode 가 PARTNER·DISPOSAL_SITE 인 건만 건다', async () => {
      const { prisma, calls } = listStub();
      await new GoodsIssueQueryService(prisma).list({ supplierId: 1001 });

      expect(calls.where?.destination_type_code).toEqual({ in: ['PARTNER', 'DISPOSAL_SITE'] });
      expect(calls.where?.destination_id).toBe(1001);
    });

    it('목록 — goodsIssueLineId 는 그 라인이 속한 전표를 낸다', async () => {
      const { prisma, calls } = listStub();
      await new GoodsIssueQueryService(prisma).list({ goodsIssueLineId: 55 });

      expect(calls.where?.goods_issue_line).toEqual({ some: { goods_issue_line_id: 55 } });
    });

    it('목록 — q 는 goods_issue_no 부분 일치다(대소문자 무시)', async () => {
      const { prisma, calls } = listStub();
      await new GoodsIssueQueryService(prisma).list({ q: 'GI-2026' });

      expect(calls.where?.goods_issue_no).toEqual({ contains: 'GI-2026', mode: 'insensitive' });
    });

    it('목록 — issuedAtFrom·To 는 UTC 하루 경계로 자른다', async () => {
      const { prisma, calls } = listStub();
      await new GoodsIssueQueryService(prisma).list({
        issuedAtFrom: '2026-08-01',
        issuedAtTo: '2026-08-31',
      });

      expect(calls.where?.issued_at).toEqual({
        gte: new Date('2026-08-01T00:00:00.000Z'),
        lt: new Date('2026-09-01T00:00:00.000Z'), // 「To」는 다음날 00:00Z 미만(반열림)이다.
      });
    });

    it('목록 — 숫자 축에 글자가 오면 400 INVALID 다(500 으로 새지 않는다)', async () => {
      const { prisma } = listStub();

      const rejection = new GoodsIssueQueryService(prisma).list({ sourceWarehouseId: 'abc' });
      await expect(rejection).rejects.toBeInstanceOf(ContractException);
      await rejection.catch((error: ContractException) => {
        expect(error.errors).toEqual([
          { scope: 'field', field: 'sourceWarehouseId', code: 'INVALID', message: '숫자여야 합니다.' },
        ]);
      });
    });
  });

  describe('get', () => {
    it('상세 — 없는 출고면 404', async () => {
      const { prisma } = listStub();

      await expect(new GoodsIssueQueryService(prisma).get(999999999)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('라인 목록 — 없는 출고면 404(형제 ASN·입하·P/O 의 빈 배열과 «다르게» 고정한다 · I-4.md §6-4)', async () => {
      const { prisma } = listStub();

      await expect(new GoodsIssueQueryService(prisma).lines(999999999)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });
});
