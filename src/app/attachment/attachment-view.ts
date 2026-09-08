import { Prisma } from '@prisma/client';

export type AttachmentRow = Prisma.attachmentGetPayload<object>;
export type AttachmentView = ReturnType<typeof attachmentView>;

/**
 * 계약 `Attachment`(required 7 · 프로퍼티 8)로 옮기는 자리(I-34.md §1-3).
 *
 * ⭐ 형제 뷰와 달리 `omitEmpty` 를 쓰지 않는다 — 계약 8칸이 «전건» 언제나 값을 갖는다
 * (널 가능 칸 0개). `uploadedBy` 도 계약은 `[integer,null]` 로 적었지만 물리
 * `uploaded_by` 가 `NOT NULL FK` 라 언제나 값이 있다. `storageKey`·`checksumSha256`
 * 은 계약에 없는 칸이라 애초에 담지 않는다 — 외부 저장소 키를 새지 않는다(§3).
 */
export function attachmentView(row: AttachmentRow) {
  return {
    attachmentId: Number(row.attachment_id),
    targetTypeCode: row.target_type_code,
    targetId: Number(row.target_id),
    fileName: row.file_name,
    contentType: row.mime_type,
    byteSize: Number(row.file_size),
    uploadedAt: row.uploaded_at.toISOString(),
    uploadedBy: Number(row.uploaded_by),
  };
}
