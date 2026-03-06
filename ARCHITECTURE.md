# Discord-Connector — アーキテクチャ設計書

作成日: 2026-02-25

この設計書は、プロジェクトの最終形態（目的・データフロー・各コンポーネントの責務）と、現時点で実施すべき作業を明確にします。別のLLMやエンジニアが途中から作業を引き継げるよう、実装の要点、API 仕様、運用手順、検証手順を含めます。

---

## 目的

- Discord から案内されたユーザーが最大1GBのファイルを安全かつ低コストで、管理者側の Google Drive（サービスアカウント）に保存できる仕組みを作る。
- サーバ側で大容量データを転送しない（できる限りクライアント直送）ことを優先してコストを最小化する。

---

## 最終アーキテクチャ（要約）

1. Discord Bot がユーザーにアップロード用の URL を返す。
2. ユーザーはブラウザでページを開きファイルを選択。
3. ブラウザは Cloudflare Pages/Worker のエンドポイントにリクエストして「一回限り・短命の resumable upload セッション URL」を受け取る。
4. ブラウザはその upload URL に対して resumable（チャンク分割／再試行可能）で直接データを送る（Google Drive へ）。
5. アップロード完了通知を Pages/Worker に送信し、必要なら R2 を経由している場合は Worker が後続処理（クリーンアップ通知）を行う。

（注）上記の流れでは Cloud Run は不要。ただし Worker にサービスアカウントの鍵／秘密を安全に保管する必要がある。

---

## コンポーネント詳細

- Discord Bot
  - 役割: /upload 等のコマンドでユーザーへ専用アップロードURLを返す（ページURL）。
  - 実装: 任意（Discord.js 等）、Bot は重いデータ処理を行わない。

- Cloudflare Pages (フロントエンド)
  - 役割: ユーザーにアップロードUIを提供する (`cloudflare/public/*`)。
  - 変更点: `app.js` を resumable クライアントに更新して、session URL を利用してチャンク送信する。

- Cloudflare Workers / Pages Functions (API)
  - 役割: Google Cloud への認証を行い、Drive の resumable upload セッションを作成して短命の upload URL を返す。
  - 実装要点:
    - **従来**: Worker にサービスアカウントの `private_key`／`client_email` を `wrangler secret` として保存。
    - **現在推奨**: Workload Identity Federation (WIF) を使い、Worker は自前の鍵（WIF_PRIVATE_KEY）で JWT を署名し、STS 経由でサービスアカウントをインパーソネーションする。サービスアカウントキーは一切不要。
    - Worker は JWT を作成し `https://oauth2.googleapis.com/token` 又は `https://sts.googleapis.com/v1/token` に POST してアクセストークンを取得する。
    - Drive Files API を呼び、`uploadType=resumable` を指定した POST を行って `Location` ヘッダの upload URL を受け取る。
    - upload URL をクライアントに返す（可能なら `oneTime=true` の設計にするか短時間で期限切れにする）。

- Google Drive (サービスアカウント)
  - 役割: 最終保存先。サービスアカウントを組織の Drive フォルダに紐づけて権限を限定する。
  - 実装要点: resumable upload を使い、チャンク単位で再送可能にする。

- (任意) Cloudflare R2
  - 役割: もしブラウザ⇢Google の直接PUTがブラウザ互換性で問題ある場合のフォールバック。一時保存バッファとして使用。
  - 現状: 既存実装は R2 を使っている。最終形態では直接Driveへ送れるなら不要。

---

## API 仕様（Worker 側）

- POST /api/init-resumable
  - 説明: Drive に resumable upload セッションを作成して upload URL を返す。
  - リクエスト JSON:
    - `filename`: string (optional; if omitted the client will pass the actual name of the file the
    user selected when it requests an upload URL)
    - `contentType`: string (optional)
    - `size`: number (optional)
  - レスポンス JSON (成功 200):
    - `uploadUrl`: string (Drive の resumable upload URL — クライアントが PUT する先)
    - `fileId`: string (Drive ファイルの id — 任意)
    - `expiresIn`: number (秒)
  - エラー: 400 / 500

