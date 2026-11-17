# 共有セッションの設計

## 目的と切り分け

共有編成は「見るだけ」と「編集に参加する」を分離する。閲覧者にログイン・招待・承認を要求せず、閲覧中の定期通信も行わない。編集者だけが認証済みの共有メンバーとなり、変更通知を受ける。

この設計の前提は、Supabase Freeでの通常利用を目標にしつつ、アクセス量の実測なしに大量アクセスへの耐性を保証しないこと。読み取りをCDNへ逃がす仕組みは現在の実装に含めない。

## モードと権限

| モード | 開始方法 | 認証 | 自動通信 | 操作 |
|---|---|---|---|---|
| 閲覧 | `#session=<uuid>` の共有リンク | 不要 | なし | 編成・人格・罪悪属性を閲覧。手動更新可能 |
| 編集参加 | 閲覧画面の「編集に参加」 | Supabase Anonymous Authを裏側で使用 | Private Realtime Broadcast | 人格の追加・交換・削除、担当PL名などを編集 |
| 発行者 | 共有スペース作成時 | Anonymous Auth | 編集者と同じRealtime | 公開設定、参加者解除、スペース終了 |

匿名表示名は本人確認ではない。共有リンクを受け取った人は閲覧でき、公開編集が有効なら編集者として参加できる。リンクそのものが共有アクセスの入口となるため、リンクを知る人を限定したい場合は発行者が公開閲覧を無効にする。

公開設定は `party_sessions.public_view_enabled` と `public_edit_enabled` で保持する。追加カラムの `DEFAULT false` により既存スペースは従来どおり非公開のままになる。移行時に既存行を一括更新しないため、同じSQLを再実行してもオーナーが後から変更した公開設定を巻き戻さない。置き換えた `create_party_session` RPCは新規作成時も両方falseを明示する。新UIは作成直後に `set_public_party_access(true, true)` を呼び、成功を確認してから公開状態として扱う。旧UIから作成されたスペースが移行・デプロイ間に意図せず公開されることを防ぐ。公開閲覧をfalseにする場合、公開編集もfalseでなければならない。

- 閲覧停止は新しい公開読み取りを拒否する。ただし既に取得・キャッシュされたデータを遠隔から消すことはできない。
- 公開編集停止は新しい直接参加を拒否するだけで、既存の承認済みメンバーの権限は変更しない。既存参加者の解除はownerが個別に行い、解除時は `revoked` の記録で同一Authユーザーの再参加を拒否する。
- 編集参加者は発行者込み20名まで。1ユーザーが同時に編集参加できるスペースは20件まで。
- 発行者が個別の編集参加者を解除すると、旧 `session_access_requests` に `revoked` の記録を残す。join RPCはこれを拒否するため、同じ匿名Auth IDは同じスペースへ再参加できない。ただしAnonymous Authは本人確認ではなく、ブラウザデータ削除や別端末から新しい匿名IDを発行すれば、公開編集がONの間は再参加できる。
- 公開編集を停止すると新規参加だけを拒否する。既存の `session_members` と編集権限は維持され、必要な参加者だけをownerが個別に解除する。個別解除では再参加禁止の記録を残す。
- 発行者のowner権限は公開設定を無効にしても維持する。

## 読み取り経路

`read_public_party_session(uuid)` はSECURITY DEFINERの読み取り専用RPCである。匿名ロールに実行権限を与えるが、テーブルへの直接アクセス権は与えない。返すのはセッション名、編成キー、選択された追加人格スナップショット、revision、発行者表示名、公開設定だけとし、参加者一覧・編集履歴・認証情報は返さない。

認証ユーザーが既存メンバーである場合は、公開閲覧停止中でも自分の権限で読み直せる。一般訪問者は `public_view_enabled=true` のセッションだけを読める。未知のID、終了済み、閲覧停止セッションは同じ読み取り失敗として扱う。

クライアントは取得結果をsessionStorageへ最大60秒保存する。キャッシュから返すときは必ずroleを `public-viewer` に固定し、キャッシュがowner/editor権限を復元しないようにする。最新データへの更新は手動ボタンで行い、その要求はキャッシュを迂回する。

**現在はStorage CDN配信ではない。** 読み取りはSupabase RPCからPostgresへ到達する。閲覧者にpollやRealtime接続を持たせないことで継続的な負荷を避けるが、初回訪問・手動更新の回数に応じてDB読み取りと通常Egressが増える。公開リンクの大量アクセスを想定したIP単位の専用レート制限やCDNキャッシュは未実装であり、利用量監視が必要である。

