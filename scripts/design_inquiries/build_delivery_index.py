#!/usr/bin/env python3
"""설계 요청서 176건을 «슬라이스(주제)별»로 묶은 전달 색인을 만든다.

⛔ 레인별로 묶지 않는다. 레인은 «우리» 사정이고 받는 쪽 사정이 아니다 — 레인 C 가 멈춘 뒤
슬라이스가 인계되면서 **같은 주제가 두 대역에 갈렸다**(취급단위 = C 140~145 + A2 몫,
출하지시 = A 190~208, 재생재 = A2 213~216). 레인별로 내면 설계팀이 한 주제를 두 곳에서 본다.

⭐ **묶는 축은 「걸리는 오퍼레이션」의 경로**다 — 요청서가 스스로 적어 둔 사실이라 우리가
새로 판정하지 않는다. 못 읽은 것은 **숨기지 않고 §9 에 남긴다.**

    python3 scripts/design_inquiries/build_delivery_index.py            # 쓴다
    python3 scripts/design_inquiries/build_delivery_index.py --check    # 낡았으면 exit 1
"""
# ⛔ 3.9 에서 `str | None` 이 def 평가 때 터진다(TypeError). 이 한 줄이 주석을 미뤄 3.9 도 돈다 —
#    macOS 기본 파이썬이 아직 3.9.6 이라 「내 노트북에서는 됐다」가 남의 손에서 멈춘다.
from __future__ import annotations

import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / 'docs' / 'design-inquiries'
OUT = SRC / '전달분-색인.md'

SECTIONS = [
    ('1', '자재·창고', '입하 · 적치 · 이동 · 조정 · 실사 · 취급단위 · 재생재'),
    ('2', '생산실행', '작업지시 · 세션 · 실적 · 자재투입 · 공정인계 · LOT 계보'),
    ('3', '품질', '검사 · 보류 · 부적합 · 처분 · 특채'),
    ('4', '제품출하', '출하지시 · 피킹 · 배분 · 출하 · 재입고'),
    ('5', '설비·툴', '고장 · 가동중지 · 보전 · 툴 · 교정'),
    ('6', '공통·기준정보', '결재 · 알림 · 발행 · 권한 · 마스터'),
    ('7', '횡단', '한 도메인에 안 묶이는 것 — 헤더 규약 · 채번 · 코드사전 · 날짜 축'),
]

# 번호 대역 → 레인. 정본은 `coverage-100/lanes.md` §1-1.
BANDS = [('A', 16, 89), ('B', 90, 119), ('C', 120, 149), ('A2', 150, 179),
         ('A', 180, 209), ('A2', 210, 239), ('A', 240, 269), ('B', 270, 299)]

# 「구분」 줄이 없는 옛 요청서(016~119)의 판정 원천. 각 레인이 스스로 정리한 표다.
RECLASSIFIED = ['재정리-2026-09-08-레인A.md', '재정리-2026-09-08-레인C.md']
# B 정산본은 표가 «번호 범위»라 번호마다 못 읽는다 — #342 본문이 셋만 예외로 못 박았다.
B_EXCEPTIONS = {276: '질의', 105: '회신 완료'}


def kind_from_index() -> dict[int, str]:
    """옛 요청서(016~119)는 「구분」 줄이 없다. `README.md` 색인의 «상태» 칸은 번호마다 있고,
    그 README 가 스스로 「대부분 이미 「구현함」이라 실질은 통보다」라 적었다 — 그것을 읽는다."""
    found: dict[int, str] = {}
    for line in (SRC / 'README.md').read_text().splitlines():
        cells = [c.strip() for c in line.split('|')]
        if len(cells) < 4:
            continue
        head = re.fullmatch(r'\**(\d{2,3})\**', cells[1])
        if not head:
            continue
        status = cells[3]
        # 상태 칸에서 「질의」·「통보」를 그냥 찾으면 안 된다 — 30 의 상태가
        # 「**통보** … 「승인 없이 나간 폐기 출고」 **질의** 확보」라 SQL 질의에 걸린다(145 와 같은 뿌리).
        # ⭐ 분류 표식은 «굵게» 쓴다(`**질의(2026-…`). 먼저 나오는 굵은 표식 하나만 본다.
        marker = re.search(r'\*\*(질의|통보)', status)
        if '회신 옴' in status or '회신 완료' in status:
            found[int(head.group(1))] = '회신 완료'
        elif marker:
            found[int(head.group(1))] = marker.group(1)
        elif '구현함' in status or '건너뜀' in status:
            found[int(head.group(1))] = '통보'
    return found


def section_of(operations: str) -> str | None:
    # ⭐ 도메인이 «여럿»인 것은 스스로 「횡단」이라 적는다 — 기계가 추측하지 않는다.
    #    (예: `X-Worker-No` 규약은 6도메인 37 오퍼레이션에 걸린다.)
    if '횡단' in operations:
        return '7'
    if re.search(r'/logistics/(shipment|stock-reinstatement)', operations):
        return '4'
    for pattern, key in [(r'/(logistics|inventory)/', '1'), (r'/(production|trace)/', '2'),
                         (r'/quality/', '3'), (r'/maintenance/', '5'), (r'/(app|mdm)/', '6')]:
        if re.search(pattern, operations):
            return key
    return None


