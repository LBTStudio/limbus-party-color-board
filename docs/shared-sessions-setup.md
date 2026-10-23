# 共有セッション導入手順

このリポジトリには共有編成のフロントエンドと SQL マイグレーションを追加しています。**接続設定が入るまでは公開サイトで共有機能は動作しません**。Supabase の secret / service role key はブラウザへ絶対に置かないでください。

## 1. ブラウザ用 publishable key を設定

1. Supabase Dashboard で対象プロジェクト `hobntjcrzybqsiobrpsz` を開く。
2. Project Settings → API Keys（または Project Overview の Connect）で **Publishable key** をコピーする。古いプロジェクトでは `anon` key が表示される場合がある。
3. `js/supabase-config.mjs` の `SUPABASE_PUBLISHABLE_KEY` の値を置き換える。`SUPABASE_URL` はこのプロジェクトの URL として設定済み。
4. 変更をリポジトリへ push する。これはブラウザで公開されるキーなので、公開してはいけない secret / service_role key とは異なる。実際のデータアクセスはこの実装の RPC 権限チェックで制限される。

**選択するのは `sb_publishable_...` または legacy `anon` key です。** `sb_secret_...`、`service_role` は入力しないでください。

## 2. DB マイグレーションを適用

Supabase Dashboard → SQL Editor から `supabase/migrations/202610230001_shared_party_sessions.sql` 全体を開いて実行する。成功したら以下が作成される。

- セッション、参加者、招待、アクセス申請、編集履歴、許可済み人格キーのテーブル
- ブラウザからの直接テーブルアクセスを禁止する権限と RLS
- セッション作成・招待・承認／却下・権限剥奪・同期・競合検知用 RPC

この SQL は初期導入用です。すでに一部テーブルを手作業で作成した場合や、SQL の途中で失敗した場合は、エラーの状態を確認してから再実行してください。すべての既存テーブルを削除するような操作は含めていませんが、実行結果を確認してください。

## 3. 匿名ログインを有効化

Supabase Dashboard → Authentication の設定で **Anonymous Sign-Ins** を有効にする。共有リンクを開く側も、編成へのアクセス申請を送るための匿名ユーザーとして認証される。メールアドレスやパスワードは現行の初期実装では要求しない。

### 重要な制約

匿名ユーザーの ID はブラウザの保存領域に紐づきます。ブラウザのデータ削除、別ブラウザ／別端末への移行、ログアウトなどで元の ID を失うと、その ID が所有していたセッションを復旧できません。最初はテスト用セッションのみで確認してください。本運用前には、所有者アカウントをメール／OAuth にリンクできる認証導線を追加するのが安全です。

匿名サインインは第三者に悪用される可能性があるため、Supabase の Auth rate limit を確認し、公開範囲を広げる前に CAPTCHA / Turnstile などのボット対策も検討してください。現行コードには CAPTCHA トークンの連携はまだありません。

## 4. GitHub / Supabase デプロイ設定

Supabase Project Settings → Integrations の GitHub Integration で対象リポジトリを選択し、Working directory はリポジトリ直下の `.` を指定する。Production branch のデプロイを有効化した場合、新しいマイグレーションは通常そのブランチへ merge した後に適用される。

この会話で確認できた Supabase の Integrations ページでは、GitHub リポジトリの選択を促す画面になっていたため、プロジェクト単位の接続と production deploy が有効かを確認すること。接続だけではフロントエンドの publishable key や Auth 設定が自動で埋まるわけではない。

マイグレーションを手動で SQL Editor から適用した場合、Supabase CLI の migration 履歴と一致しない可能性がある。後で GitHub Integration / CLI を本格運用する際は、実 DB の状態と migration 履歴を照合し、同じ変更を二重に適用しないようにする。

## 5. 動作確認

1. GitHub Pages の配信更新後、サイトを開き「空の共有セッションを作成」を押す。
2. 任意のセッション名で作成し、発行者として編成に人格を追加する。パネルの状態が「保存済み」になることを確認する。
3. 「参加リンクを発行」でリンクをコピーし、別のブラウザプロファイル／シークレットウィンドウで開く。表示名を入力してアクセス申請を送る。
4. 発行者側で「自分のセッションを読み込む」を押し、参加申請を編集者または閲覧者として承認する。
5. 参加者側で承認が確認され、編成が表示されることを確認する。編集者による追加・交換・削除は数秒以内に他画面へ同期される。閲覧者の編集ボタンが無効であることも確認する。
6. 2画面でほぼ同時に編集し、競合 UI が出ることを確認する。招待リンク失効、参加権限剥奪、セッション終了もテストする。

## 6. 人格DB更新時

`data/personas.json` が更新されたら、`npm run build:supabase-seed` が `supabase/seed-persona-keys.sql` を再生成する。この seed SQL は DB の許可キー一覧へ追加するためのものなので、新しい人格キーが追加された場合は SQL Editor で `supabase/seed-persona-keys.sql` を再実行して DB 側の許可リストを同期する。通常の人格データ更新 workflow はこの seed を自動生成し、差分をコミットする。

## 未完了事項

- この初期実装は匿名 Auth ベースで、メール／OAuth による所有者の本人確認・アカウント復旧は未実装。
- CAPTCHA / Turnstile の UI/API 連携とアクセス申請スパム対策は追加が必要。
- Supabase の実 DB へ SQL を適用した成功確認は、この PR からは行えていない。マイグレーションを適用し、動作確認手順を実施する必要がある。
- RLS/RPC の負荷・権限テストを実 Supabase で行う必要がある。既存の Node テストはデータ集計、パーサー、静的な SQL セキュリティ条件を確認するのみ。
