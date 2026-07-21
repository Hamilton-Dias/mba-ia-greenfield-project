import { registerAs } from '@nestjs/config';

export default registerAs('storage', () => ({
  internalEndpoint: process.env.STORAGE_INTERNAL_ENDPOINT,
  publicEndpoint: process.env.STORAGE_PUBLIC_ENDPOINT,
  accessKey: process.env.STORAGE_ACCESS_KEY,
  secretKey: process.env.STORAGE_SECRET_KEY,
  bucket: process.env.STORAGE_BUCKET || 'streamtube',
}));
