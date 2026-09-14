import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';

import { IdempotencyService } from '../src/common/idempotency';
import { PrismaService } from '../src/prisma/prisma.service';
import { DocumentIssueController } from '../src/app/document-issue/document-issue.controller';
import { DocumentIssueQueryService } from '../src/app/document-issue/document-issue-query.service';
import { DocumentIssueSummaryService } from '../src/app/document-issue/document-issue-summary.service';
import { DocumentIssueReportService } from '../src/app/document-issue/document-issue-report.service';
import { DocumentIssueWriteService } from '../src/app/document-issue/document-issue-write.service';
import { DocumentIssueRenditionService } from '../src/app/document-issue/document-issue-rendition.service';

it('sends the rendition as PNG bytes over HTTP', async () => {
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
  const module = await Test.createTestingModule({
    controllers: [DocumentIssueController],
    providers: [
      DocumentIssueQueryService, DocumentIssueSummaryService, DocumentIssueReportService,
      DocumentIssueWriteService, IdempotencyService, JwtService, PrismaService,
      { provide: DocumentIssueRenditionService, useValue: { rendition: jest.fn().mockResolvedValue(png) } },
    ],
  }).overrideProvider(DocumentIssueQueryService).useValue({})
    .overrideProvider(DocumentIssueSummaryService).useValue({})
    .overrideProvider(DocumentIssueReportService).useValue({})
    .overrideProvider(DocumentIssueWriteService).useValue({})
    .overrideProvider(IdempotencyService).useValue({})
    .overrideProvider(JwtService).useValue({})
    .overrideProvider(PrismaService).useValue({})
    .compile();
  const app: INestApplication = module.createNestApplication();
  await app.init();
  try {
    const response = await request(app.getHttpServer())
      .get('/app/document-issues/7/rendition')
      .buffer(true)
      .parse((stream, callback) => {
        const chunks: Buffer[] = [];
        stream.on('data', (chunk: Buffer) => chunks.push(chunk));
        stream.on('end', () => callback(null, Buffer.concat(chunks)));
      })
      .expect(200)
      .expect('Content-Type', /image\/png/);
    expect(response.body).toEqual(png);
  } finally {
    await app.close();
  }
});

it('sends TSPL as command bytes and rejects unsupported PDF without PNG fallback', async () => {
  const tspl = Buffer.from('SIZE 100 mm, 60 mm\r\nCLS\r\nPRINT 1,1\r\n', 'ascii');
  const rendition = { rendition: jest.fn().mockResolvedValue(tspl) };
  const module = await Test.createTestingModule({
    controllers: [DocumentIssueController],
    providers: [
      DocumentIssueQueryService, DocumentIssueSummaryService, DocumentIssueReportService,
      DocumentIssueWriteService, IdempotencyService, JwtService, PrismaService,
      { provide: DocumentIssueRenditionService, useValue: rendition },
    ],
  }).overrideProvider(DocumentIssueQueryService).useValue({})
    .overrideProvider(DocumentIssueSummaryService).useValue({})
    .overrideProvider(DocumentIssueReportService).useValue({})
    .overrideProvider(DocumentIssueWriteService).useValue({})
    .overrideProvider(IdempotencyService).useValue({})
    .overrideProvider(JwtService).useValue({})
    .overrideProvider(PrismaService).useValue({})
    .compile();
  const app: INestApplication = module.createNestApplication();
  await app.init();
  try {
    const response = await request(app.getHttpServer())
      .get('/app/document-issues/7/rendition?format=tspl')
      .buffer(true)
      .parse((stream, callback) => {
        const chunks: Buffer[] = [];
        stream.on('data', (chunk: Buffer) => chunks.push(chunk));
        stream.on('end', () => callback(null, Buffer.concat(chunks)));
      })
      .expect(200)
      .expect('Content-Type', /application\/vnd\.tspl/);
    expect(response.body).toEqual(tspl);
    expect(rendition.rendition).toHaveBeenCalledWith('7', 'tspl');
    await request(app.getHttpServer())
      .get('/app/document-issues/7/rendition?format=pdf').expect(422);
    expect(rendition.rendition).toHaveBeenCalledTimes(1);
  } finally {
    await app.close();
  }
});