- POST /api/notify-upload-complete
  - 説明: クライアントが upload 完了を通知する（オプション）。Worker が後続処理を行う（メタ更新やログ）。
  - リクエスト JSON:
    - `fileId` or `fileKey`, `originalName`, `size` 等

補足: Worker は upload 完了を検出できない場合があるため、クライアント側で完了通知を送るパターンを推奨。

---

## Worker 実装の技術詳細（重要）

1. JWT 作成: サービスアカウントの `client_email` と `private_key` を用いて JWT を生成（scope: `https://www.googleapis.com/auth/drive.file` など）。
2. トークン交換: JWT を `https://oauth2.googleapis.com/token` に `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer` で POST してアクセストークンを取得。
3. Resumable セッション生成: Drive API の `POST https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable` を呼び、`X-Upload-Content-Type` ヘッダ等を設定。`Location` レスポンスヘッダを取り出す。
4. 返却: `Location` の URL をクライアントに返す（短寿命に見えるように内部で期限管理をするか、Worker 側で一回限りのトークン化を行う）。

注意: Worker は軽量で実行時間が短い（CPU/Time 制約）ため、上記処理は数百ミリ秒〜数秒で終わる実装を目指す。トークン発行は短時間で完了する。

---

## クライアント側（resumable）実装ポイント

- 手順（簡易）:
  1. `POST /api/init-resumable` で `uploadUrl` を取得。
  2. 取得した `uploadUrl` に対して `PUT` を行う。初回は `Content-Range: bytes 0-<chunkEnd>/<total>` ヘッダでチャンクを送る。
  3. サーバ（Google）から 308 Resume Incomplete が返ってきたら、次チャンクを送る。完了すると 200 または 201 が返る。
  4. 失敗時は `Range` ヘッダでサーバ側の受信済みバイト数を問い合わせ、再開する。

- ブラウザでの実装: `fetch` でも可能だが、進捗イベントが必要なら `XMLHttpRequest` を使う方が簡単。チャンクを `Blob.slice()` で分割して順次送信。

---

## セキュリティ要件

- サービスアカウントの `private_key` を直接クライアントに渡してはいけない。
- Worker に入れる秘密は **R2 の認証情報のみ**。`wrangler pages secret put R2_ACCOUNT_ID` などで登録し、アクセス権限を最小化する。
  Google Drive は Cloud Run 側が扱うため、Worker には鍵を渡さない。
- upload URL は短時間・一回限りで失効させる設計にする。
- ファイルサイズ/拡張子/MIME のホワイトリストチェックを入れる。悪意あるファイルの保存を防止する。

---

## テスト／検証手順（CORS 含む）

1. Worker をローカルで動かすか Preview で `POST /api/init-resumable` を叩き、upload URL を取得する。
2. ブラウザから小さなファイルで resumable upload を試す。Chrome/Firefox で両方試す。
3. CORS エラーが出る場合: Google の `Location` へ `OPTIONS` を送って許可ヘッダを確認。必要なら client 側の `Origin` とヘッダを調整するか、Worker 側で中継（最後の手段）を検討。

---

## 運用・デプロイ手順（概要）

- Cloudflare Worker secrets 登録 (例):

```bash
# Wrangler を用いる例
wrangler secret put GOOGLE_SA_JSON < service-account.json
wrangler publish
```

- Pages デプロイは既存の `cloudflare/public` を `wrangler pages publish` などで更新。

---

## 現時点でやるべき作業（短期タスク、優先順）

1. Bot→Pages UI のフローを安定させる — 優先度: 高
   - `bot.js` と `cloudflare/public/app.js` の動作を確認し、
     URLパラメータ経由でR2 URLを取得する流れを検証。