def lane_of(number: int) -> str:
    return next((lane for lane, low, high in BANDS if low <= number <= high), '?')


def kind_from_tables() -> dict[int, str]:
    """레인 재정리표에서 번호별 구분을 읽는다. 행 모양: `| **122** | 제목 | ⭐ **질의** | 근거 |`"""
    found: dict[int, str] = {}
    for name in RECLASSIFIED:
        path = SRC / name
        if not path.exists():
            continue
        for line in path.read_text().splitlines():
            cells = [c.strip() for c in line.split('|')]
            if len(cells) < 4:
                continue
            head = re.fullmatch(r'\**(\d{2,3})\**', cells[1])
            if not head:
                continue
            # 행 전체에서 찾지 마라 — 「근거」 칸이 다른 요청서를 «질의»라 부르면 오분류된다
            # (145 가 그렇게 질의로 잡혔다). 「구분」 칸은 «짧다» — 그 칸만 본다.
            for cell in cells[2:]:
                bare = re.sub(r'[*⭐\s]', '', cell)
                if bare in ('질의', '통보'):
                    found[int(head.group(1))] = bare
                    break
    return found


def collect() -> list[dict[str, object]]:
    table, index = kind_from_tables(), kind_from_index()
    rows = []
    for path in sorted(SRC.glob('[0-9]*.md')):
        head = re.match(r'(\d+)-', path.name)
        if not head:
            continue
        number, text = int(head.group(1)), path.read_text()
        heading = re.search(r'^#\s*\d+\.\s*(.+)$', text, re.M)
        # 제목 줄이 없으면 파일 이름을 읽을 만하게 편다 — 번호를 떼고 하이픈을 띄운다.
        title = heading.group(1).strip() if heading else re.sub(r'^\d+-', '', path.stem).replace('-', ' ')

        # 「구분」은 두 모양으로 쓰인다 — 머리의 `**구분: 통보**` 줄, 그리고 머리표의 `| **구분** | **통보** … |` 행.
        # ⛔ 한쪽만 읽으면 문서가 멀쩡한데 「미분류」로 잡힌다(070·074·075·079·082 가 그랬다).
        declared = (re.search(r'^\*\*구분[:：]\s*(질의|통보)', text, re.M)
                    or re.search(r'^\|\s*\**구분\**\s*\|[^|\n]*?(질의|통보)', text, re.M))
        lane = lane_of(number)
        kind = (declared.group(1) if declared
                else table.get(number)
                or index.get(number)
                or B_EXCEPTIONS.get(number)
                or ('통보' if lane == 'B' else None))

        operations = re.search(r'걸리는 오퍼레이션[^|\n]*\|([^|\n]*)\|', text)
        section = section_of(operations.group(1) if operations else '') or section_of(text)
        rows.append({'n': number, 'title': title, 'kind': kind, 'section': section,
                     'lane': lane, 'file': path.name})
    return rows


COVER = SRC / '전달분-2026-루틴마감.md'
LETTER = SRC / '검토요청서-2026-09-10.md'


def cover_drift(rows: list[dict[str, object]]) -> list[str]:
    """표지가 손으로 적은 두 수가 색인의 계산과 갈렸는지 본다.

    ⭐ 표지는 사람이 쓴다 — 그래서 **낡는다**. 요청서를 더하거나 질의 하나가 회신으로 닫히면
    표지의 「176건」·「4건」이 조용히 틀린다(#577 이 고친 「낡은 수」와 같은 모양이다).
    ⛔ 표지를 자동 생성으로 바꾸지 않는다 — 나머지가 전부 사람의 판단이다. 수만 지킨다."""
    # ⛔ 없으면 조용히 넘어가지 않는다 — 표지가 사라지면 전달분에 «읽는 법»이 없다.
    #    (§6-2 변이 M5 가 이 자리를 초록으로 통과했다.)
    if not COVER.exists():
        return [f'⛔ 표지 {COVER.name} 이 없다.']
    text, drift = COVER.read_text(), []
    for pattern, actual, what in [
        (r'요청서는 \*\*(\d+)건\*\*이다', len(rows), '요청서'),
        (r'답이 와야 서는 자리 — (\d+)건', len([r for r in rows if r['kind'] == '질의']), '미회신 질의'),
    ]:
        found = re.search(pattern, text)
        if not found:
            drift.append(f'⛔ 표지에서 「{what}」 수를 못 찾았다 — 문장이 바뀌었으면 이 검사도 같이 고쳐라.')
        elif int(found.group(1)) != actual:
            drift.append(f'⛔ 표지의 「{what}」 = {found.group(1)}건, 실제 = {actual}건.')
    return drift


