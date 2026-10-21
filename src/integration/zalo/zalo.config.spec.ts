import { ConfigService } from '@nestjs/config';

import { zaloConfig } from './zalo.config';

const configOf = (values: Record<string, string>) => new ConfigService(values);

describe('zaloConfig', () => {
  it('기본은 발송 꺼짐·공식 주소다', () => {
    expect(zaloConfig(configOf({}))).toEqual({
      deliveryEnabled: false,
      apiBaseUrl: 'https://business.openapi.zalo.me',
      oauthBaseUrl: 'https://oauth.zaloapp.com',
      credentialKey: '',
    });
  });

  it('발송을 켰는데 암호화 키가 비면 기동에서 던진다', () => {
    expect(() => zaloConfig(configOf({ ZALO_DELIVERY_ENABLED: 'true' }))).toThrow(/ZALO_CREDENTIAL_KEY/);
  });

  it('주소 끝의 / 를 지운다', () => {
    expect(zaloConfig(configOf({ ZALO_API_BASE_URL: 'http://127.0.0.1:3990/' })).apiBaseUrl).toBe('http://127.0.0.1:3990');
  });
});
