"""
Intraday Imbalance Trader — Streamlit版
JEPX × ICS 30分コマ毎のインバランス料金単価バックテスト
"""
import streamlit as st
import pandas as pd
import requests
import csv
import io
import json
import time
from datetime import datetime, date, timedelta
from pathlib import Path
import plotly.graph_objects as go

# streamlit-autorefresh はオプション(無くても手動更新で動く)
try:
    from streamlit_autorefresh import st_autorefresh
    AUTOREFRESH_OK = True
except ImportError:
    AUTOREFRESH_OK = False

# ════════════════════════════════════════════════════════════════════
# 定数
# ════════════════════════════════════════════════════════════════════
REGIONS = [
    {'id': 'hokkaido', 'name': '北海道', 'color': '#60a5fa'},
    {'id': 'tohoku',   'name': '東北',   'color': '#a78bfa'},
    {'id': 'tokyo',    'name': '東京',   'color': '#f0b541'},
    {'id': 'chubu',    'name': '中部',   'color': '#fb7185'},
    {'id': 'hokuriku', 'name': '北陸',   'color': '#34d399'},
    {'id': 'kansai',   'name': '関西',   'color': '#22d3ee'},
    {'id': 'chugoku',  'name': '中国',   'color': '#e879f9'},
    {'id': 'shikoku',  'name': '四国',   'color': '#fbbf24'},
    {'id': 'kyushu',   'name': '九州',   'color': '#fb923c'},
]
REGION_BY_ID = {r['id']: r for r in REGIONS}
AREA_ORDER = [r['id'] for r in REGIONS]

def _make_periods():
    out = []
    for i in range(48):
        s, e = i * 30, (i + 1) * 30
        fmt = lambda m: f"{m // 60:02d}:{m % 60:02d}"
        e_cap = min(e, 1440)
        out.append({'period': i + 1, 'startTime': fmt(s), 'endTime': fmt(e_cap),
                    'label': f"{fmt(s)}–{fmt(e_cap)}"})
    return out
PERIODS = _make_periods()

STATE_FILE = Path.home() / '.intraday_trader_state.json'

# ════════════════════════════════════════════════════════════════════
# CSVパース — ICS imbalance-price 形式
#   D行: [0]"D" [1]YYYYMMDD [2]period [3]start [4]end
#        [5..22]  9エリア × (余剰単価, フラグ)
#        [23..40] 9エリア × (不足単価, フラグ)
# ════════════════════════════════════════════════════════════════════
def parse_imbalance_csv(text: str):
    out = []
    reader = csv.reader(io.StringIO(text))
    for row in reader:
        if not row or row[0] != 'D':
            continue
        try:
            date_str = str(row[1]).strip()
            period = int(row[2])
        except (ValueError, IndexError):
            continue
        prices = {}
        for i in range(9):
            try: surplus = float(row[5 + i * 2])
            except (ValueError, IndexError): surplus = None
            try: shortage = float(row[23 + i * 2])
            except (ValueError, IndexError): shortage = None
            prices[AREA_ORDER[i]] = {'surplus': surplus, 'shortage': shortage}
        out.append({
            'date': date_str, 'period': period,
            'startTime': row[3] if len(row) > 3 else '',
            'endTime': row[4] if len(row) > 4 else '',
            'prices': prices,
        })
    return out

# ════════════════════════════════════════════════════════════════════
# データ取得 — サーバーサイドからICS APIを直接コール (CORS無し)
# ════════════════════════════════════════════════════════════════════
def fetch_imbalance(year_month: str, revision: str = ''):
    url = f"https://www.imbalanceprices-cs.jp/api/1.0/imb/price/{year_month}"
    if revision.strip():
        url += f"/{revision.strip()}"
    r = requests.get(url, timeout=30, headers={'User-Agent': 'IntradayTrader/1.0'})
    if r.status_code == 204:
        raise RuntimeError("HTTP 204 — 該当データが存在しません")
    if r.status_code == 503:
        raise RuntimeError("HTTP 503 — 公表ファイル作成中。30秒後に再試行してください")
    r.raise_for_status()
    # MS932/Shift_JIS デコード
    try:
        text = r.content.decode('cp932')
    except UnicodeDecodeError:
        text = r.content.decode('utf-8', errors='replace')
    return parse_imbalance_csv(text), url

