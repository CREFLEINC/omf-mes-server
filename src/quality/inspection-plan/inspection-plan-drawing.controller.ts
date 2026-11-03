import {
  Controller,
  Delete,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Post,
  Put,
  Req,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request } from 'express';

import { ATTACHMENT_UPLOAD_OPTIONS } from '../../common/attachment-storage';
import { Contract } from '../../common/contract';
import { InspectionPlanDrawingService } from './inspection-plan-drawing.service';

/** 검사기준 버전 도면(omf-all-around#227) — `W-06-02` 버전 상세 「도면」 탭의 추가·바꾸기·빼기. */
@Controller('quality/inspection-plan-versions')
export class InspectionPlanDrawingController {
  constructor(private readonly drawings: InspectionPlanDrawingService) {}

  @Post(':inspectionPlanVersionId/drawings')
  @Contract('POST /quality/inspection-plan-versions/{inspectionPlanVersionId}/drawings')
  @HttpCode(HttpStatus.CREATED)
  @UseInterceptors(FileInterceptor('file', ATTACHMENT_UPLOAD_OPTIONS))
  add(
    @Req() request: Request,
    @Param('inspectionPlanVersionId', ParseIntPipe) versionId: number,
    @UploadedFile() file?: Express.Multer.File,
  ): Promise<unknown> {
    return this.drawings.add(versionId, file, request);
  }

  @Put(':inspectionPlanVersionId/drawings/:attachmentId')
  @Contract('PUT /quality/inspection-plan-versions/{inspectionPlanVersionId}/drawings/{attachmentId}')
  @UseInterceptors(FileInterceptor('file', ATTACHMENT_UPLOAD_OPTIONS))
  replace(
    @Req() request: Request,
    @Param('inspectionPlanVersionId', ParseIntPipe) versionId: number,
    @Param('attachmentId', ParseIntPipe) attachmentId: number,
    @UploadedFile() file?: Express.Multer.File,
  ): Promise<unknown> {
    return this.drawings.replace(versionId, attachmentId, file, request);
  }

  @Delete(':inspectionPlanVersionId/drawings/:attachmentId')
  @Contract('DELETE /quality/inspection-plan-versions/{inspectionPlanVersionId}/drawings/{attachmentId}')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(
    @Req() request: Request,
    @Param('inspectionPlanVersionId', ParseIntPipe) versionId: number,
    @Param('attachmentId', ParseIntPipe) attachmentId: number,
  ): Promise<void> {
    return this.drawings.remove(versionId, attachmentId, request);
  }
}
