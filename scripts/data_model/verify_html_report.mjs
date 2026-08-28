#!/usr/bin/env node
/**
 * 03-data-model-api-map.html 의 상호작용을 실제 Chrome 으로 검사한다.
 *
 * 사람이 눈으로 보고 「PASS」라고 적는 대신 돌려서 확인하려고 만들었다 —
 * 콘솔 오류가 없다는 것만으로 통과로 적었다가 관계도 선택이 망가진 채
 * 배포된 적이 있다(docs/data-model/05-재검토-2026-08-28.md).
 *
 * 합성 이벤트가 아니라 CDP 의 Input 도메인을 쓴다. setPointerCapture 처럼
 * 진짜 포인터에서만 드러나는 문제는 dispatchEvent 로는 재현되지 않는다.
 *
 *   node scripts/data_model/verify_html_report.mjs
 *   node scripts/data_model/verify_html_report.mjs <html 경로>
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];

const PORT = Number(process.env.VERIFY_CDP_PORT || 9333);
const target = resolve(
  process.argv[2] || new URL('../../docs/data-model/03-data-model-api-map.html', import.meta.url).pathname,
);

const chrome = CHROME_CANDIDATES.find((p) => existsSync(p));
if (!chrome) {
  console.error('SKIP: Chrome/Chromium 을 찾지 못했다. 이 검사는 브라우저가 있어야 돈다.');
  process.exit(2);
}
if (!existsSync(target)) {
  console.error(`FAIL: 대상 파일이 없다 — ${target}`);
  process.exit(1);
}

const profile = mkdtempSync(join(tmpdir(), 'omf-report-verify-'));
const proc = spawn(
  chrome,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    '--disable-gpu',
    '--no-first-run',
    '--window-size=1600,1000',
    'about:blank',
  ],
  { stdio: 'ignore' },
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

async function connect() {
  for (let i = 0; i < 40; i += 1) {
    try {
      const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json());
      const page = list.find((t) => t.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      /* 아직 안 떴다 */
    }
    await sleep(250);
  }
  throw new Error('CDP 에 연결하지 못했다');
}

