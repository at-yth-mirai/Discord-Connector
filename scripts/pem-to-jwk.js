// pem-to-jwk.js (CommonJS)
// Usage: node pem-to-jwk.js public.pem jwks.json
const fs = require('fs');
const { createPublicKey } = require('crypto');

const [,, pubPath, outPath] = process.argv;
if (!pubPath || !outPath) {
  console.error('Usage: node pem-to-jwk.js public.pem jwks.json');
  process.exit(2);
}
const pem = fs.readFileSync(pubPath, 'utf8');
const key = createPublicKey(pem);
const jwk = key.export({ format: 'jwk' });
if (!jwk.kid) jwk.kid = 'wif-key-1';
const jwks = { keys: [jwk] };
fs.writeFileSync(outPath, JSON.stringify(jwks, null, 2));
console.log('Wrote', outPath);
