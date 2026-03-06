export async function onRequestPost(context) {
  const { request, env } = context;
  try {
    // 1. Verify Authentication Token
    const authHeader = request.headers.get('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return new Response(JSON.stringify({ error: '認証トークンがありません' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const token = authHeader.substring(7);
    const secret = env.UPLOAD_SECRET_KEY;

    if (!secret) {
      return new Response(JSON.stringify({ error: 'サーバーのシークレットキーが設定されていません' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const isValid = await verifyHmacToken(token, secret);
    if (!isValid) {
      return new Response(JSON.stringify({ error: 'トークンが無効または期限切れです' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // 2. Process Upload Request
    const { filename, contentType, size } = await request.json();

    if (!filename) {
      return new Response(JSON.stringify({ error: 'ファイル名が必要です' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const hasSaJson = !!env.GOOGLE_SA_JSON;
    const hasWif = env.WIF_PROVIDER_AUDIENCE && env.WIF_PRIVATE_KEY && env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
    if (!hasSaJson && !hasWif) {
      return new Response(JSON.stringify({
        error: 'サーバーの設定が不完全です（認証情報がありません）'
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const sa = hasSaJson ? JSON.parse(env.GOOGLE_SA_JSON) : null;
    const accessToken = await getAccessToken(env, sa);
    const folderId = env.DRIVE_PARENT_FOLDER_ID;
    const origin = request.headers.get('Origin') || '*';
    const uploadUrl = await createResumableSession(accessToken, filename, contentType, size, folderId, origin);

    return new Response(
      JSON.stringify({
        uploadUrl: uploadUrl,
        expiresIn: 3600
      }),
      {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      }
    );
  } catch (error) {
    console.error('Error initializing resumable upload:', error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

export async function getAccessToken(env, sa) {
  if (sa) {
    const now = Math.floor(Date.now() / 1000);
    const header = { alg: 'RS256', typ: 'JWT' };
    const payload = {
      iss: sa.client_email,
      scope: 'https://www.googleapis.com/auth/drive.file',
      aud: 'https://oauth2.googleapis.com/token',
      exp: now + 3600,
      iat: now
    };

    const encodedHeader = b64(JSON.stringify(header));
    const encodedPayload = b64(JSON.stringify(payload));
    const input = `${encodedHeader}.${encodedPayload}`;

    const signature = await sign(input, sa.private_key);
    const jwt = `${input}.${signature}`;

    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: jwt
      })
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Failed to get access token: ${err}`);
    }

    const data = await response.json();
    return data.access_token;
  }

  return await getAccessTokenViaWif(env);
}

export async function getAccessTokenViaWif(env) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: env.WIF_ISS || 'discord-connector',
    sub: env.WIF_SUBJECT || 'discord-connector',
    aud: env.WIF_PROVIDER_AUDIENCE,
    iat: now,
    exp: now + 3600
  };

  const headerB64 = b64(JSON.stringify(header));
  const payloadB64 = b64(JSON.stringify(payload));
  const sigInput = `${headerB64}.${payloadB64}`;
  const sig = await sign(sigInput, env.WIF_PRIVATE_KEY);
  const assertion = `${sigInput}.${sig}`;

  const params = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
    audience: env.WIF_PROVIDER_AUDIENCE,
    subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
    subject_token: assertion,
    requested_token_type: 'urn:ietf:params:oauth:token-type:access_token',
    scope: 'https://www.googleapis.com/auth/cloud-platform'
  });

  const stsRes = await fetch('https://sts.googleapis.com/v1/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params
  });
  if (!stsRes.ok) {
    const err = await stsRes.text();
    throw new Error(`WIF STS exchange failed: ${err}`);
  }
  const stsData = await stsRes.json();

  const impRes = await fetch(
    `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(env.GOOGLE_SERVICE_ACCOUNT_EMAIL)}:generateAccessToken`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${stsData.access_token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        lifetime: '3600s',
        scope: ['https://www.googleapis.com/auth/drive.file']
      })
    }
  );
  if (!impRes.ok) {
    const idTokenRes = await fetch(
      `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(env.GOOGLE_SERVICE_ACCOUNT_EMAIL)}:generateIdToken`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${stsData.access_token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          audience: 'https://www.googleapis.com',
          includeEmail: true
        })
      }
    );
    if (!idTokenRes.ok) {
      const err = await impRes.text();
      throw new Error(`Service account impersonation failed: ${err}`);
    }
    const idTokenData = await idTokenRes.json();
    return idTokenData.identity;
  }
  const impData = await impRes.json();
  return impData.accessToken;
}

async function createResumableSession(accessToken, filename, contentType, size, folderId, origin) {
  const metadata = { name: filename };
  if (folderId) {
    metadata.parents = [folderId];
  }

  const response = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Type': contentType || 'application/octet-stream',
      'Origin': origin
    },
    body: JSON.stringify(metadata)
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Failed to create resumable session: ${err}`);
  }

  const uploadUrl = response.headers.get('Location');
  if (!uploadUrl) {
    throw new Error('Location header not found in Google Drive response');
  }

  return uploadUrl;
}

async function verifyHmacToken(token, secret) {
  try {
    const parts = token.split('.');
    if (parts.length !== 2) return false;

    const [payloadB64, signatureB64] = parts;

    const paddedPayload = payloadB64.replace(/-/g, '+').replace(/_/g, '/');
    const payloadStr = atob(paddedPayload);
    const payload = JSON.parse(payloadStr);

    if (!payload.exp || Date.now() > payload.exp) {
      return false;
    }

    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"]
    );

    const paddedSig = signatureB64.replace(/-/g, '+').replace(/_/g, '/');
    const sigBytes = Uint8Array.from(atob(paddedSig), c => c.charCodeAt(0));

    return await crypto.subtle.verify(
      "HMAC",
      key,
      sigBytes,
      new TextEncoder().encode(payloadB64)
    );
  } catch (e) {
    console.error("Token verification error:", e);
    return false;
  }
}

export function b64(str) {
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function sign(input, privateKeyPem) {
  const pemHeader = "-----BEGIN PRIVATE KEY-----";
  const pemFooter = "-----END PRIVATE KEY-----";
  const normalizedPem = privateKeyPem.replace(/\\n/g, "\n");
  const pemContents = normalizedPem
    .replace(pemHeader, "")
    .replace(pemFooter, "")
    .replace(/\s/g, "");

  const binaryDerString = atob(pemContents);
  const binaryDer = new Uint8Array(binaryDerString.length);
  for (let i = 0; i < binaryDerString.length; i++) {
    binaryDer[i] = binaryDerString.charCodeAt(i);
  }

  const key = await crypto.subtle.importKey(
    "pkcs8",
    binaryDer.buffer,
    {
      name: "RSASSA-PKCS1-v1_5",
      hash: "SHA-256"
    },
    false,
    ["sign"]
  );

  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(input)
  );

  return b64(String.fromCharCode(...new Uint8Array(signature)));
}
