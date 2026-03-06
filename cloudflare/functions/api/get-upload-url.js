import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

export async function onRequestPost({ request, env }) {
    try {
        const { filename, contentType } = await request.json();

        if (!filename) {
            return new Response(JSON.stringify({ error: 'ファイル名が必要です' }), {
                status: 400,
                headers: { 'Content-Type': 'application/json' }
            });
        }

        if (!env.R2_ACCOUNT_ID || !env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY) {
            console.error("Missing R2 credentials in environment variables.");
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
        const fileKey = `${Date.now()}-${Math.random().toString(36).substring(2, 15)}-${filename}`;

        const S3 = new S3Client({
            region: 'auto',
            endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
            credentials: {
                accessKeyId: env.R2_ACCESS_KEY_ID,
                secretAccessKey: env.R2_SECRET_ACCESS_KEY,
            },
        });

        const command = new PutObjectCommand({
            Bucket: bucketName,
            Key: fileKey,
            ContentType: contentType || 'application/octet-stream',
        });

        const signedUrl = await getSignedUrl(S3, command, { expiresIn: 3600 });

        return new Response(
            JSON.stringify({
                uploadUrl: signedUrl,
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
