import type { RelayErrorShape } from "./types.js";

export class RelayError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly details?: unknown;

  constructor(
    code: string,
    message: string,
    options: { retryable?: boolean; details?: unknown; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "RelayError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }

  toJSON(): RelayErrorShape {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...(this.details === undefined ? {} : { details: this.details }),
    };
  }
}

export function asRelayError(
  error: unknown,
  fallbackCode = "INTERNAL_ERROR",
): RelayError {
  if (error instanceof RelayError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new RelayError(fallbackCode, message, { cause: error });
}
