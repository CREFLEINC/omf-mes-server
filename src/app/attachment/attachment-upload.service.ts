import { HttpStatus, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { Request } from 'express';

import { currentSession } from '../../auth/session-resolver.service';
import { attachmentFileName, attachmentRoot, imageMimeOf, storeAttachment } from '../../common/attachment-storage';
import { ContractException, ERROR_CODE, ErrorItem, field } from '../../common/errors';
import { IdempotencyService, requestFingerprint } from '../../common/idempotency';
import { PrismaService } from '../../prisma/prisma.service';
import { AttachmentView, attachmentView } from './attachment-view';

const OPERATION = 'POST /app/attachments';
const MISSING_TARGET = { WAREHOUSE: '없는 창고입니다.', NOTICE: '없는 공지입니다.' } as const;
type TargetType = keyof typeof MISSING_TARGET;
const INT64_MAX = 2n ** 63n - 1n;
/** 계약 `Attachment.contentType` 이 100자다(물리 칸은 150). */
const MIME = /^[\w!#$&^.+-]+\/[\w!#$&^.+-]+$/;

interface UploadInput {
  targetType: TargetType;
  targetId: bigint;
  fileName: string;
  contentType: string;
  extension: string;
  bytes: Buffer;
}

/**
 * 창고 도면·공지 첨부 올리기(#652).
 *
 * ⚠ 계약 검증기는 multipart 본문을 보지 않고, 가드는 multer 보다 먼저 돈다 — 칸 검증은 여기서 한다.
 * ⚠ 대상이 없어도 404 가 아니다 — 계약이 400·403·413 만 선언했다(targetId 칸의 400).
 */
@Injectable()
export class AttachmentUploadService {
  constructor(private readonly prisma: PrismaService, private readonly idempotency: IdempotencyService) {}

  async upload(body: unknown, file: Express.Multer.File | undefined, request: Request): Promise<AttachmentView> {
    const session = currentSession(request);
    if (!session) throw new Error('첨부 올리기는 로그인 세션에서만 온다 — 인증 가드가 먼저 막아야 한다.');
    const root = attachmentRoot();
    const input = parseUpload(body, file);
    await this.assertTarget(input.targetType, input.targetId);

    const checksum = createHash('sha256').update(input.bytes).digest('hex');
    const context = {
      key: String(request.headers['idempotency-key']),
      fingerprint: requestFingerprint(OPERATION, {
        targetTypeCode: input.targetType, targetId: String(input.targetId),
        fileName: input.fileName, contentType: input.contentType, checksum,
      }),
      appUserId: session.userId,
      successStatus: HttpStatus.CREATED,
    };
    const prior = await this.idempotency.replayExisting<AttachmentView>(context);
    if (prior) return prior.body;

    const area = input.targetType.toLowerCase();
    return storeAttachment(root, { area, extension: input.extension, bytes: input.bytes }, (storageKey) =>
      this.idempotency.run<AttachmentView>(context, async (tx) => attachmentView(await tx.attachment.create({ data: {
        target_type_code: input.targetType,
        target_id: input.targetId,
        file_name: input.fileName,
        storage_key: storageKey,
        mime_type: input.contentType,
        file_size: BigInt(input.bytes.length),
        checksum_sha256: checksum,
        uploaded_by: BigInt(session.userId),
      } }))));
  }

  /** 창고·공지 모두 삭제 오퍼레이션이 없어 트랜잭션 밖 확인으로 충분하다. */
  private async assertTarget(targetType: TargetType, targetId: bigint): Promise<void> {
    const exists = targetId < 1n || targetId > INT64_MAX ? null
      : targetType === 'WAREHOUSE'
        ? await this.prisma.warehouse.findUnique({ where: { warehouse_id: targetId }, select: { warehouse_id: true } })
        : await this.prisma.notice.findUnique({ where: { notice_id: targetId }, select: { notice_id: true } });
    if (!exists) {
      throw new ContractException(HttpStatus.BAD_REQUEST, [field('targetId', ERROR_CODE.INVALID, MISSING_TARGET[targetType])]);
    }
  }
}

/** multer 가 푼 본문은 문자열이다(같은 칸이 두 번 오면 배열). 틀린 칸을 모아 한 번에 400 으로 낸다. */
function parseUpload(body: unknown, file: Express.Multer.File | undefined): UploadInput {
  const fields = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  const errors: ErrorItem[] = [];

  const rawType = fields.targetTypeCode;
  const targetType = rawType === 'WAREHOUSE' || rawType === 'NOTICE' ? rawType : undefined;
  if (rawType === undefined) errors.push(field('targetTypeCode', ERROR_CODE.REQUIRED, '대상 유형이 필요합니다.'));
  else if (!targetType) errors.push(field('targetTypeCode', ERROR_CODE.INVALID, 'WAREHOUSE 또는 NOTICE 여야 합니다.'));

  const rawId = fields.targetId;
  const targetId = typeof rawId === 'string' && /^-?\d+$/.test(rawId) ? BigInt(rawId) : undefined;
  if (rawId === undefined) errors.push(field('targetId', ERROR_CODE.REQUIRED, '대상 식별자가 필요합니다.'));
  else if (targetId === undefined) errors.push(field('targetId', ERROR_CODE.INVALID, '대상 식별자는 정수여야 합니다.'));

  const fileName = file ? attachmentFileName(file.originalname) : undefined;
  const image = file && targetType === 'WAREHOUSE' ? imageMimeOf(file.buffer) : undefined;
  if (!file) errors.push(field('file', ERROR_CODE.REQUIRED, '파일이 필요합니다.'));
  else if (file.buffer.length === 0) errors.push(field('file', ERROR_CODE.INVALID, '빈 파일은 올릴 수 없습니다.'));
  else if (!fileName) errors.push(field('file', ERROR_CODE.INVALID, '파일 이름이 올바르지 않습니다.'));
  else if (targetType === 'WAREHOUSE' && image !== 'image/png' && image !== 'image/jpeg') {
    errors.push(field('file', ERROR_CODE.INVALID, '도면은 PNG·JPEG 이미지만 올릴 수 있습니다.'));
  }

  if (errors.length > 0 || !targetType || targetId === undefined || !file || !fileName) {
    throw new ContractException(HttpStatus.BAD_REQUEST, errors);
  }
  if (targetType === 'WAREHOUSE') {
    const contentType = image as 'image/png' | 'image/jpeg';
    return { targetType, targetId, fileName, contentType, extension: contentType === 'image/png' ? 'png' : 'jpg', bytes: file.buffer };
  }
  const declared = file.mimetype.toLowerCase();
  const contentType = declared.length <= 100 && MIME.test(declared) ? declared : 'application/octet-stream';
  return { targetType, targetId, fileName, contentType, extension: 'bin', bytes: file.buffer };
}
