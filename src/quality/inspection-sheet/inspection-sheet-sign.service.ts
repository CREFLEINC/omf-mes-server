import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE } from '../../common/errors';
import { assertUpdated } from '../../common/optimistic-lock';
import { PrismaService } from '../../prisma/prisma.service';
import { InspectionSheetEntryService, SheetResult } from './inspection-sheet-entry.service';
import { effectiveResults, oqcOf, SHIPMENT_STEP } from './inspection-sheet-oqc';

type Decision = 'APPROVE' | 'CHECK';

/**
 * 제품 검사표 서명·승인·확인·승인 취소(관리웹 W-03-14 · omf-all-around#89 · 장부 P-102).
 * 서명은 로그인한 관리자의 이름·시각만 남긴다(담당자 결정 ②). 승인과 확인이 둘 다 되면 완료다 — 완료된 검사표는
 * 고칠 수 없고, 관리자가 사유를 남기고 승인을 취소해야 다시 작성중이 된다(결정 ⑦). 모든 서명·결정은 이력에 남는다.
 */
@Injectable()
export class InspectionSheetSignService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly entries: InspectionSheetEntryService,
  ) {}

  /**
   * 기록된 단계에만 서명한다. 이미 서명된 단계면 서명자·시각을 새로 남긴다.
   * 출하검사를 시리얼 OQC 가 기록했으면 그 판정을 단계 줄(원천 OQC)에 옮겨 적고 서명한다(#68 · 장부 P-102).
   */
  async signStep(id: number, stepCode: string, version: number, actorId: number): Promise<SheetResult> {
    await this.prisma.$transaction(async (tx) => {
      const serialNumberId = await bumpInProgress(tx, id, version, actorId);
      const oqc = stepCode === SHIPMENT_STEP ? await oqcOf(tx, serialNumberId) : null;
      if (oqc !== null) {
        const now = new Date();
        const values = {
          first_judgment_code: oqc.first_judgment_code,
          final_judgment_code: oqc.final_judgment_code,
          source_code: 'OQC',
          inspected_worker_id: oqc.inspected_worker_id,
          inspected_at: oqc.inspected_at,
          inspection_result_id: oqc.inspection_result_id,
          signed_by: actorId,
          signed_at: now,
          updated_by: actorId,
          updated_at: now,
        };
        await tx.inspection_sheet_step_result.upsert({
          where: { inspection_sheet_id_step_code: { inspection_sheet_id: id, step_code: stepCode } },
          create: { inspection_sheet_id: id, step_code: stepCode, created_by: actorId, ...values },
          update: { ...values, version_no: { increment: 1 } },
        });
        await tx.inspection_sheet_event.create({
          data: { inspection_sheet_id: id, event_code: 'SIGN_STEP', step_code: stepCode, acted_by: actorId },
        });
        return;
      }
      const signed = await tx.inspection_sheet_step_result.updateMany({
        where: { inspection_sheet_id: id, step_code: stepCode },
        data: { signed_by: actorId, signed_at: new Date(), updated_by: actorId, updated_at: new Date(), version_no: { increment: 1 } },
      });
      if (signed.count === 0) throw locked('stepCode', '판정이 기록되지 않은 단계는 서명할 수 없습니다.');
      await tx.inspection_sheet_event.create({
        data: { inspection_sheet_id: id, event_code: 'SIGN_STEP', step_code: stepCode, acted_by: actorId },
      });
    });
    return this.entries.get(id);
  }

  /**
   * 승인(양식 「승인」)·확인(양식 「확인」). 서명이 필요한 단계는 모두 서명돼 있어야 하고, 기록된 단계는 최종 판정이
   * 모두 OK 여야 한다(400 `STATE_LOCKED`). 둘 다 되면 완료로 바뀐다.
   */
  async decide(id: number, decision: Decision, version: number, actorId: number): Promise<SheetResult> {
    await this.prisma.$transaction(async (tx) => {
      const sheet = await tx.inspection_sheet.findUnique({
        where: { inspection_sheet_id: id },
        select: {
          serial_number_id: true,
          status_code: true,
          approved_by: true,
          checked_by: true,
          template: { select: { steps: { select: { step_code: true, name_ko: true, sign_required: true } } } },
          step_results: { select: { step_code: true, source_code: true, final_judgment_code: true, signed_at: true } },
        },
      });
      if (sheet === null) throw new NotFoundException('없는 검사표입니다.');
      if (sheet.status_code === 'COMPLETED') throw locked(null, '이미 완료된 검사표입니다.');
      const oqc = await oqcOf(tx, sheet.serial_number_id);
      const stepCodes = sheet.template.steps.map((step) => step.step_code);
      assertDecidable(sheet.template.steps, effectiveResults(sheet.step_results, oqc, stepCodes));
      const now = new Date();
      const approved = decision === 'APPROVE' || sheet.approved_by !== null;
      const checked = decision === 'CHECK' || sheet.checked_by !== null;
      const updated = await tx.inspection_sheet.updateMany({
        where: { inspection_sheet_id: id, version_no: version, status_code: 'IN_PROGRESS' },
        data: {
          ...(decision === 'APPROVE' ? { approved_by: actorId, approved_at: now } : { checked_by: actorId, checked_at: now }),
          status_code: approved && checked ? 'COMPLETED' : 'IN_PROGRESS',
          updated_by: actorId,
          updated_at: now,
          version_no: { increment: 1 },
        },
      });
      assertUpdated(updated.count);
      await tx.inspection_sheet_event.create({ data: { inspection_sheet_id: id, event_code: decision, acted_by: actorId } });
    });
    return this.entries.get(id);
  }

  /** 승인 취소 — 승인·확인을 비우고 작성중으로 돌린다. 사유가 없으면 400 `reason`·`REQUIRED`. */
  async reopen(id: number, version: number, reason: string, actorId: number): Promise<SheetResult> {
    const trimmed = reason.trim();
    if (trimmed === '') {
      throw new ContractException(HttpStatus.BAD_REQUEST, [
        { scope: 'field', field: 'reason', code: ERROR_CODE.REQUIRED, message: '승인 취소 사유를 적으세요.' },
      ]);
    }
    await this.prisma.$transaction(async (tx) => {
      const sheet = await tx.inspection_sheet.findUnique({
        where: { inspection_sheet_id: id },
        select: { approved_by: true, checked_by: true },
      });
      if (sheet === null) throw new NotFoundException('없는 검사표입니다.');
      if (sheet.approved_by === null && sheet.checked_by === null) throw locked(null, '승인·확인된 적이 없는 검사표입니다.');
      const updated = await tx.inspection_sheet.updateMany({
        where: { inspection_sheet_id: id, version_no: version },
        data: {
          status_code: 'IN_PROGRESS',
          approved_by: null,
          approved_at: null,
          checked_by: null,
          checked_at: null,
          updated_by: actorId,
          updated_at: new Date(),
          version_no: { increment: 1 },
        },
      });
      assertUpdated(updated.count);
      await tx.inspection_sheet_event.create({
        data: { inspection_sheet_id: id, event_code: 'REOPEN', reason: trimmed, acted_by: actorId },
      });
    });
    return this.entries.get(id);
  }
}