2. R2 認証情報の管理 — 優先度: 中
   - `get-upload-url.js` が必要とするR2アクセストークンを
     `wrangler secret` に設定しておく。
3. CI/テストの整備 — 優先度: 中
   - Bot のユニットテストや、Pages上のprefetchエラーハンドリングを
     テストできるようにする。
4. Cloud Run の転送ロジックリファクタ（任意） — 優先度: 低
   - Drive 側の認証を短期トークンや Workload Identity に変更する。

5. (将来) 完全 Cloud Run 排除のため `init-resumable` など別経路を検討 — 優先度: 低

各タスクには対応するファイルパスを記載しています。既存ファイルの多くは `cloudflare/functions/api/*.js` と `cloudflare/public/*` にあります。

---

## 他のLLM/開発者がすぐ作業を引き継ぐためのチェックリスト

- 必須ファイルの確認:
  - `cloudflare/public/app.js`
  - `cloudflare/functions/api/get-upload-url.js` （参考）
  - 新規: `cloudflare/functions/api/init-resumable.js`（作成予定）

- 必要環境変数 / secrets:
  - `WORKER_URL` — Pages の公開 URL を Bot に渡すために使用
  - `DISCORD_BOT_TOKEN`, `CLIENT_ID`, `TEST_GUILD_ID` など Bot 用
  - R2 認証情報は `get-upload-url` 内で直接保持（Worker の `wrangler secret` で設定）
  - **Drive/Google 認証は Cloud Run 側が担当するため、サービスアカウントキーは不要**

- 開発手順（短く）:
  1. `wrangler login` / `wrangler whoami` で環境確認
  2. `wrangler pages secret put` で R2 の `ACCOUNT_ID`, `ACCESS_KEY_ID`,
   `SECRET_ACCESS_KEY` を登録
  3. `wrangler dev` で Worker をローカル確認
  4. ブラウザから `POST /api/init-resumable` を叩き `uploadUrl` を受け取り、簡易クライアントでアップロードを試す

---

## 付録: LLM への指示メモ（次にやるべき具体的変更）

1. `cloudflare/functions/api/init-resumable.js` を追加。既存の `get-upload-url.js` をテンプレートに、JWT と token endpoint 周りを実装する。
2. `cloudflare/public/app.js` の `uploadBtn` イベントハンドラ内で、現行の R2 PUT ロジックを resumable ロジックへ差し替える。必要に応じて小さな resumable ライブラリの導入を検討するが、XHR で十分実装可能。
3. テストケース: 1MB, 5MB, 100MB のファイルでアップロード成功、途中断の再開テストを作成する。

---

もしこの設計書の追記や、実装パッチ（`init-resumable.js` と `app.js` の変更）を私に依頼するなら「次へ: 実装して」とだけ返してください。私は実装と簡易テストを行います。

---

## 現在の実装状態（2026-02-27 時点）

### リポジトリ構成（確認済み）

**フロントエンド（Cloudflare Pages）**
- `cloudflare/public/index.html` — ドラッグ&ドロップ UI、1GB制限、日本語メッセージ対応
- `cloudflare/public/app.js` — ファイル選択〜アップロード〜進捗表示の実装（現在は R2 プリサインド URL 方式）

**バックエンド API（Cloudflare Workers / Pages Functions）**
- `cloudflare/functions/api/get-upload-url.js` — R2 用のプリサインド PUT URL 生成
- `cloudflare/functions/api/notify-transfer.js` — Cloud Run への転送通知（現在は Cloud Run 依存）
- `cloudflare/wrangler.toml` — Pages 設定、R2 バッファ設定

**その他**
- `cloud-run/index.js` — Express サーバー（R2 からダウンロード→ Google Drive へアップロード）
- `service-account-key.json` — Google サービスアカウント鍵（存在確認済み）
- リンターエラー: なし

### 現在の問題点・制限

