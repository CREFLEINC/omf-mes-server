import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE, ErrorItem, field } from '../../common/errors';
import { assertUpdated } from '../../common/optimistic-lock';
import { SecretBox } from '../../core/crypto/secret-box';
import { NOTIFICATION_EVENTS } from '../../core/notification';
import { PrismaService } from '../../prisma/prisma.service';

type Tx = Prisma.TransactionClient;

export const ZALO_CONNECTION_ID = 1;
/** 연결 정보 암호화 상자 — 키(env)가 없으면 `null` 이고, 비밀값을 받는 저장은 400 이다. */
export const ZALO_SECRET_BOX = Symbol('ZALO_SECRET_BOX');
/** 서버 env `ZALO_DELIVERY_ENABLED` — 화면이 「서버 발송 꺼짐」을 보인다(읽기 전용). */
export const ZALO_DELIVERY_ENABLED = Symbol('ZALO_DELIVERY_ENABLED');

const DEFAULT_PARAM_MAX_LENGTH = 100;

export interface ZaloConnectionView {
  appId: string | null;
  secretKeySet: boolean;
  refreshTokenSet: boolean;
  status: string;
  accessTokenExpiresAt: string | null;
  lastRefreshedAt: string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  paramMaxLength: number;
  templates: { eventCode: string; templateId: string | null }[];
  deliveryEnabled: boolean;
}

export interface ZaloConnectionReplace {
  appId: string | null;
  /** 보낼 때만 교체한다. 생략 = 유지. */
  secretKey?: string;
  /** 보낼 때만 교체한다 — 교체하면 접속 토큰을 비우고 다음 tick 에 갱신한다. */
  refreshToken?: string;
  paramMaxLength: number;
  templates: { eventCode: string; templateId: string | null }[];
}

type ConnectionRow = Prisma.zalo_connectionGetPayload<object>;

/**
 * Zalo 연결 정보(W-CO-12 · 장부 P-95). ⛔ 비밀값 원문은 응답·감사·로그 어디에도 싣지 않는다(FR-028).
 * 시스템에 1행(id=1)이다 — 행이 없으면 미설정으로 읽고 GET 은 행을 만들지 않는다.
 */