# ════════════════════════════════════════════════════════════════════
# PnL計算
# ════════════════════════════════════════════════════════════════════
def calc_pnl(trade: dict, daily_data: list):
    d = next((x for x in daily_data if x['period'] == trade['period']), None)
    if not d:
        return None, None
    region = trade['region']
    side = trade['side']
    sp = d['prices'].get(region, {}).get('shortage' if side == 'buy' else 'surplus')
    if sp is None:
        return None, None
    if side == 'buy':
        pnl = (sp - trade['price']) * 500 * trade['quantity']
    else:
        pnl = (trade['price'] - sp) * 500 * trade['quantity']
    return sp, pnl

# ════════════════════════════════════════════════════════════════════
# フォーマッタ
# ════════════════════════════════════════════════════════════════════
def fmt_jpy(n):
    if n is None or not isinstance(n, (int, float)): return '—'
    sign = '-' if n < 0 else ''
    return f"{sign}¥{abs(n):,.0f}"

def fmt_num(n, d=2):
    if n is None or not isinstance(n, (int, float)): return '—'
    return f"{n:,.{d}f}"

# ════════════════════════════════════════════════════════════════════
# 状態管理 — st.session_state + ローカルJSONファイル
# ════════════════════════════════════════════════════════════════════
def load_persisted():
    if STATE_FILE.exists():
        try:
            with open(STATE_FILE, 'r', encoding='utf-8') as f:
                return json.load(f)
        except Exception:
            return {}
    return {}

def save_persisted():
    try:
        with open(STATE_FILE, 'w', encoding='utf-8') as f:
            json.dump({
                'trades': st.session_state.trades,
            }, f, ensure_ascii=False, indent=2)
    except Exception:
        pass

def init_state():
    if 'initialized' in st.session_state:
        return
    st.session_state.initialized = True
    persisted = load_persisted()
    st.session_state.trades = persisted.get('trades', {})
    st.session_state.imbalance_data = []
    st.session_state.last_updated = None
    st.session_state.fetch_message = 'データ未取得 — サイドバーから取得してください'
    st.session_state.fetch_state = 'idle'
    st.session_state.active_region = 'tokyo'

# ════════════════════════════════════════════════════════════════════
# Streamlit ページ設定
# ════════════════════════════════════════════════════════════════════
st.set_page_config(
    page_title='Intraday Imbalance Trader',
    page_icon='⚡',
    layout='wide',
    initial_sidebar_state='auto',
    menu_items={
        'About': 'JEPX × ICS Intraday Imbalance Backtester'
    }
)

# モバイル最適化 CSS
st.markdown("""
<style>
/* ベース */
.stApp {
    background: radial-gradient(ellipse 80% 60% at 50% -20%, #1e293b 0%, #020617 70%);
}
[data-testid="stHeader"] { background: transparent; }

/* メトリック装飾 */
[data-testid="stMetric"] {
    background: linear-gradient(135deg, rgba(240,181,65,0.08), rgba(15,23,42,0.5));
    border: 1px solid rgba(240,181,65,0.18);
    border-radius: 12px;
    padding: 14px 16px;
}
[data-testid="stMetricValue"] {
    font-family: 'JetBrains Mono', 'SF Mono', ui-monospace, monospace;
    font-variant-numeric: tabular-nums;
}
[data-testid="stMetricLabel"] {
    font-size: 10px !important;
    letter-spacing: 0.2em;
    text-transform: uppercase;
    color: rgba(240,181,65,0.8) !important;
}

/* ボタン */
.stButton button {
    border-radius: 8px;
    font-weight: 600;
}

/* テーブル */
.stDataFrame { font-variant-numeric: tabular-nums; }

/* タブ — モバイル横スクロール */
.stTabs [data-baseweb="tab-list"] {
    gap: 4px;
    overflow-x: auto;
    flex-wrap: nowrap;
}
.stTabs [data-baseweb="tab"] {
    padding: 8px 14px;
    white-space: nowrap;
}

/* タイトル */
.app-title {
    background: linear-gradient(135deg, #f0b541, #fbbf24);
    -webkit-background-clip: text;
    background-clip: text;
    color: transparent;
    font-weight: 700;
    font-size: 1.5rem;
}

/* PnL色 */
.pnl-pos { color: #34d399; font-weight: 600; }
.pnl-neg { color: #fb7185; font-weight: 600; }
.pnl-zero { color: #94a3b8; }

/* スマホでフォントサイズ調整 */
@media (max-width: 640px) {
    .stApp { font-size: 14px; }
    [data-testid="stMetricValue"] { font-size: 1.4rem !important; }
}
</style>
""", unsafe_allow_html=True)

