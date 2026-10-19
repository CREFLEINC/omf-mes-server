import { ConfigService } from '@nestjs/config';

import { RelayConfig } from './relay-client';

export interface ErpSyncConfig {
  enabled: boolean;
  relay: RelayConfig;
  masterIntervalMs: number;
}

/** 기준정보(공통코드·사원·품목·거래처·BOM)는 하루 두 번이면 된다 — 게이트웨이 기본값과 같다. */
const MASTER_INTERVAL_SEC = 43_200;

/**
 * ⛔ 켜져 있는데 접속 정보가 비면 부팅에서 죽는다. 조용히 뜨면 ERP 기준정보가 안 들어오는
 * 것을 화면에서 한참 뒤에야 알게 된다.
 * 한국 개발 서버는 현장 중계 DB(192.168.1.2)에 닿지 않는다 — 기본은 꺼짐이다.
 */
export function erpSyncConfig(config: ConfigService): ErpSyncConfig {
  const enabled = config.get<string>('ERP_SYNC_ENABLED') === 'true';
  const value = (name: string): string => {
    const found = config.get<string>(name)?.trim() ?? '';
    if (enabled && found === '') {
      throw new Error(`ERP_SYNC_ENABLED=true 인데 ${name} 이 비어 있다 (.env.prod.example 참조)`);
    }
    return found;
  };
  return {
    enabled,
    relay: {
      host: value('ERP_DB_HOST'),
      port: Number(config.get('ERP_DB_PORT')) || 1433,
      user: value('ERP_DB_USER'),
      password: value('ERP_DB_PASSWORD'),
      database: value('ERP_DB_NAME'),
      encrypt: config.get<string>('ERP_DB_ENCRYPT') !== 'false',
    },
    masterIntervalMs:
      (Number(config.get('ERP_SYNC_MASTER_INTERVAL_SEC')) || MASTER_INTERVAL_SEC) * 1000,
  };
}
