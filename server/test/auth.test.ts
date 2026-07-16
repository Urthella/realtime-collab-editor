import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createTestEnv, registerUser, type TestEnv } from './helpers.js';

describe('auth API', () => {
  let env: TestEnv;

  beforeEach(async () => {
    env = await createTestEnv();
  });

  it('registers a user and returns a token', async () => {
    const res = await request(env.app)
      .post('/api/auth/register')
      .send({ email: 'Ada@Example.com', name: 'Ada', password: 'password123' });
    expect(res.status).toBe(201);
    expect(res.body.token).toBeTypeOf('string');
    expect(res.body.user.email).toBe('ada@example.com'); // normalized
    expect(res.body.user.passwordHash).toBeUndefined();
  });

  it('rejects duplicate registration', async () => {
    await registerUser(env.app, 'ada@example.com');
    const res = await request(env.app)
      .post('/api/auth/register')
      .send({ email: 'ada@example.com', name: 'Ada 2', password: 'password123' });
    expect(res.status).toBe(409);
  });

  it('rejects weak passwords and invalid emails', async () => {
    const short = await request(env.app)
      .post('/api/auth/register')
      .send({ email: 'x@example.com', name: 'X', password: 'short' });
    expect(short.status).toBe(400);

    const badEmail = await request(env.app)
      .post('/api/auth/register')
      .send({ email: 'not-an-email', name: 'X', password: 'password123' });
    expect(badEmail.status).toBe(400);
  });

  it('logs in with correct credentials and rejects wrong password', async () => {
    await registerUser(env.app, 'ada@example.com');

    const ok = await request(env.app)
      .post('/api/auth/login')
      .send({ email: 'ada@example.com', password: 'password123' });
    expect(ok.status).toBe(200);
    expect(ok.body.token).toBeTypeOf('string');

    const wrong = await request(env.app)
      .post('/api/auth/login')
      .send({ email: 'ada@example.com', password: 'wrong-password' });
    expect(wrong.status).toBe(401);

    const unknown = await request(env.app)
      .post('/api/auth/login')
      .send({ email: 'nobody@example.com', password: 'password123' });
    expect(unknown.status).toBe(401);
  });

  it('serves /me with a valid token and rejects missing/garbage tokens', async () => {
    const { token, user } = await registerUser(env.app, 'ada@example.com');

    const me = await request(env.app).get('/api/auth/me').set('Authorization', `Bearer ${token}`);
    expect(me.status).toBe(200);
    expect(me.body.user.id).toBe(user.id);

    expect((await request(env.app).get('/api/auth/me')).status).toBe(401);
    expect(
      (await request(env.app).get('/api/auth/me').set('Authorization', 'Bearer garbage')).status,
    ).toBe(401);
  });

  it('protects document routes behind auth', async () => {
    const res = await request(env.app).get('/api/documents');
    expect(res.status).toBe(401);
  });
});
