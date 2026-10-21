import { Logger } from '@nestjs/common';

import { SecretBox } from '../../core/crypto/secret-box';
import { PrismaService } from '../../prisma/prisma.service';
import { ZaloClient } from './zalo-client';
import { ZALO_CONNECTION_ID } from './zalo-connection.service';

/** 만료 5분 전이면 미리 갱신한다(research R-2). */
export const REFRESH_AHEAD_MS = 5 * 60 * 1000;
/** 대기 건이 없어도 이만큼마다 갱신한다 — 갱신 토큰(3개월)이 쓰이지 않아 만료되지 않게(research R-8). */
export const REFRESH_EVERY_MS = 12 * 60 * 60 * 1000;

export interface ZaloAccess {
  accessToken: string;
}

/**
 * 접속 토큰 관리. ⭐ 갱신 토큰은 한 번만 쓸 수 있고 성공하면 이전 것이 무효가 된다 — 받은 새 토큰을
 * «별도 트랜잭션으로 곧바로» 암호화 저장한다. 저장 전에 죽으면 연결이 끊긴다(research R-2).
 */
export class ZaloTokenService {
  private readonly logger = new Logger(ZaloTokenService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly box: SecretBox,
    private readonly client: Pick<ZaloClient, 'refresh'>,
  ) {}

  /**
   * 쓸 수 있는 접속 토큰. 연결이 `ACTIVE` 가 아니거나 갱신에 실패하면 `null` 이다.
   * `force` 는 `-124` 를 받은 뒤 — 저장된 토큰을 믿지 않고 갱신한다.
   */
  async access(now: Date, force = false): Promise<ZaloAccess | null> {
    const row = await this.prisma.zalo_connection.findUnique({ where: { zalo_connection_id: ZALO_CONNECTION_ID } });
    if (row === null || row.status_code !== 'ACTIVE') return null;
    if (row.app_id === null || row.secret_key_enc === null || row.refresh_token_enc === null) return null;

    const expiresAt = row.access_token_expires_at?.getTime() ?? 0;
    const refreshedAt = row.last_refreshed_at?.getTime() ?? 0;
    const fresh = row.access_token_enc !== null && expiresAt - REFRESH_AHEAD_MS > now.getTime() && now.getTime() - refreshedAt < REFRESH_EVERY_MS;
    if (!force && fresh) return { accessToken: this.box.open(row.access_token_enc as string) };

    const result = await this.client.refresh(row.app_id, this.box.open(row.secret_key_enc), this.box.open(row.refresh_token_enc));
    if (result.ok) {
      // 조건부 갱신 — 그 사이 관리자가 갱신 토큰을 바꿨으면(판이 올랐으면) 덮지 않는다.
      await this.prisma.zalo_connection.updateMany({
        where: { zalo_connection_id: ZALO_CONNECTION_ID, version_no: row.version_no, refresh_token_enc: row.refresh_token_enc },
        data: {
          access_token_enc: this.box.seal(result.accessToken),
          refresh_token_enc: this.box.seal(result.refreshToken),
          access_token_expires_at: new Date(now.getTime() + result.expiresInSec * 1000),
          last_refreshed_at: now,
          last_error_code: null,
          last_error_message: null,
          updated_at: new Date(),
        },
      });
      return { accessToken: result.accessToken };
    }
    // 네트워크·5xx 는 연결 상태를 바꾸지 않는다 — 다음 tick 에 다시 해 본다.
    this.logger.warn(`Zalo 토큰 갱신 실패(${result.code}) — ${result.transient ? '일시 장애' : '재인증 필요'}`);
    await this.prisma.zalo_connection.updateMany({
      where: { zalo_connection_id: ZALO_CONNECTION_ID, version_no: row.version_no },
      data: {
        ...(result.transient ? {} : { status_code: 'REAUTH_REQUIRED' }),
        // -124 로 무효임을 안 접속 토큰은 버린다 — 남겨 두면 갱신이 될 때까지 회차마다 같은 토큰으로 보내고 -124 를 받는다.
        ...(force ? { access_token_enc: null, access_token_expires_at: null } : {}),
        last_error_code: result.code.slice(0, 20),
        last_error_message: result.message || null,
        updated_at: new Date(),
      },
    });
    return null;
  }
}
