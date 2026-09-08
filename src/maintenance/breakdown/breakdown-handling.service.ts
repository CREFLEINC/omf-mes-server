import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE, field } from '../../common/errors';
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

const UNRESOLVED_BREAKDOWN_CAUSE_MESSAGE =
  '설비 고장 원인코드의 기준정보 원천이 확정되지 않았습니다.';

export interface BreakdownHandlingUpdate {
  causeCode?: string | null;
  handlingNote?: string | null;
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
  if (causePresent && input.causeCode !== null) {
    throw new ContractException(HttpStatus.BAD_REQUEST, [
      field(
        'causeCode',
        ERROR_CODE.INVALID,
        UNRESOLVED_BREAKDOWN_CAUSE_MESSAGE,
      ),
    ]);
  }
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
    return this.updateAndRead(tx, locked, version, context.appUserId, {
      ...(checked.causePresent ? { cause_code: null } : {}),
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

  private async updateAndRead(
    tx: BreakdownTx,
    locked: { breakdown_id: bigint },
    version: number,
    appUserId: number,
    changes: Pick<
      Prisma.breakdownUpdateManyMutationInput,
      'cause_code' | 'handling_note' | 'status_code' | 'started_at'
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
