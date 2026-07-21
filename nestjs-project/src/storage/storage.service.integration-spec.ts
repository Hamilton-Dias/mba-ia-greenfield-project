import {
  DeleteBucketCommand,
  DeleteObjectCommand,
  HeadBucketCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { ConfigModule, ConfigType } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { randomUUID } from 'crypto';
import storageConfig from '../config/storage.config';
import { StorageModule } from './storage.module';
import { StorageService } from './storage.service';

// Independent client used only by the test itself to perform raw byte transfer and
// out-of-band verification against the real internal MinIO endpoint — bypasses the
// service entirely so assertions don't rely on the code under test being correct.
const rawAdminClient = new S3Client({
  endpoint: process.env.STORAGE_INTERNAL_ENDPOINT,
  region: 'us-east-1',
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.STORAGE_ACCESS_KEY as string,
    secretAccessKey: process.env.STORAGE_SECRET_KEY as string,
  },
});

async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

describe('StorageService (integration)', () => {
  let module: TestingModule;
  let service: StorageService;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        StorageModule,
      ],
    }).compile();

    service = module.get(StorageService);
    // Mirrors app bootstrap: onModuleInit() is not invoked by .compile() alone.
    await module.init();
  }, 30000);

  afterAll(async () => {
    await module.close();
  });

  describe('bucket bootstrap', () => {
    it('is a no-op when the bucket already exists (idempotent)', async () => {
      await expect(service.ensureBucketExists()).resolves.toBeUndefined();
      await expect(service.ensureBucketExists()).resolves.toBeUndefined();
    });

    it('creates the bucket when it does not yet exist', async () => {
      const uniqueBucket = `streamtube-test-${randomUUID()}`;
      const scopedModule = await Test.createTestingModule({
        imports: [
          ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
          StorageModule,
        ],
      })
        .overrideProvider(storageConfig.KEY)
        .useValue({
          internalEndpoint: process.env.STORAGE_INTERNAL_ENDPOINT,
          publicEndpoint: process.env.STORAGE_PUBLIC_ENDPOINT,
          accessKey: process.env.STORAGE_ACCESS_KEY,
          secretKey: process.env.STORAGE_SECRET_KEY,
          bucket: uniqueBucket,
        } as ConfigType<typeof storageConfig>)
        .compile();

      try {
        const scopedService = scopedModule.get(StorageService);
        await scopedService.ensureBucketExists();

        // Verify creation out-of-band, independent of the service under test.
        await expect(
          rawAdminClient.send(new HeadBucketCommand({ Bucket: uniqueBucket })),
        ).resolves.toBeDefined();

        // Second call against the now-existing bucket must remain a no-op.
        await expect(
          scopedService.ensureBucketExists(),
        ).resolves.toBeUndefined();
      } finally {
        await rawAdminClient
          .send(new DeleteBucketCommand({ Bucket: uniqueBucket }))
          .catch(() => undefined);
        await scopedModule.close();
      }
    }, 30000);
  });

  describe('dual-endpoint signing', () => {
    it('signs presigned upload-part URLs against STORAGE_PUBLIC_ENDPOINT, not the internal endpoint', async () => {
      const uploadId = await service.createMultipartUpload(
        `videos/${randomUUID()}/original`,
      );
      const url = await service.presignUploadPart(
        `videos/${randomUUID()}/original`,
        uploadId,
        1,
      );

      const parsed = new URL(url);
      const expectedPublic = new URL(
        process.env.STORAGE_PUBLIC_ENDPOINT as string,
      );
      expect(parsed.host).toBe(expectedPublic.host);
      expect(parsed.host).not.toBe(
        new URL(process.env.STORAGE_INTERNAL_ENDPOINT as string).host,
      );
    });

    it('signs presigned get-object URLs against STORAGE_PUBLIC_ENDPOINT, not the internal endpoint', async () => {
      const url = await service.presignGetObject(
        `videos/${randomUUID()}/original`,
      );

      const parsed = new URL(url);
      const expectedPublic = new URL(
        process.env.STORAGE_PUBLIC_ENDPOINT as string,
      );
      expect(parsed.host).toBe(expectedPublic.host);
      expect(parsed.host).not.toBe(
        new URL(process.env.STORAGE_INTERNAL_ENDPOINT as string).host,
      );
    });

    it('throws a clear error naming the missing env var when STORAGE_PUBLIC_ENDPOINT is absent', async () => {
      const noPublicEndpointModule = await Test.createTestingModule({
        imports: [
          ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
          StorageModule,
        ],
      })
        .overrideProvider(storageConfig.KEY)
        .useValue({
          internalEndpoint: process.env.STORAGE_INTERNAL_ENDPOINT,
          publicEndpoint: undefined,
          accessKey: process.env.STORAGE_ACCESS_KEY,
          secretKey: process.env.STORAGE_SECRET_KEY,
          bucket: process.env.STORAGE_BUCKET,
        } as ConfigType<typeof storageConfig>)
        .compile();

      try {
        const noPublicEndpointService =
          noPublicEndpointModule.get(StorageService);

        await expect(
          noPublicEndpointService.presignGetObject('videos/some-key/original'),
        ).rejects.toThrow(/STORAGE_PUBLIC_ENDPOINT/);
      } finally {
        await noPublicEndpointModule.close();
      }
    });
  });

  describe('ResponseContentDisposition behavior', () => {
    it('omits response-content-disposition when download is not requested', async () => {
      const url = await service.presignGetObject(
        `videos/${randomUUID()}/original`,
      );
      const parsed = new URL(url);

      expect(parsed.searchParams.has('response-content-disposition')).toBe(
        false,
      );
    });

    it('sets an attachment response-content-disposition when download is true', async () => {
      const url = await service.presignGetObject(
        `videos/${randomUUID()}/original`,
        { download: true, filename: 'my video.mp4' },
      );
      const parsed = new URL(url);

      expect(parsed.searchParams.get('response-content-disposition')).toBe(
        'attachment; filename="my video.mp4"',
      );
    });
  });

  describe('multipart upload round-trip', () => {
    it('creates, uploads a part, and completes a multipart upload into a retrievable object', async () => {
      const key = `videos/${randomUUID()}/original`;
      const content = Buffer.from('a'.repeat(6 * 1024)); // small stand-in payload

      const uploadId = await service.createMultipartUpload(key);

      // Real byte transfer is done via the internal endpoint directly (a browser-facing
      // presigned URL bound to STORAGE_PUBLIC_ENDPOINT=http://localhost:9000 is not
      // reachable from inside this container's network namespace).
      const uploadPartResult = await rawAdminClient.send(
        new UploadPartCommand({
          Bucket: process.env.STORAGE_BUCKET,
          Key: key,
          UploadId: uploadId,
          PartNumber: 1,
          Body: content,
        }),
      );
      expect(uploadPartResult.ETag).toBeDefined();

      await service.completeMultipartUpload(key, uploadId, [
        { partNumber: 1, eTag: uploadPartResult.ETag as string },
      ]);

      await expect(service.headObject(key)).resolves.toBeDefined();

      const body = await service.getObjectBody(key);
      const retrieved = await streamToBuffer(
        body as unknown as NodeJS.ReadableStream,
      );
      expect(retrieved.equals(content)).toBe(true);

      await rawAdminClient.send(
        new DeleteObjectCommand({
          Bucket: process.env.STORAGE_BUCKET,
          Key: key,
        }),
      );
    }, 30000);
  });

  describe('headObject', () => {
    it('rejects with a not-found error for a key that was never uploaded', async () => {
      await expect(
        service.headObject(`videos/${randomUUID()}/never-uploaded`),
      ).rejects.toThrow();
    });
  });

  describe('putObject / getObjectBody', () => {
    it('writes and reads back an object via the admin client', async () => {
      const key = `videos/${randomUUID()}/thumbnail.jpg`;
      const content = Buffer.from('fake-thumbnail-bytes');

      await service.putObject(key, content);

      const body = await service.getObjectBody(key);
      const retrieved = await streamToBuffer(
        body as unknown as NodeJS.ReadableStream,
      );
      expect(retrieved.equals(content)).toBe(true);

      await rawAdminClient.send(
        new DeleteObjectCommand({
          Bucket: process.env.STORAGE_BUCKET,
          Key: key,
        }),
      );
    });
  });
});
