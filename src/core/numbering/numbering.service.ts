import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';

/**
 * 문서 유형 → 기본 접두어. 규칙이 등재되면 이 표를 안 본다.
 * 없는 유형은 던진다 — 접두어를 지어내지 않는다.
 */
const DEFAULT_PREFIX: Record<string, string> = {
  PURCHASE_ORDER: 'PO',
  GOODS_RECEIPT: 'GR',
  PUTAWAY_TASK: 'PT',
  NOTICE: 'NTC',
  APPROVAL_REQUEST: 'AP',
};

/** 규칙이 없는 문서 유형의 기본 패턴(`plan.md` §0 #3). 접두어만 채워 등재한다. */
const DEFAULT_PATTERN = '-{YYYYMMDD}-{SEQ4}';

/** 값 목록이 없다 — 시드된 유일한 값이 이것이고, 그 밖은 던진다(I-2.md §7-2). */
const DAILY = 'DAILY';

interface RuleRow {
  numbering_rule_id: bigint;
  pattern: string;
  reset_cycle_code: string;
  is_active: boolean;
}

/**
 * 전표 번호 한 자리. 32 전표가 이것만 부른다(`plan-api.md` §5.5 표).
 * ⛔ **Prisma 를 받는다** — 다른 코어와 달리 호출자의 `tx` 로 돌지 않는다.
 */
@Injectable()
export class NumberingService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 전표 번호 한 건. 규칙(`app.numbering_rule`)이 있으면 그 패턴, 없으면 기본 패턴.
   * 같은 (규칙, 기간)에서 둘이 동시에 불러도 값이 겹치지 않는다 — 카운터를 한 문장으로
   * 올린다.
   *
   * ⛔ `tx` 를 받지 않는다 — 안에서 올리면 ① 롤백이 번호를 되돌려 호출자의 재시도가
   *   «같은 번호»를 다시 뽑고 ② 카운터 행 잠금이 전표 커밋까지 가서 같은 (유형·영업일)이
   *   직렬화된다. 대가는 결번인데, 계약이 번호의 연속을 요구하지 않는다(I-2.md R-2).
   *
   * ⛔ **`$transaction` 을 «열기 전»에 부른다** — 열린 트랜잭션 «안»에서 부르면 그 요청이
   *   커넥션을 둘 쥐게 되고, 동시 요청이 풀(기본 `cpu×2+1`)에 이르면 서로를 기다려
   *   `P2024` 로 죽는다. 받은 «문자열»만 트랜잭션에 넘긴다.
   *
   * @param periodDate 리셋 주기 키를 만드는 날짜(`YYYY-MM-DD`). ⛔ 서버가 「오늘」로 다시
   *   잡지 않는다 — 호출자가 이미 가진 날짜를 그대로 준다(입고는 businessDate, P/O 는
   *   orderDate). 공유계약 C-8 「business_date 는 클라이언트가 보낸다」와 같은 이유.
   * @param plantId 공장 지정 규칙이 있으면 그것이 전역 규칙을 이긴다.
   */
  async next(documentTypeCode: string, plantId: bigint | null, periodDate: string): Promise<string> {
    const rule = await this.rule(documentTypeCode, plantId);
    if (rule.reset_cycle_code !== DAILY) {
      throw new Error(
        `채번 리셋 주기를 풀 수 없다: ${documentTypeCode} / ${rule.reset_cycle_code} — ` +
          `값 목록이 없어 ${DAILY} 만 푼다 (공유계약 F-6)`,
      );
    }
    const periodKey = periodDate.replace(/-/g, '');
    const counter = await this.prisma.$queryRaw<{ last_value: bigint }[]>`
      INSERT INTO app.numbering_counter (numbering_rule_id, period_key, last_value)
           VALUES (${rule.numbering_rule_id}, ${periodKey}, 1)
      ON CONFLICT ON CONSTRAINT uq_numbering_counter
        DO UPDATE SET last_value = app.numbering_counter.last_value + 1,
                      updated_at = clock_timestamp()
        RETURNING last_value`;
    return render(rule.pattern, documentTypeCode, periodKey, counter[0].last_value);
  }

  /**
   * ⛔ `is_active` 를 조회 `WHERE` 에 넣지 않는다 — `uq_numbering_rule` 에 그 칸이 없어
   * 비활성 행이 하나 있으면 조회는 실패하고 자동 생성은 유일 충돌로 막혀 그 문서 유형이
   * 영영 번호를 못 받는다(I-2.md R-3). 대신 찾은 행이 비활성이면 던진다.
   */
  private async rule(documentTypeCode: string, plantId: bigint | null): Promise<RuleRow> {
    const found = await this.prisma.numbering_rule.findMany({
      where: {
        document_type_code: documentTypeCode,
        lot_type_code: null,
        OR: [{ plant_id: plantId }, { plant_id: null }],
      },
    });
    // 공장 지정본이 전역본을 이긴다(결재선 선택과 같은 층 규칙).
    const specific = found.filter((row) => row.plant_id !== null);
    const rule = (specific.length > 0 ? specific : found)[0];
    if (rule) {
      if (!rule.is_active) {
        throw new Error(
          `채번 규칙이 비활성이다: ${documentTypeCode} — 되살리거나 지워야 한다 (I-2.md R-3)`,
        );
      }
      return rule;
    }

    // ⛔ `DO NOTHING` 은 충돌 시 `RETURNING` 이 0행이라 재-SELECT 를 부른다. `updated_at`
    //    만 건드려 «항상 한 행을 돌려받는다». `is_active` 를 여기서 되살리지 않는다 —
    //    운영자가 내린 플래그를 켜는 것은 도출이 아니라 상태 쓰기다.
    // ⚠ `uq_numbering_rule` 은 제약이 아니라 **표현식 UNIQUE INDEX** 라 `ON CONSTRAINT`
    //    를 못 쓰고 표현식으로 추론한다(baseline:2595).
    const pattern = prefixOf(documentTypeCode) + DEFAULT_PATTERN;
    const created = await this.prisma.$queryRaw<RuleRow[]>`
      INSERT INTO app.numbering_rule (document_type_code, pattern, reset_cycle_code)
           VALUES (${documentTypeCode}, ${pattern}, ${DAILY})
      ON CONFLICT (document_type_code, COALESCE(plant_id, 0), COALESCE(lot_type_code, ''))
        DO UPDATE SET updated_at = clock_timestamp()
        RETURNING numbering_rule_id, pattern, reset_cycle_code, is_active`;
    return created[0];
  }
}

