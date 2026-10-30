export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const unauthorized = (msg = 'Authentication required') => new HttpError(401, 'UNAUTHENTICATED', msg);
export const forbidden = (msg = 'You do not have access to this resource') => new HttpError(403, 'FORBIDDEN', msg);
export const notFound = (what = 'Resource') => new HttpError(404, 'NOT_FOUND', `${what} not found`);
export const conflict = (msg: string) => new HttpError(409, 'CONFLICT', msg);

export const nowIso = () => new Date().toISOString();
