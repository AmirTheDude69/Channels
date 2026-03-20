import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(8080),
  PUBLIC_BASE_URL: z.string().url().optional(),
  DATABASE_URL: z.string().optional(),
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_OWNER_ID: z.string().optional(),
  TELEGRAM_WEBHOOK_SECRET: z.string().default('replace-me'),
  PAIR_CODE_TTL_SECONDS: z.coerce.number().int().positive().default(600),
  AGENT_HEARTBEAT_STALE_SECONDS: z.coerce.number().int().positive().default(90),
});

export const env = envSchema.parse(process.env);

export const features = {
  hasDatabase: Boolean(env.DATABASE_URL),
  hasTelegram: Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_OWNER_ID),
};
