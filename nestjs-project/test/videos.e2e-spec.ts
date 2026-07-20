import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
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
});
