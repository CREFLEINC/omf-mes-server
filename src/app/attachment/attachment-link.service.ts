import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE, field } from '../../common/errors';
import { PrismaService } from '../../prisma/prisma.service';
import { AttachmentView, attachmentView } from './attachment-view';

const REQUEST_TARGET = 'INSPECTION_REQUEST';
const LOT_TARGET = 'LOT';

export interface AttachmentLotLink {
  lotIds: number[];
}

/**
 * 검사 의뢰 첨부를 자재 관리 LOT 에 나중에 연결한다(omf-all-around#296 · 사용자 지시 2026-11-19).
 *
 * IQC 파일 첨부에서 LOT 을 고르지 않으면 파일은 검사 의뢰(`INSPECTION_REQUEST`)에 붙는다. 그 파일을 고른 LOT 마다의 LOT 첨부로
 * 옮긴다 — 같은 파일(저장 위치·이름·크기·올린 사람·올린 시각)을 가리키는 행을 LOT 마다 만들고 검사 의뢰 행은 지운다.
 * 파일 바이트는 옮기지 않는다(행만 바뀐다 · 첨부 삭제 오퍼레이션이 없어 저장 파일을 지우는 곳도 없다).
 *
 * ⚠ 계약 검증기가 `lotIds` 형식(1개 이상 · 양의 정수)을 먼저 본다 — 여기서는 겹침과 «이 검사 의뢰의 LOT 인가»를 본다.
 */
@Injectable()
export class AttachmentLinkService {
  constructor(private readonly prisma: PrismaService) {}

  /** 존재 확인은 트랜잭션 밖(404) — 계약이 404 를 선언했다. 옮기기는 멱등 트랜잭션 안에서. */
  async assertExists(attachmentId: number): Promise<void> {
    const row = await this.prisma.attachment.findUnique({
      where: { attachment_id: BigInt(attachmentId) },
      select: { attachment_id: true },
    });
    if (!row) throw new NotFoundException('없는 첨부입니다.');
  }

  async linkLots(
    tx: Prisma.TransactionClient,
    attachmentId: number,
    body: AttachmentLotLink,
  ): Promise<{ items: AttachmentView[] }> {
    const source = await tx.attachment.findUnique({ where: { attachment_id: BigInt(attachmentId) } });
    if (!source) throw new NotFoundException('없는 첨부입니다.');
    if (source.target_type_code !== REQUEST_TARGET) {
      throw new ContractException(HttpStatus.BAD_REQUEST, [
        field('attachmentId', ERROR_CODE.INVALID, 'LOT 이 연결되지 않은 검사 의뢰 첨부만 LOT 에 연결할 수 있습니다.'),
      ]);
    }
    const request = await tx.inspection_request.findUnique({
      where: { inspection_request_id: source.target_id },
      select: { inbound_lot_id: true, confirmed_at: true },
    });
    /* 파일 첨부·LOT 연결은 판정 확정 전(작성 중·대기)에만(사용자 지시 2026-11-19) — 확정 뒤 LOT 첨부가 바뀌지 않게. */
    if (request?.confirmed_at != null) {
      throw new ContractException(HttpStatus.BAD_REQUEST, [
        field('attachmentId', ERROR_CODE.INVALID, '판정이 확정된 검사 의뢰입니다. 판정 수정 뒤 연결하세요.'),
      ]);
    }
    const lotIds = body.lotIds.map((id) => BigInt(id));
    if (new Set(body.lotIds).size !== body.lotIds.length) {
      throw new ContractException(HttpStatus.BAD_REQUEST, [field('lotIds', ERROR_CODE.INVALID, '같은 LOT 이 두 번 들어 있습니다.')]);
    }
    const owned = request?.inbound_lot_id == null ? 0 : await tx.lot.count({
      where: { lot_id: { in: lotIds }, inbound_lot_id: request.inbound_lot_id },
    });
    if (owned !== lotIds.length) {
      throw new ContractException(HttpStatus.BAD_REQUEST, [
        field('lotIds', ERROR_CODE.INVALID, '이 검사 의뢰의 자재 관리 LOT 만 연결할 수 있습니다.'),
      ]);
    }

    const created: AttachmentView[] = [];
    for (const lotId of lotIds) {
      created.push(attachmentView(await tx.attachment.create({ data: {
        target_type_code: LOT_TARGET,
        target_id: lotId,
        file_name: source.file_name,
        storage_key: source.storage_key,
        mime_type: source.mime_type,
        file_size: source.file_size,
        checksum_sha256: source.checksum_sha256,
        uploaded_by: source.uploaded_by,
        uploaded_worker_id: source.uploaded_worker_id,
        uploaded_at: source.uploaded_at,
      } })));
    }
    await tx.attachment.delete({ where: { attachment_id: source.attachment_id } });
    return { items: created };
  }
}
