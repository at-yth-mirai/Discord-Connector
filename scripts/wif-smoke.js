// smoke test: create JWT signed by wif_private.pem, exchange via STS, then generateAccessToken
const fs = require('fs');
const crypto = require('crypto');

async function main(){
  const projectNumber = '671908432307';
  const pool = 'cloudflare-pool';
  const provider = 'cloudflare-provider';
  const providerResource = `//iam.googleapis.com/projects/${projectNumber}/locations/global/workloadIdentityPools/${pool}/providers/${provider}`;
  const iss = 'https://discord-connector';
  const sub = 'discord-connector';
  const saEmail = 'discord-drive-uploader@discord-connector-488207.iam.gserviceaccount.com';

  const privateKey = fs.readFileSync('./wif_private.pem','utf8');

  const header = { alg: 'RS256', typ: 'JWT' };
  const now = Math.floor(Date.now()/1000);
  const payload = { iss, sub, aud: providerResource, iat: now, exp: now + 3600 };

  const base64Url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  const signingInput = base64Url(header) + '.' + base64Url(payload);
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(signingInput);
  const signature = sign.sign(privateKey);
  const signatureB64 = signature.toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  const assertion = signingInput + '.' + signatureB64;

  console.log('Assertion length:', assertion.length);

  // Call STS
  const params = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
    audience: providerResource,
    subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
    subject_token: assertion,
    requested_token_type: 'urn:ietf:params:oauth:token-type:access_token',
    scope: 'https://www.googleapis.com/auth/drive.file'
  });

  const stsRes = await fetch('https://sts.googleapis.com/v1/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: params });
  const stsText = await stsRes.text();
  console.log('STS response status', stsRes.status);
  console.log('STS response', stsText);
  if (!stsRes.ok) throw new Error('STS exchange failed');
  const sts = JSON.parse(stsText);

  // Impersonate service account
  const impRes = await fetch(`https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(saEmail)}:generateAccessToken`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${sts.access_token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ 
      lifetime: 3600,
      scope: ['https://www.googleapis.com/auth/drive.file'] 
    })
  });
  const impText = await impRes.text();
  console.log('Impersonate status', impRes.status);
  console.log('Impersonate response', impText);
}

main().catch(e=>{console.error(e); process.exit(1);});