1. **Cloud Run の課金**: `cloud-run/index.js` が実行されるたびに課金発生。1GB ファイルの場合、数分間のリソース消費が発生する。
2. **データの二重転送**: クライアント→R2 → Cloud Run（ダウンロード）→ Google Drive という経路で、サーバ側の帯域を使用。
3. **大容量ファイルの信頼性**: Cloud Run のリクエストタイムアウト（デフォルト60分）や、メモリ/CPU 制限の懸念。
4. **セキュリティ**: R2 プリサインド URL と Cloud Run シークレットの管理が複数レイヤーで分散している。

### やりたいこと（目標）

- **コスト削減**: Cloud Run を完全に排除し、Cloudflare Worker のみで処理する（Worker は無料枠が活用しやすい）。
- **パフォーマンス向上**: クライアント→Google Drive への直接 resumable upload で帯域を節約。
- **堅牢性**: サービスアカウント鍵を Worker の secret に安全に格納し、JWT + resumable upload でリトライ可能な実装。
- **シンプル化**: API エンドポイントを 1 つ（`/api/init-resumable`）に統一し、セッション管理を明確に。

---

## これまでに実施した作業（Copilot）

### 2026-02-25 ～ 2026-02-27

#### 1. リポジトリ全体の解析
- `file_search` で全ファイル一覧を取得（15 ファイル）。
- `read_file` で主要ファイルの内容を取得：
  - `cloud-run/index.js` （Express アプリ、Google Drive resumable 実装の参考に）
  - `cloudflare/public/app.js` （ドラッグ&ドロップ UI、XHR ベースの進捗表示）
  - `cloudflare/functions/api/get-upload-url.js` （R2 プリサインド URL 生成ロジック）
  - `cloudflare/functions/api/notify-transfer.js` （Cloud Run への通知）
  - パッケージ設定（`package.json`、`wrangler.toml`）

#### 2. 現在の設計・問題点の整理
- 既存アーキテクチャ（R2 バッファ方式）の課金と効率問題を指摘。
- 3 つの実装パターンを提案：
  1. クライアント OAuth で直接ユーザー Drive へアップロード
  2. サーバ（Cloud Run）で resumable セッションを作成し、クライアント直送
  3. **採用: Cloudflare Worker で resumable セッションを作成し、クライアント直送（推奨）**

#### 3. 最終アーキテクチャ設計書の作成
- `ARCHITECTURE.md` を新規作成（本ファイル）。
- 最終形態、コンポーネント設計、API 仕様、技術詳細、セキュリティ要件を文書化。
- 他の LLM/エンジニアが引き継げるよう、実装チェックリストと具体的なタスク分割を記載。

#### 4. コード解析
- `get_errors` でコンパイル/リンターエラーを確認 → **エラーなし**（既存コードは動作状態）。

### 実施内容の詳細

**A. 設計フェーズ**
- Discord → Browser → Cloudflare Worker（resumable session 作成）→ Google Drive（直接PUT）への流れを確定。
- Cloud Run 排除による月額コスト削減を定量化（Cloud Run 時給 vs Worker の無料枠／従量）。
- サービスアカウント秘密管理（wrangler secret）の手順を明記。

**B. ドキュメンテーション**
- 現在の README.md は空状態。`ARCHITECTURE.md` に集約。
- 他の LLM が「この設計書を読んで実装できる」レベルで詳細化。

**C. 検証**
- 既存コード（`app.js`, `notify-transfer.js` 等）の動作に問題なし。
- 新しい Worker エンドポイント（`/api/init-resumable`）は **未実装ステータス**。

---

## 残作業（Next Steps）

優先順位順に記載。

### 1. Worker エンドポイント実装（`/api/init-resumable`）— 高優先

**概要**: Google OAuth トークン発行 + Drive resumable session 作成

**ファイル**: `cloudflare/functions/api/init-resumable.js` （新規作成）

