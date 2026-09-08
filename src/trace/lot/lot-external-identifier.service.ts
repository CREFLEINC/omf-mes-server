import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';

import { ContractException, ERROR_CODE, ErrorItem, field, one } from '../../common/errors';
import { assertCodeValues } from '../../common/master';
import { assertUpdated } from '../../common/optimistic-lock';
import { Tx } from '../../core/lot';
import { PrismaService } from '../../prisma/prisma.service';
import { ExternalIdentifierView, identifierView } from './lot-view';

const IDENTIFIER_TYPE_GROUP = 'LOT_EXTERNAL_IDENTIFIER_TYPE';

/** 계약 `LotExternalIdentifierUpsert` — required 2 · 프로퍼티 4. ⛔ **id 칸이 없다**(§3-2 ⓒ). */
export interface LotExternalIdentifierUpsert {
  identifierTypeCode: string;
  externalIdentifier: string;
  partnerId?: number | null;
  externalSystemCode?: string | null;
}

/**
 * `GET`·`PUT /trace/lots/{lotId}/external-identifiers`. `lot.service.ts` 에 안 넣는 이유는
 * 그 파일이 이미 293줄이라서다(§0 자리 5 · `CLAUDE.md` ~300줄 신호).
 *
 * `list()` 와 `replace()` 의 응답은 상세 GET(`lot.service.ts:139-142`)과 **같은 정렬·같은 뷰**를
 * 쓴다 — id 오름차순 · `identifierView`.
 */
@Injectable()
export class LotExternalIdentifierService {
  constructor(private readonly prisma: PrismaService) {}

  async list(lotId: number): Promise<{ items: ExternalIdentifierView[] }> {
    await this.assertLotExists(lotId);
    const rows = await this.prisma.lot_external_identifier.findMany({
      where: { lot_id: lotId },
      orderBy: { lot_external_identifier_id: 'asc' },
    });
    return { items: rows.map(identifierView) };
  }

  /**
   * 치환 — **전삭제 + 전삽입**. 계약 `LotExternalIdentifierUpsert` 에 id 칸이 없어 자연키 diff 를
   * 할 근거가 없고 이 표를 참조하는 자식이 0개다. ⚠ 그래서 `lotExternalIdentifierId` 는 매
   * 치환마다 갈린다 — 계약 「요청에서 빠진 기존 행은 삭제한다」가 그것을 허용한다(통보 152).
   *
   * ⭐ **0행 요청을 받는다**(전건 삭제) — 계약이 `minItems` 를 안 걸었고 등록 쪽
   *    `LotCreate.externalIdentifiers` 도 선택 배열이다. 출고 라인이 0행을 막은 것은 그쪽 등록
   *    계약이 「최소 1행」이라 적었기 때문이라 여기와 근거가 다르다.
   * ⭐ **부모 `version_no` 를 올린다** — 응답에 ETag 선언이 없어 `runVersioned` 를 못 쓰지만,
   *    상세 GET 이 `externalIdentifiers` 를 본문에 실어(`lot.service.ts:146`) 이 치환이 부모의
   *    내용을 바꾼다. 다음 If-Match 는 상세 GET 이 준다(0단계 선례
   *    `goods-issue-update.service.ts:46-47`).
   */
  async replace(
    lotId: number,
    version: number,
    items: LotExternalIdentifierUpsert[],
    appUserId: number,
  ): Promise<{ items: ExternalIdentifierView[] }> {
    // 잠글 필요가 없는 검사는 트랜잭션 «밖»이다(형제 `:complete`·출고 치환과 같은 순서).
    assertNoDuplicate(items);
    await assertCodeValues(
      this.prisma,
      items.map((item, index) => ({
        field: `items.${index}.identifierTypeCode`,
        value: item.identifierTypeCode,
        groupCode: IDENTIFIER_TYPE_GROUP,
      })),
    );
    await this.assertPartners(items);

    return this.prisma.$transaction(async (tx) => {
      await lockLot(tx, lotId, version);
      await tx.lot_external_identifier.deleteMany({ where: { lot_id: lotId } });
      await tx.lot_external_identifier.createMany({
        data: items.map((item) => ({
          lot_id: lotId,
          identifier_type_code: item.identifierTypeCode,
          external_identifier: item.externalIdentifier,
          partner_id: item.partnerId ?? null,
          external_system_code: item.externalSystemCode ?? null,
          created_by: BigInt(appUserId),
        })),
      });
      const bumped = await tx.lot.updateMany({
        where: { lot_id: lotId, version_no: version },
        data: { version_no: { increment: 1 }, updated_by: BigInt(appUserId) },
      });
      // 잠그고 비교했으니 0행일 수 없다 — 그래도 조건을 걸어 둔다(같은 축의 마지막 그물).
      assertUpdated(bumped.count);

      const rows = await tx.lot_external_identifier.findMany({
        where: { lot_id: lotId },
        orderBy: { lot_external_identifier_id: 'asc' },
      });
      return { items: rows.map(identifierView) };
    });
  }

