import type { ErrorCode } from './error-codes.js';

export class DomainError extends Error {
  public readonly code: ErrorCode;
  public readonly httpStatus: number;
  public readonly safeMessage: string;

  constructor(input: {
    code: ErrorCode;
    httpStatus: number;
    safeMessage: string;
  }) {
    super(input.safeMessage);
    this.code = input.code;
    this.httpStatus = input.httpStatus;
    this.safeMessage = input.safeMessage;
  }
}

