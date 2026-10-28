/** An error that maps straight to an HTTP response. Business outcomes (conflict, gone) use this. */
export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const badRequest = (code: string, message: string) => new HttpError(400, code, message);
export const notFound = (code: string, message: string) => new HttpError(404, code, message);
export const conflict = (code: string, message: string) => new HttpError(409, code, message);
export const unprocessable = (code: string, message: string) => new HttpError(422, code, message);
