import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { getDatabase, MerchantRepository, SupportTicketRepository } from '@youpi/db';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// In production, reliably ensure environment variables from .env are loaded if not already provided
if (!process.env.BASE_PAYMENT_API_URL && typeof process.loadEnvFile === 'function') {
  try {
    const rootEnv = path.resolve(__dirname, '../../../.env');
    if (fs.existsSync(rootEnv)) {
      process.loadEnvFile(rootEnv);
    }
  } catch {}
}

function getJwtSecret() {
  return process.env.JWT_SECRET || process.env.ENCRYPTION_MASTER_KEY || 'youpi_pg_admin_secure_secret_key_change_me_in_prod_min_32_chars';
}

function parseCookies(cookieHeader) {
  const cookies = {};
  if (!cookieHeader) return cookies;
  const pairs = cookieHeader.split(';');
  for (const pair of pairs) {
    const idx = pair.indexOf('=');
    if (idx > 0) {
      const key = pair.substring(0, idx).trim();
      const val = pair.substring(idx + 1).trim();
      cookies[key] = decodeURIComponent(val);
    }
  }
  return cookies;
}

function createAdminToken(email, rememberMe = true) {
  const durationMs = rememberMe ? 30 * 24 * 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
  const payload = {
    email,
    role: 'admin',
    iat: Date.now(),
    exp: Date.now() + durationMs
  };
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', getJwtSecret()).update(payloadB64).digest('hex');
  return {
    token: `${payloadB64}.${sig}`,
    durationSeconds: Math.floor(durationMs / 1000),
    payload
  };
}

function verifyAdminToken(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payloadB64, sig] = parts;
  const expectedSig = crypto.createHmac('sha256', getJwtSecret()).update(payloadB64).digest('hex');
  if (sig.length !== expectedSig.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expectedSig, 'hex'))) {
    return null;
  }
  try {
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    if (payload.exp && Date.now() > payload.exp) {
      return null; // Expired
    }
    return payload;
  } catch {
    return null;
  }
}

function getSessionFromRequest(req) {
  // 1. Authorization header: Bearer <token>
  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.substring(7).trim();
    const verified = verifyAdminToken(token);
    if (verified) return verified;
  }
  // 2. Cookie header: youpi_admin_session=<token>
  const cookies = parseCookies(req.headers['cookie']);
  if (cookies.youpi_admin_session) {
    const verified = verifyAdminToken(cookies.youpi_admin_session);
    if (verified) return verified;
  }
  return null;
}

// In-memory brute force protection
const loginAttempts = new Map();
function checkRateLimit(ip) {
  const now = Date.now();
  const record = loginAttempts.get(ip);
  if (!record) return { allowed: true };
  if (record.lockedUntil && now < record.lockedUntil) {
    const remainingSec = Math.ceil((record.lockedUntil - now) / 1000);
    return { allowed: false, remainingSec };
  }
  if (record.lockedUntil && now >= record.lockedUntil) {
    loginAttempts.delete(ip);
    return { allowed: true };
  }
  return { allowed: true };
}

function recordFailedAttempt(ip) {
  const now = Date.now();
  const record = loginAttempts.get(ip) || { count: 0, lockedUntil: 0 };
  record.count += 1;
  if (record.count >= 5) {
    record.lockedUntil = now + 15 * 60 * 1000; // 15 min lockout
  }
  loginAttempts.set(ip, record);
}

function clearRateLimit(ip) {
  loginAttempts.delete(ip);
}

function verifyCredentials(inputEmail, inputPassword) {
  const envEmail = (process.env.ADMIN_EMAIL || process.env.INITIAL_ADMIN_EMAIL || 'admin@youpi.local').toLowerCase().trim();
  const envPass = process.env.ADMIN_PASSWORD || process.env.INITIAL_ADMIN_PASSWORD || 'AdminSecurePassword123!';

  const cleanInputEmail = (inputEmail || '').toLowerCase().trim();
  const cleanInputPass = inputPassword || '';

  // Double SHA-256 hash for constant-length timing-safe comparison
  const hashA = crypto.createHash('sha256').update(`${cleanInputEmail}:${cleanInputPass}`).digest();
  const hashB = crypto.createHash('sha256').update(`${envEmail}:${envPass}`).digest();

  return crypto.timingSafeEqual(hashA, hashB);
}