## 編集参加・書き込み経路

1. 閲覧者が「編集に参加」を押す。
2. 必要ならTurnstile確認後、Anonymous Authを作成する。
3. `join_public_party_session(uuid,text)` が対象セッション行をロックして、アーカイブ状態・`public_edit_enabled`・20名のセッション上限・ユーザーごとの同時参加上限を確認する。
4. 新規ユーザーをeditorとして登録する。既存ownerはownerのまま、既存viewerはeditorへ昇格する。
5. 編集は既存の `apply_party_edit_v2` を使う。RPCはサーバー側でmembership/role、expected revision、operation ID、人格キー、追加人格スナップショットの型・サイズを検証する。

招待・参加申請・owner承認を新規参加の条件にしない。旧テーブル・旧RPCは既存データ移行を安全にするため残すが、新しい画面から招待リンクを発行しない。

## 匿名Authユーザーの保持

SupabaseのAnonymous Authユーザーは自動削除されない。公式ドキュメントには古い匿名ユーザーを削除するSQL例があるが、このプロジェクトでは一律の30日削除を実装しない。`party_sessions.owner_user_id` と `session_members.user_id` は `auth.users` を `ON DELETE CASCADE` で参照しているため、単純な削除SQLは所有者の共有スペースや参加membershipを連鎖削除し得る。また、同じAuthプロジェクトはLBTアカウント保管機能とも共有されており、別機能のデータにも影響する可能性がある。

現在、新しい匿名Auth IDを作るのは共有スペース作成または明示的な編集参加だけであり、公開閲覧と未認証の参加スペース一覧取得では作成しない。匿名ユーザーの自動削除ジョブは設けず、Authユーザー数とDatabase Sizeを監視する。将来整理する場合は、共有スペースの所有権移管・終了と他機能の参照をすべて検証する依存関係対応の手順を別途設計する。

## 編集者の同期

編集者のみが `party:<session_id>` のprivate Broadcastチャンネルへ接続する。Realtime AuthorizationのRLSポリシーは `session_members` にowner/editorとして存在する認証ユーザーだけに受信を許可する。Supabase DashboardのRealtime Settingsでは `Allow public access to channels` をOFFにして、このprivate channel RLS認可を強制する。

Postgresのrevision更新トリガーは `realtime.send()` で `party_changed` イベントを送る。payloadにはrevision番号だけを含め、`party_keys` や `party_personas` は含めない。通知を受けたクライアントは既存の認可付きpoll RPCで最新版を取得する。送信者自身は保存RPCの応答を利用する。Realtimeへの接続が成立した直後にも1回だけrevisionを再照合し、初回スナップショット取得から購読開始までの間に確定した更新を取りこぼさない。購読中は同じ画面からの重複接続を防ぎ、タブ非表示・画面切替で開始待ちの接続試行も破棄する。

Realtimeが利用できない場合、編集画面のみ30秒（操作直後）／60秒（アイドル）の確認通信へ切り替え、失敗時は指数バックオフで最大120秒まで延ばす。非表示タブでは接続・pollを停止し、復帰時に最新revisionを確認して再接続する。閲覧モードにはこのフォールバックを適用しない。

Realtimeの認可ポリシーは接続時に評価され、接続中にmember rowを削除しても既存WebSocketが即時切断されるとは限らない。そのため、個別メンバー解除後の保存可否は必ず書き込みRPCで再検証する。解除後の書き込みは失敗する。公開編集フラグをOFFにしただけでは既存member rowを削除せず、既存editorの保存・同期を継続する。解除された受信側の接続はタブを閉じるか再接続するまで通知を受け続ける可能性があるが、通知に編成内容は含まれない。

## データ量・無料枠の目安

編成は最大20人格、追加人格スナップショットは合計60,000 bytes以下。通常の閲覧取得では人格データ全体やLBT保存データは送信せず、選択中の編成に必要な範囲だけを返す。公開閲覧時の最終利用時刻は同じスペースにつき最大5分に1回だけ更新し、アクセス数に比例した行更新を避ける。

Supabase Freeの公開枠（2026-11-17確認）は次のとおり。