init_state()

# ════════════════════════════════════════════════════════════════════
# サイドバー — 取得設定・リセット
# ════════════════════════════════════════════════════════════════════
with st.sidebar:
    st.markdown('### ⚙️ コントロール')

    selected_date = st.date_input(
        '対象日', value=date.today() - timedelta(days=1),
        format='YYYY-MM-DD', key='selected_date',
    )
    revision = st.text_input('リビジョン (任意)', value='', placeholder='例: 2', key='revision')

    fetch_clicked = st.button('🔄 データ取得', type='primary', use_container_width=True)

    st.divider()

    st.markdown('##### 自動更新')
    auto_refresh = st.toggle(
        '有効化',
        value=False,
        help='指定間隔でAPIを再取得します' + ('' if AUTOREFRESH_OK else ' (要: streamlit-autorefresh)')
    )
    refresh_sec = st.slider('間隔 (秒)', 15, 300, 60, step=15, disabled=not auto_refresh)

    if auto_refresh and AUTOREFRESH_OK:
        st_autorefresh(interval=refresh_sec * 1000, key='auto_refresh_tick')

    st.divider()

    st.markdown('##### CSV取込 (代替)')
    uploaded = st.file_uploader('ファイル選択', type=['csv'], label_visibility='collapsed')
    if uploaded is not None:
        try:
            content = uploaded.read()
            try:
                text = content.decode('cp932')
            except UnicodeDecodeError:
                text = content.decode('utf-8', errors='replace')
            data = parse_imbalance_csv(text)
            if data:
                st.session_state.imbalance_data = data
                st.session_state.last_updated = datetime.now()
                st.session_state.fetch_state = 'success'
                st.session_state.fetch_message = f'{uploaded.name} 読込成功 — {len(data)}行'
                st.toast(f'✅ {len(data)}行 読込み完了')
            else:
                st.error('有効なD行が見つかりません')
        except Exception as e:
            st.error(f'読込エラー: {e}')

    st.divider()

    st.markdown('##### リセット')
    col_r1, col_r2 = st.columns(2)
    with col_r1:
        if st.button('🗑️ エリア', use_container_width=True, help='アクティブエリアのみリセット'):
            ar = st.session_state.active_region
            st.session_state.trades[ar] = []
            save_persisted()
            st.toast(f'✅ {REGION_BY_ID[ar]["name"]} リセット')
            st.rerun()
    with col_r2:
        if st.button('💥 全体', use_container_width=True, help='全エリアの取引履歴削除'):
            st.session_state.trades = {}
            save_persisted()
            st.toast('✅ 全リセット完了')
            st.rerun()

    if st.session_state.last_updated:
        st.caption(f"最終更新: {st.session_state.last_updated.strftime('%Y-%m-%d %H:%M:%S')}")
    st.caption(f"状態ファイル: `{STATE_FILE}`")

# ════════════════════════════════════════════════════════════════════
# データ取得処理
# ════════════════════════════════════════════════════════════════════
if fetch_clicked:
    ym = selected_date.strftime('%Y%m')
    with st.spinner(f'{ym} のインバランス料金単価を取得中...'):
        try:
            data, url = fetch_imbalance(ym, revision)
            if not data:
                st.error('データが空です')
                st.session_state.fetch_state = 'error'
            else:
                st.session_state.imbalance_data = data
                st.session_state.last_updated = datetime.now()
                target = selected_date.strftime('%Y%m%d')
                cnt = sum(1 for d in data if d['date'] == target)
                st.session_state.fetch_state = 'success'
                st.session_state.fetch_message = f'取得成功: {len(data)}行 (対象日 {cnt}コマ)'
                st.toast(f'✅ {len(data)}行 取得 / 対象日 {cnt}コマ')
        except requests.HTTPError as e:
            st.error(f'HTTPエラー: {e}')
            st.session_state.fetch_state = 'error'
        except Exception as e:
            st.error(f'エラー: {e}')
            st.session_state.fetch_state = 'error'

