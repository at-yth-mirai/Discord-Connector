export async function onRequestPost({ request, env }) {
    try {
        const data = await request.json();
        const { fileKey, originalName, contentType, size } = data;

        if (!fileKey || !originalName) {
            return new Response(JSON.stringify({ error: 'ファイル情報が不完全です' }), {
                status: 400,
                headers: { 'Content-Type': 'application/json' }
            });
        }

        if (!env.CLOUD_RUN_URL || !env.CLOUD_RUN_SECRET) {
            console.warn("Cloud Run URL or Secret is not configured. Simulating success.");
            // In development/testing, simulate success
            return new Response(JSON.stringify({
                message: '転送通知のシミュレーション成功（環境変数が未設定です）',
                simulated: true
            }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' }
            });
        }

        // Call Cloud Run (Non-blocking or blocking depending on use case.
        // For 1GB files, Cloud Run processing will take a while, so we fire and forget or expect an immediate 202 Accepted.

        // We expect Cloud Run to respond 202 Accepted immediately, then process in the background.
        const response = await fetch(`${env.CLOUD_RUN_URL}/api/transfer`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${env.CLOUD_RUN_SECRET}` // Simple shared secret authentication
            },
            body: JSON.stringify({
                fileKey,
                originalName,
                contentType,
                size
            })
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.error('Cloud Run error:', errorText);
            throw new Error(`Cloud Run returned ${response.status}: ${errorText}`);
        }

        const responseData = await response.json();

        return new Response(JSON.stringify({
            message: responseData.message || '転送タスクが開始されました',
            link: responseData.link || null
        }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
        });

    } catch (error) {
        console.error('Error notifying Cloud Run:', error);
        return new Response(JSON.stringify({ error: error.message }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' }
        });
    }
}