| リソース | Free枠 | この機能の消費要因 |
|---|---:|---|
| Database size | 500 MB | セッション、参加者、短期編集イベント |
| 通常Egress | 5 GB/月 | 初回閲覧、手動更新、編集後のスナップショット取得 |
| Realtime Messages | 2,000,000/月 | 送信1件＋受信した各編集者1件／保存 |
| Peak Realtime connections | 200 | 同時に編集画面を開いている全ユーザー |

Egressは追加人格スナップショット60,000 bytesに編成キー・タイトル等の応答メタデータを加味し、1回64KBとして概算する。1,000回で約64MB、10,000回で約640MB、30,000回で約1.92GB、50,000回で約3.2GBとなる。実際の応答サイズは編成内容とJSONメタデータに依存する。FreeのEgress 5GBは組織内プロジェクト間で合算されるため、このツール単独で5GBすべてを利用できるわけではない。通常Egress以外のサイト資産・RPC通信も同じ月次枠に加算される。

Realtime Broadcastは送信1件に加え、配信を受けた各クライアント1件として数えられる。したがって「編集保存数 × (1 + その時点の受信者数)」で概算する。例えば20人が受信中の編集スペースで1,000回保存すると約21,000メッセージとなる。20人を超える接続者をRealtimeに載せないこと、Presenceを使わず通知をrevisionだけにすることがコスト抑制の要点である。

### 実DBでのロール別スモーク試験（2026-11-17）

本番DBへ変更を残さない明示的な `BEGIN ... ROLLBACK` の内部で、現行マイグレーションSQLを一時適用して検証した。匿名アクセスとAnonymous Authの両方を分けて確認している。

- `anon` ロールは公開閲覧ONのスペースの必要最小限スナップショットだけを取得でき、roleは `public-viewer`。メンバー一覧・user_idなどの識別情報を含まない。
- 同じテストスペースを公開閲覧OFFにすると、anonの再読込は `P0002` で拒否される。
- `authenticated` ロールで `is_anonymous=true` のJWTを模擬し、匿名Authユーザーが公開閲覧者から明示参加でeditorへ昇格すること、editorだけRealtime Broadcast認可がtrueになることを確認した。
- 公開編集OFFは新しいjoinを拒否する一方、既存editorのreadとBroadcast認可を維持する。
- ownerによる個別解除後は、同じ匿名Auth IDの再joinが `42501` で拒否され、Broadcast認可もfalseへ戻る。
- 解除対象外のユーザーによる非公開スペース読取、匿名ロールからのjoin・owner設定RPC実行は拒否される。
- セッションがowner込み20名に達している場合の21人目のjoinは `53300` で拒否される。1ユーザーの編集membershipが19件ある状態では20件目が成功し、21件目は `53300` で拒否される。

各スモーク試験後の確認では、新しいカラム・関数・トリガー・Realtime policyは0件で、テスト用auth.users／party_sessionsレコードも0件だった。つまりテスト用のユーザー・スペース・membershipも含め、ロールバックによってDBに残っていない。これはRPCとPostgreSQL権限のスモーク試験であり、実ブラウザのTurnstile・WebSocket・負荷試験の代わりではない。

### 本番DBへの適用とロール別検証（2026-11-17）

Supabase本番PostgreSQL 17.11に `20261117155808_public_view_open_edit_realtime` として適用済み。migration履歴にはこのversionが1件だけ存在し、Git側のファイル名も同じversionへ揃えた。GitHub Integrationが後からこのリポジトリを処理しても、同じmigrationを未適用として二重登録しない。

適用直後の確認結果：

- `public_view_enabled` と `public_edit_enabled` はともに `NOT NULL DEFAULT false`。
- 既存の共有スペース5件は全件とも2つのflagがfalse。既存の編成・参加者・人格データは変更していない。
- `anon` は `read_public_party_session` のみ実行でき、join・owner設定・member削除RPCは実行できない。
- `authenticated` はjoin・owner設定・member削除RPCを実行できる。`anon` / `authenticated` には `party_sessions` の直接SELECT権限がない。
- `realtime.messages` のBroadcast SELECT policyと、revision / membership通知triggerが作成済み。
- 既存ownerのJWTを模擬した読み取りでは、非公開spaceのroleがownerとして返り、Broadcast membership predicateはtrue。
- 既存spaceの公開flagをトランザクション内で一時的にtrueにした匿名読み取りでは、role `public-viewer` と必要最小限の編成スナップショットが返り、membersやuser_idは含まれなかった。テストはrollbackし、実データを非公開へ戻した。