# ════════════════════════════════════════════════════════════════════
# データ整形 — 当日分・PnL再計算
# ════════════════════════════════════════════════════════════════════
target_date_str = selected_date.strftime('%Y%m%d')
date_iso = selected_date.strftime('%Y-%m-%d')
daily_data = sorted(
    [r for r in st.session_state.imbalance_data if r['date'] == target_date_str],
    key=lambda x: x['period']
)

# 全取引のPnLを再計算
for region_id, trades in list(st.session_state.trades.items()):
    for t in trades:
        if t.get('date') != date_iso:
            continue
        sp, pnl = calc_pnl(t, daily_data)
        if sp is not None:
            t['settlementPrice'] = sp
            t['pnl'] = pnl

# 集計
def compute_stats(region_id):
    trades = [t for t in st.session_state.trades.get(region_id, []) if t.get('date') == date_iso]
    settled = [t for t in trades if t.get('pnl') is not None]
    return {
        'count': len(trades),
        'open': len(trades) - len(settled),
        'total_pnl': sum(t['pnl'] for t in settled),
        'long_mw': sum(t['quantity'] for t in trades if t['side'] == 'buy'),
        'short_mw': sum(t['quantity'] for t in trades if t['side'] == 'sell'),
    }

stats = {r['id']: compute_stats(r['id']) for r in REGIONS}
grand_pnl = sum(s['total_pnl'] for s in stats.values())
total_trades = sum(s['count'] for s in stats.values())
total_open = sum(s['open'] for s in stats.values())

# ════════════════════════════════════════════════════════════════════
# メイン画面
# ════════════════════════════════════════════════════════════════════
st.markdown('<div class="app-title">⚡ Intraday Imbalance Trader</div>', unsafe_allow_html=True)
st.caption(f'JEPX × ICS · 30分コマ毎のインバランス料金単価バックテスト · 対象日 **{date_iso}**')

# === KPI ===
k1, k2, k3, k4 = st.columns(4)
with k1:
    st.metric('Grand Total PnL', fmt_jpy(grand_pnl))
with k2:
    st.metric('総取引数', f'{total_trades}件')
with k3:
    st.metric('オープン', f'{total_open}件')
with k4:
    cnt = len(daily_data)
    st.metric('取得済コマ', f'{cnt}/48')

# 状態メッセージ
if st.session_state.fetch_state == 'error':
    st.error(st.session_state.fetch_message)
elif st.session_state.fetch_state == 'success':
    st.success(st.session_state.fetch_message)
else:
    st.info(st.session_state.fetch_message)

# === エリア選択 ===
st.markdown('### 🗾 エリア選択')

# pillsが使えればpills、なければselectbox
region_labels = [
    f"{r['name']} ({fmt_jpy(stats[r['id']]['total_pnl'])})"
    for r in REGIONS
]
try:
    selected_label = st.pills(
        '取引エリア',
        options=region_labels,
        default=region_labels[AREA_ORDER.index(st.session_state.active_region)],
        label_visibility='collapsed',
    )
    if selected_label:
        idx = region_labels.index(selected_label)
        st.session_state.active_region = REGIONS[idx]['id']
except AttributeError:
    # 古いStreamlit
    idx = st.selectbox(
        '取引エリア',
        options=list(range(9)),
        index=AREA_ORDER.index(st.session_state.active_region),
        format_func=lambda i: region_labels[i],
        label_visibility='collapsed',
    )
    st.session_state.active_region = REGIONS[idx]['id']

active_region = st.session_state.active_region
active_region_obj = REGION_BY_ID[active_region]

# ════════════════════════════════════════════════════════════════════
# チャート
# ════════════════════════════════════════════════════════════════════
st.markdown(f"### 📊 {active_region_obj['name']} エリア — 料金単価 & 約定価格")

times = [p['startTime'] for p in PERIODS]
shortage = [None] * 48
surplus = [None] * 48
for d in daily_data:
    idx = d['period'] - 1
    if 0 <= idx < 48:
        p = d['prices'].get(active_region, {})
        shortage[idx] = p.get('shortage')
        surplus[idx] = p.get('surplus')

