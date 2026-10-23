# 共有セッション導入手順

このリポジトリには共有編成のフロントエンドと SQL マイグレーションを追加しています。**接続設定が入るまでは公開サイトで共有機能は動作しません**。Supabase の secret / service role key はブラウザへ絶対に置かないでください。

## 1. ブラウザ用 publishable key

この PR の `js/supabase-config.mjs` には、プロジェクトの Dashboard に表示されている `sb_publishable_...` キーを設定済みです。通常、追加操作は不要です。念のため、対象プロジェクトの Project Settings → API Keys と一致することを確認してください。

このキーはブラウザに配信される公開キーであり、公開リポジトリに置いて問題ありません。実際のアクセス権は RLS とサーバー側 RPC で制御します。**`sb_secret_...` や旧形式の `service_role` キーは、ブラウザ設定や公開リポジトリに絶対に置かないでください。** [Supabase API keys の公式説明](https://supabase.com/docs/guides/getting-started/api-keys)
## 2. DB マイグレーションを適用

次のどちらか一方を選ぶ。

- **GitHub Integration で自動適用する場合（推奨）:** リポジトリ連携済みとのことなので、Project Settings → Integrations → GitHub Integration で Working directory が `.`、Production branch が `main`、Deploy to production が有効であることを確認する。このリポジトリの `supabase/config.toml` には `[remotes.main]`、匿名ログイン設定、人格キーseedのパスを追加済み。PRを `main` にマージした後、Supabase Dashboardのデプロイ履歴で migration・config・seed の各ステップが成功したことを確認する。Supabaseの [GitHub integration 公式手順](https://supabase.com/docs/guides/deployment/branching/github-integration) を参照。
- **手動で適用する場合:** 自動デプロイが未設定なら、Dashboard → SQL Editor から `supabase/migrations/202610230001_shared_party_sessions.sql` 全体を開いて実行する。

GitHub Integration が `supabase/config.toml` の設定を本番にも適用するには、対象の本番ブランチに対応する `[remotes.main]` の指定が必要です。seed は migration の後に実行されます。手動実行と自動適用を併用しないでください。公式仕様は [Supabase GitHub Integration](https://supabase.com/docs/guides/deployment/branching/github-integration) を参照してください。

- セッション、参加者、招待、アクセス申請、編集履歴、許可済み人格キーのテーブル
- ブラウザからの直接テーブルアクセスを禁止する権限と RLS
- セッション作成・招待・承認／却下・閲覧者／編集者の変更・権限剥奪・同期・競合検知用 RPC

この SQL は初期導入用です。すでに一部テーブルを手作業で作成した場合や、SQL の途中で失敗した場合は、エラーの状態を確認してから再実行してください。すべての既存テーブルを削除するような操作は含めていませんが、実行結果を確認してください。

## 3. 匿名ログインを有効化

Supabase Dashboard → Authentication / Sign-in methods の設定で **Anonymous Sign-Ins** を有効にする。必要な設定場所は Supabase の [Anonymous Sign-Ins 公式説明](https://supabase.com/docs/guides/auth/auth-anonymous) を参照。共有リンクを開く側も、編成へのアクセス申請を送るための匿名ユーザーとして認証される。メールアドレスやパスワードは現行の初期実装では要求しない。

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
6. 2画面でほぼ同時に編集し、競合 UI が出ることを確認する。所有者画面で参加者を閲覧者／編集者へ変更できること、招待リンク失効、参加権限剥奪、セッション終了もテストする。

## 6. 人格DB更新時

`data/personas.json` が更新されたら、`npm run build:supabase-seed` が `supabase/seed-persona-keys.sql` を再生成する。この seed SQL は DB の許可キー一覧を `data/personas.json` と完全一致させるため、新しいキーの追加だけでなく削除されたキーも反映します。人格データが更新された場合は SQL Editor で `supabase/seed-persona-keys.sql` を再実行して同期してください。通常の人格データ更新 workflow はこの seed を自動生成し、差分をコミットする。

## 未完了事項

- この初期実装は匿名 Auth ベースで、メール／OAuth による所有者の本人確認・アカウント復旧は未実装。
- CAPTCHA / Turnstile の UI/API 連携とアクセス申請スパム対策は追加が必要。
- Supabase の実 DB へ SQL を適用した成功確認は、この PR からは行えていない。マイグレーションを適用し、動作確認手順を実施する必要がある。
- RLS/RPC の負荷・権限テストを実 Supabase で行う必要がある。既存の Node テストはデータ集計、パーサー、静的な SQL セキュリティ条件を確認するのみ。
