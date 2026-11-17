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
- セッション作成・公開読み取り・直接編集参加・編集参加者解除・同期・競合検知用 RPC（旧セッション用の招待・承認RPCは互換性のため残存）

この SQL は初期導入用です。すでに一部テーブルを手作業で作成した場合や、SQL の途中で失敗した場合は、エラーの状態を確認してから再実行してください。すべての既存テーブルを削除するような操作は含めていませんが、実行結果を確認してください。

## 3. 匿名ログインを有効化

Supabase Dashboard → Authentication / Sign-in methods の設定で **Anonymous Sign-Ins** を有効にする。必要な設定場所は Supabase の [Anonymous Sign-Ins 公式説明](https://supabase.com/docs/guides/auth/auth-anonymous) を参照。閲覧だけなら匿名認証は不要です。編集参加・共有スペース作成の操作時に匿名Authを裏側で使います。メールアドレスやパスワードは要求しません。

### 重要な制約

匿名ユーザーの ID はブラウザの保存領域に紐づきます。ブラウザのデータ削除、別ブラウザ／別端末への移行、ログアウトなどで元の ID を失うと、その ID が所有していたセッションや編集者権限を復旧できません。表示名は本人確認ではありません。ownerによる参加解除が拒否できるのも同じ匿名Auth IDだけであり、本人そのものを恒久的に遮断する機能ではありません。別端末やブラウザデータ削除後に新しい匿名IDを作れば、公開編集がONの間は再参加できます。

匿名サインインは編集参加・スペース作成のタイミングだけで使います。第三者に悪用される可能性があるため、Supabase の Auth rate limit を確認し、編集参加を広く許可する前に上記の CAPTCHA / Turnstile を設定してください。

SupabaseのAnonymous Authユーザーは自動削除されません。公式ドキュメントには30日を超えた匿名ユーザーを削除するSQL例がありますが、このプロジェクトではその一括削除を実行しないでください。`party_sessions.owner_user_id` と `session_members.user_id` は `auth.users` を `ON DELETE CASCADE` で参照しているため、所有者のAuthユーザーを削除すると共有スペースや参加データまで削除される可能性があります。同じAuthプロジェクトはLBTアカウント保管機能とも共有されています。現在は自動削除ジョブを設けず、Authユーザー数とDatabase Sizeを監視します。整理が必要な場合は、共有スペースの所有権・メンバーシップと他機能の参照を個別に確認してから実施してください。

## 4. 公開前に必須：Cloudflare Turnstile / CAPTCHA

匿名ユーザーを大量生成する攻撃は、ユーザー単位の SQL レート制限だけでは防ぎ切れません。**公開範囲を広げる前に CAPTCHA を有効にしてください。**

1. Cloudflare Turnstile でこのサイトのホスト名を登録し、Site key と Secret key を取得する。
2. `js/supabase-config.mjs` の `TURNSTILE_SITE_KEY` を Cloudflare の Site key と一致させる。現在の `main` には提供された Site key を設定済み。Site key は公開値なのでリポジトリに置いて構わない。
3. [Supabase の CAPTCHA 設定を直接開く](https://supabase.com/dashboard/project/hobntjcrzybqsiobrpsz/auth/protection)。画面で **Enable CAPTCHA protection** を有効にし、プロバイダーに Cloudflare Turnstile を選択して対応する Secret key を設定する。UI上で「Bot and Abuse Protection」という見出しが見当たらない場合は、直リンクを使う。**Secret key は Supabase Dashboard にのみ保存し、GitHub / ブラウザ / チャットへ置かない。**
4. デプロイ後、シークレットウィンドウで初回共有操作時に CAPTCHA が表示され、確認を完了しないと匿名ログインが作成されないことを確認する。失敗時・期限切れ時の再試行もテストする。

コードは匿名サインイン時にTurnstile Site keyと認証用 `captchaToken` を必須にし、Site key未設定またはtoken未取得なら匿名Authを開始しないfail-closed動作です。ただし、Site key / Secret keyを登録し、Supabase側でCAPTCHA protectionを有効にするまではサーバー側の検証は成立しません。両方の設定を必ず確認してください。Supabaseの [CAPTCHA protection 公式手順](https://supabase.com/docs/guides/auth/auth-captcha) を参照してください。

## 5. デプロイ結果の確認

Supabase GitHub Integration を使う場合は、Project Settings → Integrations で Working directory が `.`、Production branch が `main`、Deploy to production が有効であることを確認してください。GitHub Integration は未適用の migration を実行しますが、Auth 設定と seed SQL は本番へ自動適用されないため、次を別々に確認してください。

- migration: Dashboard の migration 履歴に `202610230001` および新しい forward migration がある。適用済み migration ファイルを編集しても、同じバージョンは再実行されない。
- Auth: Dashboard の Authentication 設定で Anonymous Sign-Ins と CAPTCHA protection が個別に有効化されている。
- seed: `202610230001` の適用後に `supabase/seed-persona-keys.sql` を SQL Editor などで別途実行し、許可対象の人格キー一覧を同期する。コード内の `config.toml` に seed のパスが書かれていても、本番 Integration が自動実行するとは限らない。

公式仕様: [Supabase GitHub Integration](https://supabase.com/docs/guides/deployment/branching/github-integration)。

### 5.1 Freeプランでの本番migration経路

このSupabase組織はFreeプランです。現在の料金表ではFreeにSupabase Branchingは含まれず、GitHub連携によるproductionへの直接デプロイは全プランで利用できます。したがって、このPRにSupabase Preview用DBが作られず、Preview checkがskipされること自体はテスト失敗ではありません。リリースのためだけに新しいpreview branchや別projectを作らず、無料枠を維持してください。

本番migrationの適用経路は次のどちらか一方に固定してください。

1. **GitHub Integrationがこのリポジトリを参照している場合**：Working directory `.`、Production branch `main`、Deploy to productionの状態を確認し、migration適用履歴を照合します。`main`へ統合したときに対象migrationが一度だけ適用されることを確認します。
2. **GitHub Integrationが別リポジトリを参照している、または自動適用を無効にしている場合**：このPRのSQLファイルをDashboardのSQL Editorから一度だけ適用し、Postgresのmigration履歴とRPC・trigger・policyを確認します。その後も自動適用と手動適用を併用しないでください。

現在の接続先は複数リポジトリで共有されているため、GitHub Integrationがどのリポジトリを参照しているかをコネクタから確認できていません。実際のIntegration設定を見ずに、mergeだけでこのPRのmigrationが本番に届くと判断しないでください。

### 5.1 Supabase Branching と既存migration履歴

2026-11-17のSupabase Branch一覧では、既定の `main` branchが `MIGRATIONS_FAILED` と表示されていた。`updated_at` は2026-10-23のままで、新しい共有編成migrationの適用時刻とは一致しない。実際の失敗内容はDashboard → Branches → `main` → **View logs** で確認する必要がある。

ただし、今回の共有編成migrationはPreview branch経由ではなく、本番PostgreSQL 17.11に直接適用し、Postgres migration履歴に `20261117155808_public_view_open_edit_realtime` として登録されたことを確認済みである。追加カラム、RPC、Realtime policy、triggerも本番DBで確認した。**このversionを本番へ再度手動適用してはいけない。** 現在のGitブランチにも同じversion名のSQLファイルがあり、将来のmigration履歴照合に使える。

このSupabaseプロジェクトはFreeプランで、Supabase BranchingのPreview環境は作成していない。GitHubの `Supabase Preview` がskipされても、この機能migrationの本番適用が失敗したことを意味しない。GitHub ActionsのNodeテストは別途成功している。

このSupabaseプロジェクトは複数リポジトリで共有されている。本番migration履歴にはLBTアカウント保管機能の次のversionが記録されている。

- `20261025211015_lbt_account_vaults`
- `20261025212903_lbt_account_vault_access_hardening`
- `20261025215542_reject_anonymous_vault_access`
- `20261025232745_lbt_account_payload_hashes`
- `20261026001049_drop_stale_lbt_vault_policies`

現行の `LBTStudio/LIMBUS_BUILD_TERMINAL` には4つのmigrationファイルがあり、`202610260002_reject_anonymous_vault_access.sql` は本番履歴の `20261025215542` とversionが異なる。また `20261026001049_drop_stale_lbt_vault_policies` は現行ファイル一覧で見つからなかった。これらの既存差分がBranching `MIGRATIONS_FAILED` と関係する可能性はあるが、Dashboardの失敗ログなしに原因を断定しない。

本番DBに今回のmigrationが適用済みであることと、Supabase GitHub Integrationが現在どのrepositoryをproduction branchとして参照しているかは別問題である。Project Settings → Integrationsで対象repository・Working directory・Production branch・Deploy to productionを確認すること。自動適用を利用する場合は、対象versionがmigration履歴に存在するため再実行されないことを確認し、SQL Editorから同じversionを重ねて実行しない。別リポジトリが管理元なら、既存migrationの復旧はそのリポジトリの管理下で行う。

Branching `MIGRATIONS_FAILED` の原因を確定するまでは、branchのreset/rebase/deleteやmigration repairをしない。Supabase公式の [Branching troubleshooting](https://supabase.com/docs/guides/deployment/branching/troubleshooting) を参照。

### 5.2 Realtimeのprivate channel設定

Supabase Dashboard → Project Settings → Realtime → **Allow public access to channels** を **OFF** にしてください。これにより、private channelへの接続時に `realtime.messages` のRLSポリシーが評価されます。このプロジェクトでは、セッションのowner/editorだけを `party:<session_id>` のBroadcast受信者として許可します。ONのままの場合、public channelに対してRLS認可が実行されず、意図したアクセス境界と異なるため、公開前の必須設定です。

フロントエンドも `config.private: true` で接続し、DB側の `realtime.send(..., private => true)` と一致させます。どちらか一方だけprivateにしても配信は成立しません。詳しくはSupabaseの [Realtime Authorization](https://supabase.com/docs/guides/realtime/authorization)、[Realtime Settings](https://supabase.com/docs/guides/realtime/settings)、[Broadcast](https://supabase.com/docs/guides/realtime/broadcast) を参照してください。

## 6. 動作確認

新しい読み取り・直接編集方式を使うには、既存マイグレーションの後に `20261117155808_public_view_open_edit_realtime.sql` を適用し、その後GitHub Pagesを更新します。**このSupabase本番環境では、2026-11-17にmigration version `20261117155808` として適用済み**です。同じ本番DBへSQL Editorから再実行しないでください。他の環境へ導入する場合は、このversionを一度だけ適用します。フロントエンドだけ先に公開すると新RPCが見つからず共有機能が利用できません。既存の共有スペースは公開閲覧・公開編集ともOFFのまま移行されます。DB関数による作成も初期値は両方OFFです。新UIから新規作成した場合だけ、作成直後に両方ONへ切り替えます。したがって、マイグレーション適用後・フロントエンド公開前の旧UIによる新規作成も非公開のままです。

1. 発行者のブラウザで共有スペースを作成し、編成に人格を追加する。保存が成功しrevisionが増えることを確認する。
2. 「閲覧・編集リンクをコピー」でリンクを取得し、ログインしていない別ブラウザで開く。認証や申請なしに編成が表示され、画面を開いたままでも自動ポーリングやRealtime接続が発生しないことを確認する。
3. 閲覧側で「編成を更新」を押し、最新revisionへ更新できることを確認する。同じタブで再読み込みした場合、60秒以内は閲覧キャッシュが使われ、キャッシュからowner/editor権限が復元されないことを確認する。
4. 閲覧側で「編集に参加」を押す。初回は必要に応じてTurnstile確認と匿名Authが実行され、承認待ち画面を経ずに編集可能になることを確認する。
5. 編集者2人で同時に編集し、Realtime通知後にrevisionが読み直されること、競合時は既存の競合UIが表示されることを確認する。
6. ブラウザのネットワークを遮断してRealtime接続を失敗させ、編集画面だけが低頻度pollへフォールバックすることを確認する。閲覧画面には自動pollがないことも確認する。
7. 発行者画面で「新しい人の編集参加を許可する」を無効にする。未参加者のjoin RPCが拒否される一方、既存editorは引き続き編集・同期できることを確認する。再びONにすると新しい参加を受け付けることを確認する。
8. 発行者画面で特定の編集参加者を解除する。同じブラウザ・同じ匿名Auth IDでは「編集に参加」が拒否され、公開編集を再度ONにしても拒否記録が残ることを確認する。別端末やブラウザデータ削除後の新しい匿名IDは本人確認されないため、公開編集ONなら再参加できることも運用上の制約として確認する。
9. 「共有リンクからの閲覧」を無効にすると「誰でも編集参加」もOFFになり、未認証の別ブラウザから新規取得できないこと、発行者は認証済みのまま設定を再度有効にできることを確認する。
10. 編集参加者20名の上限、1ユーザー20スペースの上限、スペース終了、30日未利用の自動終了・7日後削除を確認する。

## 7. 人格DB更新時

`data/personas.json` が更新されたら、`npm run build:supabase-seed` が `supabase/seed-persona-keys.sql` を再生成する。この seed SQL は DB の許可キー一覧を `data/personas.json` と完全一致させるため、新しいキーの追加だけでなく削除されたキーも反映します。人格データが更新された場合は SQL Editor で `supabase/seed-persona-keys.sql` を再実行して同期してください。通常の人格データ更新 workflow はこの seed を自動生成し、差分をコミットする。

## 未完了事項

- この初期実装は匿名 Auth ベースで、メール／OAuth による所有者の本人確認・アカウント復旧は未実装。
- CAPTCHA / Turnstile はコード側のトークン連携を実装済みだが、Cloudflare Site key / Secret key の登録と Supabase 側 CAPTCHA 有効化は管理者操作が必要。
- Supabase の実 DB へ SQL を適用した成功確認は、migration のデプロイ後に行う。デプロイ履歴または RPC の応答を確認し、動作確認手順を実施する必要がある。
- RLS/RPC の負荷・権限テストを実 Supabase で行う必要がある。既存の Node テストはデータ集計、パーサー、静的な SQL セキュリティ条件を確認するのみ。


## 8. 共有編成の保存先と自動削除

「共有編成」は端末セッション管理ではなく、Supabase に保存される共同編集ワークスペースです。個人編成は各ブラウザの `localStorage` / URL、共有編成は Supabase Postgres が正本です。

- 認可済みユーザーが共有編成を表示している間は、最終利用時刻を最大5分に1回更新します。
- 30日間誰も開かなかった共有編成は日次ジョブで自動終了扱いになり、さらに7日後にセッション、メンバー、招待、申請、編集イベントが削除されます。
- 発行者が「共同編集スペースを終了」を確定した場合は、親セッションと関連する参加者・招待・申請・編集イベントをその場で物理削除します。復元できません。
- 自動終了から7日後に行う削除猶予は、30日間利用されなかったセッションだけに適用されます。
- 手動終了で共有セッションを即時削除しても、乱発防止の作成回数記録（1時間10件・30日50件）は30日間の枠内で維持されます。
- 旧方式で終了済み・削除待ちだったセッションのうち、作成から30日以内のものは即時削除のポリシーへ移行する際にまとめて削除します。作成回数記録は残ります。
- 「この端末で閉じる」は現在の表示を個人編成に戻すだけで、共有編成を削除しません。
- 1つのスペースは発行者込み最大20名です。16名に限定する変更はしていません。短時間の通常利用は現構成で十分現実的と見積もりますが、20名全員の長時間利用や大容量スナップショットが続く場合の負荷保証ではありません。poll数・Egressの概算と本番DB計測値は [共有セッション設計](shared-sessions-design.md) を参照し、公開後はDashboardでEgress / CPU / DB connectionsを確認してください。
- 追加人格ライブラリの上限はブラウザごとに最大300件、1編成に同時配置できる人格は最大6名です。人格ライブラリ全体はクラウド共有せず、共有編成に選ばれた人格データのみ送信します。参加者数上限とは別の制限です。
- 自動削除ジョブは `pg_cron` を使います。migration 適用後に Database → Cron Jobs で `cleanup-idle-party-sessions` が登録され、成功履歴が出ていることを確認してください。
