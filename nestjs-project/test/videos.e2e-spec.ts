import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { StorageService } from '../src/storage/storage.service';
import { cleanAllTables } from '../src/test/create-test-data-source';

describe('Videos (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let userCounter = 0;

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(
      new DomainExceptionFilter(),
      new ValidationExceptionFilter(),
    );
    await app.init();

    dataSource = moduleFixture.get(DataSource);
  }, 30000);

  afterAll(async () => {
    // Leave no `videos` rows behind — other e2e spec files share this same
    // live Postgres instance and their own `cleanAllTables()` does a plain
    // `DELETE FROM "channels"`, which fails on the FK from `videos.channelId`
    // if this file's rows (created by tests that don't run through the
    // per-test beforeEach cleanup below, i.e. whatever the last test left)
    // are still present when a later suite runs against the same database.
    await dataSource.query('DELETE FROM "videos"');
    await app.close();
  });

  beforeEach(async () => {
    await dataSource.query('DELETE FROM "videos"');
    await cleanAllTables(dataSource);
  });

  async function captureConfirmationToken(
    email: string,
    password = 'password123',
  ): Promise<string> {
    const authService = app.get(AuthService);
    const mailServiceInstance = (authService as any).mailService;
    let capturedToken = '';
    jest
      .spyOn(mailServiceInstance, 'sendConfirmationEmail')
      .mockImplementationOnce(async (_e: string, _n: string, t: string) => {
        capturedToken = t;
      });
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password });
    return capturedToken;
  }

  async function registerConfirmAndLogin(): Promise<string> {
    const email = `videos_e2e_${++userCounter}@example.com`;
    const password = 'password123';
    const token = await captureConfirmationToken(email, password);
    await request(app.getHttpServer())
      .get('/auth/confirm-email')
      .query({ token });
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password });
    return res.body.access_token as string;
  }

  describe('POST /videos', () => {
    it('returns 201 with { id, status: draft, upload } for a valid body and access token', async () => {
      const accessToken = await registerConfirmAndLogin();

      const res = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ originalFilename: 'my-video.mp4', fileSize: 1024 })
        .expect(201);

      expect(res.body.id).toBeDefined();
      expect(res.body.status).toBe('draft');
      expect(res.body.upload).toBeDefined();
      expect(res.body.upload.type).toBe('single');
      expect(res.body.upload.url).toEqual(expect.any(String));
    });

    it('returns 401 without an Authorization header', async () => {
      await request(app.getHttpServer())
        .post('/videos')
        .send({ originalFilename: 'my-video.mp4', fileSize: 1024 })
        .expect(401);
    });

    it('returns a single-PUT upload handshake when fileSize is at the 100MB threshold', async () => {
      const accessToken = await registerConfirmAndLogin();

      const res = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ originalFilename: 'my-video.mp4', fileSize: 104857600 })
        .expect(201);

      expect(res.body.upload.type).toBe('single');
      expect(res.body.upload.url).toEqual(expect.any(String));
    });

    it('returns a multipart upload handshake when fileSize exceeds the 100MB threshold', async () => {
      const accessToken = await registerConfirmAndLogin();

      const res = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ originalFilename: 'big-video.mp4', fileSize: 104857601 })
        .expect(201);

      expect(res.body.upload.type).toBe('multipart');
      expect(res.body.upload.uploadId).toEqual(expect.any(String));
      expect(Array.isArray(res.body.upload.parts)).toBe(true);
      expect(res.body.upload.parts.length).toBeGreaterThan(0);
      expect(res.body.upload.parts[0]).toEqual({
        partNumber: 1,
        url: expect.any(String),
      });
    }, 15000);

    it('returns 400 when fileSize exceeds 10GB', async () => {
      const accessToken = await registerConfirmAndLogin();

      const res = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ originalFilename: 'huge-video.mp4', fileSize: 10737418241 })
        .expect(400);

      expect(res.body.error).toBe('VALIDATION_ERROR');
    });

    it('returns 400 when originalFilename is missing', async () => {
      const accessToken = await registerConfirmAndLogin();

      const res = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ fileSize: 1024 })
        .expect(400);

      expect(res.body.error).toBe('VALIDATION_ERROR');
    });

    it('returns 400 when fileSize is missing', async () => {
      const accessToken = await registerConfirmAndLogin();

      const res = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ originalFilename: 'my-video.mp4' })
        .expect(400);

      expect(res.body.error).toBe('VALIDATION_ERROR');
    });
  });

  describe('POST /videos/:id/complete-upload', () => {
    async function createDraftVideo(
      accessToken: string,
      fileSize = 1024,
    ): Promise<{ id: string; storageKey: string }> {
      const res = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ originalFilename: 'my-video.mp4', fileSize })
        .expect(201);
      const id = res.body.id as string;
      return { id, storageKey: `videos/${id}/original` };
    }

    // The three cases below share a single registerConfirmAndLogin() call
    // (rather than one per `it`) to stay well under the app's global
    // ThrottlerGuard (10 req/60s per IP+route, see auth.module.ts) — this
    // file alone already burns ~6 registrations in the POST /videos describe
    // above, and `beforeEach` wipes users/channels before every test so a
    // shared user can't be hoisted into a `beforeAll` either.
    it('returns 200 for the owner, 404 for an unknown id, and 409 when never uploaded', async () => {
      const accessToken = await registerConfirmAndLogin();

      // 200: genuine upload really lands in storage, then verified.
      const { id, storageKey } = await createDraftVideo(accessToken);
      const storageService = app.get(StorageService);
      await storageService.putObject(storageKey, Buffer.from('real content'));

      const okRes = await request(app.getHttpServer())
        .post(`/videos/${id}/complete-upload`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({})
        .expect(200);
      expect(okRes.body).toEqual({ id, status: 'processing' });

      // 404: no video exists with this id at all.
      const notFoundRes = await request(app.getHttpServer())
        .post('/videos/00000000-0000-0000-0000-000000000000/complete-upload')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({})
        .expect(404);
      expect(notFoundRes.body.error).toBe('VIDEO_NOT_FOUND');

      // 409: a fresh draft whose storage object was never actually uploaded.
      const { id: neverUploadedId } = await createDraftVideo(accessToken);
      const verificationRes = await request(app.getHttpServer())
        .post(`/videos/${neverUploadedId}/complete-upload`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({})
        .expect(409);
      expect(verificationRes.body.error).toBe('UPLOAD_VERIFICATION_FAILED');
    }, 20000);

    it('returns 401 without an Authorization header', async () => {
      await request(app.getHttpServer())
        .post('/videos/00000000-0000-0000-0000-000000000000/complete-upload')
        .send({})
        .expect(401);
    });

    it("returns 404 VIDEO_NOT_FOUND for another user's video", async () => {
      const ownerToken = await registerConfirmAndLogin();
      const { id } = await createDraftVideo(ownerToken);

      const otherToken = await registerConfirmAndLogin();

      const res = await request(app.getHttpServer())
        .post(`/videos/${id}/complete-upload`)
        .set('Authorization', `Bearer ${otherToken}`)
        .send({})
        .expect(404);

      expect(res.body.error).toBe('VIDEO_NOT_FOUND');
    });
  });
});