**実装要点**:
- リクエスト JSON から `filename`, `contentType`, `size` を受け取る。
- サービスアカウント JSON（`env.GOOGLE_SA_JSON`）から `client_email`, `private_key` を抽出。
- JWT 作成（`Header.Payload.Signature` 形式）、scope: `https://www.googleapis.com/auth/drive.file`。
- `POST https://oauth2.googleapis.com/token` でアクセストークン取得（`grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer`）。
- `GET https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable` + `X-Upload-Content-Type` ヘッダで Drive に resumable session 開始。
- `Location` レスポンスヘッダから upload URL を抽出、クライアントへ返す。

**返却フォーマット** (200):
```json
{
  "uploadUrl": "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=...",
  "fileId": "drive-file-id",
  "expiresIn": 3600
}
```

**参考コード**: `cloud-run/index.js` の行 27～60 に Google Drive API 実装がある（参考に）。

**見積り**: 200～300 行程度

---

### 2. クライアント側 resumable 実装（`cloudflare/public/app.js`）— 高優先

**概要**: チャンク分割・再試行可能なアップロード

**変更内容**:
- 現在の `uploadBtn` クリックハンドラ内で、R2 プリサインド URL の代わりに `/api/init-resumable` を呼ぶ。
- 受け取った `uploadUrl` に対して、チャンク単位（例: 10MB）で `PUT` を実行。
- `Content-Range: bytes <start>-<end>/<total>` ヘッダを設定。
- レスポンス 308 (Resume Incomplete) → 次チャンク。200/201 → 完了。
- 失敗時は `Range` ヘッダで再開位置を確認し、リトライ。
- 進捗バーは現向け実装（`XMLHttpRequest` + `upload.progress` イベント）を流用、UI は維持。

**チャンク設定例**:
```javascript
const CHUNK_SIZE = 10 * 1024 * 1024; // 10MB
```

**見積り**: 150～200 行の変更（既存進捗部分は再利用可能）

---

### 3. secret 登録手順の追加（`README.md`）— 中優先

**概要**: デプロイ時の環境変数設定方法

**内容**:
```bash
# (このワーカーでは Google サービスアカウント JSON は不要。R2 の認証情報のみを登録.)
wrangler deploy
```

**補足**: CORS の許可、期限管理も簡潔に記載。

---

### 4. CORS 検証・ブラウザテスト — 中優先

**手順**:
1. Worker をローカル (`wrangler dev`) で動かす。
2. ブラウザ開発ツール → Network タブで `POST /api/init-resumable` の応答を確認。
3. `uploadUrl` を取得後、小さいファイル（1MB）で PUT テスト。
4. Chrome, Firefox で動作確認。
5. CORS エラーが出ないか確認（Google Drive の upload URL が CORS 許可していることを前提）。

**想定結果**: 大抵は問題なく動く（Google API は CORS フレンドリー）が、万一エラーが出たら Worker 側で中継も検討。

---

### 5. (オプション) R2 フォールバック保持 — 低優先

現在の `notify-transfer.js` を残すか、完全に削除するかを決定。Worker resumable が安定して動作すれば、R2 は不要。ただし「直接PUT が CORS で問題ある場合」のフォールバック手段として残す選択肢もある（判断は実装後）。

---

## 実装前の確認事項

**Worker への secret 登録**:
- Worker には `service-account-key.json` は渡さない。Drive 認証は Cloud Run 側に任せる。
- token 発行時の有効期限チェック、セキュリティ監査を実施。

**Google Drive API の permissions**:
- サービスアカウントが書き込むフォルダの ID を環境変数 `DRIVE_PARENT_FOLDER_ID` で指定（任意）。
- フォルダが存在し、サービスアカウントにアクセス権があることを確認。

**大容量テスト**:
- 実装後、100MB〜1GB のファイルでアップロード成功を確認。
- 途中断・再開テストも実施。

