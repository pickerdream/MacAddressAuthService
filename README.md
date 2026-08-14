# MAC Address Auth Service (MAC Gate)

FreeRADIUS による MAC アドレス認証を管理するための社内向け Web サービスです。
利用者がブラウザから所有デバイスの MAC アドレスを登録申請し、管理者が承認することで、自動的に FreeRADIUS が参照するデータベース（PostgreSQL）に反映されます。

---

## 🏗️ 環境の違いについて

本システムは、**本番環境**と**開発・テスト環境**で Docker の実行構成を明確に分けています。

*   **開発・テスト環境 (`docker-compose.yml`)**
    *   起動時に `seed` スクリプトが自動実行され、テスト用のダミー管理者ユーザー（`admin@example.local`）と初期データが自動生成されます。
    *   起動してすぐにログインし、動作確認が行えます。
*   **本番環境 (`docker-compose.prod.yml`)**
    *   データベースのテーブルのみ作成され、**ダミーユーザーは作成されません**。
    *   初回アクセス時にブラウザ上に**セットアップウィザード**が表示され、本番用の管理者アカウントを手動で登録する安全な設計になっています。

---

## 🚀 実行手順

### A. 開発・テスト環境で実行する場合

Docker Desktop を使用して、手軽に動作確認が可能です。

1.  以下のコマンドでビルドと起動を行います。
    ```powershell
    docker compose up --build -d
    ```
2.  ブラウザで `http://localhost:3000` にアクセスします。
3.  以下のテスト用アカウントでログインできます。
    *   **メールアドレス:** `admin@example.local`
    *   **パスワード:** `ChangeMe123!`
4.  停止・クリーンアップ（データをリセット）する場合は以下を実行します。
    ```powershell
    docker compose down -v
    ```

### B. 本番環境で実行する場合

本番環境では、マルチステージビルドによる軽量なコンテナが非rootユーザーで実行されます。

1.  環境変数ファイルの雛形をコピーします。
    ```powershell
    cp .env.production.example .env.production
    ```
2.  `.env.production` をテキストエディタで開き、**必ず推測不可能なランダムな文字列**に変更してください。
    *   `POSTGRES_PASSWORD`: データベースのパスワード
    *   `DATABASE_URL`: `postgresql://macauth:<上記のパスワード>@postgres:5432/macauth` に修正
    *   `SESSION_SECRET`: セッション暗号化キー（32文字以上のランダム文字列）
3.  以下のコマンドで起動します。
    ```powershell
    docker compose --env-file .env.production -f docker-compose.prod.yml up -d
    ```
4.  初回起動後、ブラウザで `http://localhost:3000` にアクセスすると**初期セットアップウィザード**が表示されます。画面の指示に従って最初の管理者ユーザーを作成してください。

> [!WARNING]
> 本番データベースのデータは `production-postgres-data` ボリュームに永続化されます。運用中は絶対に `docker compose -f docker-compose.prod.yml down -v`（`-v`オプション付き）を実行しないでください。データが全て消失します。

---

## 🔑 シングルサインオン（SAML SSO）の連携

本システムは SAML 2.0 に準拠した IdP (Identity Provider) とのシングルサインオンに対応しています。
SSO を有効にするには、`.env` ファイル（または環境変数）に以下の設定を追加してください。

*   `SAML_ENTRY_POINT`: IdP の SSO ログイン URL (例: `https://idp.example.com/saml2/idp/SSOService.php`)
*   `SAML_ISSUER`: 本サービスの識別子 (例: `mac-address-auth-service`)
*   `SAML_CERT`: IdP の公開鍵証明書 (ヘッダー/フッターを含まない1行の文字列、または PEM 形式)
*   `SAML_CALLBACK_URL` (任意): コールバックURLのオーバーライド

> [!NOTE]
> SSO が有効な場合、ログイン画面に「シングルサインオン (SAML) でログイン」ボタンが表示されます。
> SAML 経由で初めてログインしたユーザーは自動的に「利用者」としてシステムに登録され、パスワード変更機能は無効化されます。

---

## 📡 FreeRADIUS の設定

管理画面で承認された MAC アドレスは、PostgreSQL の `radcheck` テーブルに以下の形式で自動登録されます。

| username | attribute | op | value |
| :--- | :--- | :--- | :--- |
| `AA:BB:CC:DD:EE:FF` | `Cleartext-Password` | `:=` | `AA:BB:CC:DD:EE:FF` |

FreeRADIUS がこの PostgreSQL を参照して認証・アカウンティング（ログ記録）を行うよう、以下の設定を行ってください。

### 1. SQL モジュールの有効化
FreeRADIUS サーバー上で PostgreSQL 用のドライバをインストールし、モジュールを有効化します。

```bash
# Ubuntu/Debian の場合
sudo apt install freeradius-postgresql
sudo ln -s /etc/freeradius/3.0/mods-available/sql /etc/freeradius/3.0/mods-enabled/
```

### 2. データベース接続設定
`/etc/freeradius/3.0/mods-available/sql` を編集し、本システムの PostgreSQL に接続するよう設定します。

```text
sql {
    driver = "rlm_sql_postgresql"
    server = "192.168.x.x"  # このWebサービスをホストしているサーバーのIP
    port = 5432
    login = "macauth"       # .env の POSTGRES_USER
    password = "..."        # .env の POSTGRES_PASSWORD
    radius_db = "macauth"   # .env の POSTGRES_DB
    
    # テーブル名はデフォルトのまま (radcheck, radacct) で動作します
}
```

### 3. 認証・アカウンティングの組み込み
`/etc/freeradius/3.0/sites-available/default` （またはご使用の仮想サーバー設定ファイル）を編集します。

```text
authorize {
    ...
    sql
    ...
}

accounting {
    ...
    sql
    ...
}
```
※ `accounting` セクションに `sql` を追加することで、APから送信される接続・切断ログが `radacct` テーブルに保存され、本Webシステムの「管理機能 ＞ 接続ログ」から閲覧できるようになります。

### 4. MAC アドレスフォーマットの統一
AP（アクセスポイント）やスイッチが FreeRADIUS に送信してくる MAC アドレスのフォーマットに合わせて、本アプリの `.env` ファイル内の `RADIUS_MAC_FORMAT` を設定してください。

*   `colon` (既定): `AA:BB:CC:DD:EE:FF`
*   `hyphen`: `AA-BB-CC-DD-EE-FF`
*   `plain`: `AABBCCDDEEFF`

設定後、FreeRADIUS を再起動（`sudo systemctl restart freeradius`）して連携をテストしてください。