def letter_drift(rows: list[dict[str, object]]) -> list[str]:
    """검토 요청서가 손으로 적은 수가 색인의 계산과 갈렸는지 본다.

    ⭐ 이 한 장이 설계팀이 «맨 처음 여는» 문서다. 여기 적힌 「질의 4건」이 틀리면
    받는 쪽이 답해야 할 목록을 잘못 읽는다 — 표지보다 더 나쁘다.
    ⛔ 자동 생성으로 바꾸지 않는다(문장이 전부 사람의 판단이다). 수만 지킨다."""
    if not LETTER.exists():
        return [f'⛔ 검토 요청서 {LETTER.name} 이 없다.']
    text, drift = LETTER.read_text(), []
    counts = Counter(row['kind'] for row in rows)
    checks = [
        (r'\*\*질의\*\* — 우리가 정하면 안 되는 것 \| \*\*(\d+)\*\*', counts['질의'], '질의'),
        (r'\*\*통보\*\* — 우리가 정했고 구현했습니다 \| \*\*(\d+)\*\*', counts['통보'], '통보'),
        (r'\*\*합계\*\* \| \*\*(\d+)\*\*', len(rows), '합계'),
    ]
    for key, name, _ in SECTIONS:
        actual = sum(1 for row in rows if row['section'] == key)
        checks.append((rf'\| §{key} \| \**{re.escape(name)}\** \| \**(\d+)\**', actual, f'§{key} {name}'))
    for pattern, actual, what in checks:
        found = re.search(pattern, text)
        if not found:
            drift.append(f'⛔ 요청서에서 「{what}」 수를 못 찾았다 — 문장이 바뀌었으면 이 검사도 같이 고쳐라.')
        elif int(found.group(1)) != actual:
            drift.append(f'⛔ 요청서의 「{what}」 = {found.group(1)}건, 실제 = {actual}건.')
    return drift


def render(rows: list[dict[str, object]]) -> str:
    by_section: dict[str, list] = defaultdict(list)
    for row in rows:
        by_section[row['section'] or '?'].append(row)
    questions = [r for r in rows if r['kind'] == '질의']
    unknown = [r for r in rows if r['kind'] is None or r['section'] is None]

    out = [
        '# 설계 검토 요청 — 전달 색인 (자동 생성)',
        '',
        '⛔ **이 파일은 손으로 고치지 않는다** — `scripts/design_inquiries/build_delivery_index.py` 가 만든다.',
        '요청서를 더하거나 「구분」을 바꾸면 **다시 돌린다**. 표지·횡단·배포 노트는 `전달분-2026-루틴마감.md` 에 있다.',
        '',
        f'요청서 **{len(rows)}건** · 미회신 질의 **{len(questions)}건** · 손질 필요 **{len(unknown)}건**.',
        '',
        '## §0. 먼저 볼 것 — 답이 와야 서는 자리',
        '',
        '⭐ 나머지는 전부 **알려 두는 것**이라 회신을 기다리지 않는다. **이 표만 막고 있다.**',
        '',
        '| # | 제목 | 레인 |',
        '|:-:|---|:-:|',
    ]
    out += [f"| **{r['n']}** | {r['title']} | {r['lane']} |" for r in sorted(questions, key=lambda r: r['n'])] or ['| — | (없다) | |']

    for key, name, note in SECTIONS:
        group = sorted(by_section.get(key, []), key=lambda r: r['n'])
        out += ['', f'## §{key}. {name} — {len(group)}건', '', f'> {note}', '',
                '| # | 구분 | 제목 | 레인 |', '|:-:|:-:|---|:-:|']
        out += [f"| {r['n']} | {r['kind'] or '⚠ 미분류'} | {r['title']} | {r['lane']} |" for r in group] or ['| — | | (없다) | |']

    out += ['', f'## §X. 손질 필요 — {len(unknown)}건 (내부용 · 전달분에 안 싣는다)', '',
            '⛔ **숨기지 않는다.** 「구분」 줄이 없거나 「걸리는 오퍼레이션」에서 도메인을 못 읽은 것들이다 —',
            '전달 전에 사람이 채운다(요청서에 `**구분: …**` 한 줄을 더하면 다음 실행부터 저절로 잡힌다).', '',
            '| # | 없는 것 | 제목 | 레인 |', '|:-:|---|---|:-:|']
    out += [f"| {r['n']} | {'구분' if r['kind'] is None else ''}{' · ' if r['kind'] is None and r['section'] is None else ''}{'도메인' if r['section'] is None else ''} | {r['title']} | {r['lane']} |"
            for r in sorted(unknown, key=lambda r: r['n'])] or ['| — | | (없다) | |']
    return '\n'.join(out) + '\n'


if __name__ == '__main__':
    rows = collect()
    body, drift = render(rows), cover_drift(rows) + letter_drift(rows)
    if '--check' in sys.argv:
        current = OUT.read_text() if OUT.exists() else ''
        if current != body:
            print(f'⛔ {OUT.name} 이 낡았다 — 스크립트를 다시 돌려라.')
            raise SystemExit(1)
        if drift:
            print('\n'.join(drift + ['  → 표지/요청서의 수를 고쳐라.']))
            raise SystemExit(1)
        print(f'✅ {OUT.name} 최신 · 표지·요청서 수 일치')
    else:
        OUT.write_text(body)
        print(f'✅ {OUT.relative_to(ROOT)}')
        for line in drift:
            print(line)
