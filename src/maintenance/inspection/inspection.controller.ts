import { Controller, Get, Param, Query } from '@nestjs/common';

import { Contract } from '../../common/contract';
import {
  InspectionList,
  InspectionQuery,
  InspectionQueryService,
} from './inspection-query.service';
import { InspectionView } from './inspection-view';

@Controller('maintenance/inspections')
export class InspectionController {
  constructor(private readonly queries: InspectionQueryService) {}

  @Get()
  @Contract('GET /maintenance/inspections')
  list(@Query() query: InspectionQuery): Promise<InspectionList> {
    return this.queries.list(query);
  }

  @Get(':inspectionId')
  @Contract('GET /maintenance/inspections/{inspectionId}')
  get(@Param('inspectionId') inspectionId: number): Promise<InspectionView> {
    return this.queries.get(inspectionId);
  }
}