Security Advisorでは、この実装により`read_public_party_session`がanonから実行できるSECURITY DEFINER関数として警告される。公開閲覧機能そのものに必要な入口であり、関数内で公開flag・アーカイブ状態・member権限を検査し、返却フィールドを限定する。Realtime policyに対する匿名Auth警告も出るが、匿名AuthユーザーはPostgresの`authenticated` roleを使う仕様のためで、実際の許可はowner/editor membership predicateで制限している。アプリケーションテーブルへの直接SELECT権限は与えていない。

この検証は本番DB上の権限・RPC・DDL確認であり、Supabase DashboardのAnonymous Sign-Ins / CAPTCHA / private channel設定、実WebSocket接続、別ブラウザ間のE2E、負荷試験が成功したことを意味しない。
### 本番DBの移行前ベースライン（2026-11-17）

Supabase PostgreSQLの `pg_stat_statements` を読み取り専用で確認した。統計のリセット日時は2026-10-23 11:07 UTCであり、約25日分のプロジェクト集計である。以下は共有セッション関連RPCの観測値で、将来の利用量や容量を保証するものではない。

| RPC | Calls | 平均実行時間 | 最大実行時間 | 累計実行時間 |
|---|---:|---:|---:|---:|
| `poll_party_session` | 408 | 2.69 ms | 88.51 ms | 1.10 s |
| `list_party_session_admin` | 243 | 1.42 ms | 20.55 ms | 0.34 s |
| `list_my_party_sessions` | 65 | 2.28 ms | 34.47 ms | 0.15 s |
| `create_party_session` | 10 | 34.89 ms | 91.28 ms | 0.35 s |

この期間の既存共有データは5スペースすべてactiveで、各スペースにowner行が1件ずつ存在し、所有者IDの不一致・不正role・20名超過は0件だった。既存スペースは最大3人格、最大1,801 bytesの人格JSONだった。新方式の閲覧RPCはまだ本番導入前なので、上記のRPC統計には実アクセスがなく、読み取り負荷の評価は導入後に別途行う。

Freeの同時Realtime接続200はプロジェクト全体の上限であり、複数スペースの合計で消費する。編集者20人のスペースが同時に10個あるだけで上限に達するため、実運用ではその手前に十分な余裕を残す。

### 監視と対応

- Dashboardの通常Egress、Realtime Messages、Peak Connections、Database Size、DB CPU/接続数を定期確認する。
- 無料枠の80%を警戒ライン、95%を新規共有・編集参加を制限するか検討するラインとする。
- Egress増加時は、閲覧回数とスナップショットサイズを分けて確認する。閲覧者に自動pollを追加して解決しない。
- Realtime増加時は、保存頻度と平均受信者数を確認する。Presenceや全編成データBroadcastは導入しない。
- 閲覧数が増えた場合の次の段階は、revision別の不変スナップショットを安全に生成しStorage CDNからGET配信する仕組みである。DB更新とStorage公開の整合性、認可停止後のキャッシュ有効期間、無効化手順を設計・試験するまでは導入しない。

## マイグレーションとリリース条件

追加マイグレーション `20261117155808_public_view_open_edit_realtime.sql` は、既存の招待テーブル・承認RPCを削除せず、新しい公開フラグ、読み取りRPC、直接参加RPC、private Broadcast trigger/RLS policyを追加する。既存セッションとDB関数で作成されたセッションはpublic view/editをfalseにして非公開を維持する。新UIから作成したセッションだけ、作成直後に両方trueへ切り替える。

公開前に次を確認する。

- anonは公開中セッションの必要最小限の編成だけを読める。メンバー一覧・編集履歴・別セッション情報は読めない。
- 公開閲覧停止後は新規anon読み取りが拒否される。既存owner/editorは認証済みメンバーとして管理・読取を継続できる。
- 編集参加には認証済みmembershipが作成され、20名上限と役割昇格が守られる。
- 公開編集OFFでは新規joinだけが拒否され、既存editorのmembership・保存・同期は維持される。個別解除では該当membershipを削除して `revoked` tombstoneを残し、同じAuth IDの再joinと解除後のwriteを拒否する。
- Broadcastはrevisionだけを通知し、owner/editorだけがprivate channelに接続できる。
- 同時編集・stale revision・重複operation ID・Realtime切断時のpoll fallbackを検証する。
- 実Supabaseで、1、20、100、1,000閲覧相当の連続アクセスと、20人編集時の通信量・DB負荷を計測する。Nodeの静的テストは本番負荷試験の代わりではない。

