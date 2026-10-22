'use strict';

// The loopback hop a Claude spawn's ANTHROPIC_BASE_URL points at when its
// provider carries a dedicated-egress binding (`provider.egressBinding`, see
// providers.updateProvider). Two sides have to agree on the exact shape and they
// live in different layers — the spawn side (providers/core.js builds the URL in
// claudeRoutingProviderView) and the HTTP side (src/claude-auth/egress-forwarder
// serves it) — so the shape lives here instead of being written down twice.
//
// No dependencies: providers/core.js requires this before anything else exists,
// and the forwarder's mount() is what tells it the real listening port (PORT is
// computed from network-policy in server.js, not read from the environment).
const PREFIX = '/claude-egress';
const ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;

let port = Number.parseInt(process.env.PORT || '3000', 10) || 3000;

function setPort(value) {
  const next = Number.parseInt(value, 10);
  if (Number.isInteger(next) && next > 0 && next < 65536) port = next;
}

function baseUrlFor(providerId) {
  return `http://127.0.0.1:${port}${PREFIX}/${encodeURIComponent(providerId)}`;
}

// '/<providerId>/v1/messages?beta=true' → { providerId, path: '/v1/messages', query: '?beta=true' }
// Everything after the provider id is the upstream API path, kept verbatim (the
// provider id is the only segment this hop owns).
function parseRequestPath(url) {
  const raw = typeof url === 'string' ? url : '';
  const at = raw.indexOf('?');
  const pathname = at === -1 ? raw : raw.slice(0, at);
  const query = at === -1 ? '' : raw.slice(at);
  const parts = pathname.split('/').filter(Boolean);
  if (!parts.length) return null;
  let providerId = parts[0];
  try { providerId = decodeURIComponent(providerId); } catch (_) { return null; }
  if (!ID_PATTERN.test(providerId)) return null;
  return { providerId, path: `/${parts.slice(1).join('/')}`, query };
}

module.exports = { PREFIX, setPort, baseUrlFor, parseRequestPath };
