import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE, field } from '../../common/errors';
import { assertNotBlank } from '../../common/master';
import { assertUpdated } from '../../common/optimistic-lock';
import { DocumentStateService } from '../../core/document-state';
import { readBreakdownMutationView } from './breakdown-mutation-view';
import {
  assertBreakdownEditable,
  assertBreakdownVersion,
  BreakdownTx,
  lockBreakdownForUpdate,
} from './breakdown-lock';
import { BreakdownView } from './breakdown-view';
import { BreakdownManagementContext } from './breakdown-write-context';

export const BREAKDOWN_CAUSE_GROUP = 'EQUIPMENT_BREAKDOWN_CAUSE';

export interface BreakdownHandlingUpdate {
  causeCode?: string | null;
  handlingNote?: string | null;
}

export interface BreakdownComplete {
  causeCode: string;
  handlingNote: string;
}

const has = (
  input: BreakdownHandlingUpdate,
  name: keyof BreakdownHandlingUpdate,
): boolean => Object.prototype.hasOwnProperty.call(input, name);

export interface CheckedBreakdownHandling {
  causePresent: boolean;
  notePresent: boolean;
}

export function checkBreakdownHandling(
  input: BreakdownHandlingUpdate,
): CheckedBreakdownHandling {
  const causePresent = has(input, 'causeCode');
  return { causePresent, notePresent: has(input, 'handlingNote') };
}

@Injectable()
export class BreakdownHandlingService {
  constructor(private readonly state: DocumentStateService) {}

  async updateWithin(
    tx: BreakdownTx,
    breakdownId: number,
    version: number,
    input: BreakdownHandlingUpdate,
    context: BreakdownManagementContext,
  ): Promise<BreakdownView> {
    const locked = await lockBreakdownForUpdate(tx, breakdownId);
    assertBreakdownVersion(locked, version);
    assertBreakdownEditable(locked);
    const checked = checkBreakdownHandling(input);
    if (checked.causePresent && typeof input.causeCode === 'string') {
      await assertBreakdownCause(tx, input.causeCode);
    }
    return this.updateAndRead(tx, locked, version, context.appUserId, {
      ...(checked.causePresent ? { cause_code: input.causeCode ?? null } : {}),
      ...(checked.notePresent
        ? { handling_note: input.handlingNote ?? null }
        : {}),
    });
  }

  async startWithin(
    tx: BreakdownTx,
    breakdownId: number,
    version: number,
    context: BreakdownManagementContext,
  ): Promise<BreakdownView> {
    const locked = await lockBreakdownForUpdate(tx, breakdownId);
    assertBreakdownVersion(locked, version);
    const transition = this.state.assertTransition(
      'maintenance.breakdown.status_code',
      'breakdown-start-handling',
      locked.status_code,
      HttpStatus.BAD_REQUEST,
    );
    const now = new Date();
    return this.updateAndRead(
      tx,
      locked,
      version,
      context.appUserId,
      {
        status_code: transition.to,
        started_at: now,
      },
      now,
    );
  }

  async completeWithin(
    tx: BreakdownTx,
    breakdownId: number,
    version: number,
    input: BreakdownComplete,
    context: BreakdownManagementContext,
  ): Promise<BreakdownView> {
    const locked = await lockBreakdownForUpdate(tx, breakdownId);
    assertBreakdownVersion(locked, version);
    const transition = this.state.assertTransition(
      'maintenance.breakdown.status_code',
      'breakdown-complete',
      locked.status_code,
      HttpStatus.BAD_REQUEST,
    );
    assertNotBlank([
      ['causeCode', input.causeCode],
      ['handlingNote', input.handlingNote],
    ]);
    await assertBreakdownCause(tx, input.causeCode);
    const now = new Date();
    assertBreakdownCompletionWindow(locked.started_epoch_us, now);
    return this.updateAndRead(
      tx,
      locked,
      version,
      context.appUserId,
      {
        cause_code: input.causeCode,
        handling_note: input.handlingNote,
        status_code: transition.to,
        completed_at: now,
      },
      now,
    );
  }

  private async updateAndRead(
    tx: BreakdownTx,
    locked: { breakdown_id: bigint },
    version: number,
    appUserId: number,
    changes: Pick<
      Prisma.breakdownUpdateManyMutationInput,
      | 'cause_code'
      | 'handling_note'
      | 'status_code'
      | 'started_at'
      | 'completed_at'
    >,
    now = new Date(),
  ): Promise<BreakdownView> {
    const actorId = BigInt(appUserId);
    const updated = await tx.breakdown.updateMany({
      where: { breakdown_id: locked.breakdown_id, version_no: version },
      data: {
        ...changes,
        handled_by: actorId,
        handled_at: now,
        updated_by: actorId,
        updated_at: now,
        version_no: { increment: 1 },
      },
    });
    assertUpdated(updated.count, 'user');
    const view = await readBreakdownMutationView(tx, locked.breakdown_id);
    if (view === null) throw new Error('Updated breakdown is missing');
    return view;
  }
}

export function assertBreakdownCompletionWindow(
  startedEpochUs: string | null,
  completedAt: Date,
): void {
  const completedEpochUs = BigInt(completedAt.getTime()) * 1000n;
  if (startedEpochUs === null || BigInt(startedEpochUs) <= completedEpochUs)
    return;
  throw new ContractException(HttpStatus.UNPROCESSABLE_ENTITY, [
    field(
      'startedAt',
      ERROR_CODE.RANGE,
      '처리 시작 시각이 완료 시각보다 늦을 수 없습니다.',
    ),
  ]);
}

async function assertBreakdownCause(
  tx: BreakdownTx,
  causeCode: string,
): Promise<void> {
  const cause = await tx.code_value.findFirst({
    where: {
      code: causeCode,
      is_active: true,
      code_group: { group_code: BREAKDOWN_CAUSE_GROUP, is_active: true },
    },
    select: { code_value_id: true },
  });
  if (cause === null) {
    throw new ContractException(HttpStatus.BAD_REQUEST, [
      field(
        'causeCode',
        ERROR_CODE.INVALID,
        '사용할 수 없는 설비 고장 원인코드입니다.',
      ),
    ]);
  }
}
