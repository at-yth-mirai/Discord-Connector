import { getAccessToken, getAccessTokenViaWif, b64, sign } from './initResumable.js';

export async function onRequestPost(context) {
    const { request, env } = context;
    try {
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
            return new Response(JSON.stringify({ error: 'シークレットキー未設定' }), { status: 500 });
        }

        const payload = await verifyHmacTokenAndGetPayload(token, secret);
        if (!payload) {
            return new Response(JSON.stringify({ error: 'トークンが無効または期限切れです' }), { status: 403 });
        }

        if (!env.DISCORD_BOT_TOKEN) {
            console.warn("DISCORD_BOT_TOKEN is not configured. Skipping Discord notification.");
            return new Response(JSON.stringify({ message: '通知スキップ（BotToken未設定）' }), { status: 200 });
        }

        const { fileId, filename } = await request.json();
        if (!fileId) {
            return new Response(JSON.stringify({ error: 'fileIdが必要です' }), { status: 400 });
        }

        // --- Step 1: Set Google Drive Permission to Public ---
        try {
            const hasSaJson = !!env.GOOGLE_SA_JSON;
            const sa = hasSaJson ? JSON.parse(env.GOOGLE_SA_JSON) : null;
            const accessToken = await getAccessToken(env, sa);

            const permissionRes = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}/permissions?supportsAllDrives=true`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    type: 'anyone',
                    role: 'reader'
                })
            });

            if (!permissionRes.ok) {
                const pErr = await permissionRes.text();
                console.error("Failed to set file permission to public:", pErr);
                // We'll proceed to notify Discord even if permission setting failed 
                // but we should log it for debugging.
            }
        } catch (authErr) {
            console.error("Error authenticating to Google Drive for permissions:", authErr);
        }

        // --- Step 2: Notify Discord ---

        const discordRes = await fetch(`https://discord.com/api/v10/channels/${payload.channelId}/messages`, {
            method: 'POST',
            headers: {
                'Authorization': `Bot ${env.DISCORD_BOT_TOKEN}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                content: `<@${payload.userId}> ファイルのアップロードが完了しました！\n📄 **${filename || '不明なファイル'}**\n🔗 https://drive.google.com/file/d/${fileId}/view`
            })
        });

        if (!discordRes.ok) {
            const errText = await discordRes.text();
            console.error("Failed to notify Discord:", errText);
            return new Response(JSON.stringify({ error: 'Discord通知失敗' }), { status: 500 });
        }

        return new Response(JSON.stringify({ success: true }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
        });

    } catch (error) {
        console.error('Error in notifyDiscord:', error);
        return new Response(JSON.stringify({ error: error.message }), { status: 500 });
    }
}

async function verifyHmacTokenAndGetPayload(token, secret) {
    try {
        const parts = token.split('.');
        if (parts.length !== 2) return null;

        const [payloadB64, signatureB64] = parts;
        const paddedPayload = payloadB64.replace(/-/g, '+').replace(/_/g, '/');
        const payloadStr = atob(paddedPayload);
        const payload = JSON.parse(payloadStr);

        if (!payload.exp || Date.now() > payload.exp) return null;
        if (!payload.channelId || !payload.userId) return null;

        const key = await crypto.subtle.importKey(
            "raw",
            new TextEncoder().encode(secret),
            { name: "HMAC", hash: "SHA-256" },
            false,
            ["verify"]
        );

        const paddedSig = signatureB64.replace(/-/g, '+').replace(/_/g, '/');
        const sigBytes = Uint8Array.from(atob(paddedSig), c => c.charCodeAt(0));

        const isValid = await crypto.subtle.verify(
            "HMAC",
            key,
            sigBytes,
            new TextEncoder().encode(payloadB64)
        );

        return isValid ? payload : null;
    } catch (e) {
        console.error("Token verification error:", e);
        return null;
    }
}
