import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import type { Request } from 'express';

import { currentSession } from '../../auth/session-resolver.service';
import { AttachmentView, attachmentView } from '../../app/attachment/attachment-view';
import { attachmentFileName, attachmentRoot, imageMimeOf, storeAttachment } from '../../common/attachment-storage';
import { ContractException, ERROR_CODE } from '../../common/errors';
import { IdempotencyService, requestFingerprint } from '../../common/idempotency';
import { runIdempotent } from '../../common/master';
import { REVISION_STATUS } from '../../planning/revision-status';
import { DRAWING_TARGET } from './inspection-plan-drawing';

export interface DrawingFile {
  fileName: string;
  mime: 'image/png' | 'image/jpeg';
  bytes: Buffer;
}

type Tx = Prisma.TransactionClient;

/**
 * 검사기준 버전 도면을 화면에서 한 장씩 더하고·바꾸고·뺀다(omf-all-around#227). 엑셀 올리기(`replaceDrawings`)와 같은 첨부 행이다.
 * 작성중 버전만 고친다 — 확정 버전은 검사가 쓰고 있어 신규 버전에서 고친다(사용자 결정).
 * ⚠ 파일은 지우지 않는다 — 신규 버전 발행이 행만 복사해 다른 버전이 같은 파일을 가리킬 수 있다. 행만 바꾸거나 지운다.
 * 바꾸기는 같은 행을 고친다 — 화면이 첨부 id 순으로 도면을 늘어놓아 자리가 유지된다.
 */
@Injectable()
export class InspectionPlanDrawingService {
  constructor(private readonly idempotency: IdempotencyService) {}

  add(versionId: number, file: Express.Multer.File | undefined, request: Request): Promise<AttachmentView> {
    const drawing = parseDrawingFile(file);
    const userId = sessionUserOf(request);
    return this.store(request, `POST /quality/inspection-plan-versions/${String(versionId)}/drawings`, HttpStatus.CREATED, drawing,
      async (tx, storageKey) => {
        await lockDraft(tx, versionId, '도면을 추가할');
        return attachmentView(await tx.attachment.create({ data: {
          target_type_code: DRAWING_TARGET,
          target_id: BigInt(versionId),
          ...fileData(drawing, storageKey, userId),
        } }));
      });
  }

  replace(versionId: number, attachmentId: number, file: Express.Multer.File | undefined, request: Request): Promise<AttachmentView> {
    const drawing = parseDrawingFile(file);
    const userId = sessionUserOf(request);
    const operation = `PUT /quality/inspection-plan-versions/${String(versionId)}/drawings/${String(attachmentId)}`;
    return this.store(request, operation, HttpStatus.OK, drawing, async (tx, storageKey) => {
      await lockDraft(tx, versionId, '도면을 바꿀');
      await assertDrawing(tx, versionId, attachmentId);
      return attachmentView(await tx.attachment.update({
        where: { attachment_id: BigInt(attachmentId) },
        data: { ...fileData(drawing, storageKey, userId), uploaded_at: new Date() },
      }));
    });
  }

  async remove(versionId: number, attachmentId: number, request: Request): Promise<void> {
    await runIdempotent(this.idempotency, request, HttpStatus.NO_CONTENT, async (tx) => {
      await lockDraft(tx, versionId, '도면을 뺄');
      await assertDrawing(tx, versionId, attachmentId);
      await tx.attachment.delete({ where: { attachment_id: BigInt(attachmentId) } });
      return undefined;
    });
  }

  /** 파일을 먼저 쓰고 행을 세운다 — 같은 키 재전송이면 방금 쓴 파일을 지우고 앞 응답을 준다(첨부 올리기와 같다). */
  private async store(
    request: Request,
    operation: string,
    successStatus: number,
    drawing: DrawingFile,
    commit: (tx: Tx, storageKey: string) => Promise<AttachmentView>,
  ): Promise<AttachmentView> {
    const root = attachmentRoot();
    const context = {
      key: String(request.headers['idempotency-key']),
      fingerprint: requestFingerprint(operation, {
        fileName: drawing.fileName, mime: drawing.mime, checksum: checksumOf(drawing.bytes),
      }),
      appUserId: sessionUserOf(request),
      successStatus,
    };
    const prior = await this.idempotency.replayExisting<AttachmentView>(context);
    if (prior) return prior.body;
    const extension = drawing.mime === 'image/png' ? 'png' : 'jpg';
    return storeAttachment(root, { area: 'inspection_plan_version', extension, bytes: drawing.bytes }, (storageKey) =>
      this.idempotency.run<AttachmentView>(context, (tx) => commit(tx, storageKey)));
  }
}

/** 도면은 PNG·JPEG 만 받는다 — 요청의 Content-Type 이 아니라 앞 바이트로 가린다(엑셀 도면·창고 도면과 같다). */
export function parseDrawingFile(file: Express.Multer.File | undefined): DrawingFile {
  if (!file || file.buffer.length === 0) throw invalid('도면 그림 파일이 필요합니다.');
  const fileName = attachmentFileName(file.originalname);
  if (!fileName) throw invalid('파일 이름이 올바르지 않습니다.');
  const mime = imageMimeOf(file.buffer);
  if (mime !== 'image/png' && mime !== 'image/jpeg') throw invalid('도면은 PNG·JPEG 그림만 올릴 수 있습니다.');
  return { fileName, mime, bytes: file.buffer };
}

function sessionUserOf(request: Request): number {
  const session = currentSession(request);
  if (!session) throw new Error('도면 고치기는 로그인 세션에서만 온다 — 인증 가드가 먼저 막아야 한다.');
  return session.userId;
}

/** ⛔ `FOR UPDATE` — 판정과 쓰기 사이에 확정이 끼면 확정 버전의 도면이 바뀐다. */
async function lockDraft(tx: Tx, versionId: number, action: string): Promise<void> {
  const rows = await tx.$queryRaw<{ status_code: string }[]>`
    SELECT status_code
      FROM quality.inspection_plan_version
     WHERE inspection_plan_version_id = ${BigInt(versionId)}
       FOR UPDATE`;
  if (rows.length === 0) throw new NotFoundException('없는 검사기준 버전입니다.');
  if (rows[0].status_code !== REVISION_STATUS.DRAFT) {
    throw new ContractException(HttpStatus.BAD_REQUEST, [{
      scope: 'screen', code: ERROR_CODE.STATE_LOCKED, message: `작성중 버전에서만 ${action} 수 있습니다.`,
    }]);
  }
}

async function assertDrawing(tx: Tx, versionId: number, attachmentId: number): Promise<void> {
  const row = await tx.attachment.findFirst({
    where: { attachment_id: BigInt(attachmentId), target_type_code: DRAWING_TARGET, target_id: BigInt(versionId) },
    select: { attachment_id: true },
  });
  if (!row) throw new NotFoundException('이 버전의 도면이 아닙니다.');
}

function fileData(drawing: DrawingFile, storageKey: string, userId: number) {
  return {
    file_name: drawing.fileName,
    storage_key: storageKey,
    mime_type: drawing.mime,
    file_size: BigInt(drawing.bytes.length),
    checksum_sha256: checksumOf(drawing.bytes),
    uploaded_by: BigInt(userId),
  };
}

function checksumOf(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function invalid(message: string): ContractException {
  return new ContractException(HttpStatus.BAD_REQUEST, [{ scope: 'screen', code: ERROR_CODE.INVALID, message }]);
}