  /**
   * ⛔ 없는 `partnerId` 를 그냥 넘기면 FK 위반이 **500 으로 샌다** — 0단계 선례가 같은 자리에서
   * 같은 이유로 앞당겨 막았다(`goods-issue-update.service.ts:70-76`).
   */
  private async assertPartners(items: LotExternalIdentifierUpsert[]): Promise<void> {
    const wanted = items
      .map((item) => item.partnerId)
      .filter((partnerId): partnerId is number => typeof partnerId === 'number');
    if (wanted.length === 0) return;
    const rows = await this.prisma.partner.findMany({
      where: { partner_id: { in: wanted } },
      select: { partner_id: true },
    });
    const known = new Set(rows.map((row) => Number(row.partner_id)));
    const errors: ErrorItem[] = items.flatMap((item, index) =>
      typeof item.partnerId === 'number' && !known.has(item.partnerId)
        ? [field(`items.${index}.partnerId`, ERROR_CODE.INVALID, '없는 거래처입니다.')]
        : [],
    );
    if (errors.length > 0) throw new ContractException(HttpStatus.BAD_REQUEST, errors);
  }

  private async assertLotExists(lotId: number): Promise<void> {
    const row = await this.prisma.lot.findUnique({ where: { lot_id: lotId }, select: { lot_id: true } });
    if (!row) throw new NotFoundException('없는 LOT 입니다.');
  }
}

/**
 * ⭐ 요청 «안» 중복을 400 으로 앞당겨 막는다. 물리 유일 인덱스가 **5칸 표현식**이라
 * (`lot_id` · `identifier_type_code` · `COALESCE(partner_id,0)` · `COALESCE(external_system_code,'')` ·
 * `external_identifier`) P2002 의 `meta.target` 이 비어 공용 그물(`prisma-error.ts:47`)에 안 걸리고
 * **500 으로 샌다** — `purchase-order.service.ts:341-350` 이 같은 사고를 이미 한 번 고쳤다.
 *
 * ⚠ 널의 동치도 표현식 그대로다 — `partnerId` 는 널과 `0` 이, `externalSystemCode` 는 널과 `''` 가
 *   같은 값으로 겹친다.
 */
export function assertNoDuplicate(items: readonly LotExternalIdentifierUpsert[]): void {
  const seen = new Set<string>();
  for (const [index, item] of items.entries()) {
    const key = JSON.stringify([
      item.identifierTypeCode,
      item.partnerId ?? 0,
      item.externalSystemCode ?? '',
      item.externalIdentifier,
    ]);
    if (seen.has(key)) {
      throw one({
        scope: 'field',
        field: `items.${index}.externalIdentifier`,
        code: ERROR_CODE.UNIQUE_VIOLATION,
        uniqueScope: [
          'lotId',
          'identifierTypeCode',
          'partnerId',
          'externalSystemCode',
          'externalIdentifier',
        ],
        message: '같은 외부 식별자를 두 번 실었습니다.',
      });
    }
    seen.add(key);
  }
}

/**
 * ⛔ 잠그는 단위가 «부모»다 — If-Match 토큰이 `trace.lot.version_no` 이고 계약이 그 이유를 적었다
 * (「잠그는 단위가 부모이기 때문이다」 · B-1-1). 자식 행에는 버전 칸이 없다.
 * ⚠ 없는 LOT 이 **404** 고 버전 어긋남이 **409** 다 — 순서를 바꾸면 없는 LOT 이 409 로 보인다.
 */
async function lockLot(tx: Tx, lotId: number, version: number): Promise<void> {
  const rows = await tx.$queryRaw<{ version_no: number }[]>`
    SELECT version_no
      FROM trace.lot
     WHERE lot_id = ${BigInt(lotId)}
       FOR UPDATE`;
  if (rows.length === 0) throw new NotFoundException('없는 LOT 입니다.');
  // 존재는 확인했다 — 값이 다르면 그 사이 누가 먼저 저장한 것이다(재로드로 풀린다).
  if (rows[0].version_no !== version) assertUpdated(0);
}
