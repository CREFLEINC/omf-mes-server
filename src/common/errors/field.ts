import { HttpStatus } from '@nestjs/common';

import { ContractException } from './contract.exception';
import { ErrorItem } from './error-response';

export function field(name: string, code: string, message: string): ErrorItem {
  return { scope: 'field', field: name, code, message };
}

export function one(item: ErrorItem): ContractException {
  return new ContractException(HttpStatus.BAD_REQUEST, [item]);
}
