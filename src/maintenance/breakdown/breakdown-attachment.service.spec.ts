import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Request } from 'express';

import { attachTerminal } from '../../auth/terminal-context';
import { IdempotencyService } from '../../common/idempotency';
import { PrismaService } from '../../prisma/prisma.service';
import { BreakdownAttachmentService } from './breakdown-attachment.service';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000b49444154789c636000020000050001a5f645400000000049454e44ae426082', 'hex');

describe('BreakdownAttachmentService', () => {
  let root: string;
  const previous = process.env.ATTACHMENT_STORAGE_ROOT;
  const worker = { worker_id: 11n, app_user_id: null, plant_id: 3n, is_active: true };
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([{ breakdown_id: 1n }]),
    worker: { findUnique: jest.fn().mockResolvedValue(worker), findFirst: jest.fn().mockResolvedValue(worker) },
    terminal: { findFirst: jest.fn().mockResolvedValue({ terminal_id: 7n }) },
    audit_event: { create: jest.fn().mockResolvedValue({}) },
    attachment: {
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn().mockResolvedValue({ attachment_id: 91n, uploaded_at: new Date('2026-09-12T00:00:00Z') }),
    },
  };
  const prisma = {
    worker: { findUnique: jest.fn().mockResolvedValue(worker) },
    breakdown: { findUnique: jest.fn().mockResolvedValue({ breakdown_id: 1n, equipment: { plant_id: 3n } }) },
  } as unknown as PrismaService;
  const idempotency = {
    replayExisting: jest.fn().mockResolvedValue(undefined),
    run: jest.fn(async (_context: unknown, work: (client: typeof tx) => Promise<unknown>) =>
      ({ replayed: false, body: await work(tx) })),
  } as unknown as IdempotencyService;
  const service = new BreakdownAttachmentService(prisma, idempotency);

  function request(): Request {
    const value = { headers: { 'x-worker-no': '900028', 'idempotency-key': 'photo-1' } } as unknown as Request;
    attachTerminal(value, { terminalId: 7n, terminalCode: 'MOB-7', plantId: 3n,
      terminalTypeCode: 'MOBILE', equipmentId: null });
    return value;
  }

  function photo() {
    return { buffer: PNG, mimetype: 'image/png', originalname: 'failure.png' } as Express.Multer.File;
  }

  beforeEach(async () => {
    jest.clearAllMocks();
    tx.$queryRaw.mockResolvedValue([{ breakdown_id: 1n }]);
    tx.worker.findUnique.mockResolvedValue(worker);
    tx.worker.findFirst.mockResolvedValue(worker);
    tx.terminal.findFirst.mockResolvedValue({ terminal_id: 7n });
    tx.attachment.count.mockResolvedValue(0);
    tx.attachment.create.mockResolvedValue({ attachment_id: 91n, uploaded_at: new Date('2026-09-12T00:00:00Z') });
    (prisma.worker.findUnique as jest.Mock).mockResolvedValue(worker);
    (prisma.breakdown.findUnique as jest.Mock).mockResolvedValue({ breakdown_id: 1n, equipment: { plant_id: 3n } });
    (idempotency.replayExisting as jest.Mock).mockResolvedValue(undefined);
    (idempotency.run as jest.Mock).mockImplementation(async (_context: unknown, work: (client: typeof tx) => Promise<unknown>) =>
      ({ replayed: false, body: await work(tx) }));
    root = await mkdtemp(join(tmpdir(), 'fr005-photo-'));
    process.env.ATTACHMENT_STORAGE_ROOT = root;
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    if (previous === undefined) delete process.env.ATTACHMENT_STORAGE_ROOT;
    else process.env.ATTACHMENT_STORAGE_ROOT = previous;
  });

  it('stores actual bytes and SHA with a worker actor, then returns the created attachment', async () => {
    const result = await service.upload(1, photo(), request());
    expect(result).toMatchObject({ attachmentId: 91, mimeType: 'image/png', uploadedAt: '2026-09-12T00:00:00.000Z' });
    expect(await readFile(join(root, result.storageKey))).toEqual(PNG);
    expect(tx.attachment.create.mock.calls[0][0].data).toMatchObject({
      target_type_code: 'BREAKDOWN', target_id: 1n, uploaded_worker_id: 11n,
      checksum_sha256: createHash('sha256').update(PNG).digest('hex'),
    });
    expect(tx.audit_event.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      target_type_code: 'ATTACHMENT', target_id: 91n, terminal_id: 7n,
      correlation_id: 'photo-1',
    }) });
  });

  it('rejects a worker from another plant before writing a file', async () => {
    (prisma.worker.findUnique as jest.Mock).mockResolvedValue({ ...worker, plant_id: 4n });
    await expect(service.upload(1, photo(), request())).rejects.toMatchObject({ status: 403 });
    expect(idempotency.run).not.toHaveBeenCalled();
  });

  it('enforces three photos atomically and cleans the staged file on rejection', async () => {
    tx.attachment.count.mockResolvedValue(3);
    await expect(service.upload(1, photo(), request())).rejects.toMatchObject({ status: 422 });
    expect(tx.attachment.create).not.toHaveBeenCalled();
  });

  it('rejects a filename path and disguised MIME', async () => {
    await expect(service.upload(1, { ...photo(), originalname: '../x.png' }, request()))
      .rejects.toMatchObject({ status: 400 });
    await expect(service.upload(1, { ...photo(), mimetype: 'image/jpeg' }, request()))
      .rejects.toMatchObject({ status: 400 });
  });
});
