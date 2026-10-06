import mongoose from 'mongoose';
import { env } from '../config/env.js';
import { logger } from './logger.js';

mongoose.set('strictQuery', true);

export async function connectDatabase(uri = env.MONGODB_URI) {
  mongoose.connection.on('disconnected', () => logger.warn('MongoDB uzildi'));
  mongoose.connection.on('reconnected', () => logger.info('MongoDB qayta ulandi'));
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 8000, autoIndex: true });
  logger.info('MongoDB ulandi', { db: mongoose.connection.name });
}

export const disconnectDatabase = () => mongoose.disconnect();
export const isDatabaseReady = () => mongoose.connection.readyState === 1;
