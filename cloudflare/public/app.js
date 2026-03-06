const dropZone = document.getElementById('dropZone');
const fileInput = document.getElementById('fileInput');
const fileInfo = document.getElementById('fileInfo');
const fileName = document.getElementById('fileName');
const fileSize = document.getElementById('fileSize');
const uploadBtn = document.getElementById('uploadBtn');
const progressContainer = document.getElementById('progressContainer');
const progressBar = document.getElementById('progressBar');
const progressPercent = document.getElementById('progressPercent');
const progressStatus = document.getElementById('progressStatus');

// If the page was opened with a `?sessionId=...` query param (from the Discord bot),
// we may show a filename suggestion and even prefetch an upload URL. Regardless,
// clicking the link should pop open the file picker automatically.
let prefetchedUploadUrl = null;
try {
    const params = new URLSearchParams(window.location.search);
    const suggested = params.get('filename');
    const token = params.get('token');

    let sessionId = null;
    if (token) {
        window.uploadToken = token; // Store globally for API calls
        try {
            // Extract payload to get the sessionId for auto-open behavior
            const base64Url = token.split('.')[0];
            const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
            const payload = JSON.parse(atob(base64));
            sessionId = payload.sessionId;
        } catch (e) {
            console.warn('Failed to parse token payload', e);
        }
    }

    if (suggested) {
        const hint = document.createElement('div');
        hint.className = 'text-sm text-gray-500 mb-3';
        hint.textContent = `Suggested filename: ${suggested}`;
        // insert hint above the drop zone
        dropZone.parentElement.insertBefore(hint, dropZone);
    }

    // If a suggested name is available, prefetch the resumable upload URL
    // so the upload button will be ready as soon as the user chooses a file.
    if (suggested) {
        (async () => {
            try {
                const headers = { 'Content-Type': 'application/json' };
                if (window.uploadToken) {
                    headers['Authorization'] = `Bearer ${window.uploadToken}`;
                }
                const res = await fetch('/api/initResumable', {
                    method: 'POST',
                    headers,
                    body: JSON.stringify({ filename: suggested, contentType: 'application/octet-stream' })
                });
                if (res.ok) {
                    const j = await res.json();
                    prefetchedUploadUrl = j.uploadUrl;
                } else {
                    console.warn('Prefetch initResumable failed', await res.text());
                }
            } catch (e) {
                console.warn('Error prefetching upload URL', e);
            }
        })();
    }

    // auto-open the file dialog if we were launched via bot link
    if (sessionId) {
        setTimeout(() => {
            try { dropZone.click(); } catch (e) { /* ignore */ }
        }, 300);
    }
} catch (e) {
    // ignore URL parsing issues
}

let selectedFile = null;

// Format file size
function formatBytes(bytes, decimals = 2) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

// Handle file selection
function handleFileSelect(file) {
    if (!file) return;

    // 1GB limit
    if (file.size > 1024 * 1024 * 1024) {
        alert('ファイルサイズは1GB以下にしてください。');
        return;
    }

    selectedFile = file;
    fileName.textContent = file.name;
    fileSize.textContent = formatBytes(file.size);
    fileInfo.classList.remove('hidden');
    uploadBtn.disabled = false;
    dropZone.classList.add('hidden');
}

// Event Listeners for Drag & Drop
dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('dragover');
});

dropZone.addEventListener('dragleave', () => {
    dropZone.classList.remove('dragover');
});

dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
    const files = e.dataTransfer.files;
    if (files.length > 0) {
        handleFileSelect(files[0]);
    }
});

dropZone.addEventListener('click', () => {
    fileInput.click();
});

fileInput.addEventListener('change', (e) => {
    if (e.target.files.length > 0) {
        handleFileSelect(e.target.files[0]);
    }
});

