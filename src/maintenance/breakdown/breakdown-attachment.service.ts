import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import type { Request } from 'express';

import { currentTerminal } from '../../auth/terminal-context';
import { recordTerminalWorkerAudit } from '../../audit/terminal-worker-audit';
import {
  MAX_ATTACHMENT_BYTES,
  attachmentFileName,
  attachmentRoot,
  imageMimeOf,
  storeAttachment,
} from '../../common/attachment-storage';
import { ContractException, ERROR_CODE } from '../../common/errors';
import { IdempotencyService, requestFingerprint } from '../../common/idempotency';
import { PrismaService } from '../../prisma/prisma.service';

const TARGET_TYPE = 'BREAKDOWN';

type PhotoMime = 'image/jpeg' | 'image/png' | 'image/webp';
const EXTENSION: Record<PhotoMime, string> = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
};

export interface BreakdownAttachmentResult {
  attachmentId: number;
  storageKey: string;
  mimeType: string;
  uploadedAt: string;
}

@Injectable()
export class BreakdownAttachmentService {
  constructor(private readonly prisma: PrismaService, private readonly idempotency: IdempotencyService) {}

  async upload(breakdownId: number, file: Express.Multer.File | undefined, request: Request): Promise<BreakdownAttachmentResult> {
    const root = attachmentRoot();
    if (!file || !Buffer.isBuffer(file.buffer) || file.buffer.length === 0) throw invalid('사진 파일이 필요합니다.');
    if (file.buffer.length > MAX_ATTACHMENT_BYTES) throw invalid('사진 크기 제한을 넘었습니다.');
    const mime = file.mimetype as PhotoMime;
    if (!(mime in EXTENSION) || imageMimeOf(file.buffer) !== mime) throw invalid('지원하지 않는 사진 형식입니다.');
    const fileName = attachmentFileName(file.originalname);
    if (!fileName) throw invalid('파일 이름이 올바르지 않습니다.');

    const terminal = currentTerminal(request);
    if (terminal && terminal.terminalTypeCode !== 'MOBILE') throw invalid('모바일 단말 전용 사진입니다.');
    const workerNo = request.headers['x-worker-no'];
    if (typeof workerNo !== 'string' || !workerNo.trim()) throw invalid('작업자 사번이 필요합니다.');
    const worker = await this.prisma.worker.findUnique({
      where: { worker_no: workerNo.trim() },
      select: { worker_id: true, app_user_id: true, plant_id: true, is_active: true },
    });
    if (!worker || !worker.is_active || (terminal && worker.plant_id !== terminal.plantId)) throw denied();
    const breakdown = await this.prisma.breakdown.findUnique({
      where: { breakdown_id: BigInt(breakdownId) },
      select: { breakdown_id: true, equipment: { select: { plant_id: true } } },
    });
    if (!breakdown) throw new NotFoundException('없는 고장 건입니다.');
    if (breakdown.equipment.plant_id !== worker.plant_id
      || (terminal && breakdown.equipment.plant_id !== terminal.plantId)) throw denied();

    const checksum = createHash('sha256').update(file.buffer).digest('hex');
    const key = String(request.headers['idempotency-key']);
    const context = {
      key,
      fingerprint: requestFingerprint(`POST /maintenance/breakdowns/${breakdownId}/attachments`,
        { checksum, fileName, mime, workerNo: workerNo.trim() }),
      ...(worker.app_user_id === null ? {} : { appUserId: Number(worker.app_user_id) }),
      successStatus: HttpStatus.CREATED,
    };
    const prior = await this.idempotency.replayExisting<BreakdownAttachmentResult>(context);
    if (prior) return prior.body;

    return storeAttachment(root, { area: 'breakdown', extension: EXTENSION[mime], bytes: file.buffer }, (storageKey) =>
      this.idempotency.run<BreakdownAttachmentResult>(context, async (tx) => {
        const locked = await tx.$queryRaw<{ breakdown_id: bigint }[]>(Prisma.sql`
          SELECT breakdown_id FROM maintenance.breakdown WHERE breakdown_id = ${breakdownId} FOR UPDATE`);
        if (locked.length !== 1) throw new NotFoundException('없는 고장 건입니다.');
        const freshWorker = await tx.worker.findUnique({
          where: { worker_id: worker.worker_id },
          select: { app_user_id: true, plant_id: true, is_active: true },
        });
        if (!freshWorker || !freshWorker.is_active || freshWorker.plant_id !== breakdown.equipment.plant_id) throw denied();
        const count = await tx.attachment.count({
          where: { target_type_code: TARGET_TYPE, target_id: BigInt(breakdownId) },
        });
        if (count >= 3) throw new ContractException(HttpStatus.UNPROCESSABLE_ENTITY, [
          { scope: 'screen', code: ERROR_CODE.INVALID, message: '고장 사진은 최대 세 장입니다.' },
        ]);
        const row = await tx.attachment.create({ data: {
          target_type_code: TARGET_TYPE,
          target_id: BigInt(breakdownId),
          file_name: fileName,
          storage_key: storageKey,
          mime_type: mime,
          file_size: BigInt(file.buffer.length),
          checksum_sha256: checksum,
          uploaded_worker_id: worker.worker_id,
          ...(freshWorker.app_user_id === null ? {} : { uploaded_by: freshWorker.app_user_id }),
        } });
        if (terminal) await recordTerminalWorkerAudit(tx, {
          actor: {
            workerId: worker.worker_id, workerNo: workerNo.trim(),
            terminalId: terminal.terminalId, plantId: terminal.plantId,
            correlationId: key, operationKey: 'POST /maintenance/breakdowns/{breakdownId}/attachments',
          },
          targetTypeCode: 'ATTACHMENT', targetId: row.attachment_id, eventTypeCode: 'CREATED',
        });
        return { attachmentId: Number(row.attachment_id), storageKey, mimeType: mime,
          uploadedAt: row.uploaded_at.toISOString() };
      }));
  }
}

function invalid(message: string): ContractException {
  return new ContractException(HttpStatus.BAD_REQUEST, [{ scope: 'screen', code: ERROR_CODE.INVALID, message }]);
}

function denied(): ContractException {
  return new ContractException(HttpStatus.FORBIDDEN, [
    { scope: 'screen', code: ERROR_CODE.PERMISSION_DENIED, message: '사진 첨부 권한이 없습니다.' },
  ]);
}
