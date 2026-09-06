import { Controller, Get, NotFoundException, Param, ParseIntPipe, Query } from '@nestjs/common';

import { Contract } from '../../common/contract';
import { PagedResponse } from '../../common/pagination';
import { AsnQuery, AsnQueryService } from './asn-query.service';
import { AsnDetail, AsnLineView, AsnView } from './asn-view';

/** ASN 조회 3건. ERP 수신본이라 등록·수정·삭제가 없다(계약 `x-internal-note`). */
@Controller('logistics/asns')
export class AsnController {
  constructor(private readonly queries: AsnQueryService) {}

  @Get()
  @Contract('GET /logistics/asns')
  list(@Query() query: AsnQuery): Promise<PagedResponse<AsnView>> {
    return this.queries.list(query);
  }

  @Get(':asnId')
  @Contract('GET /logistics/asns/{asnId}')
  async get(@Param('asnId', ParseIntPipe) asnId: number): Promise<AsnDetail> {
    const detail = await this.queries.get(asnId);
    if (!detail) throw new NotFoundException('없는 ASN 입니다.');
    return detail;
  }

  @Get(':asnId/lines')
  @Contract('GET /logistics/asns/{asnId}/lines')
  async lines(@Param('asnId', ParseIntPipe) asnId: number): Promise<{ items: AsnLineView[] }> {
    return { items: await this.queries.lines(asnId) };
  }
}
