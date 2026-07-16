import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { resolveWsAccess } from '../src/ws/auth.js';
import { createTestEnv, registerUser, TEST_JWT_SECRET, type TestEnv, type TestUser } from './helpers.js';

describe('document permissions', () => {
  let env: TestEnv;
  let owner: TestUser;
  let other: TestUser;
  let docId: string;

  beforeEach(async () => {
    env = await createTestEnv();
    owner = await registerUser(env.app, 'owner@example.com', 'Owner');
    other = await registerUser(env.app, 'other@example.com', 'Other');
    const res = await request(env.app)
      .post('/api/documents')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ title: 'Design doc' });
    expect(res.status).toBe(201);
    docId = res.body.id;
  });

  const as = (u: TestUser) => ({ Authorization: `Bearer ${u.token}` });

  it('owner can read, rename and delete; document appears in their list', async () => {
    const list = await request(env.app).get('/api/documents').set(as(owner));
    expect(list.body).toHaveLength(1);
    expect(list.body[0].role).toBe('owner');

    const renamed = await request(env.app).patch(`/api/documents/${docId}`).set(as(owner)).send({ title: 'v2' });
    expect(renamed.status).toBe(200);
    expect(renamed.body.title).toBe('v2');

    const del = await request(env.app).delete(`/api/documents/${docId}`).set(as(owner));
    expect(del.status).toBe(204);
    expect((await request(env.app).get(`/api/documents/${docId}`).set(as(owner))).status).toBe(404);
  });

  it('a non-shared user has no access at all', async () => {
    expect((await request(env.app).get(`/api/documents/${docId}`).set(as(other))).status).toBe(403);
    expect((await request(env.app).get(`/api/documents/${docId}/snapshots`).set(as(other))).status).toBe(403);
    const list = await request(env.app).get('/api/documents').set(as(other));
    expect(list.body).toHaveLength(0);
  });

  it('viewer can read but cannot write, rename, share or snapshot', async () => {
    const share = await request(env.app)
      .put(`/api/documents/${docId}/shares`)
      .set(as(owner))
      .send({ email: 'other@example.com', permission: 'viewer' });
    expect(share.status).toBe(200);

    expect((await request(env.app).get(`/api/documents/${docId}`).set(as(other))).body.role).toBe('viewer');
    expect((await request(env.app).get(`/api/documents/${docId}/snapshots`).set(as(other))).status).toBe(200);

    expect((await request(env.app).patch(`/api/documents/${docId}`).set(as(other)).send({ title: 'x' })).status).toBe(403);
    expect((await request(env.app).post(`/api/documents/${docId}/snapshots`).set(as(other)).send({})).status).toBe(403);
    expect(
      (
        await request(env.app)
          .put(`/api/documents/${docId}/shares`)
          .set(as(other))
          .send({ email: 'owner@example.com', permission: 'editor' })
      ).status,
    ).toBe(403);
    expect((await request(env.app).delete(`/api/documents/${docId}`).set(as(other))).status).toBe(403);
  });

  it('editor can snapshot/restore but not rename, share or delete', async () => {
    await request(env.app)
      .put(`/api/documents/${docId}/shares`)
      .set(as(owner))
      .send({ email: 'other@example.com', permission: 'editor' });

    const snap = await request(env.app)
      .post(`/api/documents/${docId}/snapshots`)
      .set(as(other))
      .send({ label: 'from editor' });
    expect(snap.status).toBe(201);

    const restore = await request(env.app)
      .post(`/api/documents/${docId}/snapshots/${snap.body.id}/restore`)
      .set(as(other))
      .send({});
    expect(restore.status).toBe(200);

    expect((await request(env.app).patch(`/api/documents/${docId}`).set(as(other)).send({ title: 'x' })).status).toBe(403);
    expect((await request(env.app).delete(`/api/documents/${docId}`).set(as(other))).status).toBe(403);
    expect((await request(env.app).get(`/api/documents/${docId}/shares`).set(as(other))).status).toBe(403);
  });

  it('upgrading a share overwrites the permission; removing revokes access', async () => {
    await request(env.app)
      .put(`/api/documents/${docId}/shares`)
      .set(as(owner))
      .send({ email: 'other@example.com', permission: 'viewer' });
    await request(env.app)
      .put(`/api/documents/${docId}/shares`)
      .set(as(owner))
      .send({ email: 'other@example.com', permission: 'editor' });

    expect(await env.storage.getRole(docId, other.user.id)).toBe('editor');

    await request(env.app).delete(`/api/documents/${docId}/shares/${other.user.id}`).set(as(owner));
    expect(await env.storage.getRole(docId, other.user.id)).toBeNull();
    expect((await request(env.app).get(`/api/documents/${docId}`).set(as(other))).status).toBe(403);
  });

  it('sharing with an unknown email or with the owner fails cleanly', async () => {
    const unknown = await request(env.app)
      .put(`/api/documents/${docId}/shares`)
      .set(as(owner))
      .send({ email: 'ghost@example.com', permission: 'viewer' });
    expect(unknown.status).toBe(404);

    const self = await request(env.app)
      .put(`/api/documents/${docId}/shares`)
      .set(as(owner))
      .send({ email: 'owner@example.com', permission: 'editor' });
    expect(self.status).toBe(400);
  });

  describe('WebSocket access (resolveWsAccess)', () => {
    it('grants write access to owner and editor, read-only to viewer', async () => {
      const ownerAccess = await resolveWsAccess(env.storage, TEST_JWT_SECRET, owner.token, docId);
      expect(ownerAccess).toMatchObject({ role: 'owner', canWrite: true });

      await env.storage.upsertShare(docId, other.user.id, 'viewer');
      const viewerAccess = await resolveWsAccess(env.storage, TEST_JWT_SECRET, other.token, docId);
      expect(viewerAccess).toMatchObject({ role: 'viewer', canWrite: false });

      await env.storage.upsertShare(docId, other.user.id, 'editor');
      const editorAccess = await resolveWsAccess(env.storage, TEST_JWT_SECRET, other.token, docId);
      expect(editorAccess).toMatchObject({ role: 'editor', canWrite: true });
    });

    it('rejects missing/invalid tokens, unshared users and unknown documents', async () => {
      expect(await resolveWsAccess(env.storage, TEST_JWT_SECRET, null, docId)).toBeNull();
      expect(await resolveWsAccess(env.storage, TEST_JWT_SECRET, 'garbage', docId)).toBeNull();
      expect(await resolveWsAccess(env.storage, TEST_JWT_SECRET, other.token, docId)).toBeNull();
      expect(await resolveWsAccess(env.storage, TEST_JWT_SECRET, owner.token, 'no-such-doc')).toBeNull();
    });
  });
});
