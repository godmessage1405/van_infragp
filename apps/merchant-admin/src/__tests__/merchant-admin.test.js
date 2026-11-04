import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Database } from '@youpi/db';
import { startAdminServer } from '../index.js';

describe('Merchant Admin Integration Tests', () => {
  let serverInstance;
  let baseUrl;
  let testDb;
  let sessionCookie = null;

  before(async () => {
    process.env.INITIAL_ADMIN_EMAIL = 'admin@youpi.local';
    process.env.INITIAL_ADMIN_PASSWORD = 'AdminSecurePassword123!';
    testDb = new Database({ inMemory: true });
    serverInstance = await startAdminServer(6101, { db: testDb });
    baseUrl = `http://localhost:${serverInstance.port}`;
  });

  after(async () => {
    await serverInstance.close();
    testDb.close();
  });

  function request(method, path, body = null, headers = {}) {
    return new Promise((resolve, reject) => {
      const u = new URL(path, baseUrl);
      const reqHeaders = { ...headers };
      let postData = null;

      if (body) {
        postData = typeof body === 'string' ? body : JSON.stringify(body);
        reqHeaders['Content-Type'] = 'application/json';
        reqHeaders['Content-Length'] = Buffer.byteLength(postData);
      }

      if (sessionCookie && !reqHeaders['Cookie']) {
        reqHeaders['Cookie'] = sessionCookie;
      }

      const req = http.request({
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method,
        headers: reqHeaders
      }, res => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          resolve({ status: res.statusCode, headers: res.headers, text: data });
        });
      });

      req.on('error', reject);
      if (postData) req.write(postData);
      req.end();
    });
  }

  test('GET /health returns UP', async () => {
    const res = await request('GET', '/health');
    assert.equal(res.status, 200);
    const json = JSON.parse(res.text);
    assert.equal(json.status, 'UP');
    assert.equal(json.service, 'merchant-admin');
  });

  test('Unauthenticated GET / redirects 302 to /login', async () => {
    const res = await request('GET', '/');
    assert.equal(res.status, 302);
    assert.equal(res.headers.location, '/login');
  });

  test('GET /login renders high-security login page', async () => {
    const res = await request('GET', '/login');
    assert.equal(res.status, 200);
    assert.ok(res.text.includes('Sign In to Admin Panel'));
    assert.ok(res.text.includes('Master Password'));
  });

  test('POST /api/admin/login fails with invalid credentials', async () => {
    const res = await request('POST', '/api/admin/login', {
      email: 'admin@youpi.local',
      password: 'WrongPassword!'
    });
    assert.equal(res.status, 401);
    const json = JSON.parse(res.text);
    assert.equal(json.error, 'INVALID_CREDENTIALS');
  });

  test('POST /api/admin/login succeeds with valid credentials and sets session cookie', async () => {
    const res = await request('POST', '/api/admin/login', {
      email: 'admin@youpi.local',
      password: 'AdminSecurePassword123!'
    });
    assert.equal(res.status, 200);
    const json = JSON.parse(res.text);
    assert.equal(json.success, true);
    assert.ok(json.token);

    const setCookie = res.headers['set-cookie'];
    assert.ok(setCookie);
    const cookieStr = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    assert.ok(cookieStr.includes('youpi_admin_session='));
    assert.ok(cookieStr.includes('HttpOnly'));

    // Save cookie for subsequent authenticated tests
    sessionCookie = cookieStr.split(';')[0];
  });

  test('Authenticated GET / renders dashboard with queue monitor, observers & controls', async () => {
    const res = await request('GET', '/');
    assert.equal(res.status, 200);
    assert.ok(res.headers['content-type'].includes('text/html'));

    assert.ok(res.text.includes('Real-Time Receiving Account Slot Ownership'));
    assert.ok(res.text.includes('Active Slot (5-Minute Window)'));
    assert.ok(res.text.includes('Processing Slot (30s Verification Window)'));
    assert.ok(res.text.includes('Live Counter Payment Requests'));
    assert.ok(res.text.includes('Payment Observers (SMS & Gmail)'));
    assert.ok(res.text.includes('Android SMS Gateway'));
    assert.ok(res.text.includes('Gmail Direct API'));
    assert.ok(res.text.includes('logoutAdmin()'));
  });

  test('Authenticated GET /api/admin/tickets returns tickets array', async () => {
    const res = await request('GET', '/api/admin/tickets');
    assert.equal(res.status, 200);
    const json = JSON.parse(res.text);
    assert.ok(Array.isArray(json));
  });

  test('POST /api/admin/logout clears session', async () => {
    const res = await request('POST', '/api/admin/logout');
    assert.equal(res.status, 200);
    const setCookie = res.headers['set-cookie'];
    const cookieStr = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    assert.ok(cookieStr.includes('Max-Age=0'));
  });
});
