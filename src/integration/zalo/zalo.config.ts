import { ConfigService } from '@nestjs/config';

export interface ZaloConfig {
  /** 러너가 실제로 보내는가. 기본 꺼짐 — 개발 서버·e2e 가 고객 번호로 보내지 않게. */
  deliveryEnabled: boolean;
  apiBaseUrl: string;
  oauthBaseUrl: string;
  /** 32바이트 base64. 비어 있으면 비밀값을 저장·복호화할 수 없다. */
  credentialKey: string;
}

/**
 * ⛔ 발송이 켜져 있는데 키가 비면 부팅에서 죽는다 — 조용히 뜨면 대기 건이 쌓이기만 한다(`erpSyncConfig` 와 같은 이유).
 */
export function zaloConfig(config: ConfigService): ZaloConfig {
  const deliveryEnabled = config.get<string>('ZALO_DELIVERY_ENABLED') === 'true';
  const credentialKey = config.get<string>('ZALO_CREDENTIAL_KEY')?.trim() ?? '';
  if (deliveryEnabled && credentialKey === '') {
    throw new Error('ZALO_DELIVERY_ENABLED=true 인데 ZALO_CREDENTIAL_KEY 가 비어 있다 (.env.prod.example 참조)');
  }
  return {
    deliveryEnabled,
    apiBaseUrl: trimSlash(config.get<string>('ZALO_API_BASE_URL') || 'https://business.openapi.zalo.me'),
    oauthBaseUrl: trimSlash(config.get<string>('ZALO_OAUTH_BASE_URL') || 'https://oauth.zaloapp.com'),
    credentialKey,
  };
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, '');
}