export class AdminServer {
  /**
   * @param {{
   *   db?: import('@youpi/db').Database,
   *   apiBaseUrl?: string
   * }} options
   */
  constructor(options = {}) {
    this.db = options.db || getDatabase();
    this.apiBaseUrl = options.apiBaseUrl || process.env.BASE_PAYMENT_API_URL || 'http://localhost:6100';
    this.merchantRepo = new MerchantRepository(this.db);
    this.ticketRepo = new SupportTicketRepository(this.db);
    this.htmlTemplatePath = path.join(__dirname, 'views', 'admin.html');
    this.loginTemplatePath = path.join(__dirname, 'views', 'login.html');
    this.template = fs.readFileSync(this.htmlTemplatePath, 'utf8');
  }

  renderHtml() {
    try {
      this.template = fs.readFileSync(this.htmlTemplatePath, 'utf8');
    } catch {}

    let html = this.template;
    // Always use empty string '' so client fetch calls hit the merchant admin's own /api proxy!
    // This completely eliminates CORS errors, tunnel downtime 530s, and cross-origin failures.
    const clientApiBase = '';
    html = html.replaceAll('{{API_BASE_URL}}', clientApiBase);
    html = html.replaceAll('{{ANDROID_ENROLLMENT_SECRET}}', process.env.ANDROID_ENROLLMENT_SECRET || 'android_pairing_enrollment_secret_key_32_chars');
    return html;
  }

  renderLoginHtml() {
    try {
      return fs.readFileSync(this.loginTemplatePath, 'utf8');
    } catch {
      return '<h1>Admin Login</h1>';
    }
  }

  createServer() {
    return http.createServer(async (req, res) => {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const pathname = url.pathname;

      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization'
        });
        res.end();
        return;
      }

