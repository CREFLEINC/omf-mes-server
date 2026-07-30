import { OpenAPIObject } from '@nestjs/swagger';

import { AUTH_TAG, orderApiTags } from './app.setup';

/** paths 만 있는 최소 문서 — orderApiTags 는 이것만 본다. */
function docWith(operations: Record<string, string[]>): OpenAPIObject {
  const paths: OpenAPIObject['paths'] = {};
  for (const [path, tags] of Object.entries(operations)) {
    paths[path] = { get: { tags, responses: {} } };
  }
  return { openapi: '3.0.0', info: { title: 't', version: '1' }, paths };
}

describe('orderApiTags', () => {
  /**
   * 정렬 결과를 하드코딩하지 않는다 — 한글·라틴 혼재 시의 순서는 Node 의 ICU 데이터에
   * 달려 있어서 환경이 바뀌면 값이 달라질 수 있다. 여기서 지켜야 할 계약은
   * "인증이 맨 앞" + "나머지는 이름순" 두 가지다.
   */
  it('인증을 맨 앞에 두고 나머지는 이름순으로 정렬한다', () => {
    const others = ['기준정보 — 거래처', '접근권한 — 역할', 'POP — 현장 단말'];
    const document = docWith({
      '/master/partners': [others[0]],
      '/access/roles': [others[1]],
      '/auth/login': [AUTH_TAG],
      '/pop/work-orders': [others[2]],
    });

    orderApiTags(document);
    const names = document.tags?.map((t) => t.name) ?? [];

    expect(names[0]).toBe(AUTH_TAG);
    expect(names.slice(1)).toEqual([...others].sort((a, b) => a.localeCompare(b, 'ko')));
  });

  // 컨트롤러가 늘어도 목록을 손보지 않아도 되는 것이 이 함수의 존재 이유다.
  it('문서에 있는 태그를 하나도 빠뜨리지 않는다', () => {
    const document = docWith({
      '/a': ['가'],
      '/b': ['나'],
      '/c': ['다'],
      '/d': [AUTH_TAG],
    });

    orderApiTags(document);

    expect(document.tags).toHaveLength(4);
    expect(document.tags?.[0]?.name).toBe(AUTH_TAG);
  });

  it('한 엔드포인트에 태그가 여러 개여도 모두 수집한다', () => {
    const document = docWith({ '/x': ['둘', '하나'] });

    orderApiTags(document);

    expect(document.tags?.map((t) => t.name)).toEqual(['둘', '하나'].sort((a, b) => a.localeCompare(b, 'ko')));
  });

  it('인증 태그가 없으면 이름순만 적용한다', () => {
    const document = docWith({ '/a': ['나'], '/b': ['가'] });

    orderApiTags(document);

    expect(document.tags?.map((t) => t.name)).toEqual(['가', '나']);
  });

  it('paths 가 비어도 죽지 않는다', () => {
    const document = docWith({});

    expect(() => orderApiTags(document)).not.toThrow();
    expect(document.tags).toEqual([]);
  });

  // PathItemObject 에는 operation 이 아닌 키(parameters·servers)도 들어온다.
  it('operation 이 아닌 항목을 태그로 오인하지 않는다', () => {
    const document = docWith({ '/a': [AUTH_TAG] });
    const pathItem = document.paths['/a'];
    if (!pathItem) throw new Error('테스트 픽스처 오류');
    pathItem.parameters = [{ name: 'q', in: 'query' }];
    pathItem.servers = [{ url: 'http://x' }];

    orderApiTags(document);

    expect(document.tags?.map((t) => t.name)).toEqual([AUTH_TAG]);
  });
});