region_trades_today = [
    t for t in st.session_state.trades.get(active_region, [])
    if t.get('date') == date_iso
]

# 同コマ複数発注は加重平均で1点に集約
buy_pts, sell_pts = {}, {}
for t in region_trades_today:
    bucket = buy_pts if t['side'] == 'buy' else sell_pts
    p = t['period']
    if p not in bucket:
        bucket[p] = {'num': 0, 'den': 0, 'qty': 0, 'count': 0}
    bucket[p]['num'] += t['price'] * t['quantity']
    bucket[p]['den'] += t['quantity']
    bucket[p]['qty'] += t['quantity']
    bucket[p]['count'] += 1

def agg_to_xy(bucket):
    xs, ys, txt = [], [], []
    for period, v in sorted(bucket.items()):
        idx = period - 1
        if 0 <= idx < 48 and v['den'] > 0:
            xs.append(times[idx])
            wavg = v['num'] / v['den']
            ys.append(wavg)
            txt.append(f"P{period:02d} · {PERIODS[idx]['label']}<br>"
                       f"加重平均 {wavg:.2f} 円/kWh<br>"
                       f"合計 {v['qty']:.2f} MW × {v['count']}件")
    return xs, ys, txt

buy_x, buy_y, buy_txt = agg_to_xy(buy_pts)
sell_x, sell_y, sell_txt = agg_to_xy(sell_pts)

fig = go.Figure()
fig.add_trace(go.Scatter(
    x=times, y=shortage, name='不足単価 (Buy決済)',
    mode='lines', line=dict(color='#f0b541', width=2.5),
    hovertemplate='%{x}<br>不足 %{y:.2f} 円/kWh<extra></extra>',
    connectgaps=True,
))
fig.add_trace(go.Scatter(
    x=times, y=surplus, name='余剰単価 (Sell決済)',
    mode='lines', line=dict(color='#22d3ee', width=2, dash='dash'),
    hovertemplate='%{x}<br>余剰 %{y:.2f} 円/kWh<extra></extra>',
    connectgaps=True,
))
fig.add_trace(go.Scatter(
    x=buy_x, y=buy_y, name='買い注文',
    mode='markers',
    marker=dict(size=14, color='#22c55e', line=dict(color='#022c1a', width=2), symbol='circle'),
    text=buy_txt, hovertemplate='%{text}<extra></extra>',
))
fig.add_trace(go.Scatter(
    x=sell_x, y=sell_y, name='売り注文',
    mode='markers',
    marker=dict(size=14, color='#ef4444', line=dict(color='#2c0808', width=2), symbol='circle'),
    text=sell_txt, hovertemplate='%{text}<extra></extra>',
))

fig.update_layout(
    template='plotly_dark',
    paper_bgcolor='rgba(0,0,0,0)',
    plot_bgcolor='rgba(15,23,42,0.4)',
    height=380,
    margin=dict(l=50, r=20, t=20, b=50),
    xaxis=dict(
        title='時刻',
        gridcolor='#1e293b',
        tickangle=-45,
        nticks=12,
    ),
    yaxis=dict(
        title='円/kWh',
        gridcolor='#1e293b',
    ),
    legend=dict(orientation='h', yanchor='bottom', y=1.02, xanchor='right', x=1, bgcolor='rgba(0,0,0,0)'),
    hovermode='closest',
    font=dict(family='JetBrains Mono, monospace', size=11),
)
st.plotly_chart(fig, use_container_width=True, config={'displayModeBar': False})

# ════════════════════════════════════════════════════════════════════
# 発注フォーム
# ════════════════════════════════════════════════════════════════════
st.markdown('### 📝 発注')