@Injectable()
export class ZaloConnectionService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(ZALO_SECRET_BOX) private readonly box: SecretBox | null,
    @Inject(ZALO_DELIVERY_ENABLED) private readonly deliveryEnabled: boolean,
  ) {}

  async get(): Promise<{ connection: ZaloConnectionView; versionNo: number }> {
    const [row, templates] = await Promise.all([
      this.prisma.zalo_connection.findUnique({ where: { zalo_connection_id: ZALO_CONNECTION_ID } }),
      this.prisma.zalo_template.findMany(),
    ]);
    return { connection: this.view(row, templates), versionNo: row?.version_no ?? 1 };
  }

  async replaceWithin(
    tx: Tx,
    expectedVersion: number,
    input: ZaloConnectionReplace,
    actorId?: number,
  ): Promise<{ connection: ZaloConnectionView; versionNo: number }> {
    assertInput(input);
    await tx.$executeRaw`
      INSERT INTO app.zalo_connection (zalo_connection_id) VALUES (${ZALO_CONNECTION_ID})
      ON CONFLICT (zalo_connection_id) DO NOTHING`;
    const [current] = await tx.$queryRaw<ConnectionRow[]>`
      SELECT * FROM app.zalo_connection WHERE zalo_connection_id = ${ZALO_CONNECTION_ID} FOR UPDATE`;
    assertUpdated(current.version_no === expectedVersion ? 1 : 0);

    const appId = input.appId?.trim() || null;
    const changed = changedFields(current, input, appId);
    const secretKeyEnc = input.secretKey === undefined ? current.secret_key_enc : this.seal(input.secretKey);
    const refreshTokenEnc = input.refreshToken === undefined ? current.refresh_token_enc : this.seal(input.refreshToken);
    const credentialsChanged = changed.some((name) => CREDENTIAL_FIELDS.includes(name));

    const saved = await tx.zalo_connection.update({
      where: { zalo_connection_id: ZALO_CONNECTION_ID },
      data: {
        app_id: appId,
        secret_key_enc: secretKeyEnc,
        refresh_token_enc: refreshTokenEnc,
        // 갱신 토큰을 바꾸면 이전 접속 토큰은 쓸 수 없다 — 러너가 다음 tick 에 새로 받는다.
        ...(input.refreshToken === undefined ? {} : { access_token_enc: null, access_token_expires_at: null }),
        status_code: nextStatus(current.status_code, appId !== null && secretKeyEnc !== null && refreshTokenEnc !== null, credentialsChanged),
        ...(credentialsChanged ? { last_error_code: null, last_error_message: null } : {}),
        param_max_length: input.paramMaxLength,
        version_no: { increment: 1 },
        updated_at: new Date(),
        updated_by: actorId ?? null,
      },
    });
    for (const template of input.templates) {
      const templateId = template.templateId?.trim() || null;
      if (templateId === null) {
        await tx.zalo_template.deleteMany({ where: { event_type_code: template.eventCode } });
      } else {
        await tx.zalo_template.upsert({
          where: { event_type_code: template.eventCode },
          create: { event_type_code: template.eventCode, template_id: templateId, updated_by: actorId ?? null },
          update: { template_id: templateId, updated_at: new Date(), updated_by: actorId ?? null },
        });
      }
    }
    // 감사에는 «어느 칸이 바뀌었는지»만 — 값은 남기지 않는다(contracts §1).
    await tx.audit_event.create({
      data: {
        occurred_at: new Date(),
        target_type_code: 'ZALO_CONNECTION',
        target_id: BigInt(ZALO_CONNECTION_ID),
        event_type_code: 'UPDATED',
        after_value: { changedFields: [...changed, ...(input.templates.length > 0 ? ['templates'] : [])] },
        performed_by: actorId === undefined ? null : BigInt(actorId),
      },
    });
    const templates = await tx.zalo_template.findMany();
    return { connection: this.view(saved, templates), versionNo: saved.version_no };
  }

  private seal(plain: string): string {
    if (this.box === null) {
      throw new ContractException(HttpStatus.BAD_REQUEST, [
        { scope: 'screen', code: ERROR_CODE.INVALID, message: '서버에 암호화 키(ZALO_CREDENTIAL_KEY)가 없어 비밀값을 저장할 수 없습니다.' },
      ]);
    }
    return this.box.seal(plain);
  }

  private view(row: ConnectionRow | null, templates: { event_type_code: string; template_id: string }[]): ZaloConnectionView {
    const byEvent = new Map(templates.map((t) => [t.event_type_code, t.template_id]));
    return {
      appId: row?.app_id ?? null,
      secretKeySet: row?.secret_key_enc != null,
      refreshTokenSet: row?.refresh_token_enc != null,
      status: row?.status_code ?? 'NOT_CONFIGURED',
      accessTokenExpiresAt: row?.access_token_expires_at?.toISOString() ?? null,
      lastRefreshedAt: row?.last_refreshed_at?.toISOString() ?? null,
      lastErrorCode: row?.last_error_code ?? null,
      lastErrorMessage: row?.last_error_message ?? null,
      paramMaxLength: row?.param_max_length ?? DEFAULT_PARAM_MAX_LENGTH,
      templates: NOTIFICATION_EVENTS.map((event) => ({ eventCode: event.eventCode, templateId: byEvent.get(event.eventCode) ?? null })),
      deliveryEnabled: this.deliveryEnabled,
    };
  }
}

const CREDENTIAL_FIELDS = ['appId', 'secretKey', 'refreshToken'];

/**
 * 세 값이 다 있어야 `ACTIVE` 다(data-model §4). 갱신 실패로 `REAUTH_REQUIRED` 가 된 연결은
 * 자격(앱 ID·비밀 키·갱신 토큰)을 새로 넣어야 풀린다 — 템플릿만 고쳐서는 그대로다.
 */
function nextStatus(current: string, complete: boolean, credentialsChanged: boolean): string {
  if (!complete) return 'NOT_CONFIGURED';
  if (current === 'REAUTH_REQUIRED' && !credentialsChanged) return current;
  return 'ACTIVE';
}

function changedFields(current: ConnectionRow, input: ZaloConnectionReplace, appId: string | null): string[] {
  const changed: string[] = [];
  if (appId !== current.app_id) changed.push('appId');
  if (input.secretKey !== undefined) changed.push('secretKey');
  if (input.refreshToken !== undefined) changed.push('refreshToken');
  if (input.paramMaxLength !== current.param_max_length) changed.push('paramMaxLength');
  return changed;
}

/** 계약 가드가 길이·범위를 보지만 «빈 비밀값»과 «모르는 이벤트»는 여기서 막는다. */
function assertInput(input: ZaloConnectionReplace): void {
  const errors: ErrorItem[] = [];
  for (const name of ['secretKey', 'refreshToken'] as const) {
    if (input[name]?.trim() === '') {
      errors.push(field(name, ERROR_CODE.REQUIRED, '빈 값은 저장할 수 없습니다. 바꾸지 않으려면 칸을 보내지 마세요.'));
    }
  }
  const known = new Set(NOTIFICATION_EVENTS.map((event) => event.eventCode));
  const codes = input.templates.map((t) => t.eventCode);
  if (codes.some((code) => !known.has(code)) || new Set(codes).size !== codes.length) {
    errors.push(field('templates', ERROR_CODE.INVALID, '알림 이벤트 목록에 없거나 겹친 이벤트가 있습니다.'));
  }
  if (errors.length > 0) throw new ContractException(HttpStatus.BAD_REQUEST, errors);
}
