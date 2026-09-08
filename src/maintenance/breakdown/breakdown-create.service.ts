import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import {
  ContractException,
  ERROR_CODE,
  ErrorItem,
  field,
} from '../../common/errors';
import { assertNotBlank } from '../../common/master';
import { parseMaintenanceInstant } from '../maintenance-instant';
import { NumberedMaintenanceWrite } from '../numbered-maintenance-write';
import {
  BREAKDOWN_INCLUDE,
  BreakdownView,
  breakdownView,
} from './breakdown-view';
import { BreakdownWriteContext } from './breakdown-write-context';

const OCCURRENCE_STATE_GROUP = 'BREAKDOWN_OCCURRENCE_STATE';

export interface BreakdownCreate {
  equipmentId: number;
  symptom: string;
  occurrenceStateCode: string;
  stoppedAt?: string | null;
  reportedAt: string;
  notifyAssignee?: boolean;
}

@Injectable()
export class BreakdownCreateService {
  constructor(private readonly numbered: NumberedMaintenanceWrite) {}

  create(
    input: BreakdownCreate,
    context: BreakdownWriteContext,
  ): Promise<BreakdownView> {
    let reported: ReturnType<typeof parseMaintenanceInstant> | undefined;
    const reportedInstant = () =>
      (reported ??= parseMaintenanceInstant(input.reportedAt, 'reportedAt'));
    return this.numbered.run({
      context,
      documentTypeCode: 'BREAKDOWN',
      equipmentId: input.equipmentId,
      periodDate: () => reportedInstant().utcIso.slice(0, 10),
      numberField: 'breakdownNo',
      numberColumn: 'breakdown_no',
      work: (tx, breakdownNo) =>
        this.createWithin(
          tx,
          input,
          context,
          breakdownNo,
          reportedInstant().utcIso,
        ),
    });
  }

  private async createWithin(
    tx: Prisma.TransactionClient,
    input: BreakdownCreate,
    context: BreakdownWriteContext,
    breakdownNo: string,
    reportedAt: string,
  ): Promise<BreakdownView> {
    assertNotBlank([['symptom', input.symptom]]);
    const stopped =
      input.stoppedAt == null
        ? null
        : parseMaintenanceInstant(input.stoppedAt, 'stoppedAt');
    const [worker, occurrenceState] = await Promise.all([
      tx.worker.findUnique({
        where: { worker_no: context.workerNo },
        select: { worker_id: true },
      }),
      tx.code_value.findFirst({
        where: {
          code: input.occurrenceStateCode,
          is_active: true,
          code_group: { group_code: OCCURRENCE_STATE_GROUP },
        },
        select: { code_value_id: true },
      }),
    ]);
    const errors: ErrorItem[] = [];
    if (worker === null) {
      errors.push(
        field('X-Worker-No', ERROR_CODE.INVALID, '없는 작업자 사번입니다.'),
      );
    }
    if (occurrenceState === null) {
      errors.push(
        field(
          'occurrenceStateCode',
          ERROR_CODE.INVALID,
          '등록되지 않은 고장 발생 상태입니다.',
        ),
      );
    }
    if (errors.length > 0) {
      throw new ContractException(HttpStatus.BAD_REQUEST, errors);
    }

    const actorId = BigInt(context.appUserId);
    const row = await tx.breakdown.create({
      data: {
        breakdown_no: breakdownNo,
        equipment_id: BigInt(input.equipmentId),
        reported_at: new Date(reportedAt),
        reported_by: actorId,
        symptom_code: null,
        description: input.symptom,
        severity_code: null,
        status_code: 'RECEIVED',
        started_at: null,
        completed_at: null,
        root_cause: null,
        occurrence_state_code: input.occurrenceStateCode,
        stopped_at: stopped === null ? null : new Date(stopped.utcIso),
        notify_assignee: input.notifyAssignee ?? true,
        reporter_worker_no: context.workerNo,
        cause_code: null,
        handling_note: null,
        handled_by: null,
        handled_at: null,
        created_by: actorId,
        updated_by: actorId,
      },
    });
    const created = await tx.breakdown.findUnique({
      where: { breakdown_id: row.breakdown_id },
      include: BREAKDOWN_INCLUDE,
    });
    if (created === null) throw new Error('Created breakdown is missing');
    return breakdownView(created, null);
  }
}