with st.form('order_form', clear_on_submit=False):
    # スマホでは縦並びになるよう、デスクトップでも程よいカラム幅
    fc1, fc2 = st.columns([2, 1])
    with fc1:
        order_period = st.selectbox(
            'コマ (1–48)',
            options=list(range(1, 49)),
            format_func=lambda x: f'P{x:02d} · {PERIODS[x-1]["label"]}',
        )
    with fc2:
        order_side = st.radio(
            'サイド', options=['buy', 'sell'],
            format_func=lambda x: '🟢 買い' if x == 'buy' else '🔴 売り',
            horizontal=True,
        )

    fc3, fc4 = st.columns(2)
    with fc3:
        order_price = st.number_input(
            'BID価格 (円/kWh)',
            min_value=-999.0, max_value=999.0, value=10.0, step=0.1, format='%.2f',
        )
    with fc4:
        order_qty = st.number_input(
            '数量 (MW)',
            min_value=0.0, max_value=10000.0, value=1.0, step=0.1, format='%.2f',
        )

    # 想定PnLプレビュー
    preview_d = next((x for x in daily_data if x['period'] == order_period), None)
    if preview_d:
        sp = preview_d['prices'].get(active_region, {}).get(
            'shortage' if order_side == 'buy' else 'surplus'
        )
        if sp is not None:
            if order_side == 'buy':
                ppnl = (sp - order_price) * 500 * order_qty
                st.markdown(
                    f"想定PnL = ( **不足単価 {sp:.2f}** − BID {order_price} ) × 500 × {order_qty} = "
                    f"<span class='{'pnl-pos' if ppnl>0 else 'pnl-neg' if ppnl<0 else 'pnl-zero'}'>{fmt_jpy(ppnl)}</span>",
                    unsafe_allow_html=True
                )
            else:
                ppnl = (order_price - sp) * 500 * order_qty
                st.markdown(
                    f"想定PnL = ( BID {order_price} − **余剰単価 {sp:.2f}** ) × 500 × {order_qty} = "
                    f"<span class='{'pnl-pos' if ppnl>0 else 'pnl-neg' if ppnl<0 else 'pnl-zero'}'>{fmt_jpy(ppnl)}</span>",
                    unsafe_allow_html=True
                )
        else:
            st.caption('⚠️ このコマの約定価格は未公表 — OPENポジションとして登録されます')
    else:
        st.caption('⚠️ このコマのインバランスデータが未取得 — OPENポジションとして登録')

    submitted = st.form_submit_button(
        f"{'🟢 買い発注' if order_side == 'buy' else '🔴 売り発注'} — {active_region_obj['name']}",
        type='primary', use_container_width=True,
    )

    if submitted:
        if order_qty <= 0:
            st.error('数量は正の数を入力してください')
        else:
            sp, pnl = (None, None)
            d = next((x for x in daily_data if x['period'] == order_period), None)
            if d:
                sp_check = d['prices'].get(active_region, {}).get(
                    'shortage' if order_side == 'buy' else 'surplus'
                )
                if sp_check is not None:
                    sp = sp_check
                    if order_side == 'buy':
                        pnl = (sp - order_price) * 500 * order_qty
                    else:
                        pnl = (order_price - sp) * 500 * order_qty

            trade = {
                'id': f"{int(time.time()*1000)}-{order_period}-{order_side}",
                'region': active_region,
                'date': date_iso,
                'period': order_period,
                'side': order_side,
                'price': float(order_price),
                'quantity': float(order_qty),
                'settlementPrice': sp,
                'pnl': pnl,
                'timestamp': datetime.now().isoformat(timespec='seconds'),
            }
            st.session_state.trades.setdefault(active_region, []).append(trade)
            save_persisted()

            side_label = '買い' if order_side == 'buy' else '売り'
            if pnl is not None:
                st.success(
                    f"✅ {active_region_obj['name']} P{order_period:02d} {side_label} "
                    f"@{order_price} × {order_qty}MW → PnL **{fmt_jpy(pnl)}**"
                )
            else:
                st.warning(
                    f"✅ 発注完了 (OPEN) — {active_region_obj['name']} P{order_period:02d} "
                    f"{side_label} @{order_price} × {order_qty}MW"
                )

# ════════════════════════════════════════════════════════════════════
# 取引履歴
# ════════════════════════════════════════════════════════════════════
st.markdown(f"### 📋 取引履歴 — {active_region_obj['name']}")

region_trades = sorted(
    region_trades_today,
    key=lambda t: (t['period'], t.get('timestamp', '')),
)

if not region_trades:
    st.caption('取引なし')
