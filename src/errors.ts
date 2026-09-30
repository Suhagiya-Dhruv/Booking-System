export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

export function invalid(message: string): never {
  throw new ApiError(400, 'INVALID_REQUEST', message);
}
