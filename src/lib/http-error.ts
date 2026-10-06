export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public code: string = 'error',
    public details?: unknown,
  ) {
    super(message);
  }
}

export const notFound = (msg = 'Topilmadi') => new HttpError(404, msg, 'not_found');
export const badRequest = (msg: string, details?: unknown) => new HttpError(422, msg, 'validation', details);
export const conflict = (msg: string, code = 'conflict') => new HttpError(409, msg, code);
export const unauthorized = (msg = 'Avtorizatsiya talab qilinadi') => new HttpError(401, msg, 'unauthorized');
export const forbidden = (msg = 'Ruxsat yo‘q') => new HttpError(403, msg, 'forbidden');
