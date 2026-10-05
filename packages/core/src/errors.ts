/**
 * A closed error taxonomy. Every error carries a stable `code` so that a CLI exit code,
 * an MCP error envelope, and an HTTP status can all be derived from one value.
 */
export type ErrorCode =
  | 'VALIDATION_FAILED'
  | 'PERMISSION_DENIED'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'UPSTREAM_FAILED'
  | 'TIMEOUT'
  | 'UNSUPPORTED'

export class ProductError extends Error {
  readonly code: ErrorCode
  readonly details: Record<string, unknown>

  constructor(code: ErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message)
    this.name = 'ProductError'
    this.code = code
    this.details = details
  }
}

export class ValidationError extends ProductError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super('VALIDATION_FAILED', message, details)
    this.name = 'ValidationError'
  }
}

export class PermissionError extends ProductError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super('PERMISSION_DENIED', message, details)
    this.name = 'PermissionError'
  }
}

export class NotFoundError extends ProductError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super('NOT_FOUND', message, details)
    this.name = 'NotFoundError'
  }
}

export class ConflictError extends ProductError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super('CONFLICT', message, details)
    this.name = 'ConflictError'
  }
}

export class TimeoutError extends ProductError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super('TIMEOUT', message, details)
    this.name = 'TimeoutError'
  }
}

export class UpstreamError extends ProductError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super('UPSTREAM_FAILED', message, details)
    this.name = 'UpstreamError'
  }
}

/** Narrowing helper for use across package boundaries. */
export function isProductError(value: unknown): value is ProductError {
  return value instanceof ProductError
}
