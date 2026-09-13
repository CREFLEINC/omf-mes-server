import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ConflictException, ERROR_CODE, field, one } from '../../common/errors';
import { assertWorkerNoExists } from '../../common/master';
import { PrismaService } from '../../prisma/prisma.service';
import { recordTerminalWorkerAudit } from '../../audit/terminal-worker-audit';
import { assertReferences } from './handling-unit-content.service';
import { HandlingUnitQueryService } from './handling-unit-query.service';
import { HU_STATUS_PACKED } from './handling-unit-status';
import { HandlingUnitDetailView } from './handling-unit-view';
import {
  HandlingUnitContentUpsert,
  HandlingUnitContext,
  assertContentQty,
  assertNoDuplicateContent,
} from './handling-unit.service';

type Tx = Prisma.TransactionClient;

/**
 * 계약 `HandlingUnitPack`. required 는 `contents`(minItems 1)·`businessDate`·`occurredAt` 셋이다.
 * ⛔ `remarks`·`businessDate`·`occurredAt` 은 담을 칸이 **0** 이라 형식만 보고 버린다 —
 * `inventory.handling_unit` 에 비고도 업무일도 없고, 이 오퍼레이션은 원장을 안 지나 공유계약
 * C-8 의 `business_date` 를 싣는 세 표(전표·파티션·라인)와 무관하다(계획 §2-3 · 대기 15).
 */
export interface HandlingUnitPack {
  contents: HandlingUnitContentUpsert[];
  locationId?: number | null;
  remarks?: string | null;
  businessDate: string;
  occurredAt: string;
}

/**
 * ⭐ 409 두 갈래를 «문구»로 가른다. 계약 `ConflictResponse` 는 `conflictCause`·`message` 뿐이라
 * 봉투에 `code` 칸이 없다 — 화면이 「다시 읽어 오면 풀린다」와 「영영 안 풀린다」를 가를 축이
 * 이 문자열밖에 없다. ⛔ 하나로 합치면 확정된 포장에 낡은 토큰을 쏜 화면이 재조회를 반복한다.
 */
export const PACK_ALREADY_PACKED = '이미 확정된 포장입니다. 다시 확정할 수 없습니다.';
export const PACK_STALE_TOKEN = '다른 사용자가 먼저 저장했습니다. 다시 불러온 뒤 저장하세요.';

/**
 * `POST /inventory/handling-units/{handlingUnitId}:pack` — 포장 확정(PR ⑤).
 * 계획 `docs/coverage-100/slices/I-16-a2.md` §3.
 *
 * ⛔ 재포장 이벤트를 **0행** 만든다 — 계약 `repackTypeCode` enum 이 `MERGE`·`SPLIT`·
 * `RECONFIGURE` 셋뿐이고 「빈 포장의 첫 채움·확정」은 그 셋 중 무엇도 아니다. `roleCode` 도
 * `SOURCE`·`RESULT` 둘뿐이라 첫 채움엔 `SOURCE` 로 적을 줄이 없다(§3-4).
 * ⛔ 원장을 안 부른다 — `inventory_balance` 차원에 `handling_unit_id` 가 없다(§2-5·§3-5).
 */