/**
 * ⛔ **실측한 토큰만** 푼다. 모르는 토큰을 리터럴로 남기지 않는다 — 그러면 `{PLANT}` 가
 * 번호에 그대로 박힌 전표가 생기고 그건 데이터로 남아 되돌리기 비싸다. 던지면 규칙을
 * 넣은 사람이 즉시 안다(공유계약 F-6).
 */
function render(pattern: string, documentTypeCode: string, day: string, value: bigint): string {
  return pattern.replace(/\{([A-Za-z0-9]+)\}/g, (token, name: string) => {
    if (name === 'YYYYMMDD') return day;
    if (name === 'YYMMDD') return day.slice(2);
    // 자리를 넘으면 그대로 늘어난다 — 잘라 내면 번호가 겹친다.
    const seq = /^SEQ(\d+)$/.exec(name);
    if (seq) return String(value).padStart(Number(seq[1]), '0');
    throw new Error(
      `채번 패턴의 토큰을 풀 수 없다: ${token} (${documentTypeCode} / ${pattern}) — ` +
        '푸는 토큰은 {SEQn}·{YYMMDD}·{YYYYMMDD} 뿐이다 (공유계약 F-6)',
    );
  });
}

function prefixOf(documentTypeCode: string): string {
  const prefix = DEFAULT_PREFIX[documentTypeCode];
  if (!prefix) {
    throw new Error(
      `기본 접두어를 모르는 문서 유형이다: ${documentTypeCode} — 채번 규칙을 등재하거나 ` +
        'numbering.service.ts 의 DEFAULT_PREFIX 에 더한다 (지어내지 않는다)',
    );
  }
  return prefix;
}
