import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ID = 'https://omf-mes.invalid/contract';

/**
 * 계약 정본의 응답 스키마로 실제 응답 본문을 검사한다 — 계약 검증 가드는 «요청»만 보므로 응답이 계약과
 * 어긋나도 그 자리에서 드러나지 않는다. 틀리면 ajv 오류를 그대로 돌려 어느 칸인지 보이게 한다.
 */
export function contractResponse(file: string, method: string, path: string, status: number): (body: unknown) => unknown[] {
  const contract = JSON.parse(readFileSync(join(__dirname, '../contracts', file), 'utf8')) as object;
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  for (const format of ['int64', 'int32', 'double', 'float', 'binary', 'password']) ajv.addFormat(format, true);
  ajv.addSchema(contract, ID);
  const pointer = `/paths/${path.replace(/~/g, '~0').replace(/\//g, '~1')}/${method.toLowerCase()}/responses/${status}/content/application~1json/schema`;
  const validate = ajv.compile({ $ref: `${ID}#${pointer}` });
  return (body) => (validate(body) ? [] : (validate.errors ?? []));
}
