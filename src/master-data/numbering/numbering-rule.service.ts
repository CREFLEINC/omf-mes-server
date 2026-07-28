import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { numbering_counter, numbering_rule, plant, Prisma } from '@prisma/client';

import { PageDto } from '../../common/dto/page.dto';
import { PrismaService } from '../../prisma/prisma.service';
import { CodeValidatorService } from '../common-code/code-validator.service';
import {
  baseWhere,
  createStamp,
  exactlyOne,
  orConflict,
  orFail,
  updateStamp,
} from '../common/master-crud';
import {
  CreateNumberingRuleDto,
  NumberingRuleQueryDto,
  NUMBERING_TOKENS,
  NUMBERING_TOKEN_PATTERN,
  UpdateNumberingRuleDto,
} from './numbering-rule.dto';

const SEQ_TOKEN = /^SEQ(\d+)$/;
const MAX_SEQ_WIDTH = 12;

@Injectable()
export class NumberingRuleService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly codes: CodeValidatorService,
  ) {}

  async create(dto: CreateNumberingRuleDto, actor?: bigint): Promise<numbering_rule> {
    await this.codes.assertAllValid([
      ['DOCUMENT_TYPE', dto.documentTypeCode],
      ['RESET_CYCLE', dto.resetCycleCode],
    ]);
    this.assertPattern(dto.pattern);

    const plant = dto.plantCode ? await this.getPlant(dto.plantCode) : null;
    const plantId = plant?.plant_id ?? null;

    // uq_numbering_rule은 COALESCE(plant_id,0)·COALESCE(lot_type_code,'')를 써서
    // Prisma 모델로 표현되지 않는다 — 앱에서 먼저 확인하고 경합은 DB가 막는다.
    orConflict(
      await this.prisma.numbering_rule.findFirst({
        where: {
          document_type_code: dto.documentTypeCode,
          plant_id: plantId,
          lot_type_code: dto.lotTypeCode ?? null,
        },
      }),
      `같은 문서유형·공장·LOT유형의 채번규칙이 이미 있습니다: ${dto.documentTypeCode}`,
    );

    return this.prisma.numbering_rule.create({
      data: {
        document_type_code: dto.documentTypeCode,
        plant_id: plantId,
        lot_type_code: dto.lotTypeCode ?? null,
        pattern: dto.pattern,
        reset_cycle_code: dto.resetCycleCode ?? 'DAILY',
        is_active: dto.isActive ?? true,
        ...createStamp(actor),
      },
    });
  }

  async findAll(query: NumberingRuleQueryDto): Promise<PageDto<numbering_rule>> {
    const extra: Prisma.numbering_ruleWhereInput = {};
    if (query.documentTypeCode) extra.document_type_code = query.documentTypeCode;
    if (query.plantCode) extra.plant = { plant_code: query.plantCode };

    const where = baseWhere(query, ['pattern'], extra) as Prisma.numbering_ruleWhereInput;

    const [items, total] = await this.prisma.$transaction([
      this.prisma.numbering_rule.findMany({
        where,
        include: { plant: { select: { plant_code: true } } },
        orderBy: [{ document_type_code: 'asc' }, { numbering_rule_id: 'asc' }],
        skip: query.skip,
        take: query.size,
      }),
      this.prisma.numbering_rule.count({ where }),
    ]);
    return new PageDto(items, total, query.page, query.size);
  }

  async findOne(ruleId: bigint) {
    const found = await this.prisma.numbering_rule.findUnique({
      where: { numbering_rule_id: ruleId },
      include: {
        plant: { select: { plant_code: true } },
        numbering_counter: { orderBy: { period_key: 'desc' }, take: 20 },
      },
    });
    return orFail(found, `채번규칙(${ruleId})`);
  }

  async update(
    ruleId: bigint,
    dto: UpdateNumberingRuleDto,
    actor?: bigint,
  ): Promise<numbering_rule> {
    const found = await this.getRule(ruleId);
    await this.codes.assertValid('RESET_CYCLE', dto.resetCycleCode);
    if (dto.pattern) this.assertPattern(dto.pattern);

    // 이미 발번이 시작된 규칙의 패턴·주기를 바꾸면 같은 규칙에서 형식이 다른 번호가 섞인다.
    if (dto.pattern !== undefined || dto.resetCycleCode !== undefined) {
      await this.assertNotIssued(found, '패턴·리셋주기');
    }

    return this.prisma.numbering_rule.update({
      where: { numbering_rule_id: found.numbering_rule_id },
      data: {
        pattern: dto.pattern,
        reset_cycle_code: dto.resetCycleCode,
        is_active: dto.isActive,
        ...updateStamp(actor),
      },
    });
  }

  async deactivate(ruleId: bigint, actor?: bigint): Promise<void> {
    const found = await this.getRule(ruleId);

    await this.prisma.numbering_rule.update({
      where: { numbering_rule_id: found.numbering_rule_id },
      data: { is_active: false, ...updateStamp(actor) },
    });
  }

  /**
   * 카운터는 발번이 쓰는 런타임 상태다 — 조회만 연다.
   * 값을 손으로 고치면 이미 나간 번호와 충돌할 수 있어 수정·삭제는 두지 않는다.
   */
  async findCounters(ruleId: bigint): Promise<numbering_counter[]> {
    const found = await this.getRule(ruleId);
    return this.prisma.numbering_counter.findMany({
      where: { numbering_rule_id: found.numbering_rule_id },
      orderBy: { period_key: 'desc' },
    });
  }

  /** 알 수 없는 토큰은 등록 시점에 잡는다 — 발번이 시작된 뒤엔 잘못된 번호가 이미 찍힌 뒤다. */
  private assertPattern(pattern: string): void {
    const tokens = [...pattern.matchAll(NUMBERING_TOKEN_PATTERN)].map((match) => match[1]);
    const seqTokens = tokens.filter((token) => SEQ_TOKEN.test(token));

    if (seqTokens.length !== 1) {
      throw new BadRequestException(
        `일련번호 토큰은 정확히 1개여야 합니다. 발견: ${seqTokens.length}개`,
      );
    }

    const width = Number(SEQ_TOKEN.exec(seqTokens[0])?.[1]);
    if (width < 1 || width > MAX_SEQ_WIDTH) {
      throw new BadRequestException(
        `일련번호 자리수는 1~${MAX_SEQ_WIDTH} 사이여야 합니다: {${seqTokens[0]}}`,
      );
    }

    const unknown = tokens.filter(
      (token) => !SEQ_TOKEN.test(token) && !NUMBERING_TOKENS.includes(token as never),
    );
    if (unknown.length > 0) {
      throw new BadRequestException(
        `알 수 없는 패턴 토큰입니다: ${unknown.map((t) => `{${t}}`).join(', ')} ` +
          `(사용 가능: ${NUMBERING_TOKENS.map((t) => `{${t}}`).join(', ')}, {SEQ<자리수>})`,
      );
    }
  }

  private async assertNotIssued(found: numbering_rule, what: string): Promise<void> {
    const counters = await this.prisma.numbering_counter.count({
      where: { numbering_rule_id: found.numbering_rule_id },
    });
    if (counters > 0) {
      throw new ConflictException(
        `이미 발번이 시작된 규칙의 ${what}는 바꿀 수 없습니다 (카운터 ${counters}건). ` +
          `기존 규칙을 비활성화하고 새 규칙을 만드십시오.`,
      );
    }
  }

  private async getRule(ruleId: bigint): Promise<numbering_rule> {
    return orFail(
      await this.prisma.numbering_rule.findUnique({ where: { numbering_rule_id: ruleId } }),
      `채번규칙(${ruleId})`,
    );
  }

  private async getPlant(plantCode: string): Promise<plant> {
    const rows = await this.prisma.plant.findMany({ where: { plant_code: plantCode }, take: 2 });
    return exactlyOne(rows, '공장', plantCode);
  }
}
