import { sign, b64 } from './initResumable.js'; // Reuse the web crypto sign util we wrote earlier

function hexToUint8Array(hex) {
    const arr = new Uint8Array(hex.length / 2);
    for (let i = 0; i < arr.length; i++) {
        arr[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
    }
    return arr;
}

async function verifyDiscordSignature(bodyText, signatureHex, timestamp, publicKeyHex) {
    try {
        const encoder = new TextEncoder();
        const data = encoder.encode(timestamp + bodyText);
        const signature = hexToUint8Array(signatureHex);
        const pubKeyBytes = hexToUint8Array(publicKeyHex);

        const key = await crypto.subtle.importKey(
            'raw',
            pubKeyBytes,
            { name: 'NODE-ED25519', namedCurve: 'NODE-ED25519' }, // Cloudflare specific curve name fallback
            false,
            ['verify']
        );

        return await crypto.subtle.verify(
            { name: 'NODE-ED25519' }, // Cloudflare specific
            key,
            signature,
            data
        );
    } catch (e) {
        // Fallback for standard Ed25519 if NODE-ED25519 is not supported (standardizing in Web Crypto)
        try {
            const encoder = new TextEncoder();
            const data = encoder.encode(timestamp + bodyText);
            const signature = hexToUint8Array(signatureHex);
            const pubKeyBytes = hexToUint8Array(publicKeyHex);

            const key = await crypto.subtle.importKey(
                'raw',
                pubKeyBytes,
                { name: 'Ed25519' },
                false,
                ['verify']
            );

            return await crypto.subtle.verify(
                { name: 'Ed25519' },
                key,
                signature,
                data
            );
        } catch (err) {
            console.error("Signature verification error:", err);
            return false;
        }
    }
}

export async function onRequestPost(context) {
    const { request, env } = context;

    // 1. Validate the Discord Request Ed25519 Signature
    const signature = request.headers.get('x-signature-ed25519');
    const timestamp = request.headers.get('x-signature-timestamp');
    const bodyText = await request.clone().text();

    if (!signature || !timestamp || !env.DISCORD_PUBLIC_KEY) {
        return new Response('Missing signature or config', { status: 401 });
    }

    let isValidRequest = false;
    try {
        isValidRequest = await verifyDiscordSignature(
            bodyText,
            signature,
            timestamp,
            env.DISCORD_PUBLIC_KEY
        );
    } catch (e) {
        return new Response('Error verifying signature', { status: 401 });
    }

    if (!isValidRequest) {
        return new Response('Bad request signature', { status: 401 });
    }

    const interaction = JSON.parse(bodyText);

    // 2. Handle PING (Type 1)
    if (interaction.type === 1) { // InteractionType.PING
        return new Response(JSON.stringify({ type: 1 }), { // InteractionResponseType.PONG
            headers: { 'Content-Type': 'application/json' }
        });
    }

    // 3. Handle Application Commands (Type 2) 
    if (interaction.type === 2 && interaction.data.name === 'upload') { // InteractionType.APPLICATION_COMMAND
        try {
            const secret = env.UPLOAD_SECRET_KEY;
            if (!secret) {
                throw new Error('UPLOAD_SECRET_KEY is not configured.');
            }

            // Extract filename hint if provided
            let filenameOption = null;
            if (interaction.data.options && interaction.data.options.length > 0) {
                const opt = interaction.data.options.find(o => o.name === 'filename');
                if (opt) filenameOption = opt.value;
            }

            // Generate Token Payload
            const sessionId = Math.random().toString(36).slice(2, 10);
            const payload = {
                sessionId,
                exp: Date.now() + 15 * 60 * 1000, // 15 minutes
                channelId: interaction.channel_id,
                userId: interaction.member ? interaction.member.user.id : interaction.user.id
            };

            const payloadB64 = b64(JSON.stringify(payload));

            // Generate Web Crypto HMAC Signature (Node.js crypto standard replacement)
            const key = await crypto.subtle.importKey(
                "raw",
                new TextEncoder().encode(secret),
                { name: "HMAC", hash: "SHA-256" },
                false,
                ["sign"]
            );
            const signatureBuffer = await crypto.subtle.sign(
                "HMAC",
                key,
                new TextEncoder().encode(payloadB64)
            );
            const signatureB64 = b64(String.fromCharCode(...new Uint8Array(signatureBuffer)));

            const token = `${payloadB64}.${signatureB64}`;

            // We know the frontend is on the same host, so we can use the origin itself, or WORKER_URL
            const pagesBase = env.WORKER_URL ? env.WORKER_URL.replace(/\/$/, '') : (new URL(request.url)).origin;
            let pagesUrl = `${pagesBase}/?token=${token}`;
            if (filenameOption) {
                pagesUrl += `&filename=${encodeURIComponent(filenameOption)}`;
            }

            // Respond instantly with a message (Type 4: CHANNEL_MESSAGE_WITH_SOURCE)
            // Using ephemeral flag so only the user sees it (Flag 64)
            return new Response(JSON.stringify({
                type: 4,
                data: {
                    content: `Upload page: ${pagesUrl}`,
                    flags: 64
                }
            }), {
                headers: { 'Content-Type': 'application/json' }
            });

        } catch (e) {
            console.error('Interactions processing error:', e);
            return new Response(JSON.stringify({
                type: 4,
                data: {
                    content: 'Failed to generate upload link. Check server configuration.',
                    flags: 64
                }
            }), {
                headers: { 'Content-Type': 'application/json' }
            });
        }
    }

    return new Response('Unhandled interaction type', { status: 400 });
}
