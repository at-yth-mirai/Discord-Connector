// Using aws4fetch for signing S3/R2 requests in Cloudflare Workers without large SDKs
// Installation required: npm install aws4fetch
import { AwsV4Signer } from 'aws4fetch';

export async function onRequestPost({ request, env }) {
    try {
        const { filename, contentType } = await request.json();

        if (!filename) {
            return new Response(JSON.stringify({ error: 'ファイル名が必要です' }), {
                status: 400,
                headers: { 'Content-Type': 'application/json' }
            });
        }

        // Since we're using R2 Binding (UPLOAD_BUCKET), we can also use S3 API compat
        // But for presigned URLs from Cloudflare Workers to R2, we need AWS credentials
        // We should mock this for now or assume environment variables are set.
        // However, Cloudflare recently added native support for presigned URLs if you use the aws-sdk

        // As a simpler approach for R2 bindings, we can actually just upload through the worker for small files,
        // BUT for 1GB files we MUST use Presigned URLs.
        // S3 URL FORMAT: https://<ACCOUNT_ID>.r2.cloudflarestorage.com/<BUCKET_NAME>/<FILE_KEY>

        // Ensure environment variables are set for S3 API access
        if (!env.R2_ACCOUNT_ID || !env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY) {
            console.error("Missing R2 credentials in environment variables.");
            // Placeholder response for development
            return new Response(JSON.stringify({
                error: 'サーバーの設定が不完全です（R2認証情報がありません）',
                hint: 'Wrangler.toml または ダッシュボードで R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY を設定してください。'
            }), {
                status: 500,
                headers: { 'Content-Type': 'application/json' }
            });
        }

        const accountId = env.R2_ACCOUNT_ID;
        const bucketName = 'discord-connector-uploads';
        // Unique file key to prevent overwrites
        const fileKey = `${Date.now()}-${Math.random().toString(36).substring(2, 15)}-${filename}`;

        const url = new URL(`https://${accountId}.r2.cloudflarestorage.com/${bucketName}/${fileKey}`);

        const signer = new AwsV4Signer({
            url: url.toString(),
            accessKeyId: env.R2_ACCESS_KEY_ID,
            secretAccessKey: env.R2_SECRET_ACCESS_KEY,
            method: 'PUT',
            headers: {
                'Content-Type': contentType || 'application/octet-stream'
            },
            service: 's3',
            region: 'auto',
            signQuery: true, // Generate a presigned URL in the query string
            expiresIn: 3600, // 1 hour
        });

        const signedRequest = await signer.sign();

        return new Response(
            JSON.stringify({
                uploadUrl: signedRequest.url,
                fileKey: fileKey
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
        console.error('Error generating presigned URL:', error);
        return new Response(JSON.stringify({ error: error.message }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' }
        });
    }
}
