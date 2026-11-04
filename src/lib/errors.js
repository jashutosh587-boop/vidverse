/** An error whose message is safe to show to the person who caused it. */
export class HttpError extends Error {
  constructor(status, message, { code, details, headers } = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.headers = headers;
  }
}

export class ValidationError extends HttpError {
  /** @param {Record<string,string>} fieldErrors field name -> message */
  constructor(fieldErrors, message = 'Please check the highlighted fields.') {
    super(422, message, { code: 'validation' });
    this.name = 'ValidationError';
    this.fieldErrors = fieldErrors;
  }
}

export const badRequest = (message, opts) => new HttpError(400, message, opts);
export const unauthorized = (message = 'Sign in to continue.', opts) => new HttpError(401, message, opts);
export const forbidden = (message = 'You do not have access to that.', opts) => new HttpError(403, message, opts);
export const notFound = (message = 'We could not find that page.', opts) => new HttpError(404, message, opts);
export const conflict = (message, opts) => new HttpError(409, message, opts);
export const tooMany = (message = 'Too many attempts. Wait a little and try again.', opts) => new HttpError(429, message, opts);
