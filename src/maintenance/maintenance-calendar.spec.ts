import { execFileSync } from 'node:child_process';

import { maintenanceDateRange } from './maintenance-calendar';

const DAY_MS = 86_400_000;

describe('maintenanceDateRange', () => {
  it.each([
    ['UTC', '2026-09-07', '2026-09-07T00:00:00.000Z', '2026-09-08T00:00:00.000Z', 24],
    ['Asia/Ho_Chi_Minh', '2026-09-07', '2026-09-06T17:00:00.000Z', '2026-09-07T17:00:00.000Z', 24],
    ['America/New_York', '2026-03-08', '2026-03-08T05:00:00.000Z', '2026-03-09T04:00:00.000Z', 23],
    ['America/New_York', '2026-11-01', '2026-11-01T04:00:00.000Z', '2026-11-02T05:00:00.000Z', 25],
    [
      'Australia/Lord_Howe',
      '2026-10-04',
      '2026-10-03T13:30:00.000Z',
      '2026-10-04T13:00:00.000Z',
      23.5,
    ],
    [
      'Australia/Lord_Howe',
      '2026-04-05',
      '2026-04-04T13:00:00.000Z',
      '2026-04-05T13:30:00.000Z',
      24.5,
    ],
    ['Asia/Kathmandu', '2026-09-07', '2026-09-06T18:15:00.000Z', '2026-09-07T18:15:00.000Z', 24],
    ['UTC', '2026-01-31', '2026-01-31T00:00:00.000Z', '2026-02-01T00:00:00.000Z', 24],
    ['UTC', '2026-12-31', '2026-12-31T00:00:00.000Z', '2027-01-01T00:00:00.000Z', 24],
    ['UTC', '2024-02-28', '2024-02-28T00:00:00.000Z', '2024-02-29T00:00:00.000Z', 24],
    ['UTC', '2024-02-29', '2024-02-29T00:00:00.000Z', '2024-03-01T00:00:00.000Z', 24],
    ['UTC', '2100-02-28', '2100-02-28T00:00:00.000Z', '2100-03-01T00:00:00.000Z', 24],
    ['UTC', '0099-12-31', '0099-12-31T00:00:00.000Z', '0100-01-01T00:00:00.000Z', 24],
    ['UTC', '0000-01-01', '0000-01-01T00:00:00.000Z', '0000-01-02T00:00:00.000Z', 24],
    ['UTC', '9999-12-31', '9999-12-31T00:00:00.000Z', '+010000-01-01T00:00:00.000Z', 24],
    ['America/Sao_Paulo', '2018-11-04', '2018-11-04T03:00:00.000Z', '2018-11-05T02:00:00.000Z', 23],
    ['America/Havana', '2020-11-01', '2020-11-01T04:00:00.000Z', '2020-11-02T05:00:00.000Z', 25],
  ])('%s의 %s를 양끝 포함 달력일로 역변환한다', (zone, date, from, to, hours) => {
    const range = maintenanceDateRange(String(date), String(date), String(zone));
    expect(range).toEqual({ gte: new Date(from), lt: new Date(to) });
    expect(Number(range.lt) - Number(range.gte)).toBe(Number(hours) * 3_600_000);
  });

  it('초 단위 오프셋이 바뀐 자정 생략일의 첫 유효 순간을 찾는다', () => {
    expect(maintenanceDateRange('1972-01-07', '1972-01-07', 'Africa/Monrovia')).toEqual({
      gte: new Date('1972-01-07T00:44:30.000Z'),
      lt: new Date('1972-01-08T00:00:00.000Z'),
    });
  });

  it('From 정각 포함·To 익일 정각 제외로 마지막 소수초를 보존한다', () => {
    const { gte, lt } = maintenanceDateRange('2026-09-07', '2026-09-08', 'Asia/Ho_Chi_Minh');
    const included = [
      '2026-09-06T16:59:59.999Z',
      '2026-09-06T17:00:00.000Z',
      '2026-09-08T16:59:59.999Z',
      '2026-09-08T17:00:00.000Z',
    ].filter(
      (value) => Number(new Date(value)) >= Number(gte) && Number(new Date(value)) < Number(lt),
    );
    expect(included).toEqual(['2026-09-06T17:00:00.000Z', '2026-09-08T16:59:59.999Z']);
  });

  it.each(['2026-09-07', '2026-09-06'])('역전 To=%s는 빈집합이 되는 경계를 그대로 낸다', (to) => {
    const { gte, lt } = maintenanceDateRange('2026-09-08', to, 'UTC');
    expect(gte).toEqual(new Date('2026-09-08T00:00:00.000Z'));
    expect(Number(gte)).toBeGreaterThanOrEqual(Number(lt));
    expect(lt).toEqual(
      new Date(to === '2026-09-07' ? '2026-09-08T00:00:00Z' : '2026-09-07T00:00:00Z'),
    );
  });

  it('한쪽 기간만 있으면 그 경계만 반환한다', () => {
    expect(maintenanceDateRange('2026-09-07', undefined, 'UTC')).toEqual({
      gte: new Date('2026-09-07T00:00:00.000Z'),
    });
    expect(maintenanceDateRange(undefined, '2026-09-07', 'UTC')).toEqual({
      lt: new Date('2026-09-08T00:00:00.000Z'),
    });
  });

  it('기간이 전혀 없으면 timezone을 평가하지 않는다', () => {
    const format = jest.spyOn(Intl, 'DateTimeFormat');
    try {
      expect(maintenanceDateRange(undefined, undefined, 'Invalid/Zone')).toEqual({});
      expect(format).not.toHaveBeenCalled();
    } finally {
      format.mockRestore();
    }
  });

  it.each([
    ['2011-12-30', undefined],
    [undefined, '2011-12-30'],
    ['2011-12-29', '2011-12-30'],
    ['2011-12-29', '2011-12-29'],
  ])('Apia에서 From=%s·To=%s의 사라진 입력일 또는 익일은 오류다', (from, to) => {
    expect(() => maintenanceDateRange(from, to, 'Pacific/Apia')).toThrow('date does not exist');
  });

  it('Apia 전이 다음 존재일은 독립적으로 역변환한다', () => {
    expect(maintenanceDateRange('2011-12-31', '2011-12-31', 'Pacific/Apia')).toEqual({
      gte: new Date('2011-12-30T10:00:00.000Z'),
      lt: new Date('2011-12-31T10:00:00.000Z'),
    });
  });

  it.each([
    ['1988-10-30', undefined],
    [undefined, '1988-10-30'],
  ])('날짜가 두 UTC 구간으로 끊기는 Goose_Bay의 From=%s·To=%s는 오류다', (from, to) => {
    expect(() => maintenanceDateRange(from, to, 'America/Goose_Bay')).toThrow('not one continuous');
  });

  it.each(['Invalid/Zone', ''])('zone %s가 잘못되면 UTC 대체 없이 Error를 전파한다', (zone) => {
    expect(() => maintenanceDateRange('2026-09-07', undefined, zone)).toThrow(Error);
  });

  it.each([
    '2026-02-29',
    '2026-04-31',
    '2026-13-01',
    '2026-00-01',
    '2026-09-00',
    '2026-9-7',
    '',
    '2026-09-07T00:00:00Z',
  ])('잘못된 달력일 %s를 보정하지 않는다', (date) => {
    expect(() => maintenanceDateRange(date, undefined, 'UTC')).toThrow(
      'Invalid maintenance calendar date',
    );
    expect(() => maintenanceDateRange(undefined, date, 'UTC')).toThrow(
      'Invalid maintenance calendar date',
    );
  });

  it('실제 Intl h24의 24시와 h23의 00시를 구분한다', () => {
    const at = new Date('2026-09-07T00:00:00.000Z');
    const h24 = new Intl.DateTimeFormat('en-US', {
      timeZone: 'UTC',
      hour: '2-digit',
      hourCycle: 'h24',
    });
    const h23 = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'UTC',
      hour: '2-digit',
      hourCycle: 'h23',
    });
    expect(h24.formatToParts(at).find((part) => part.type === 'hour')?.value).toBe('24');
    expect(h23.resolvedOptions().hourCycle).toBe('h23');
    expect(h23.formatToParts(at).find((part) => part.type === 'hour')?.value).toBe('00');
    expect(maintenanceDateRange('2026-09-07', undefined, 'UTC').gte).toEqual(at);
  });

  it('요청한 h23과 다른 24시 필드를 받으면 추정하지 않고 거부한다', () => {
    const original = Intl.DateTimeFormat.prototype.formatToParts;
    const format = jest
      .spyOn(Intl.DateTimeFormat.prototype, 'formatToParts')
      .mockImplementation(function (at) {
        return original
          .call(this, at)
          .map((part) => (part.type === 'hour' ? { ...part, value: '24' } : part));
      });
    try {
      expect(() => maintenanceDateRange('2026-09-07', undefined, 'UTC')).toThrow('clock fields');
    } finally {
      format.mockRestore();
    }
  });

  it('탐색 창이 보장하는 24시간을 넘는 offset은 거부한다', () => {
    const original = Intl.DateTimeFormat.prototype.formatToParts;
    const format = jest
      .spyOn(Intl.DateTimeFormat.prototype, 'formatToParts')
      .mockImplementation(function (at) {
        return original.call(this, Number(at) + 2 * DAY_MS);
      });
    try {
      expect(() => maintenanceDateRange('2026-09-07', undefined, 'UTC')).toThrow(
        'Unsupported maintenance calendar offset',
      );
    } finally {
      format.mockRestore();
    }
  });

  it('시간 안 복수 전이가 관측되면 확정하지 않는다 — 미관측 상쇄 전이의 부재 증명은 아니다', () => {
    const original = Intl.DateTimeFormat.prototype.formatToParts;
    const first = Date.parse('2026-09-07T00:10:00.000Z');
    const second = Date.parse('2026-09-07T00:40:00.000Z');
    const format = jest
      .spyOn(Intl.DateTimeFormat.prototype, 'formatToParts')
      .mockImplementation(function (at) {
        const time = Number(at);
        const offset = time < first ? 0 : time < second ? 1_800_000 : 3_600_000;
        return original.call(this, time + offset);
      });
    try {
      expect(() => maintenanceDateRange('2026-09-07', undefined, 'UTC')).toThrow(
        'Cannot resolve maintenance calendar transition',
      );
    } finally {
      format.mockRestore();
    }
  });

  it.each([
    ['UTC', 0],
    ['Asia/Seoul', -540],
    ['America/New_York', 240],
  ])('서버 TZ=%s인 별도 프로세스에서도 공장 경계는 같다', (timezone, offset) => {
    const modulePath = JSON.stringify(require.resolve('./maintenance-calendar'));
    const script = `
      const { maintenanceDateRange } = require(${modulePath});
      console.log(JSON.stringify({
        offset: new Date('2026-09-07T00:00:00.000Z').getTimezoneOffset(),
        range: maintenanceDateRange('2026-09-07', '2026-09-07', 'Asia/Ho_Chi_Minh'),
      }));
    `;
    const output = execFileSync(
      process.execPath,
      ['-r', 'ts-node/register/transpile-only', '-e', script],
      {
        env: { ...process.env, TZ: String(timezone) },
        encoding: 'utf8',
        timeout: 10_000,
      },
    );
    expect(JSON.parse(output)).toEqual({
      offset,
      range: { gte: '2026-09-06T17:00:00.000Z', lt: '2026-09-07T17:00:00.000Z' },
    });
  });
});
