import express, { type ErrorRequestHandler } from 'express';
import type { Pool } from 'pg';
import { ApiError, invalid } from './errors.js';
import { validateBooking } from './validation.js';
import { reserve } from './reservations.js';

const tokens = new Map([['test-token-a', 'operator-a'], ['test-token-b', 'operator-b']]);

export function createApp(pool: Pool) {
  const app = express();
  app.disable('x-powered-by');
  app.post('/reservations', (req, res, next) => {
    const match = /^Bearer ([^\s]+)$/i.exec(req.get('authorization') ?? '');
    const operatorId = match ? tokens.get(match[1]) : undefined;
    if (!operatorId) return next(new ApiError(401, 'UNAUTHORIZED', 'A valid bearer token is required.'));
    res.locals.operatorId = operatorId;
    next();
  }, express.json({ limit: '16kb' }), async (req, res) => {
    if (!req.is('application/json')) invalid('Content-Type must be application/json.');
    const booking = validateBooking(req.body);
    if (booking.operatorId !== res.locals.operatorId) {
      throw new ApiError(403, 'FORBIDDEN', 'The token does not authorize this operator.');
    }
    const result = await reserve(pool, res.locals.operatorId as string, booking);
    res.status(result.status).json(result.body);
  });
  app.use((_req, _res, next) => next(new ApiError(404, 'NOT_FOUND', 'Endpoint not found.')));
  const handleError: ErrorRequestHandler = (error, _req, res, _next) => {
    if (error instanceof ApiError) {
      res.status(error.status).json({ error: { code: error.code, message: error.message } });
      return;
    }
    if (typeof error?.status === 'number' && error.status >= 400 && error.status < 500) {
      res.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'Invalid JSON request body.' } });
      return;
    }
    // No SQL, credentials, customer data or internal error messages in responses/logs.
    console.error('Reservation request failed', { code: typeof error?.code === 'string' ? error.code : 'UNKNOWN' });
    res.status(503).json({ error: { code: 'SERVICE_UNAVAILABLE', message: 'Unable to complete the request. Retry with the same booking ID and payload.' } });
  };
  app.use(handleError);
  return app;
}
