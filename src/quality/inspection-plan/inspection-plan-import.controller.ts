import {
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request } from 'express';

import { Contract } from '../../common/contract';
import { ContractException, ERROR_CODE } from '../../common/errors';
import { IdempotencyService } from '../../common/idempotency';
import { runIdempotent } from '../../common/master';
import { InspectionPlanImportService } from './inspection-plan-import.service';

/** 툴 엑셀 올리기와 같은 상한이다 — proxy 의 `client_max_body_size`(12m)보다 작아야 JSON 413 이 난다. */
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/**
 * ⛔ 컬렉션 액션(`/inspection-plans:import`)이라 접두어를 한 단계 위(`quality`)에 둔다 —
 * `@Controller('quality/inspection-plans')` 아래 `\\:import` 는 `inspection-plans/:import` 가 된다(툴과 같은 이유).
 */
@Controller('quality')
export class InspectionPlanImportController {
  constructor(
    private readonly imports: InspectionPlanImportService,
    private readonly idempotency: IdempotencyService,
  ) {}

  /** 파일은 읽고 버린다 — 첨부처럼 보관하지 않는다(툴 엑셀 올리기와 같다). */
  @Post('inspection-plans\\:import')
  @Contract('POST /quality/inspection-plans:import')
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD_BYTES } }))
  upload(@Req() request: Request, @UploadedFile() file?: Express.Multer.File): Promise<unknown> {
    if (file === undefined) {
      throw new ContractException(HttpStatus.BAD_REQUEST, [
        { scope: 'screen', code: ERROR_CODE.REQUIRED, message: '엑셀 파일이 없습니다.' },
      ]);
    }
    return runIdempotent(this.idempotency, request, HttpStatus.OK, () =>
      this.imports.importWorkbook(file.buffer),
    );
  }
}
