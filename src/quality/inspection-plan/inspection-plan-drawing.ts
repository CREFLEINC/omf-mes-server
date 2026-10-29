import { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import type { Worksheet } from 'exceljs';

import { attachmentRoot, imageMimeOf, storeAttachment } from '../../common/attachment-storage';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * 검사기준 버전의 도면(omf-all-around#211 · 장부 P-155) — 고객사 기준서(TCKT)의 「Bản vẽ」 칸 그림.
 * 부품 IQC 화면이 측정 항목 번호(①②…)를 도면과 맞춰 본다. 첨부 표의 다형 참조에 버전으로 붙인다.
 * ⚠ 신규 버전 발행은 행만 복사하고 파일은 같은 것을 가리킨다 — 첨부는 지우는 오퍼레이션이 없어 파일이 먼저 사라지지 않는다.
 */
export const DRAWING_TARGET = 'INSPECTION_PLAN_VERSION';

export interface Drawing {
  bytes: Buffer;
  mime: 'image/png' | 'image/jpeg';
}

type Tx = Prisma.TransactionClient;

/**
 * 「Bản vẽ」 라벨 아래 · 검사 항목 표(「Hạng mục kiểm tra」) 왼쪽에 놓인 그림만 도면으로 본다 — 머리의 결재 도장 그림은
 * 같은 장의 오른쪽 위에 있다. 위치는 1부터 센 행·열이다. PNG·JPEG 만 받는다(브라우저가 바로 그리는 것).
 */
export function drawingsOf(sheet: Worksheet, label: { row: number; col: number }, tableCol: number): Drawing[] {
  const drawings: Drawing[] = [];
  const placed = sheet.getImages()
    .filter((image) => image.range.tl.nativeRow + 1 > label.row && image.range.tl.nativeCol + 1 < tableCol)
    .sort((a, b) => a.range.tl.nativeRow - b.range.tl.nativeRow || a.range.tl.nativeCol - b.range.tl.nativeCol);
  for (const image of placed) {
    const media = sheet.workbook.getImage(Number(image.imageId));
    const bytes = media?.buffer === undefined ? undefined : Buffer.from(media.buffer as unknown as Uint8Array);
    const mime = bytes === undefined ? undefined : imageMimeOf(bytes);
    if (bytes !== undefined && (mime === 'image/png' || mime === 'image/jpeg')) drawings.push({ bytes, mime });
  }
  return drawings;
}

/**
 * 버전의 도면을 엑셀의 것으로 바꾼다. 엑셀에 도면이 없으면 손대지 않는다(발행이 복사한 도면을 남긴다).
 * 올린 사람은 엑셀을 올린 사용자다 — 첨부는 올린 사람이 꼭 있어야 한다(`attachment_actor_required`).
 */
export async function replaceDrawings(prisma: PrismaService, versionId: number, drawings: Drawing[], uploadedBy: number): Promise<void> {
  if (drawings.length === 0) return;
  const root = attachmentRoot();
  await prisma.attachment.deleteMany({ where: { target_type_code: DRAWING_TARGET, target_id: BigInt(versionId) } });
  for (const [index, drawing] of drawings.entries()) {
    const extension = drawing.mime === 'image/png' ? 'png' : 'jpg';
    await storeAttachment(root, { area: 'inspection_plan_version', extension, bytes: drawing.bytes }, async (storageKey) => {
      await prisma.attachment.create({ data: {
        target_type_code: DRAWING_TARGET,
        target_id: BigInt(versionId),
        file_name: `drawing-${String(index + 1)}.${extension}`,
        storage_key: storageKey,
        mime_type: drawing.mime,
        file_size: BigInt(drawing.bytes.length),
        checksum_sha256: createHash('sha256').update(drawing.bytes).digest('hex'),
        uploaded_by: BigInt(uploadedBy),
      } });
      return { replayed: false, body: undefined };
    });
  }
}

/** 신규 버전 발행 — 원본 버전의 도면 행을 새 버전으로 복사한다(같은 파일). */
export async function copyDrawings(tx: Tx, fromVersionId: number, toVersionId: bigint): Promise<void> {
  const rows = await tx.attachment.findMany({
    where: { target_type_code: DRAWING_TARGET, target_id: BigInt(fromVersionId) },
    orderBy: { attachment_id: 'asc' },
  });
  for (const row of rows) {
    await tx.attachment.create({ data: {
      target_type_code: DRAWING_TARGET,
      target_id: toVersionId,
      file_name: row.file_name,
      storage_key: row.storage_key,
      mime_type: row.mime_type,
      file_size: row.file_size,
      checksum_sha256: row.checksum_sha256,
      uploaded_by: row.uploaded_by,
      uploaded_worker_id: row.uploaded_worker_id,
    } });
  }
}

/** 작성 취소 — 버전 행과 함께 그 버전을 가리키는 도면 행을 지운다(파일은 앞 버전이 같이 쓸 수 있어 남긴다). */
export async function dropDrawings(tx: Tx, versionId: number): Promise<void> {
  await tx.attachment.deleteMany({ where: { target_type_code: DRAWING_TARGET, target_id: BigInt(versionId) } });
}
