import { S3Client } from '@aws-sdk/client-s3';
import { Module } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import storageConfig from '../config/storage.config';
import { STORAGE_ADMIN_CLIENT } from './storage.constants';
import { StorageService } from './storage.service';

@Module({
  providers: [
    {
      provide: STORAGE_ADMIN_CLIENT,
      inject: [storageConfig.KEY],
      useFactory: (config: ConfigType<typeof storageConfig>): S3Client =>
        new S3Client({
          endpoint: config.internalEndpoint,
          region: 'us-east-1',
          forcePathStyle: true,
          credentials: {
            accessKeyId: config.accessKey as string,
            secretAccessKey: config.secretKey as string,
          },
        }),
    },
    StorageService,
  ],
  exports: [StorageService],
})
export class StorageModule {}
