import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { numbering_rule } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';

/** 발번 상황. 모르는 축은 생략한다 — 그 축이 지정된 규칙은 후보에서 빠진다. */
export interface NumberingContext {
  plantId?: bigint;
  lotTypeCode?: string;
  /** 발번 기준 시각 — 리셋 주기와 날짜 토큰이 이 값을 본다. 생략 시 지금. */
  on?: Date;
}

/**
 * 스코프 구체성 가중치. 지정된 축이 많을수록 이긴다 — 운영정책 resolver와 같은 방식.
 * 2의 거듭제곱이라 축 조합마다 합이 유일하다.
 */
const SCOPE_WEIGHT = { plant: 2, lotType: 1 } as const;

/**
 * 리셋 주기 → 카운터를 가르는 키. 주기가 바뀌면 키가 바뀌고 일련번호가 1부터 다시 간다.
 * 'NONE'은 키가 하나뿐이라 영원히 이어진다.
 */
const PERIOD_KEY_LENGTH: Record<string, number> = {
  NONE: 0,
  YEARLY: 4,
  MONTHLY: 6,
  DAILY: 8,
};

/** 공장 시간대를 모를 때. 날짜 토큰이 서버 로케일에 흔들리지 않도록 UTC로 고정한다. */
const FALLBACK_TIME_ZONE = 'UTC';

interface DateParts {
  year: string;
  month: string;
  day: string;
}

/**
 * 업무 번호 발번기.
 *
 * 규칙(numbering_rule)은 관리 화면이 만들고, 실제 번호는 여기서 나온다.
 * LOT·생산실적·입고·출고·검사가 모두 이 한 곳을 쓴다.
 */