@Injectable()
export class HandlingUnitPackService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queries: HandlingUnitQueryService,
  ) {}

  async pack(
    handlingUnitId: number,
    version: number | undefined,
    input: HandlingUnitPack,
    context: HandlingUnitContext,
  ): Promise<HandlingUnitDetailView> {
    await assertWorkerNoExists(this.prisma, context.workerNo);
    // 잠글 필요가 없는 검사는 트랜잭션 «밖»이다(형제 치환과 같은 순서 · §3-1 ③④).
    assertNoDuplicateContent(input.contents, 'contents');
    // ⛔ 빠뜨리면 `10.0000005` 가 `numeric(20,6)` 에서 조용히 반올림돼 저장되고 마이그가
    //    forward-only 라 소급 복구가 안 된다 — `qty` 를 쓰는 셋째 경로다(PR #499 후속 ①).
    assertContentQty(input.contents, 'contents');

    await this.prisma.$transaction(async (tx) => {
      const locked = await lockHandlingUnit(tx, handlingUnitId);
      // ⭐ 「이미 확정」이 「낡은 토큰」보다 «먼저»다 — 순서를 뒤집으면 409 가 「다시 읽어
      //    오면 풀린다」라고 말하는데 실제로는 다시 읽어도 영영 안 풀린다(§3-1 ⑥⑦).
      if (locked.status_code === HU_STATUS_PACKED) {
        throw new ConflictException('user', PACK_ALREADY_PACKED);
      }
      // If-Match 는 선택이다 — 안 보내면 낙관적 잠금 검사를 건너뛴다(공유계약 C-9).
      if (version !== undefined && locked.version_no !== version) {
        throw new ConflictException('user', PACK_STALE_TOKEN);
      }
      await assertReferences(tx, input.contents, 'contents');
      await assertLocation(tx, input.locationId);

      await tx.handling_unit_content.deleteMany({ where: { handling_unit_id: handlingUnitId } });
      await tx.handling_unit_content.createMany({
        data: input.contents.map((line) => ({
          handling_unit_id: handlingUnitId,
          item_id: line.itemId,
          lot_id: line.lotId,
          qty: line.qty,
          uom_id: line.uomId,
          created_by: context.appUserId ?? null,
        })),
      });

      await tx.handling_unit.update({
        where: { handling_unit_id: handlingUnitId },
        data: {
          status_code: HU_STATUS_PACKED,
          // ⭐ 키 자체가 없으면 「안 바꾼다」다 — 계약이 `[integer,null]` 이라 «널로 실어 보낸»
          //    것은 「비운다」이고 그 둘을 `??` 로 접으면 위치가 조용히 지워진다(§3-1 ⑩).
          ...('locationId' in input ? { location_id: input.locationId ?? null } : {}),
          version_no: { increment: 1 },
          updated_by: context.appUserId ?? null,
        },
      });
      if (context.terminalAudit !== undefined) await recordTerminalWorkerAudit(tx, {
        actor: context.terminalAudit, targetTypeCode: 'HANDLING_UNIT', targetId: BigInt(handlingUnitId),
        eventTypeCode: 'PACK',
      });
    });

    const detail = await this.queries.get(handlingUnitId);
    // ⛔ 컨트롤러가 `setEtag` 를 안 부른다 — 계약 `responses.200` 에 `headers` 키가 없다(§3-1 ⑬).
    return { handlingUnit: detail.handlingUnit, contents: detail.contents };
  }
}

/**
 * ⭐⭐ 자리 ② — 부모 `inventory.handling_unit` 을 `FOR UPDATE` 로 잠근다. I-27 발행
 * (`document-issue-simple-lock.ts:101-113`)이 같은 두 행을 부모 → 자식 순서로 잠그므로
 * 자식을 먼저 만지면 그 경로와 **교착**한다.
 *
 * ⚠ 형제 `handling-unit-content.service.ts` 의 `lockHandlingUnit` 과 **갈라졌다** — 그쪽은
 *   버전 대조까지 이 함수 안에서 하지만 `:pack` 은 「이미 확정 409」를 «먼저» 판정해야 해서
 *   잠근 행을 그대로 돌려주고 판정은 호출자가 한다. 합치면 그 순서가 사라진다.
 */
async function lockHandlingUnit(
  tx: Tx,
  handlingUnitId: number,
): Promise<{ status_code: string; version_no: number }> {
  const rows = await tx.$queryRaw<{ status_code: string; version_no: number }[]>`
    SELECT status_code, version_no
      FROM inventory.handling_unit
     WHERE handling_unit_id = ${BigInt(handlingUnitId)}
       FOR UPDATE`;
  if (rows.length === 0) throw new NotFoundException('없는 취급 단위입니다.');
  return rows[0];
}

/**
 * 위치 존재 확인. ⚠ 404 를 안 낸다 — 없는 위치는 본문이 틀린 것이다 ⇒ 400 `INVALID`
 * (등록·치환과 같은 가름 · §3-1 ⑧). `assertReferences` 에는 이 축이 없다(구성 라인에
 * 위치 칸이 없다).
 */
async function assertLocation(tx: Tx, locationId: number | null | undefined): Promise<void> {
  if (locationId === undefined || locationId === null) return;
  if ((await tx.location.count({ where: { location_id: locationId } })) === 0) {
    throw one(field('locationId', ERROR_CODE.INVALID, '없는 식별자입니다.'));
  }
}
