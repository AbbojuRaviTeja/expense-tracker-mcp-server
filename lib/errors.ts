/**
 * An error whose message is safe and useful to show to the end user.
 * Anything else that escapes a tool is logged and replaced by a generic message.
 */
export class AppError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AppError";
  }
}

export class NotFoundError extends AppError {}
export class ForbiddenError extends AppError {}
export class ValidationError extends AppError {}
export class RateLimitError extends AppError {}
