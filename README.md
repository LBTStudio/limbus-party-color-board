# LIMBUS PARTY COLOR BOARD

LIMBUS BUILD TERMINAL の人格DBを読み込み、編成の罪悪属性（資源色）をスキル単位で自動集計する非公式ツールです。ビルド済みの静的サイトなので、GitHub Pages でそのまま動きます。

**公開URL:** https://lbtstudio.github.io/limbus-party-color-board/

![編成マトリクスと資源色サマリー](docs/preview.png)

## できること

- 開始時は空の編成。人格DB（通常145 + 特異54）から人格を検索して編成に追加・変更・削除
- 各人格の戦術0〜4のスキル色を自動反映。二属性スキルは両方の色に1ずつ数える
- 資源色を「多い順」「出せる人数順」「色順」などで並べ替え
- 資源色カードを押すと、その色を出せる人格を編成の先頭に並べ替え
- 合計値と「その色を出せる人格数」を常時表示
- 編成をURLで共有（`?p=n48,n34,n78,n49` のように人格キーだけを持つ）
- TSVコピー、任意のTSV/CSV取り込み（メンバー名・PL名の列は無視）

編成を変えると統計はその場で再計算されます。通常の編成状態はURLとブラウザの `localStorage` に保存されます。URL共有は編成状態を相手に渡すスナップショット方式で、現時点では複数人の編集は同期されません。

## 複数人での共有について

共有セッションの初期実装を追加しました。公開用 Supabase キーと production 用の設定はこのPRに含めています。実際に利用できるのはPRをマージし、Supabase GitHub Integration の migration・config・seed のデプロイが成功した後です。手順は [共有セッション導入手順](docs/shared-sessions-setup.md)、設計は [共有セッション設計](docs/shared-sessions-design.md)、障害・不正利用の想定は [失敗想定と対策](docs/shared-sessions-failure-modes.md) を参照してください。デプロイが未完了の間も、既存の個人編成モードは利用できます。

## 集計ルール

- 戦術0〜4の各スロットを1資源として数える
- 1スロットに罪悪属性が2つある場合は、両方に1ずつ加算する
- `合計` は資源の総数、`人数` はその色を1つ以上出せる人格の数
- 例: 暴食 `10(4)` は「暴食の資源が合計10、暴食を出せる人格が4人」

スプレッドシートは、ツールの目的を確認するために共有されたサンプルです。実行時のデータ源は LBT の `data/db.json` で、シートの読み書きは行いません。

## データの更新

`data/personas.json` は `LIMBUS_BUILD_TERMINAL/data/db.json` から生成しています。手で編集せず、DBを更新したら再生成してください。

```sh
npm run build:data
# または
node tools/build-data.mjs --db ../LIMBUS_BUILD_TERMINAL/data/db.json
```

`LBT_DB` 環境変数でDBのパスを指定することもできます。GitHub Actions の `Update persona data` が毎週 LBT のDBを取り込み、差分があれば `data/personas.json` を更新します。

## 開発

Node.js 22 以降を想定しています。集計・取り込みは npm 依存パッケージなしで動きます。共有セッション機能を使う場合は、ブラウザが Supabase JS SDK を ESM CDN から読み込むため、インターネット接続が必要です。

```sh
npm test          # 集計・取り込み・並べ替えのテスト
npm run serve     # http://127.0.0.1:8787/
```

## データ出典

- [LIMBUS BUILD TERMINAL](https://github.com/LBTStudio/LIMBUS_BUILD_TERMINAL) の人格・スキルデータ
- 本ツールは非公式のファンツールです。Project Moon および LBT の公式見解ではありません
