# Discord-Connector

Discordから案内されたユーザーが大容量ファイルをGoogle Driveに直接アップロードするための仕組みです。

## アーキテクチャ

詳細は [ARCHITECTURE.md](ARCHITECTURE.md) を参照してください。

- **Frontend**: Cloudflare Pages (Resumable Upload 対応)
- **Backend (API)**: Cloudflare Pages Functions (Google OAuth / Drive API)
- **Storage**: Google Drive

## セットアップ手順

### 1. Google サービスアカウントの作成

1. [Google Cloud Console](https://console.cloud.google.com/) でプロジェクトを作成または選択します。
2. **Google Drive API** を有効にします。
3. **サービスアカウント**を作成し、JSON 形式のキーをダウンロードします。
4. アップロード先の Google Drive フォルダを作成し、サービスアカウントのメールアドレスに「編集者」権限で共有します。

### 2. Cloudflare の設定

1. Cloudflare Pages プロジェクトを作成します。
2. 環境変数（Secrets）を設定します。

#### 🗝️ 旧来のサービスアカウント JSON を使う場合
```bash
# サービスアカウントのJSON内容をそのまま登録
wrangler secret put GOOGLE_SA_JSON

# アップロード先のフォルダID（任意。指定しない場合はマイドライブ直下）
wrangler secret put DRIVE_PARENT_FOLDER_ID
```

#### 🔐 Workload Identity Federation (WIF) を使う場合
組織ポリシーでサービスアカウントキーの発行が禁止されている場合は
WIF によるキーレス認証へ切り替えてください。

1. GCP 上で **ワークロード ID プール / プロバイダ** を作成し、Cloudflare
   Workers から提示する JWT を受け入れるよう設定します。プロバイダの
   `audience` は任意の文字列（例: `discord-connector`）にできます。
   公開鍵 (JWK) をプールにアップロードし、JWT の検証に使います。
   - ローカルで鍵ペアを生成するには例えば:
     ```sh
     openssl genpkey -algorithm RSA -out wif_private.pem -pkeyopt rsa_keygen_bits:2048
     openssl rsa -in wif_private.pem -pubout -out wif_public.pem
     # wif_public.pem を JWK 形式に変換してプールに登録
     ```
2. サービスアカウントに `roles/iam.workloadIdentityUser` と
   `roles/iam.serviceAccountTokenCreator` をプールのプリンシパル
   (例: `principal://.../subject/discord-connector`) に付与します。
3. 以下の秘密情報を Workers のシークレットとして登録します。

```bash
wrangler secret put WIF_PROVIDER_AUDIENCE      # プロバイダで設定した audience
wrangler secret put WIF_PRIVATE_KEY            # JWT を作成する RSA 鍵 (PEM)
wrangler secret put GOOGLE_SERVICE_ACCOUNT_EMAIL  # インパーソネーション先のSA
wrangler secret put DRIVE_PARENT_FOLDER_ID     # (任意) Drive フォルダ
```

※ `WIF_ISS` / `WIF_SUBJECT` も必要であれば追加できますが、デフォルトは
`discord-connector` です。

Worker の実装は `init-resumable.js` が自動的に WIF を検出し、必要なトークン
を取得します。

### 3. デプロイ

```bash
# cloudflare ディレクトリへ移動
cd cloudflare

# デプロイ
pnpm run deploy
# または
wrangler pages deploy public --branch main
```

## 開発

```bash
cd cloudflare
pnpm install
# ローカル開発（.dev.vars に GOOGLE_SA_JSON を記述してください）
wrangler pages dev public
```

## セキュリティ

- サービスアカウントの鍵はサーバーサイド（Cloudflare Workers）でのみ保持され、クライアントには公開されません。
- アップロードは Google Drive の Resumable Upload セッション URL を介して直接行われます。この URL は短寿命で、特定のファイルに対してのみ有効です。

## Discord Bot
1. Install dependencies
   ```bash
   npm install discord.js@^13 node-fetch dotenv @discordjs/rest discord-api-types
   npm install --save-dev jest
   ```
2. Create `.env` with:
   ```env
   DISCORD_BOT_TOKEN=<your bot token>
   CLIENT_ID=<your application id>
   WORKER_URL=<https://your-pages-domain.pages.dev>
   # optionally TEST_GUILD_ID to register commands in a guild
   ```
3. Register the `/upload` command
   ```bash
   node register-commands.js
   ```
4. Start the bot locally
   ```bash
   node bot.js
   ```
5. Workflow in Discord:
   - User types `/upload` (optionally `filename=whatever`). The filename is only a
     *hint* for the upload page; if you omit it the actual name of the file you
     choose in the browser will be used automatically.
   - Bot replies with a URL like
     `https://...pages.dev/?sessionId=abcd123` (and `&filename=…` only if you
     provided a hint).
   - Opening that link loads the upload UI and even pops the file picker.
   - The page fetches a signed R2 URL when you select a file (or earlier if a
     suggestion was supplied) and then performs a straight PUT to R2.
   - After the PUT completes the front end hits `/api/notify-transfer` with the
     chosen file name, and the Cloud Run service pulls the blob from R2 and
     writes it to Drive.
   ```

2. Set Wrangler secrets (or a local `.env` for dev)
   ```bash
   wrangler secret put DISCORD_BOT_TOKEN <your-bot-token>
   wrangler secret put WORKER_URL <your-worker-base-url>
   # optional for guild‑only registration
   wrangler secret put TEST_GUILD_ID <guild-id>
   wrangler secret put CLIENT_ID <bot-application-id>
   ```

3. Register the `/upload` command (run once)
   ```bash
   node register-commands.js
   ```

4. Run the bot locally (development)
   ```bash
   node bot.js
   ```

5. Deploy (optional – you can also run the bot on any server you control).
