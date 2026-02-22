import express from 'express';
import { S3Client, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { google } from 'googleapis';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
app.use(express.json());

// Initialize S3 Client for Cloudflare R2
const s3 = new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    }
});

// Configure Google Drive API
const getDriveClient = () => {
    // In production (Cloud Run), it's recommended to use Workload Identity or a service account key
    // For local dev, a service account JSON file mapped to process.env.GOOGLE_APPLICATION_CREDENTIALS works
    const auth = new google.auth.GoogleAuth({
        scopes: ['https://www.googleapis.com/auth/drive.file']
    });
    return google.drive({ version: 'v3', auth });
};

// Middleware to verify requests from Cloudflare
const verifySecret = (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || authHeader !== `Bearer ${process.env.CLOUD_RUN_SECRET}`) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
};

app.post('/api/transfer', verifySecret, async (req, res) => {
    const { fileKey, originalName, contentType, size } = req.body;

    if (!fileKey || !originalName) {
        return res.status(400).json({ error: 'Missing required fields' });
    }

    // Acknowledge the request immediately (202 Accepted) so Cloudflare Workers don't timeout
    res.status(202).json({ message: 'Transfer task accepted and is processing in the background.' });

    // Process in the background
    try {
        console.log(`Starting transfer for ${originalName} (${fileKey})`);

        // 1. Get the readable stream from R2
        const getCommand = new GetObjectCommand({
            Bucket: process.env.R2_BUCKET_NAME || 'discord-connector-uploads',
            Key: fileKey
        });
        const { Body: r2Stream } = await s3.send(getCommand);

        // 2. Prepare Google Drive upload
        const drive = getDriveClient();
        const driveFolderId = process.env.GOOGLE_DRIVE_FOLDER_ID;

        const fileMetadata = {
            name: originalName,
            ...(driveFolderId ? { parents: [driveFolderId] } : {})
        };

        const media = {
            mimeType: contentType || 'application/octet-stream',
            body: r2Stream // Pass the stream directly
        };

        // 3. Upload to Google Drive
        console.log('Uploading stream to Google Drive...');
        const driveResponse = await drive.files.create({
            resource: fileMetadata,
            media: media,
            fields: 'id, webViewLink'
        });

        console.log(`Successfully uploaded to Google Drive. File ID: ${driveResponse.data.id}`);

        // 4. Clean up R2 completely
        console.log('Deleting temporary file from R2...');
        const deleteCommand = new DeleteObjectCommand({
            Bucket: process.env.R2_BUCKET_NAME || 'discord-connector-uploads',
            Key: fileKey
        });
        await s3.send(deleteCommand);
        console.log('R2 cleanup complete.');

    } catch (error) {
        console.error(`Error during transfer of ${fileKey}:`, error);
        // Note: For a robust system, we would want to implement a retry mechanism 
        // or a Dead Letter Queue (DLQ) if the background job fails.
    }
});

// Health check endpoint for Cloud Run
app.get('/', (req, res) => {
    res.status(200).send('Discord Connector Transfer Service is running.');
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});
