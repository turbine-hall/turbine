export class TurbineError extends Error {
  readonly code: string;
  readonly exitCode: number;
  readonly details?: Record<string, unknown>;

  constructor(
    code: string,
    message: string,
    exitCode = 2,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'TurbineError';
    this.code = code;
    this.exitCode = exitCode;
    this.details = details;
  }
}

export const ErrorCodes = {
  E_INVALID_CONFIG: { code: 'E_INVALID_CONFIG', exit: 2 },
  E_REQUIREMENTS_INCOMPLETE: { code: 'E_REQUIREMENTS_INCOMPLETE', exit: 3 },
  E_STALE_REVISION: { code: 'E_STALE_REVISION', exit: 3 },
  E_MISSING_CAPABILITY: { code: 'E_MISSING_CAPABILITY', exit: 3 },
  E_UNTRUSTED_IDENTITY: { code: 'E_UNTRUSTED_IDENTITY', exit: 3 },
  E_BUDGET_EXCEEDED: { code: 'E_BUDGET_EXCEEDED', exit: 7 },
  E_SOURCE_CONFLICT: { code: 'E_SOURCE_CONFLICT', exit: 4 },
  E_EEC_UNSATISFIED: { code: 'E_EEC_UNSATISFIED', exit: 3 },
  E_EVIDENCE_STALE: { code: 'E_EVIDENCE_STALE', exit: 3 },
  E_IMPACT_UNKNOWN: { code: 'E_IMPACT_UNKNOWN', exit: 3 },
  E_RECOVERY_UNAUTHORIZED: { code: 'E_RECOVERY_UNAUTHORIZED', exit: 3 },
  E_UNSAFE_EXECUTION: { code: 'E_UNSAFE_EXECUTION', exit: 3 },
  E_INVALID_TRANSITION: { code: 'E_INVALID_TRANSITION', exit: 3 },
  E_NOT_FOUND: { code: 'E_NOT_FOUND', exit: 2 },
  E_ADAPTER: { code: 'E_ADAPTER', exit: 4 },
  E_RUN_FAILURE: { code: 'E_RUN_FAILURE', exit: 5 },
  E_CONCURRENT: { code: 'E_CONCURRENT', exit: 6 },
  E_CONTEXT_UNAVAILABLE: { code: 'E_CONTEXT_UNAVAILABLE', exit: 3 },
} as const;

export function err(
  key: keyof typeof ErrorCodes,
  message: string,
  details?: Record<string, unknown>,
): TurbineError {
  const meta = ErrorCodes[key];
  return new TurbineError(meta.code, message, meta.exit, details);
}