/** 서명은 작성중인 검사표에만 — 완료된 검사표는 400, 버전이 다르면 409. 검사표의 시리얼을 돌려준다. */
async function bumpInProgress(tx: Prisma.TransactionClient, id: number, version: number, actorId: number): Promise<bigint> {
  const sheet = await tx.inspection_sheet.findUnique({
    where: { inspection_sheet_id: id },
    select: { status_code: true, serial_number_id: true },
  });
  if (sheet === null) throw new NotFoundException('없는 검사표입니다.');
  if (sheet.status_code === 'COMPLETED') throw locked(null, '완료된 검사표입니다. 승인 취소 뒤에 서명하세요.');
  const updated = await tx.inspection_sheet.updateMany({
    where: { inspection_sheet_id: id, version_no: version, status_code: 'IN_PROGRESS' },
    data: { updated_by: actorId, updated_at: new Date(), version_no: { increment: 1 } },
  });
  assertUpdated(updated.count);
  return sheet.serial_number_id;
}

/** 문구는 단계 이름(기준의 한국어 이름)으로 — 화면이 서버 문구를 그대로 보인다. */
export function assertDecidable(
  steps: readonly { step_code: string; name_ko: string; sign_required: boolean }[],
  results: readonly { step_code: string; final_judgment_code: string; signed_at: Date | null }[],
): void {
  const unsigned = steps.filter(
    (step) => step.sign_required && !results.some((r) => r.step_code === step.step_code && r.signed_at !== null),
  );
  if (unsigned.length > 0) {
    throw locked(null, `서명이 필요한 단계가 남아 있습니다: ${unsigned.map((step) => step.name_ko).join(', ')}`);
  }
  const ng = results.filter((r) => r.final_judgment_code !== 'OK');
  const nameOf = (code: string) => steps.find((step) => step.step_code === code)?.name_ko ?? code;
  if (ng.length > 0) throw locked(null, `최종 판정이 NG 인 단계가 있습니다: ${ng.map((r) => nameOf(r.step_code)).join(', ')}`);
}

function locked(field: string | null, message: string): ContractException {
  return new ContractException(HttpStatus.BAD_REQUEST, [
    field === null
      ? { scope: 'screen', code: ERROR_CODE.STATE_LOCKED, message }
      : { scope: 'field', field, code: ERROR_CODE.STATE_LOCKED, message },
  ]);
}