@Injectable()
export class NumberingService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 다음 번호 1건. 예: `PR-260728-0001`
   *
   * **같은 번호가 두 번 나오지 않는다** — 카운터 증가를 단일 UPSERT로 원자화해서,
   * 두 단말이 동시에 요청해도 DB가 순서를 세운다. 읽고-더하고-쓰는 방식이면
   * 그 사이에 낀 요청이 같은 값을 가져간다.
   */
  async issue(documentTypeCode: string, context: NumberingContext = {}): Promise<string> {
    const on = context.on ?? new Date();
    const rule = await this.resolveRule(documentTypeCode, context);

    const plant = await this.resolvePlant(rule, context);
    const parts = this.dateParts(on, plant?.timezone_code ?? FALLBACK_TIME_ZONE);
    const sequence = await this.nextSequence(rule, parts);

    return this.render(rule, parts, sequence, context, plant?.plant_code ?? '');
  }

  /**
   * 상황에 맞는 규칙 1건. 공장·LOT유형이 지정된 규칙이 전역 규칙을 이긴다.
   *
   * 축이 null인 규칙은 그 축에 대해 '전역'이라 어떤 값에도 맞는다. 반대로 요청이 축을
   * 주지 않으면 그 축이 지정된 규칙은 후보에서 뺀다 — 맞는지 확인할 수 없는 규칙으로
   * 번호를 뽑으면 안 된다.
   */
  private async resolveRule(
    documentTypeCode: string,
    context: NumberingContext,
  ): Promise<numbering_rule> {
    const candidates = await this.prisma.numbering_rule.findMany({
      where: {
        document_type_code: documentTypeCode,
        is_active: true,
        AND: [
          context.plantId === undefined
            ? { plant_id: null }
            : { OR: [{ plant_id: context.plantId }, { plant_id: null }] },
          context.lotTypeCode === undefined
            ? { lot_type_code: null }
            : { OR: [{ lot_type_code: context.lotTypeCode }, { lot_type_code: null }] },
        ],
      },
    });

    const best = candidates.reduce<numbering_rule | null>((winner, row) => {
      if (!winner) return row;
      return this.specificity(row) > this.specificity(winner) ? row : winner;
    }, null);

    if (!best) {
      throw new NotFoundException(
        `채번규칙이 없습니다: ${documentTypeCode}. 기준정보에서 규칙을 등록하십시오.`,
      );
    }
    return best;
  }

  private specificity(rule: numbering_rule): number {
    return (
      (rule.plant_id === null ? 0 : SCOPE_WEIGHT.plant) +
      (rule.lot_type_code === null ? 0 : SCOPE_WEIGHT.lotType)
    );
  }

  /**
   * 날짜 토큰과 리셋 경계는 **공장 현지 시각**으로 끊는다.
   *
   * 서버가 UTC고 공장이 UTC+7이면, 현지 00:30에 뽑은 번호가 전날 날짜를 달고 나온다.
   * 번호는 한번 나가면 되돌릴 수 없어 시간대를 처음부터 맞춘다.
   */
  private async resolvePlant(
    rule: numbering_rule,
    context: NumberingContext,
  ): Promise<{ plant_code: string; timezone_code: string } | null> {
    const plantId = rule.plant_id ?? context.plantId;
    if (plantId === undefined || plantId === null) return null;

    return this.prisma.plant.findUnique({
      where: { plant_id: plantId },
      select: { plant_code: true, timezone_code: true },
    });
  }

  private dateParts(on: Date, timeZone: string): DateParts {
    // en-CA는 YYYY-MM-DD로 내준다 — 파트를 따로 뽑아 쓰므로 로케일 표기에 의존하지 않는다.
    const formatted = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(on);

    const pick = (type: string) => formatted.find((part) => part.type === type)?.value ?? '';
    return { year: pick('year'), month: pick('month'), day: pick('day') };
  }

  /** 리셋 주기가 자르는 만큼만 남긴 날짜 문자열. 이게 카운터를 가르는 키가 된다. */
  private periodKey(rule: numbering_rule, parts: DateParts): string {
    const length = PERIOD_KEY_LENGTH[rule.reset_cycle_code];
    if (length === undefined) {
      throw new BadRequestException(
        `알 수 없는 채번 리셋주기입니다: ${rule.reset_cycle_code} (규칙 ${rule.numbering_rule_id})`,
      );
    }
    return length === 0 ? 'ALL' : `${parts.year}${parts.month}${parts.day}`.slice(0, length);
  }

  /**
   * 카운터를 1 올리고 그 값을 받는다. INSERT … ON CONFLICT DO UPDATE … RETURNING이라
   * 조회와 증가 사이에 다른 요청이 끼어들 틈이 없다.
   */
  private async nextSequence(rule: numbering_rule, parts: DateParts): Promise<bigint> {
    const periodKey = this.periodKey(rule, parts);

    const rows = await this.prisma.$queryRaw<{ last_value: bigint }[]>`
      INSERT INTO app.numbering_counter (numbering_rule_id, period_key, last_value)
      VALUES (${rule.numbering_rule_id}, ${periodKey}, 1)
      ON CONFLICT (numbering_rule_id, period_key)
      DO UPDATE SET last_value = app.numbering_counter.last_value + 1,
                    updated_at = clock_timestamp()
      RETURNING last_value
    `;
    return rows[0].last_value;
  }

  /**
   * 패턴의 토큰을 실제 값으로 바꾼다. 예: `PR-{YYMMDD}-{SEQ4}` → `PR-260728-0001`
   *
   * **모르는 토큰이 남으면 던진다.** `{PLNAT}` 같은 오타를 그대로 내보내면 업무 번호에
   * 중괄호가 박힌 채 영구히 남는다.
   */
  private render(
    rule: numbering_rule,
    parts: DateParts,
    sequence: bigint,
    context: NumberingContext,
    plantCode: string,
  ): string {
    const shortYear = parts.year.slice(-2);
    const values: Record<string, string> = {
      YYYYMMDD: `${parts.year}${parts.month}${parts.day}`,
      YYMMDD: `${shortYear}${parts.month}${parts.day}`,
      YYYYMM: `${parts.year}${parts.month}`,
      YYMM: `${shortYear}${parts.month}`,
      YYYY: parts.year,
      YY: shortYear,
      PLANT: plantCode,
      LOT_TYPE: context.lotTypeCode ?? '',
    };

    const rendered = rule.pattern.replace(/\{([A-Z_0-9]+)\}/g, (whole, token: string) => {
      const sequenceMatch = /^SEQ(\d*)$/.exec(token);
      if (sequenceMatch) {
        const width = sequenceMatch[1] ? Number(sequenceMatch[1]) : 0;
        return sequence.toString().padStart(width, '0');
      }
      const value = values[token];
      if (value === undefined) {
        throw new BadRequestException(
          `채번 패턴에 알 수 없는 토큰이 있습니다: ${whole} (규칙 ${rule.numbering_rule_id}, 패턴 ${rule.pattern})`,
        );
      }
      return value;
    });

    return rendered;
  }
}
