import { Router } from 'express';
import { isDatabaseReady } from '../../infrastructure/mongo.js';

export const healthRouter = Router();

healthRouter.get('/live', (_req, res) => {
  res.json({ ok: true });
});

healthRouter.get('/ready', (_req, res) => {
  const db = isDatabaseReady();
  res.status(db ? 200 : 503).json({ ok: db, db });
});
