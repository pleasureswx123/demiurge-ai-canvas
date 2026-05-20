import dotenv from 'dotenv';
import { NODE_SERVICE_ROOT } from './paths.js';

dotenv.config({ path: [`${NODE_SERVICE_ROOT}/.env.local`, `${NODE_SERVICE_ROOT}/.env`] });

export const NODE_API_PORT = Number(process.env.NODE_API_PORT || 3200);
export const NODE_API_HOST = process.env.NODE_API_HOST || '127.0.0.1';