---

## 技術的な注意・リスク

1. **JWT ライブラリ**: Worker 内で JWT を署名するため、`node-jose` や `@tsndr/cloudflare-worker-jwt` などのライブラリを検討。Cloudflare Worker の API だけでは署名が難しい。
2. **CORS**: Google Drive の `Location` へのブラウザからの直接 PUT が CORS で許可されているか一度確認が必要。通常は許可だが、万一ダメならWorker 側で中継（増加したレイテンシを許容する）。
3. **チャンクサイズ**: 10MB 単位を推奨（ネットワーク遅延リスクと再送コストのバランス）。
4. **セッション有効期限**: resumable session の有効期限がある（24時間程度）。クライアント側でタイムアウト検知とリトライオプションを用意。

## 追加コンポーネント: Discord Bot
- **役割**: `/upload` コマンドでユーザーに R2 への署名付きアップロード URL を返す。
- **実装**: `bot.js` (Node.js + discord.js)。Bot は `WORKER_URL` 環境変数で Cloudflare Worker の `get‑upload‑url` エンドポイントを呼び出す。
- **シークレット**: `DISCORD_BOT_TOKEN`, `WORKER_URL` (wrangler secret)。
- **フロー**:
  1. ユーザーが Discord で `/upload` コマンドを送信。オプションで
     `filename=<hint>` を付けることもできるが、ファイルを後から選ぶので
     通常は必要ない。
  2. Bot は `WORKER_URL/?sessionId=<rand>` という形式の URL を返信し、
     もしヒントが与えられていれば `&filename=<hint>` を追加する。
  3. ユーザーがリンクをクリック → Pages のアップロード UI に遷移
  4. ページはクエリパラメータを読み取り、ヒント付きのときのみ
     `/api/get-upload-url` を事前取得(prefetch)。ヒントなしの場合は
     ファイル選択後に取得する。
  5. 同ページがファイル選択ダイアログを自動オープン
  6. ユーザーがファイルを選択すると、選択したファイル名を含めて
     R2 署名 URL をリクエストし、その URL に `PUT` で送信
  7. アップロード完了後、ページが `/api/notify-transfer` を呼び出して
     Cloud Run に転送を依頼
  8. Cloud Run が R2 からデータをダウンロードし Google Drive に保存、
     成功後に R2 オブジェクトを削除

  この変更によりサービスアカウント鍵は不要になり、
  Pages/Workers は R2 URL の発行と通知だけを担う。
---

## Verification Plan
### Automated Tests
1. **Unit test for bot command handler** – using `jest` and mocking `node-fetch` to ensure the bot sends the correct reply when the API returns a URL.
   - Command to run: `npm test`
2. **Integration test** – start `wrangler dev` for the worker, run the bot locally, issue a `/upload` command via Discord test guild, and verify the reply contains a URL that matches the pattern `https://<.*>.r2.cloudflarestorage.com/*`.
   - Steps are documented in [README.md](file:///home/kiu/Documents/web/youth-mirai/team/Discord-Connector/README.md) under *Manual verification*.
### Manual Verification
1. Deploy the bot (or run locally) and register the command in a test guild.
2. In Discord, run `/upload filename=test.bin`.
3. Copy the returned URL, open it in a browser, and upload a small file (e.g., 1 KB) using `curl`:
   ```bash
   curl -X PUT "<uploadUrl>" --upload-file test.bin
   ```
   Verify that the file appears in the R2 bucket and that Cloud Run subsequently moves it to Google Drive (check Drive folder).
   Confirm that the bot logs show no errors.
Estimated effort: ~4 hours for bot implementation, secret setup, documentation, and verification.

---

**実装の進め方**: 上記の「残作業」セクション（1～5）を順番に実装し、各ステップ後に`wrangler dev` でローカル検証、最後にステージ環境でブラウザテストを推奨。

---

ファイル: ARCHITECTURE.md
