import { Module } from '@nestjs/common';

import { InspectionSheetService } from './inspection-sheet.service';

/** Prisma 는 받지 않는다 — 호출자가 연 `tx` 로만 돈다(검사표 입력과 시리얼 OQC 가 자기 기록과 한 번에 쓴다). */
@Module({
  providers: [InspectionSheetService],
  exports: [InspectionSheetService],
})
export class InspectionSheetModule {}
