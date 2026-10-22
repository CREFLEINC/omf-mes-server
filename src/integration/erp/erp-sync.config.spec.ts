import { ConfigService } from '@nestjs/config';

import { erpSyncConfig } from './erp-sync.config';

const FULL = {
  ERP_SYNC_ENABLED: 'true',
  ERP_DB_HOST: '192.168.1.2',
  ERP_DB_USER: 'mes-system',
  ERP_DB_PASSWORD: 'secret',
  ERP_DB_NAME: 'sample_mes',
};

const config = (values: Record<string, string>): ConfigService =>
  new ConfigService(values) as ConfigService;

describe('erpSyncConfig', () => {
  it('기본은 꺼짐이고, 꺼져 있으면 접속 정보가 없어도 된다', () => {
    expect(erpSyncConfig(config({})).enabled).toBe(false);
    expect(erpSyncConfig(config({})).sendEnabled).toBe(false);
  });

  it('보내기는 받기와 따로 켠다', () => {
    expect(erpSyncConfig(config(FULL))).toMatchObject({ enabled: true, sendEnabled: false });
    expect(
      erpSyncConfig(config({ ...FULL, ERP_SYNC_ENABLED: 'false', ERP_SEND_ENABLED: 'true' })),
    ).toMatchObject({ enabled: false, sendEnabled: true });
  });

  it('보내기만 켜도 접속 정보가 비면 부팅에서 실패한다', () => {
    expect(() =>
      erpSyncConfig(config({ ...FULL, ERP_SYNC_ENABLED: 'false', ERP_SEND_ENABLED: 'true', ERP_DB_HOST: '' })),
    ).toThrow('ERP_SEND_ENABLED=true 인데 ERP_DB_HOST 이 비어 있다');
  });

  it.each(['ERP_DB_HOST', 'ERP_DB_USER', 'ERP_DB_PASSWORD', 'ERP_DB_NAME'])(
    '켜져 있는데 %s 이 비면 부팅에서 실패한다',
    (name) => {
      expect(() => erpSyncConfig(config({ ...FULL, [name]: ' ' }))).toThrow(name);
    },
  );

  it('포트·암호화·주기의 기본값', () => {
    const settings = erpSyncConfig(config(FULL));

    expect(settings.relay).toMatchObject({ port: 1433, encrypt: true });
    expect(settings.masterIntervalMs).toBe(43_200_000);
    expect(settings.orderIntervalMs).toBe(900_000);
  });

  it('ERP_DB_ENCRYPT=false 일 때만 암호화를 끈다', () => {
    expect(erpSyncConfig(config({ ...FULL, ERP_DB_ENCRYPT: 'false' })).relay.encrypt).toBe(false);
    expect(erpSyncConfig(config({ ...FULL, ERP_DB_ENCRYPT: 'no' })).relay.encrypt).toBe(true);
  });
});
