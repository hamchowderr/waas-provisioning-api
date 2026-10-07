/** Errors the API returns to the caller. 400s carry the contract's ExceptionResult body. */
export class HttpError extends Error {
  constructor(
    readonly status: 400 | 403 | 404,
    message: string,
  ) {
    super(message);
  }
}

export const badRequest = (message: string) => new HttpError(400, message);
