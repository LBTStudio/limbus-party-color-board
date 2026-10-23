# 共有セッション導入手順

このリポジトリには共有編成のフロントエンドと SQL マイグレーションが含まれています。**Supabase のプロジェクト設定と migration の適用が済むまで、公開サイトで共有機能は動作しません**。Supabase の secret / service role key はブラウザへ絶対に置かないでください。

## 1. ブラウザ用 publishable key

`js/supabase-config.mjs` には、対象プロジェクトのDashboardに表示されている公開キーを設定済みです。追加のキー登録は不要です。対象プロジェクトの Project Settings → API Keys と一致することだけ確認してください。キーを変更した場合は、このファイルを更新して再デプロイしてください。

このキーはブラウザに配信される公開キーであり、公開リポジトリに置いて問題ありません。実際のアクセス権は RLS とサーバー側 RPC で制御します。**`sb_secret_...` や旧形式の `service_role` キーは、ブラウザ設定や公開リポジトリに絶対に置かないでください。** [Supabase API keys の公式説明](https://supabase.com/docs/guides/getting-started/api-keys)

## 2. DB マイグレーションを適用

次のどちらか一方を選ぶ。

- **GitHub Integration で自動適用する場合（推奨）:** Project Settings → Integrations → GitHub Integration で Working directory が `.`、Production branch が `main`、Deploy to production が有効であることを確認する。`main` にマージすると未適用の migration は自動適用される。**GitHub Integration は Auth 設定と seed SQL を本番へ自動適用しないため、Anonymous Sign-Ins と CAPTCHA は Dashboard で個別に設定し、人格キー seed は migration 適用後に別途実行する。** Supabase の [GitHub integration 公式手順](https://supabase.com/docs/guides/deployment/branching/github-integration) を参照。
- **手動で適用する場合:** 自動デプロイが未設定なら、Dashboard → SQL Editor から `supabase/migrations/202610230001_shared_party_sessions.sql` 全体を開いて実行する。

GitHub Integration が適用するのは未適用の migration など所定のデプロイ対象であり、Auth の設定値と `seed-persona-keys.sql` は自動適用される前提にしないでください。接続状況は Project Settings → Integrations で確認できます。

- セッション、参加者、招待、アクセス申請、編集履歴、許可済み人格キーのテーブル
- ブラウザからの直接テーブルアクセスを禁止する権限と RLS
- セッション作成・招待・承認／却下・閲覧者／編集者の変更・権限剥奪・同期・競合検知用 RPC

この SQL は初期導入用です。すでに一部テーブルを手作業で作成した場合や、SQL の途中で失敗した場合は、エラーの状態を確認してから再実行してください。すべての既存テーブルを削除するような操作は含めていませんが、実行結果を確認してください。

## 3. 匿名ログインを有効化

Supabase Dashboard → Authentication / Sign-in methods の設定で **Anonymous Sign-Ins** を有効にする。必要な設定場所は Supabase の [Anonymous Sign-Ins 公式説明](https://supabase.com/docs/guides/auth/auth-anonymous) を参照。共有リンクを開く側も、編成へのアクセス申請を送るための匿名ユーザーとして認証される。メールアドレスやパスワードは現行の初期実装では要求しない。

### 重要な制約

匿名ユーザーの ID はブラウザの保存領域に紐づきます。ブラウザのデータ削除、別ブラウザ／別端末への移行、ログアウトなどで元の ID を失うと、その ID が所有していたセッションを復旧できません。最初はテスト用セッションのみで確認してください。本運用前には、所有者アカウントをメール／OAuth にリンクできる認証導線を追加するのが安全です。

匿名サインインは第三者に悪用される可能性があるため、Supabase の Auth rate limit を確認し、公開範囲を広げる前に上記の CAPTCHA / Turnstile を必ず設定してください。

## 4. 公開前に必須：Cloudflare Turnstile / CAPTCHA

匿名ユーザーを大量生成する攻撃は、ユーザー単位の SQL レート制限だけでは防ぎ切れません。**公開範囲を広げる前に CAPTCHA を有効にしてください。**

1. Cloudflare Turnstile でこのサイトのホスト名を登録し、Site key と Secret key を取得する。
2. \`js/supabase-config.mjs\` の \`TURNSTILE_SITE_KEY\` を Site key に置き換えてコミットする。Site key は公開値なのでリポジトリに置いて構わない。
3. [Supabase の CAPTCHA 設定を直接開く](https://supabase.com/dashboard/project/hobntjcrzybqsiobrpsz/auth/protection)。画面で **Enable CAPTCHA protection** を有効にし、プロバイダーに Cloudflare Turnstile を選択して対応する Secret key を設定する。UI上で「Bot and Abuse Protection」という見出しが見当たらない場合は、直リンクを使う。**Secret key は Supabase Dashboard にのみ保存し、GitHub / ブラウザ / チャットへ置かない。**
4. デプロイ後、シークレットウィンドウで初回共有操作時に CAPTCHA が表示され、確認を完了しないと匿名ログインが作成されないことを確認する。失敗時・期限切れ時の再試行もテストする。

コードには Turnstile の Site key と認証時の \`captchaToken\` を渡す仕組みを追加していますが、Cloudflare の Site key / Secret key を登録し、Supabase 側で CAPTCHA を有効化するまでは有効な防御になりません。Supabase の [CAPTCHA protection 公式手順](https://supabase.com/docs/guides/auth/auth-captcha) を参照してください。

## 5. デプロイ結果の確認

Supabase GitHub Integration を使う場合は、Project Settings → Integrations で Working directory が `.`、Production branch が `main`、Deploy to production が有効であることを確認してください。GitHub Integration は未適用の migration を実行しますが、Auth 設定と seed SQL は本番へ自動適用されないため、次を別々に確認してください。

- migration: Dashboard の migration 履歴に `202610230001` および新しい forward migration がある。適用済み migration ファイルを編集しても、同じバージョンは再実行されない。
- Auth: Dashboard の Authentication 設定で Anonymous Sign-Ins と CAPTCHA protection が個別に有効化されている。
- seed: `202610230001` の適用後に `supabase/seed-persona-keys.sql` を SQL Editor などで別途実行し、許可対象の人格キー一覧を同期する。コード内の `config.toml` に seed のパスが書かれていても、本番 Integration が自動実行するとは限らない。

公式仕様: [Supabase GitHub Integration](https://supabase.com/docs/guides/deployment/branching/github-integration)。

**手動でSQL Editorから同じmigrationを実行するのは、GitHub連携で適用しない場合だけにしてください。** 両方を使うと migration 履歴がずれる可能性があります。
## 6. 動作確認

1. GitHub Pages の配信更新後、サイトを開き「空の共有セッションを作成」を押す。
2. 任意のセッション名で作成し、発行者として編成に人格を追加する。パネルの状態が「保存済み」になることを確認する。
3. 「参加リンクを発行」でリンクをコピーし、別のブラウザプロファイル／シークレットウィンドウで開く。表示名を入力してアクセス申請を送る。
4. 発行者側で「自分のセッションを読み込む」を押し、参加申請を編集者または閲覧者として承認する。
5. 参加者側で承認が確認され、編成が表示されることを確認する。編集者による追加・交換・削除は数秒以内に他画面へ同期される。閲覧者の編集ボタンが無効であることも確認する。
6. 2画面でほぼ同時に編集し、競合 UI が出ることを確認する。所有者画面で参加者を閲覧者／編集者へ変更できること、招待リンク失効、参加権限剥奪、セッション終了もテストする。

## 7. 人格DB更新時

`data/personas.json` が更新されたら、`npm run build:supabase-seed` が `supabase/seed-persona-keys.sql` を再生成する。この seed SQL は DB の許可キー一覧を `data/personas.json` と完全一致させるため、新しいキーの追加だけでなく削除されたキーも反映します。人格データが更新された場合は SQL Editor で `supabase/seed-persona-keys.sql` を再実行して同期してください。通常の人格データ更新 workflow はこの seed を自動生成し、差分をコミットする。

## 未完了事項

- この初期実装は匿名 Auth ベースで、メール／OAuth による所有者の本人確認・アカウント復旧は未実装。
- CAPTCHA / Turnstile はコード側のトークン連携を実装済みだが、Cloudflare Site key / Secret key の登録と Supabase 側 CAPTCHA 有効化は管理者操作が必要。
- Supabase の実 DB へ SQL を適用した成功確認は、migration のデプロイ後に行う。デプロイ履歴または RPC の応答を確認し、動作確認手順を実施する必要がある。
- RLS/RPC の負荷・権限テストを実 Supabase で行う必要がある。既存の Node テストはデータ集計、パーサー、静的な SQL セキュリティ条件を確認するのみ。