let ws;
try {
  ws = new WebSocket(await connect());
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });

  let id = 0;
  const pending = new Map();
  const errors = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.method === 'Runtime.exceptionThrown') {
      errors.push(m.params.exceptionDetails?.text || 'exception');
    }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      errors.push(m.params.args?.[0]?.value || 'console.error');
    }
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    }
  };
  const send = (method, params = {}) =>
    new Promise((res) => {
      const n = (id += 1);
      pending.set(n, res);
      ws.send(JSON.stringify({ id: n, method, params }));
    });
  const ev = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true });
    return r.result?.result?.value;
  };
  const mouse = (type, x, y) =>
    send('Input.dispatchMouseEvent', {
      type,
      x,
      y,
      button: 'left',
      clickCount: type === 'mouseMoved' ? 0 : 1,
      buttons: type === 'mouseReleased' ? 0 : 1,
    });

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false,
  });
  await send('Page.navigate', { url: pathToFileURL(target).href });
  await sleep(2500);

  console.log(`대상: ${target}\n`);

  const nodeCount = await ev(`document.querySelectorAll('.node[data-table]').length`);
  check('관계도 노드 렌더', nodeCount > 0, `${nodeCount}개`);

  // 노드가 무대의 쓸 만한 크기를 차지하는가 — 배율이 어긋나면 여기서 걸린다
  const box = await ev(`(() => {
    const n = document.querySelector('.node[data-table]');
    const r = n.getBoundingClientRect();
    return { table: n.dataset.table, x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
  })()`);
  check('노드가 클릭 가능한 크기', box.w >= 30 && box.h >= 6,
    `${box.w.toFixed(0)}×${box.h.toFixed(0)}px`);

  // 진짜 클릭 — setPointerCapture 가 click 을 가로채면 여기서 걸린다
  await mouse('mousePressed', box.x, box.y);
  await sleep(60);
  await mouse('mouseReleased', box.x, box.y);
  await sleep(400);
  const selected = await ev(`(() => {
    const n = document.querySelector('.node[data-table]');
    return { picked: n.classList.contains('selected'),
             edges: document.querySelectorAll('.edge.active').length,
             panel: document.getElementById('tableDetail').textContent.trim() };
  })()`);
  check('노드 클릭 → 상세 패널', selected.picked && !selected.panel.startsWith('테이블을 선택하면'),
    `${box.table} · 강조 엣지 ${selected.edges}`);

  // 끌기는 이동만 하고 선택하지 않아야 한다
  await ev(`document.getElementById('resetGraph').click()`);
  await sleep(200);
  const t0 = await ev(`document.querySelector('#graph g').getAttribute('transform')`);
  await mouse('mousePressed', 700, 500);
  for (const d of [10, 40, 90, 150]) {
    await mouse('mouseMoved', 700 + d, 500 + d / 2);
    await sleep(30);
  }
  await mouse('mouseReleased', 850, 575);
  await sleep(250);
  const t1 = await ev(`document.querySelector('#graph g').getAttribute('transform')`);
  const stillEmpty = await ev(
    `document.getElementById('tableDetail').textContent.trim().startsWith('테이블을 선택하면')`,
  );
  check('끌기 → 이동하되 선택 안 됨', t0 !== t1 && stillEmpty, `${t0} → ${t1}`);

  await ev(`document.getElementById('fitGraph').click()`);
  await sleep(200);
  check('Fit 복귀', (await ev(`document.querySelector('#graph g').getAttribute('transform')`)) === t0);

  await send('Input.dispatchMouseEvent', {
    type: 'mouseWheel', x: 700, y: 500, deltaX: 0, deltaY: -120, button: 'none',
  });
  await sleep(200);
  check('휠 확대', (await ev(`document.querySelector('#graph g').getAttribute('transform')`)) !== t0);

  const tab = async (i) => {
    await ev(`document.querySelectorAll('.tab')[${i}].click()`);
    await sleep(400);
  };
  await tab(1);
  check('API 탭', (await ev(`document.querySelectorAll('.api-item').length`)) > 0 &&
    (await ev(`document.getElementById('apiDetail').textContent.length > 50`)),
    `${await ev(`document.querySelectorAll('.api-item').length`)}건`);

  await tab(2);
  const findings = await ev(`document.querySelectorAll('.finding').length`);
  const gaps = await ev(`document.querySelectorAll('#gapRows tr').length`);
  check('재검토 탭', findings > 0 && gaps > 0, `발견 ${findings} · 결손 ${gaps}`);

  const filtered = await ev(`(() => {
    const b = [...document.querySelectorAll('#reviewFilters .pill')].find(x => x.textContent === '유효');
    if (!b) return -1;
    b.click();
    return document.querySelectorAll('.finding').length;
  })()`);
  check('재검토 판정 필터', filtered > 0 && filtered <= findings, `유효 ${filtered}건`);

  await tab(0);
  check('관계도 탭 복귀', (await ev(`document.querySelectorAll('.node[data-table]').length`)) === nodeCount);

  await send('Emulation.setDeviceMetricsOverride', {
    width: 1024, height: 800, deviceScaleFactor: 1, mobile: false,
  });
  await sleep(300);
  check('1024px 반응형', await ev(`getComputedStyle(document.querySelector('.side')).display === 'none'`));

  check('콘솔 오류 없음', errors.length === 0, errors.slice(0, 3).join(' / '));
} catch (err) {
  check('검사 실행', false, String(err?.message || err));
} finally {
  try { ws?.close(); } catch { /* 이미 닫혔다 */ }
  proc.kill();
  // Chrome 이 프로필에 쓰는 중에 지우면 ENOTEMPTY 가 난다. 종료를 기다린 뒤 지운다.
  await new Promise((res) => {
    proc.once('exit', res);
    setTimeout(res, 3000);
  });
  try {
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    /* 임시 디렉터리다 — 못 지워도 검사 결과에 영향이 없다 */
  }
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} PASS`);
process.exit(failed.length ? 1 : 0);
