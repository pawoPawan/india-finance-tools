/**
 * MF Analyzer — Cloudflare Worker CORS Proxy
 * Deploy: wrangler deploy
 * This worker proxies requests to Morningstar APIs and adds CORS headers
 * so the static GitHub Pages app can call them from the browser.
 *
 * Setup:
 *   1. npm install -g wrangler
 *   2. wrangler login
 *   3. wrangler deploy proxy.js --name mf-proxy
 *   4. Copy the worker URL (e.g. https://mf-proxy.YOUR.workers.dev)
 *   5. Paste it into the MF Analyzer app's Setup screen
 */

const ALLOWED_DOMAINS = [
  'morningstar.com',
  'morningstar.in',
  'apac-api.morningstar.com',
  'us-api.morningstar.com',
  'www.morningstar.in',
];

const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Max-Age':       '86400',
};

export default {
  async fetch(request, env, ctx) {
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);

    // Health check
    if (url.pathname === '/health') {
      return new Response(JSON.stringify({ ok: true, ts: Date.now() }), {
        headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
      });
    }

    // Target URL via ?url= param
    const targetEncoded = url.searchParams.get('url');
    if (!targetEncoded) {
      return new Response(JSON.stringify({ error: 'Missing ?url= parameter' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
      });
    }

    let targetUrl;
    try {
      targetUrl = decodeURIComponent(targetEncoded);
      new URL(targetUrl); // validate
    } catch {
      return new Response(JSON.stringify({ error: 'Invalid target URL' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
      });
    }

    // Only allow Morningstar domains
    const targetHost = new URL(targetUrl).hostname;
    const allowed = ALLOWED_DOMAINS.some(d =>
      targetHost === d || targetHost.endsWith('.' + d)
    );
    if (!allowed) {
      return new Response(JSON.stringify({ error: `Domain not allowed: ${targetHost}` }), {
        status: 403,
        headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
      });
    }

    // Forward all headers except Cloudflare-injected ones
    const skipHeaders = new Set([
      'host', 'cf-connecting-ip', 'cf-ipcountry', 'cf-ray',
      'cf-visitor', 'x-forwarded-for', 'x-forwarded-proto',
      'x-real-ip', 'cdn-loop',
    ]);
    const fwdHeaders = {};
    for (const [k, v] of request.headers) {
      if (!skipHeaders.has(k.toLowerCase()) && !k.startsWith('cf-')) {
        fwdHeaders[k] = v;
      }
    }

    try {
      const body = ['GET', 'HEAD'].includes(request.method) ? undefined : request.body;
      const resp = await fetch(targetUrl, {
        method:  request.method,
        headers: fwdHeaders,
        body,
        redirect: 'follow',
      });

      // Build response headers: copy target headers + add CORS
      const outHeaders = { ...CORS_HEADERS };
      for (const [k, v] of resp.headers) {
        const kl = k.toLowerCase();
        if (!kl.startsWith('access-control-') && kl !== 'x-frame-options') {
          outHeaders[k] = v;
        }
      }

      return new Response(resp.body, {
        status:  resp.status,
        headers: outHeaders,
      });
    } catch (e) {
      return new Response(JSON.stringify({ error: `Proxy fetch error: ${e.message}` }), {
        status: 502,
        headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
      });
    }
  },
};
