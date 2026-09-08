import { Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

@Injectable()
export class DocumentIssueSummaryMiddleware implements NestMiddleware {
  use(request: Request, _response: Response, next: NextFunction): void {
    const query = { ...request.query } as Record<string, unknown>;
    if (typeof query.targetIds === 'string') {
      query.targetIds = query.targetIds.split(',');
    }
    Object.defineProperty(request, 'query', {
      value: query,
      writable: true,
      configurable: true,
      enumerable: true,
    });
    next();
  }
}
