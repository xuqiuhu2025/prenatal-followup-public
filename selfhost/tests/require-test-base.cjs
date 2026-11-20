'use strict';
module.exports = function requireTestBase() {
  const value = (process.env.QA_BASE_URL || '').trim();
  if (!value) throw new Error('Set QA_BASE_URL to your own authorized test service');
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('QA_BASE_URL must be an HTTP(S) origin without credentials, path, query or fragment');
  }
  return url.origin;
};