else:
    rows = []
    for t in region_trades:
        rows.append({
            'コマ': f"P{t['period']:02d}",
            '時間帯': PERIODS[t['period'] - 1]['label'],
            'Side': '🟢買' if t['side'] == 'buy' else '🔴売',
            'BID価格': t['price'],
            '数量(MW)': t['quantity'],
            '約定価格': t.get('settlementPrice'),
            'PnL': t.get('pnl'),
            '時刻': t.get('timestamp', '')[-8:] if t.get('timestamp') else '',
        })
    df = pd.DataFrame(rows)
    st.dataframe(
        df,
        use_container_width=True,
        hide_index=True,
        column_config={
            'BID価格': st.column_config.NumberColumn(format='%.2f'),
            '数量(MW)': st.column_config.NumberColumn(format='%.2f'),
            '約定価格': st.column_config.NumberColumn(format='%.2f'),
            'PnL': st.column_config.NumberColumn(format='¥%.0f'),
        },
    )

    # 個別削除
    with st.expander('🗑️ 個別取引を削除'):
        for t in region_trades:
            cols = st.columns([5, 1])
            with cols[0]:
                st.text(
                    f"P{t['period']:02d} {'買' if t['side']=='buy' else '売'} "
                    f"@{t['price']} × {t['quantity']}MW "
                    f"→ {fmt_jpy(t.get('pnl'))}"
                )
            with cols[1]:
                if st.button('削除', key=f"del_{t['id']}"):
                    st.session_state.trades[active_region] = [
                        x for x in st.session_state.trades[active_region] if x['id'] != t['id']
                    ]
                    save_persisted()
                    st.rerun()

# ════════════════════════════════════════════════════════════════════
# 全エリアサマリ
# ════════════════════════════════════════════════════════════════════
st.markdown('### 🌐 全エリアポジション一覧')

summary_rows = []
for r in REGIONS:
    s = stats[r['id']]
    summary_rows.append({
        'エリア': r['name'],
        '取引数': s['count'],
        'オープン': s['open'],
        'Long(MW)': s['long_mw'],
        'Short(MW)': s['short_mw'],
        'Net(MW)': s['long_mw'] - s['short_mw'],
        'PnL': s['total_pnl'],
    })
summary_df = pd.DataFrame(summary_rows)
st.dataframe(
    summary_df,
    use_container_width=True,
    hide_index=True,
    column_config={
        'Long(MW)': st.column_config.NumberColumn(format='%.2f'),
        'Short(MW)': st.column_config.NumberColumn(format='%.2f'),
        'Net(MW)': st.column_config.NumberColumn(format='%.2f'),
        'PnL': st.column_config.NumberColumn(format='¥%.0f'),
    },
)

# ════════════════════════════════════════════════════════════════════
# PnL計算式メモ
# ════════════════════════════════════════════════════════════════════
with st.expander('📐 PnL計算式・ICS API仕様'):
    st.markdown("""
**PnL計算式:**
- 買い (Buy):  `(不足単価 − BIDした価格) × 500 × bidした数量(MW)`
- 売り (Sell): `(BIDした価格 − 余剰単価) × 500 × bidした数量(MW)`

**単位変換:** 500 = 0.5時間 × 1000kW/MW → 円/kWh × MW を 円 に変換

**APIエンドポイント:** `https://www.imbalanceprices-cs.jp/api/1.0/imb/price/{YYYYMM}/{revision}`
- データ形式: CSV (MS932/Shift_JIS)
- 更新頻度: 30分 (各コマの実需給終了後30分以内に公表)
- 取得可能期間: 公表日 〜 対象年度の5年後年度末
- リトライ規約: 30秒間隔で5回まで

**HTTP ステータス:**
- 200: 正常
- 204: データなし (リビジョン不一致 or 期間外)
- 503: 公表ファイル作成中 (30秒後に再試行)
""")

st.markdown(
    '<div style="text-align:center; color:#475569; font-size:11px; margin-top:30px;">'
    'ICS WebAPI 第2版準拠 · '
    '<a href="https://www.imbalanceprices-cs.jp/show/footer/terms_of_use.pdf" '
    'target="_blank" style="color:#64748b;">利用規約</a> に従って使用 · '
    'バックテスト用シミュレータ</div>',
    unsafe_allow_html=True
)