      // Health Check (Always Public)
      if (pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'UP', service: 'merchant-admin' }));
        return;
      }

      // Public Login API: POST /api/admin/login
      if (pathname === '/api/admin/login' && req.method === 'POST') {
        const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress || '127.0.0.1';
        const rateCheck = checkRateLimit(ip);
        if (!rateCheck.allowed) {
          res.writeHead(429, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ 
            error: 'TOO_MANY_REQUESTS', 
            message: `Too many failed login attempts. Please try again after ${rateCheck.remainingSec} seconds.` 
          }));
          return;
        }

        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
          try {
            const { email, password, rememberMe } = JSON.parse(body || '{}');
            if (!email || !password) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'BAD_REQUEST', message: 'Email and password are required' }));
              return;
            }

            const isValid = verifyCredentials(email, password);
            if (!isValid) {
              recordFailedAttempt(ip);
              res.writeHead(401, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'INVALID_CREDENTIALS', message: 'Invalid admin email or password' }));
              return;
            }

            clearRateLimit(ip);
            const { token, durationSeconds } = createAdminToken(email, rememberMe !== false);
            const isSecure = (req.headers['x-forwarded-proto'] === 'https') || req.socket.encrypted;
            const cookieParts = [
              `youpi_admin_session=${token}`,
              'Path=/',
              'HttpOnly',
              'SameSite=Lax',
              `Max-Age=${durationSeconds}`
            ];
            if (isSecure) {
              cookieParts.push('Secure');
            }

            res.writeHead(200, {
              'Content-Type': 'application/json',
              'Set-Cookie': cookieParts.join('; ')
            });
            res.end(JSON.stringify({ success: true, email, token }));
          } catch (err) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'INVALID_JSON', message: err.message }));
          }
        });
        return;
      }

      // Public Logout API: POST /api/admin/logout or GET /logout
      if ((pathname === '/api/admin/logout' && req.method === 'POST') || (pathname === '/logout' && req.method === 'GET')) {
        const isSecure = (req.headers['x-forwarded-proto'] === 'https') || req.socket.encrypted;
        const cookieParts = [
          'youpi_admin_session=',
          'Path=/',
          'HttpOnly',
          'SameSite=Lax',
          'Max-Age=0'
        ];
        if (isSecure) {
          cookieParts.push('Secure');
        }

        if (pathname === '/logout') {
          res.writeHead(302, {
            'Location': '/login',
            'Set-Cookie': cookieParts.join('; ')
          });
          res.end();
          return;
        }

        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Set-Cookie': cookieParts.join('; ')
        });
        res.end(JSON.stringify({ success: true, message: 'Logged out successfully' }));
        return;
      }

      // Login Page: GET /login
      if (pathname === '/login') {
        const session = getSessionFromRequest(req);
        if (session) {
          res.writeHead(302, { 'Location': '/admin' });
          res.end();
          return;
        }

        const html = this.renderLoginHtml();
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-cache'
        });
        res.end(html);
        return;
      }

      // Download Android Companion APK (Public)
      if (pathname === '/youpi-sms-gateway.apk' || pathname === '/api/v1/admin/sms-gateway/download-apk') {
        const apkCandidates = [
          path.resolve(__dirname, '../public/youpi-sms-gateway.apk'),
          path.resolve(__dirname, '../../payment-api/public/youpi-sms-gateway.apk'),
          path.resolve(__dirname, '../../android-observer-app/youpi-sms-gateway.apk')
        ];
        let apkPath = null;
        for (const p of apkCandidates) {
          if (fs.existsSync(p)) {
            apkPath = p;
            break;
          }
        }
        if (apkPath) {
          const stat = fs.statSync(apkPath);
          res.writeHead(200, {
            'Content-Type': 'application/vnd.android.package-archive',
            'Content-Disposition': 'attachment; filename="youpi-sms-gateway.apk"',
            'Content-Length': stat.size,
            'Access-Control-Allow-Origin': '*'
          });
          const stream = fs.createReadStream(apkPath);
          stream.pipe(res);
          return;
        }
      }

      // Require authentication for all Admin APIs
      if (pathname.startsWith('/api/')) {
        const session = getSessionFromRequest(req);
        if (!session) {
          res.writeHead(401, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          });
          res.end(JSON.stringify({
            error: 'UNAUTHORIZED',
            message: 'Admin authentication required. Please sign in.'
          }));
          return;
        }
      }

      // Admin Tickets API: GET /api/admin/tickets
      if (pathname === '/api/admin/tickets') {
        const merchants = this.merchantRepo.findAll();
        const mId = merchants[0]?.id || '00000000-0000-0000-0000-000000000001';
        const tickets = this.ticketRepo.findTicketsByMerchant(mId);

        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        });
        res.end(JSON.stringify(tickets));
        return;
      }

      // Merged Control Center Supervisor Proxy: /api/services/* and /api/logs/stream -> Control Center on port 8090
      if (pathname.startsWith('/api/services') || pathname === '/api/logs/stream') {
        const ccPort = Number(process.env.CONTROL_CENTER_PORT || 8090);
        const proxyReq = http.request({
          hostname: '127.0.0.1',
          port: ccPort,
          path: req.url,
          method: req.method,
          headers: {
            ...req.headers,
            host: `localhost:${ccPort}`
          }
        }, (proxyRes) => {
          res.writeHead(proxyRes.statusCode, proxyRes.headers);
          proxyRes.pipe(res);
        });

        proxyReq.on('error', (err) => {
          if (!res.headersSent) {
            res.writeHead(502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Control center supervisor unavailable', details: err.message }));
          }
        });

        req.on('data', chunk => proxyReq.write(chunk));
        req.on('end', () => proxyReq.end());
        return;
      }

      // Transparent API Proxy: /api/* -> Payment Core REST API
      if (pathname.startsWith('/api/')) {
        const targetPort = Number(process.env.PAYMENT_API_PORT || 6100);
        const defaultMerchant = this.merchantRepo.getDefault ? this.merchantRepo.getDefault() : (this.merchantRepo.findById('00000000-0000-0000-0000-000000000001') || this.merchantRepo.findAll()[0]);
        const defaultMerchantId = defaultMerchant?.id || '00000000-0000-0000-0000-000000000001';
        const proxyReq = http.request({
          hostname: '127.0.0.1',
          port: targetPort,
          path: req.url,
          method: req.method,
          headers: {
            ...req.headers,
            'x-merchant-id': req.headers['x-merchant-id'] || defaultMerchantId,
            host: `localhost:${targetPort}`,
            'x-forwarded-host': req.headers.host || '',
            'x-forwarded-proto': req.headers['x-forwarded-proto'] || 'http'
          }
        }, (proxyRes) => {
          res.writeHead(proxyRes.statusCode, proxyRes.headers);
          proxyRes.pipe(res);
        });

        proxyReq.on('error', (err) => {
          if (!res.headersSent) {
            res.writeHead(502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Gateway API unavailable', details: err.message }));
          }
        });

        req.pipe(proxyReq);
        return;
      }

      // Dashboard View: GET / or GET /admin (Protected)
      if (pathname === '/' || pathname === '/admin') {
        const session = getSessionFromRequest(req);
        if (!session) {
          res.writeHead(302, { 'Location': '/login' });
          res.end();
          return;
        }

        const html = this.renderHtml();
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-cache'
        });
        res.end(html);
        return;
      }

      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Admin Route Not Found');
    });
  }
}
