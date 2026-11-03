import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Request } from 'express';

import { InspectionPlanDrawingService, parseDrawingFile } from './inspection-plan-drawing.service';

const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(16)]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);

function upload(buffer: Buffer, originalname = 'drawing.png'): Express.Multer.File {
  return { buffer, originalname, mimetype: 'image/png' } as Express.Multer.File;
}

function request(): Request {
  return { headers: { 'idempotency-key': 'k-1' }, session: { userId: 7, permissions: ['W-06-02'] } } as unknown as Request;
}

const row = {
  attachment_id: 31n, target_type_code: 'INSPECTION_PLAN_VERSION', target_id: 5n, file_name: 'drawing.png',
  mime_type: 'image/png', file_size: 24n, uploaded_at: new Date('2026-11-03T00:00:00Z'), uploaded_by: 7n,
};

function harness(status: string | undefined, drawing: object | null = { attachment_id: 31n }) {
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue(status === undefined ? [] : [{ status_code: status }]),
    attachment: {
      findFirst: jest.fn().mockResolvedValue(drawing),
      create: jest.fn().mockResolvedValue(row),
      update: jest.fn().mockResolvedValue(row),
      delete: jest.fn().mockResolvedValue(row),
    },
  };
  const idempotency = {
    replayExisting: jest.fn().mockResolvedValue(undefined),
    run: jest.fn(async (_context: unknown, work: (t: typeof tx) => Promise<unknown>) => ({ replayed: false, body: await work(tx) })),
  };
  return { tx, service: new InspectionPlanDrawingService(idempotency as never) };
}

jest.mock('../../auth/session-resolver.service', () => ({
  currentSession: (req: { session?: unknown }) => req.session,
}));

describe('검사기준 버전 도면 파일 검사', () => {
  it('PNG·JPEG 는 앞 바이트로 가려 받는다', () => {
    expect(parseDrawingFile(upload(PNG)).mime).toBe('image/png');
    expect(parseDrawingFile(upload(JPEG, '도면.jpg'))).toMatchObject({ mime: 'image/jpeg', fileName: '도면.jpg' });
  });

  it('파일이 없거나 비었거나 그림이 아니면 400 이다', () => {
    expect(() => parseDrawingFile(undefined)).toThrow();
    expect(() => parseDrawingFile(upload(Buffer.alloc(0)))).toThrow();
    expect(() => parseDrawingFile(upload(Buffer.from('%PDF-1.7'), 'a.pdf'))).toThrow();
  });
});

describe('검사기준 버전 도면 추가·바꾸기·빼기', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'drawing-'));
    process.env.ATTACHMENT_STORAGE_ROOT = root;
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('작성중 버전에 도면을 붙이고 올린 사람을 남긴다', async () => {
    const { tx, service } = harness('DRAFT');
    const view = await service.add(5, upload(PNG), request());
    expect(view).toMatchObject({ attachmentId: 31, targetTypeCode: 'INSPECTION_PLAN_VERSION', targetId: 5 });
    expect(tx.attachment.create.mock.calls[0][0].data).toMatchObject({
      target_type_code: 'INSPECTION_PLAN_VERSION', target_id: 5n, mime_type: 'image/png', uploaded_by: 7n,
    });
  });

  it('확정 버전이면 400 STATE_LOCKED 이고 써 둔 파일을 지운다', async () => {
    const { tx, service } = harness('CONFIRMED');
    await expect(service.add(5, upload(PNG), request())).rejects.toMatchObject({ status: 400 });
    expect(tx.attachment.create).not.toHaveBeenCalled();
    expect(readdirSync(join(root, 'inspection_plan_version'), { recursive: true }).filter((f) => String(f).endsWith('.png'))).toEqual([]);
  });

  it('없는 버전이면 404 다', async () => {
    const { service } = harness(undefined);
    await expect(service.add(5, upload(PNG), request())).rejects.toMatchObject({ status: 404 });
  });

  it('바꾸기는 같은 행을 고친다 — 도면 순서(첨부 id)가 그대로다', async () => {
    const { tx, service } = harness('DRAFT');
    await service.replace(5, 31, upload(JPEG, 'b.jpg'), request());
    expect(tx.attachment.update.mock.calls[0][0]).toMatchObject({
      where: { attachment_id: 31n }, data: { file_name: 'b.jpg', mime_type: 'image/jpeg' },
    });
    expect(tx.attachment.create).not.toHaveBeenCalled();
  });

  it('다른 버전의 도면은 바꾸거나 뺄 수 없다(404)', async () => {
    const { tx, service } = harness('DRAFT', null);
    await expect(service.replace(5, 99, upload(PNG), request())).rejects.toMatchObject({ status: 404 });
    await expect(service.remove(5, 99, request())).rejects.toMatchObject({ status: 404 });
    expect(tx.attachment.delete).not.toHaveBeenCalled();
  });

  it('빼기는 작성중 버전에서 행만 지운다', async () => {
    const { tx, service } = harness('DRAFT');
    await service.remove(5, 31, request());
    expect(tx.attachment.delete).toHaveBeenCalledWith({ where: { attachment_id: 31n } });
    const locked = harness('CONFIRMED');
    await expect(locked.service.remove(5, 31, request())).rejects.toMatchObject({ status: 400 });
    expect(locked.tx.attachment.delete).not.toHaveBeenCalled();
  });
});
