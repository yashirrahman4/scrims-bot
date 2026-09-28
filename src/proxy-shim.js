'use strict';
// Preload shim: routes all Discord-bound traffic through the egress proxy.
// Load with: node -r ./src/proxy-shim.js src/index.js
// Safe to load when no proxy is configured (becomes a no-op).

const proxyUrl =
  process.env.HTTPS_PROXY ||
  process.env.https_proxy ||
  process.env.HTTP_PROXY ||
  process.env.http_proxy;

if (!proxyUrl) {
  return;
}

function isLocalHost(hostname) {
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname.startsWith('127.') ||
    hostname.startsWith('10.') ||
    hostname.startsWith('192.168.') ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(hostname)
  );
}

// --- 1) undici (discord.js REST + global fetch) -> env proxy dispatcher ---
try {
  const { EnvHttpProxyAgent, setGlobalDispatcher } = require('undici');
  setGlobalDispatcher(new EnvHttpProxyAgent());
  console.log('[proxy-shim] undici global dispatcher -> proxy');
} catch (err) {
  console.warn('[proxy-shim] undici dispatcher not set:', err.message);
}

// --- 2) `ws` package (discord.js gateway) -> inject proxy agent ---
try {
  const { HttpsProxyAgent } = require('https-proxy-agent');
  const agent = new HttpsProxyAgent(proxyUrl);
  const wsPath = require.resolve('ws');
  const wsModule = require(wsPath);
  const Original = wsModule.WebSocket || wsModule;

  function ProxiedWebSocket(url, protocols, options) {
    const opts = { ...(options || {}) };
    try {
      const hostname = new URL(url).hostname;
      if (!isLocalHost(hostname) && !opts.agent) {
        opts.agent = agent;
      }
    } catch {
      if (!opts.agent) opts.agent = agent;
    }
    return new Original(url, protocols, opts);
  }
  ProxiedWebSocket.prototype = Original.prototype;
  Object.setPrototypeOf(ProxiedWebSocket, Original);
  // preserve static props (Server, WebSocket, constants...)
  for (const key of Object.getOwnPropertyNames(Original)) {
    if (!(key in ProxiedWebSocket)) {
      try {
        ProxiedWebSocket[key] = Original[key];
      } catch { /* ignore */ }
    }
  }
  ProxiedWebSocket.WebSocket = ProxiedWebSocket;

  if (require.cache[wsPath]) {
    require.cache[wsPath].exports = ProxiedWebSocket;
  }
  console.log('[proxy-shim] ws WebSocket constructor patched -> proxy');
} catch (err) {
  console.warn('[proxy-shim] ws patch not applied:', err.message);
}