// Upload functionality
uploadBtn.addEventListener('click', async () => {
    if (!selectedFile) return;

    try {
        // Disable UI
        uploadBtn.disabled = true;
        uploadBtn.classList.add('opacity-50', 'cursor-not-allowed');
        progressContainer.classList.remove('hidden');

        // Ensure we have a Drive resumable upload URL – fetch now if prefetched is missing.
        if (!prefetchedUploadUrl) {
            progressStatus.textContent = 'アップロード用URLを取得中...';
            const headers = { 'Content-Type': 'application/json' };
            if (window.uploadToken) {
                headers['Authorization'] = `Bearer ${window.uploadToken}`;
            }
            const res = await fetch('/api/initResumable', {
                method: 'POST',
                headers,
                body: JSON.stringify({ filename: selectedFile.name, contentType: selectedFile.type || 'application/octet-stream', size: selectedFile.size })
            });
            if (!res.ok) throw new Error('Drive resumable URL の取得に失敗しました');
            const j = await res.json();
            prefetchedUploadUrl = j.uploadUrl;
        }

        // Step 1 (Drive): Upload directly to Drive via resumable PUT
        progressStatus.textContent = 'Google Driveへアップロード中...';

        const fileMetadata = await uploadFileResumable(prefetchedUploadUrl, selectedFile);

        // Step 2 (Discord): Notify bot of completion
        progressStatus.textContent = 'Discordへ通知中...';
        try {
            const headers = { 'Content-Type': 'application/json' };
            if (window.uploadToken) {
                headers['Authorization'] = `Bearer ${window.uploadToken}`;
            }
            await fetch('/api/notifyDiscord', {
                method: 'POST',
                headers,
                body: JSON.stringify({ fileId: fileMetadata.id, filename: selectedFile.name })
            });
        } catch (e) {
            console.warn('Discord notification failed:', e);
        }

        // Step: success UI update
        progressStatus.textContent = 'アップロード完了！Google Drive に保存されました。';
        progressBar.style.width = '100%';
        progressPercent.textContent = '100%';
        progressBar.classList.remove('bg-blue-600');
        progressBar.classList.add('bg-green-500');

        // cleanup UI
        fileInfo.classList.add('hidden');
        uploadBtn.classList.add('hidden');
        progressBar.parentElement.classList.add('hidden');
        progressPercent.classList.add('hidden');
    } catch (error) {
        console.error('Upload Error:', error);
        progressStatus.textContent = `エラー: ${error.message}`;
        progressStatus.classList.add('text-red-600');
        progressBar.classList.remove('bg-blue-600');
        progressBar.classList.add('bg-red-500');

        // Allow retry after failure
        uploadBtn.disabled = false;
        uploadBtn.classList.remove('opacity-50', 'cursor-not-allowed');
    }
});

// If user clicked link and we have a suggested filename, optionally pre-fill UI details
// when a file is selected we don't override the actual name, but suggestion guides the user.

/**
 * Resumable upload implementation for Google Drive
 */
async function uploadFileResumable(uploadUrl, file) {
    const chunkSize = 10 * 1024 * 1024; // 10MB chunks (recommended for Drive)
    let offset = 0;

    while (offset < file.size) {
        const end = Math.min(offset + chunkSize, file.size);
        const chunk = file.slice(offset, end);
        const isLastChunk = end >= file.size;

        const success = await new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            xhr.open('PUT', uploadUrl, true);

            // Content-Range: bytes start-end/total
            const range = `bytes ${offset}-${end - 1}/${file.size}`;
            xhr.setRequestHeader('Content-Range', range);

            xhr.upload.addEventListener('progress', (e) => {
                if (e.lengthComputable) {
                    const loadedTotal = offset + e.loaded;
                    const percentComplete = Math.round((loadedTotal / file.size) * 100);
                    progressBar.style.width = percentComplete + '%';
                    progressPercent.textContent = percentComplete + '%';
                }
            });

            xhr.addEventListener('load', () => {
                if (xhr.status === 308) {
                    // 308 Resume Incomplete: success for intermediate chunk
                    resolve(true);
                } else if (xhr.status === 200 || xhr.status === 201) {
                    // 200/201: success for last chunk
                    try {
                        resolve(JSON.parse(xhr.responseText));
                    } catch (e) {
                        resolve(true);
                    }
                } else {
                    reject(new Error(`アップロード失敗: HTTP ${xhr.status} - ${xhr.responseText}`));
                }
            });

            xhr.addEventListener('error', () => reject(new Error('ネットワークエラーが発生しました')));
            xhr.addEventListener('abort', () => reject(new Error('アップロードがキャンセルされました')));

            xhr.send(chunk);
        });

        if (!success) break;
        if (typeof success === 'object' && success.id) {
            return success;
        }
        offset = end;
    }
}
