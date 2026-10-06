import { Router } from 'express';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { unauthorized } from '../../lib/http-error.js';
import { parse } from '../../lib/validate.js';
import { verifyInitData } from './telegram.js';
import { UserModel } from './user.model.js';
import { signToken } from './auth.middleware.js';

export const authRouter = Router();

/** Telegram Mini App: initData -> JWT */
authRouter.post('/telegram', async (req, res) => {
  const { init_data } = parse(z.object({ init_data: z.string().min(10).max(4096) }), req.body);
  const tg = verifyInitData(init_data, env.TELEGRAM_BOT_TOKEN);
  if (!tg) throw unauthorized('Telegram ma’lumotlari tasdiqlanmadi');

  const user = await UserModel.findOneAndUpdate(
    { telegram_id: tg.id },
    { $set: { first_name: tg.first_name ?? '', last_name: tg.last_name ?? '', username: tg.username, language_code: tg.language_code } },
    { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
  ).lean();

  const auth = { id: String(user!._id), telegram_id: tg.id };
  res.json({ token: signToken(auth), user: { id: auth.id, telegram_id: tg.id, first_name: user!.first_name, username: user!.username ?? null } });
});
