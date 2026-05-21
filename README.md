# Intraday Imbalance Trader — Streamlit版

JEPX × ICS の 30分コマ毎インバランス料金単価を使った バックテスト / トレード再現 アプリです。サーバーサイドでICS APIを直接叩くため、ブラウザのCORS制限の影響を受けません。スマホブラウザから普通のWebアプリとして使えます。

## 機能

- ICS WebAPI からインバランス料金単価をリアルタイム取得 (or CSV取込)
- JEPX 9エリア(北海道/東北/東京/中部/北陸/関西/中国/四国/九州)で個別取引
- 30分コマ × 48スロット で BID発注 (買い/売り、価格 円/kWh、数量 MW)
- 自動/手動更新切替
- 累積PnL・ポジションを常時表示 (エリア別 + 全体合算)
- インバランス料金単価 と BID注文 のチャート可視化
- 取引履歴の永続化 (`~/.intraday_trader_state.json`)
- エリア単位 / 全体 のリセット

PnL計算式:
- 買い: `(不足単価 − BID価格) × 500 × 数量(MW)`
- 売り: `(BID価格 − 余剰単価) × 500 × 数量(MW)`

## セットアップ

### 1. Pythonと依存関係をインストール

Python 3.9以上が必要です。

```bash
# プロジェクトディレクトリへ移動
cd /path/to/intraday_trader

# (推奨) 仮想環境を作成
python3 -m venv venv
source venv/bin/activate    # Windowsの場合: venv\Scripts\activate

# 依存パッケージをインストール
pip install -r requirements.txt
```

### 2. ローカル起動

```bash
streamlit run streamlit_app.py
```

ブラウザが自動で `http://localhost:8501` を開きます。ターミナル出力には Network URL (例: `http://192.168.1.10:8501`) も表示されます。

## スマホからのアクセス

### 方法A: 同じWiFiで自宅PCに接続(最も簡単)

1. PCで `streamlit run streamlit_app.py` を実行
2. ターミナルに表示される **Network URL** をメモ (例: `http://192.168.1.10:8501`)
3. スマホを同じWiFiに接続
4. スマホブラウザで上記URLを開く
5. **ホーム画面に追加** で PWA風に使える
    - iOS Safari: 共有ボタン → 「ホーム画面に追加」
    - Android Chrome: ︙メニュー → 「ホーム画面に追加」

注: PCのファイアウォール設定で 8501ポート の許可が必要な場合があります。

### 方法B: Streamlit Community Cloud (無料・どこからでも)

1. GitHub に新しいリポジトリを作成
2. このディレクトリ(`streamlit_app.py`, `requirements.txt`)を push
3. https://share.streamlit.io にログイン (GitHubアカウント)
4. **New app** → リポジトリ・ブランチ・`streamlit_app.py` を選択 → **Deploy**
5. 数分でデプロイ完了 → 公開URL (`https://xxx.streamlit.app`) が発行される
6. スマホでそのURLを開く・ホーム画面に追加

注意: Streamlit Cloud では取引履歴の永続化(JSONファイル)は再デプロイで消えます。永続化したい場合は別途DB等を使うか、ローカル実行を推奨。

### 方法C: その他のクラウド

- **Render** (https://render.com): Web Service として無料デプロイ可
- **Railway** (https://railway.app): 無料枠あり
- **Hugging Face Spaces**: Streamlit テンプレートあり、GitHub連携で簡単

いずれも `requirements.txt` と `streamlit_app.py` をpushしてビルドコマンド `streamlit run streamlit_app.py --server.port=$PORT --server.address=0.0.0.0` を設定すればOK。

## 使い方

### 基本フロー

1. **サイドバー** (スマホでは左上の `>` ボタンで開く)
   - **対象日**: バックテストする日を選択 (過去日OK)
   - **リビジョン**: 通常は空欄 (最新版が取得される)
   - **🔄 データ取得** をタップ
2. **エリア選択**: 取引したいエリアをタップ (タブの右側にPnLが表示)
3. **発注フォーム**:
   - コマ (1〜48)、サイド (買い/売り)、BID価格、数量MW を入力
   - 入力中にリアルタイムで想定PnLがプレビュー表示
   - **発注** ボタンで確定
4. **PnL/ポジション** はページ上部のメトリックと「全エリアポジション一覧」で常時確認可能
5. **チャート** で価格推移と自分のBIDポイントを重ねて確認
6. **取引履歴** で個別取引と削除

### 自動更新の使い方

サイドバーの「自動更新」をONにし、間隔(15〜300秒)を設定。指定秒ごとにAPIを再取得し、新しいコマが公表されたら自動でOPENポジションのPnLが確定します。

実需給直後の運用シミュレーションに便利。

### CSV取込 (API障害時の代替)

ICS API がダウンしている、または直接ブラウザで動作確認したい場合:

1. ブラウザで `https://www.imbalanceprices-cs.jp/api/1.0/imb/price/202404` のようにアクセスしてCSVを保存
2. サイドバーの「CSV取込」からそのファイルを選択

## ファイル構成

```
intraday_trader/
├── streamlit_app.py            # メインアプリ
├── requirements.txt            # 依存パッケージ
├── README.md                   # 本ファイル
└── ~/.intraday_trader_state.json   # 取引履歴 (自動生成、ホームディレクトリ)
```

## トラブルシューティング

**Q. データ取得で `HTTP 204` が出る**
→ 指定した年月のCSVがまだ公表されていません。前月以前の日付を試してください。

**Q. データ取得で `HTTP 503` が出る**
→ ICS側でファイル作成中です。30秒〜数分後に再試行してください。

**Q. 自動更新が動かない**
→ `pip install streamlit-autorefresh` を再実行してください。

**Q. 文字化けする (CSV取込時)**
→ CSVが Shift_JIS でない場合は手動で `cp932` に変換するか、API経由で取得しなおしてください。

**Q. スマホで横スクロールが必要**
→ Streamlitは縦長レイアウトに最適化されています。スマホ向きに作っていますが、テーブルが広い場合は横スクロールが発生することがあります。

## ライセンス / 利用規約

ICS WebAPI の [利用規約](https://www.imbalanceprices-cs.jp/show/footer/terms_of_use.pdf) を必ずお読みください。サーバ負荷軽減のため、リトライは30秒間隔で5回までとしてください(自動更新の最短間隔を15秒にしているのはそのためです)。
