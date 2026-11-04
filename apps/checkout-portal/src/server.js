import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateQrSvg } from './qr.js';

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

export class CheckoutServer {
  /**
   * @param {{
   *   apiBaseUrl?: string,
   *   helpPortalUrl?: string
   * }} options
   */
  constructor(options = {}) {
    try {
      const rootEnv = path.resolve(__dirname, '../../../.env');
      if (fs.existsSync(rootEnv)) {
        const raw = fs.readFileSync(rootEnv, 'utf8');
        for (const line of raw.split(/\r?\n/)) {
          const trimmed = line.trim();
          if (trimmed.startsWith('BASE_PAYMENT_API_URL=')) {
            const val = trimmed.split('=')[1]?.trim();
            if (val) process.env.BASE_PAYMENT_API_URL = val.replace(/^["']|["']$/g, '');
          }
        }
      }
    } catch {}

    this.apiBaseUrl = options.apiBaseUrl || process.env.BASE_PAYMENT_API_URL || 'http://localhost:6100';
    this.htmlTemplatePath = path.join(__dirname, 'views', 'checkout.html');
    this.directPayTemplatePath = path.join(__dirname, 'views', 'direct-pay.html');
    this.sdkScriptPath = path.join(__dirname, 'sdk', 'youpi-checkout.js');
    this.template = fs.readFileSync(this.htmlTemplatePath, 'utf8');
  }

  renderNotFoundHtml(paymentId) {
    const appName = process.env.GATEWAY_TITLE || 'Infravan PG';
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Payment Session Not Found | ${appName}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0b1329; color: #f8fafc; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 20px; box-sizing: border-box; }
    .card { background: #111d3d; border: 1px solid #1e293b; border-radius: 20px; padding: 40px 28px; max-width: 440px; width: 100%; text-align: center; box-shadow: 0 25px 50px -12px rgba(0,0,0,0.5); }
    .icon { font-size: 52px; margin-bottom: 16px; line-height: 1; }
    h1 { font-size: 21px; margin: 0 0 10px; font-weight: 700; color: #fff; }
    p { font-size: 14px; color: #94a3b8; margin: 0 0 22px; line-height: 1.5; }
    .session-id { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; background: #070d1e; padding: 8px 12px; border-radius: 8px; color: #38bdf8; word-break: break-all; margin-bottom: 24px; border: 1px solid #1e293b; }
    .btn { display: inline-block; background: #fe932c; color: #fff; text-decoration: none; font-weight: 600; padding: 12px 28px; border-radius: 10px; font-size: 14px; transition: transform 0.15s, opacity 0.15s; }
    .btn:hover { opacity: 0.92; transform: translateY(-1px); }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">⌛</div>
    <h1>Payment Session Not Found</h1>
    <p>This payment link is invalid, has already completed, or has expired after the checkout window.</p>
    <div class="session-id">Session: ${paymentId}</div>
    <a href="/" class="btn">Create New Payment</a>
  </div>
</body>
</html>`;
  }

  renderDirectPayHtml() {
    try {
      let html = fs.readFileSync(this.directPayTemplatePath, 'utf8');
      const appName = process.env.GATEWAY_TITLE || 'Infravan PG';
      const merchantName = process.env.MERCHANT_BUSINESS_NAME || 'Infravan Technologies';
      html = html.replaceAll('{{APP_NAME}}', appName);
      html = html.replaceAll('{{MERCHANT_NAME}}', merchantName);
      return html;
    } catch {
      return '<h1>Direct Pay Portal</h1>';
    }
  }

  async fetchPaymentState(paymentId) {
    try {
      const internalPort = process.env.PAYMENT_API_PORT || 6100;
      const res = await fetch(`http://127.0.0.1:${internalPort}/api/v1/checkout/${paymentId}/state`, {
        headers: { 'X-Internal-Render': 'true' }
      });
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  }

  renderHtml(paymentId, state) {
    try {
      this.template = fs.readFileSync(this.htmlTemplatePath, 'utf8');
    } catch {}

    let html = this.template;

    const appName = state?.branding?.appName || 'Infravan PG';
    const primaryColor = state?.branding?.primaryColor || '#fe932c';
    const merchantName = state?.merchantName || 'Merchant Checkout';
    const orderId = state?.orderId || '';
    const logoUrl = state?.branding?.logoUrl || '';
    const sidebarNotice = state?.branding?.sidebarNotice || 'Fast & Secure 256-Bit Encrypted Payments';
    const counterInstructions = state?.branding?.counterInstructions || 'Please visit the billing counter and present this screen to the cashier.';
    const vpa = state?.payeeVpa || state?.vpa || 'merchant@upi';

    // In production and localhost, use relative '' so browser requests hit the checkout portal /api proxy
    // This avoids cross-origin blocking, CORS errors, and tunnel DNS resolution issues.
    const clientApiBase = '';

    const indicator = state?.upiServerIndicator || { status: 'ISSUES', tier: 'RED', label: 'Server Facing Issues' };
    const tier = indicator.tier || (indicator.status === 'WORKING' ? 'GREEN' : (indicator.status === 'BUSY' ? 'YELLOW' : 'RED'));
    const healthClass = tier === 'GREEN' ? 'is-working' : (tier === 'YELLOW' ? 'is-busy' : 'is-issues');
    const healthLabel = indicator.label || (tier === 'GREEN' ? 'Server Is Working' : (tier === 'YELLOW' ? 'UPI Server Busy' : 'Server Facing Issues'));
    const alertStyle = tier === 'GREEN' ? 'none' : 'flex';
    const alertClass = tier === 'YELLOW' ? 'ypg-downtime-alert is-warning' : 'ypg-downtime-alert';
    const alertHeading = tier === 'YELLOW' ? 'UPI Server Busy' : 'UPI Server Facing Issues';
    const alertMsg = indicator.warning || (tier === 'YELLOW'
      ? 'Your payment may go through extra processing seconds.'
      : 'It is not recommended to pay by UPI right now as the server is facing downtime. We recommend paying by cash instead.');

    const sellingMode = state?.sellingMode || state?.branding?.sellingMode || 'ONLINE';
    const enabledMethods = state?.enabledMethods || state?.branding?.enabledPaymentMethods || ['UPI'];
    const showMethodBar = (enabledMethods && enabledMethods.length > 1) ? 'flex' : 'none';
    const tabCodStyle = (sellingMode === 'ONLINE' && enabledMethods.includes('COD')) ? 'display:inline-flex;' : 'display:none;';
    const tabCashStyle = (sellingMode === 'OFFLINE' && enabledMethods.includes('CASH_COUNTER')) ? 'display:inline-flex;' : 'display:none;';
    const tabCardStyle = (sellingMode === 'OFFLINE' && enabledMethods.includes('CARD_COUNTER')) ? 'display:inline-flex;' : 'display:none;';
    const pcCodStyle = (sellingMode === 'ONLINE' && enabledMethods.includes('COD')) ? 'display:block;' : 'display:none;';
    const pcCashStyle = (sellingMode === 'OFFLINE' && enabledMethods.includes('CASH_COUNTER')) ? 'display:block;' : 'display:none;';
    const pcCardStyle = (sellingMode === 'OFFLINE' && enabledMethods.includes('CARD_COUNTER')) ? 'display:block;' : 'display:none;';

    const downtimeAltBtnDisplay = ((sellingMode === 'ONLINE' && enabledMethods.includes('COD')) || (sellingMode === 'OFFLINE' && enabledMethods.includes('CASH_COUNTER'))) ? 'inline-block' : 'none';
    const downtimeAltBtnLabel = (sellingMode === 'ONLINE') ? 'Pay via Cash on Delivery Instead' : 'Pay by Cash at Till Instead';

    html = html.replaceAll('{{PAYMENT_ID}}', paymentId);
    html = html.replaceAll('{{API_BASE_URL}}', clientApiBase);
    html = html.replaceAll('{{APP_NAME}}', appName);
    html = html.replaceAll('{{PRIMARY_COLOR}}', primaryColor);
    html = html.replaceAll('{{MERCHANT_NAME}}', merchantName);
    html = html.replaceAll('{{ORDER_ID}}', orderId);
    html = html.replaceAll('{{AMOUNT}}', state?.amount || '0.00');
    html = html.replaceAll('{{VPA}}', vpa);
    html = html.replaceAll('{{LOGO_URL}}', logoUrl);
    html = html.replaceAll('{{SIDEBAR_NOTICE}}', sidebarNotice);
    html = html.replaceAll('{{COUNTER_INSTRUCTIONS}}', counterInstructions);
    html = html.replaceAll('{{SERVER_HEALTH_CLASS}}', healthClass);
    html = html.replaceAll('{{SERVER_HEALTH_LABEL}}', healthLabel);
    html = html.replaceAll('{{DOWNTIME_ALERT_STYLE}}', alertStyle);
    html = html.replaceAll('{{DOWNTIME_ALERT_CLASS}}', alertClass);
    html = html.replaceAll('{{DOWNTIME_HEADING}}', alertHeading);
    html = html.replaceAll('{{DOWNTIME_MSG}}', alertMsg);
    html = html.replaceAll('{{METHOD_SELECTOR_DISPLAY}}', showMethodBar);
    html = html.replaceAll('{{TAB_COD_STYLE}}', tabCodStyle);
    html = html.replaceAll('{{TAB_CASH_STYLE}}', tabCashStyle);
    html = html.replaceAll('{{TAB_CARD_STYLE}}', tabCardStyle);
    html = html.replaceAll('{{PC_COD_STYLE}}', pcCodStyle);
    html = html.replaceAll('{{PC_CASH_STYLE}}', pcCashStyle);
    html = html.replaceAll('{{PC_CARD_STYLE}}', pcCardStyle);
    html = html.replaceAll('{{DOWNTIME_ALT_BTN_DISPLAY}}', downtimeAltBtnDisplay);
    html = html.replaceAll('{{DOWNTIME_ALT_BTN_LABEL}}', downtimeAltBtnLabel);
    html = html.replaceAll('{{INITIAL_STATE_JSON}}', JSON.stringify(state || {}).replaceAll('<', '\\u003c'));

    return html;
  }

  createServer() {
    return http.createServer(async (req, res) => {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const pathname = url.pathname;

      // Health
      if (pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'UP', service: 'checkout-portal' }));
        return;
      }

      // Transparent API Proxy: /api/* -> Payment Core REST API
      if (pathname.startsWith('/api/')) {
        const targetPort = Number(process.env.PAYMENT_API_PORT || 6100);
        const proxyReq = http.request({
          hostname: '127.0.0.1',
          port: targetPort,
          path: req.url,
          method: req.method,
          headers: {
            ...req.headers,
            host: `localhost:${targetPort}`,
            'x-forwarded-host': req.headers.host || '',
            'x-forwarded-proto': req.headers['x-forwarded-proto'] || 'https'
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

      // Official SDK script: GET /youpi.js or /sdk/youpi-checkout.js
      if (pathname === '/youpi.js' || pathname === '/sdk/youpi.js' || pathname === '/sdk/youpi-checkout.js') {
        try {
          const resolvedSdkPath = fs.existsSync(path.join(__dirname, 'sdk', 'youpi.js'))
            ? path.join(__dirname, 'sdk', 'youpi.js')
            : this.sdkScriptPath;
          const sdkContent = fs.readFileSync(resolvedSdkPath, 'utf8');
          res.writeHead(200, {
            'Content-Type': 'application/javascript; charset=utf-8',
            'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0',
            'Pragma': 'no-cache',
            'Expires': '0',
            'Access-Control-Allow-Origin': '*'
          });
          res.end(sdkContent);
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end('Error loading SDK: ' + err.message);
        }
        return;
      }

      // Static icons: GET /icons/:filename
      if (pathname.startsWith('/icons/')) {
        const iconName = path.basename(pathname);
        const iconPath = path.join(__dirname, '..', 'public', 'icons', iconName);
        if (fs.existsSync(iconPath)) {
          const ext = path.extname(iconName).toLowerCase();
          const contentType = ext === '.png' ? 'image/png' : ext === '.svg' ? 'image/svg+xml' : 'image/jpeg';
          res.writeHead(200, {
            'Content-Type': contentType,
            'Cache-Control': 'public, max-age=86400',
            'Access-Control-Allow-Origin': '*'
          });
          fs.createReadStream(iconPath).pipe(res);
          return;
        }
      }

      // QR SVG: GET /checkout/:id/qr.svg (Direct from merchant receiving account)
      const qrMatch = pathname.match(/^\/checkout\/([^/]+)\/qr\.svg$/);
      if (qrMatch) {
        const paymentId = qrMatch[1];
        const state = await this.fetchPaymentState(paymentId);
        const upiUri = state?.upiUri || `upi://pay?pa=${encodeURIComponent(state?.payeeVpa || 'merchant@upi')}&pn=${encodeURIComponent(state?.merchantName || 'Store')}&am=${encodeURIComponent(state?.amount || '100.00')}&tn=${encodeURIComponent(paymentId)}`;

        const svg = generateQrSvg(upiUri, 220);
        res.writeHead(200, {
          'Content-Type': 'image/svg+xml',
          'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0',
          'Pragma': 'no-cache',
          'Expires': '0',
          'Access-Control-Allow-Origin': '*'
        });
        res.end(svg);
        return;
      }

      // Direct Pay Portal: GET / or GET /pay or GET /direct-pay
      if (pathname === '/' || pathname === '/pay' || pathname === '/direct-pay') {
        const rendered = this.renderDirectPayHtml();
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0',
          'Pragma': 'no-cache',
          'Expires': '0',
          'Access-Control-Allow-Origin': '*'
        });
        res.end(rendered);
        return;
      }

      // Checkout Page: GET /checkout/:id
      const checkoutMatch = pathname.match(/^\/checkout\/([^/]+)$/);
      if (checkoutMatch) {
        const paymentId = checkoutMatch[1];
        const state = await this.fetchPaymentState(paymentId);

        const rendered = this.renderHtml(paymentId, state);
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0',
          'Pragma': 'no-cache',
          'Expires': '0',
          'Access-Control-Allow-Origin': '*'
        });
        res.end(rendered);
        return;
      }

      // Not found
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Checkout Page Not Found');
    });
  }
}
