'use strict';

// Compatibility names: official and other outbound requests share one policy.
const { createOutbound, outboundFetch } = require('./outbound');
const { parseMacSystemProxy } = require('./proxy-policy');
function parseMacProxy(text) {
  const { httpProxy, httpsProxy } = parseMacSystemProxy(text);
  return { httpProxy, httpsProxy };
}
function createOfficialFetch(options) { return createOutbound(options).outboundFetch; }
module.exports = { parseMacProxy, createOfficialFetch, officialFetch: outboundFetch };
