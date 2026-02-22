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

        // Step 1: Request Presigned URL
        progressStatus.textContent = 'アップロード用URLを取得中...';
        const urlResponse = await fetch('/api/get-upload-url', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                filename: selectedFile.name,
                contentType: selectedFile.type || 'application/octet-stream'
            })
        });

        if (!urlResponse.ok) {
            throw new Error(`URLの取得に失敗しました: ${urlResponse.statusText}`);
        }

        const data = await urlResponse.json();
        const { uploadUrl, fileKey } = data;

        // Step 2: Upload to R2 directly
        progressStatus.textContent = 'R2へアップロード中...';
        
        // Use XMLHttpRequest to track progress
        await new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            
            xhr.upload.addEventListener('progress', (e) => {
                if (e.lengthComputable) {
                    const percentComplete = Math.round((e.loaded / e.total) * 100);
                    progressBar.style.width = percentComplete + '%';
                    progressPercent.textContent = percentComplete + '%';
                }
            });

            xhr.addEventListener('load', () => {
                if (xhr.status >= 200 && xhr.status < 300) {
                    resolve();
                } else {
                    reject(new Error(`アップロード失敗: HTTP ${xhr.status}`));
                }
            });

            xhr.addEventListener('error', () => reject(new Error('ネットワークエラーが発生しました')));
            xhr.addEventListener('abort', () => reject(new Error('アップロードがキャンセルされました')));

            xhr.open('PUT', uploadUrl, true);
            // Setting Content-Type ensures R2 knows what file type it is receiving
            xhr.setRequestHeader('Content-Type', selectedFile.type || 'application/octet-stream');
            xhr.send(selectedFile);
        });

        // Step 3: Notify Backend (Cloud Run)
        progressStatus.textContent = 'バックエンドへ転送指示を送信中...';
        progressBar.style.width = '100%';
        progressPercent.textContent = '100%';
        progressBar.classList.remove('bg-blue-600');
        progressBar.classList.add('bg-green-500');

        const notifyResponse = await fetch('/api/notify-transfer', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                fileKey: fileKey,
                originalName: selectedFile.name,
                contentType: selectedFile.type || 'application/octet-stream',
                size: selectedFile.size
            })
        });

        if (!notifyResponse.ok) {
            console.warn('転送通知でエラーが返りましたが、R2には保存されています', await notifyResponse.text());
        }

        // Complete
        progressStatus.textContent = 'アップロード完了！Driveへの転送が開始されました。';
        
    } catch (error) {
        console.error('Upload Error:', error);
        progressStatus.textContent = `エラー: ${error.message}`;
        progressStatus.classList.add('text-red-600');
        progressBar.classList.remove('bg-blue-600');
        progressBar.classList.add('bg-red-500');
    } finally {
        // Reset state after 5 seconds to allow new uploads
        setTimeout(() => {
            selectedFile = null;
            fileInfo.classList.add('hidden');
            dropZone.classList.remove('hidden');
            progressContainer.classList.add('hidden');
            progressStatus.classList.remove('text-red-600');
            progressBar.classList.remove('bg-red-500', 'bg-green-500');
            progressBar.classList.add('bg-blue-600');
            progressBar.style.width = '0%';
            progressPercent.textContent = '0%';
        }, 5000);
    }
});
