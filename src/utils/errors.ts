export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly isOperational: boolean;
  /** If false, the raw error message should not be surfaced to HTTP clients. */
  public readonly isClientFacing: boolean = true;

  constructor(message: string, statusCode: number, code: string) {
    super(message);
    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.code = code;
    this.isOperational = true;
    Error.captureStackTrace(this, this.constructor);
  }
}

export class AuthenticationError extends AppError {
  constructor(message = 'Authentication failed') {
    super(message, 401, 'AUTHENTICATION_FAILED');
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Forbidden') {
    super(message, 403, 'FORBIDDEN');
  }
}

export class NotFoundError extends AppError {
  constructor(resource = 'Resource') {
    super(`${resource} not found`, 404, 'NOT_FOUND');
  }
}

export class ConflictError extends AppError {
  constructor(message = 'Conflict') {
    super(message, 409, 'CONFLICT');
  }
}

export class ValidationError extends AppError {
  constructor(message = 'Validation failed') {
    super(message, 422, 'VALIDATION_ERROR');
  }
}

export class TelegramApiError extends AppError {
  public readonly telegramErrorCode: number;
  public readonly telegramDescription: string;
  // Internal error — Telegram method names and API details must not be sent to clients.
  public override readonly isClientFacing = false;

  constructor(method: string, errorCode: number, description: string) {
    super(`Telegram API error on ${method}: ${description}`, 502, 'TELEGRAM_API_ERROR');
    this.telegramErrorCode = errorCode;
    this.telegramDescription = description;
  }
}
