import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import {
  ComposedChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Legend, ReferenceLine
} from 'recharts';
import Papa from 'papaparse';
import {
  RefreshCw, Upload, Trash2, TrendingUp, TrendingDown,
  AlertCircle, Zap, Activity, Play, Pause, ChevronRight,
  Database, Settings2, FileCode2, CircleDot
} from 'lucide-react';

/* ────────────────────────────────────────────────────────────
   静的定数
   ──────────────────────────────────────────────────────────── */
const REGIONS = [
  { id: 'hokkaido', name: '北海道', en: 'Hokkaido', color: '#60a5fa' },
  { id: 'tohoku',   name: '東北',   en: 'Tohoku',   color: '#a78bfa' },
  { id: 'tokyo',    name: '東京',   en: 'Tokyo',    color: '#f0b541' },
  { id: 'chubu',    name: '中部',   en: 'Chubu',    color: '#fb7185' },
  { id: 'hokuriku', name: '北陸',   en: 'Hokuriku', color: '#34d399' },
  { id: 'kansai',   name: '関西',   en: 'Kansai',   color: '#22d3ee' },
  { id: 'chugoku',  name: '中国',   en: 'Chugoku',  color: '#e879f9' },
  { id: 'shikoku',  name: '四国',   en: 'Shikoku',  color: '#fbbf24' },
  { id: 'kyushu',   name: '九州',   en: 'Kyushu',   color: '#fb923c' },
];
const REGION_BY_ID = Object.fromEntries(REGIONS.map(r => [r.id, r]));
const AREA_ORDER = REGIONS.map(r => r.id);

const PERIODS = Array.from({ length: 48 }, (_, i) => {
  const s = i * 30, e = (i + 1) * 30;
  const fmt = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  return { period: i + 1, startTime: fmt(s), endTime: fmt(e), label: `${fmt(s)}–${fmt(e)}` };
});

/* ────────────────────────────────────────────────────────────
   CSVパーサ — ICS imbalance-price CSVフォーマット
   行の先頭が "D" のデータ行のみ抽出。列構成:
     [0]"D" [1]YYYYMMDD [2]period01-48 [3]start [4]end
     [5..22]  9エリア × (余剰単価, フラグ)
     [23..40] 9エリア × (不足単価, フラグ)
   ──────────────────────────────────────────────────────────── */
function parseImbalanceCsv(text) {
  const parsed = Papa.parse(text, { skipEmptyLines: true });
  const out = [];
  for (const row of parsed.data) {
    if (!row || row[0] !== 'D') continue;
    const date = String(row[1] ?? '').trim();
    const period = parseInt(row[2], 10);
    if (!date || !Number.isFinite(period)) continue;
    const prices = {};
    for (let i = 0; i < 9; i++) {
      const surplusVal  = parseFloat(row[5  + i * 2]);
      const shortageVal = parseFloat(row[23 + i * 2]);
      prices[AREA_ORDER[i]] = {
        surplus:  Number.isFinite(surplusVal)  ? surplusVal  : null,
        shortage: Number.isFinite(shortageVal) ? shortageVal : null,
      };
    }
    out.push({ date, period, startTime: row[3] ?? '', endTime: row[4] ?? '', prices });
  }
  return out;
}

/* MS932/Shift_JIS デコード対応 */
async function fetchDecoded(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  const buf = await res.arrayBuffer();
  let text;
  try { text = new TextDecoder('shift_jis').decode(buf); }
  catch { text = new TextDecoder('utf-8').decode(buf); }
  return text;
}

const fmtJPY = n => {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  return sign + '¥' + abs.toLocaleString(undefined, { maximumFractionDigits: 0 });
};
const fmtNum = (n, d = 2) =>
  Number.isFinite(n) ? n.toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: d }) : '—';

/* ────────────────────────────────────────────────────────────
   メインアプリ
   ──────────────────────────────────────────────────────────── */
export default function App() {
  /* 取得設定 */
  const [date, setDate] = useState(() => {
    const d = new Date(); d.setDate(d.getDate() - 1);
    return d.toISOString().slice(0, 10);
  });
  const [revision, setRevision] = useState('');
  const [proxy, setProxy] = useState('https://corsproxy.io/?url=');
  const [showSettings, setShowSettings] = useState(false);

  /* インバランス価格データ */
  const [imbalanceData, setImbalanceData] = useState([]);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [fetchStatus, setFetchStatus] = useState({ state: 'idle', message: 'データ未取得 — 取得または CSV アップロードを行ってください' });

  /* オート更新 */
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [autoRefreshSec, setAutoRefreshSec] = useState(60);

  /* アクティブエリア */
  const [activeRegion, setActiveRegion] = useState('tokyo');

  /* 取引・ポジション */
  const [trades, setTrades] = useState({}); // { [regionId]: Trade[] }

  /* 発注フォーム */
  const [orderPeriod, setOrderPeriod] = useState(1);
  const [orderSide, setOrderSide]     = useState('buy');
  const [orderPrice, setOrderPrice]   = useState('');
  const [orderQty, setOrderQty]       = useState('');

  /* 永続化: 起動時ロード — loadedフラグで初回保存上書きを防止 */
  const loadedRef = useRef(false);
  useEffect(() => {
    (async () => {
      try {
        const t = await window.storage.get('intraday_trades_v1');
        if (t?.value) setTrades(JSON.parse(t.value));
      } catch {}
      try {
        const p = await window.storage.get('intraday_proxy_v1');
        if (p?.value) setProxy(p.value);
      } catch {}
      loadedRef.current = true;
    })();
  }, []);

  useEffect(() => {
    if (!loadedRef.current) return;
    window.storage.set('intraday_trades_v1', JSON.stringify(trades)).catch(() => {});
  }, [trades]);

  useEffect(() => {
    if (!loadedRef.current) return;
    window.storage.set('intraday_proxy_v1', proxy).catch(() => {});
  }, [proxy]);

  /* 当日 1 日分のデータ */
  const dailyData = useMemo(() => {
    const target = date.replace(/-/g, '');
    return imbalanceData.filter(r => r.date === target).sort((a, b) => a.period - b.period);
  }, [imbalanceData, date]);

  /* 約定済みPnL再計算 */
  useEffect(() => {
    if (dailyData.length === 0) return;
    setTrades(prev => {
      let changed = false;
      const next = {};
      for (const [region, list] of Object.entries(prev)) {
        next[region] = list.map(t => {
          if (t.date !== date) return t;
          const d = dailyData.find(x => x.period === t.period);
          if (!d) return t;
          const sp = t.side === 'buy'
            ? d.prices[region]?.shortage
            : d.prices[region]?.surplus;
          if (!Number.isFinite(sp)) return t;
          const pnl = t.side === 'buy'
            ? (sp - t.price) * 500 * t.quantity
            : (t.price - sp) * 500 * t.quantity;
          if (t.settlementPrice !== sp || t.pnl !== pnl) changed = true;
          return { ...t, settlementPrice: sp, pnl };
        });
      }
      return changed ? next : prev;
    });
  }, [dailyData, date]);

  /* チャート用データ */
  const chartData = useMemo(() => {
    const regionTrades = (trades[activeRegion] || []).filter(t => t.date === date);
    return PERIODS.map(p => {
      const d = dailyData.find(x => x.period === p.period);
      const surplus  = d?.prices?.[activeRegion]?.surplus  ?? null;
      const shortage = d?.prices?.[activeRegion]?.shortage ?? null;
      const buys  = regionTrades.filter(t => t.period === p.period && t.side === 'buy');
      const sells = regionTrades.filter(t => t.period === p.period && t.side === 'sell');
      // 同コマに複数注文がある場合、加重平均価格を表示
      const wavg = ts => {
        if (ts.length === 0) return null;
        const num = ts.reduce((s, t) => s + t.price * t.quantity, 0);
        const den = ts.reduce((s, t) => s + t.quantity, 0);
        return den > 0 ? num / den : null;
      };
      return {
        period: p.period,
        time: p.startTime,
        label: p.label,
        surplus, shortage,
        buyPrice: wavg(buys),
        sellPrice: wavg(sells),
        buyQty:  buys.reduce((s, t) => s + t.quantity, 0) || null,
        sellQty: sells.reduce((s, t) => s + t.quantity, 0) || null,
      };
    });
  }, [dailyData, trades, activeRegion, date]);

  /* リージョン別集計 */
  const regionStats = useMemo(() => {
    const r = {};
    for (const reg of REGIONS) {
      const list = (trades[reg.id] || []).filter(t => t.date === date);
      const settled = list.filter(t => Number.isFinite(t.pnl));
      const totalPnL = settled.reduce((s, t) => s + t.pnl, 0);
      const longMW  = list.filter(t => t.side === 'buy' ).reduce((s, t) => s + t.quantity, 0);
      const shortMW = list.filter(t => t.side === 'sell').reduce((s, t) => s + t.quantity, 0);
      r[reg.id] = {
        count: list.length,
        open: list.length - settled.length,
        totalPnL,
        longMW, shortMW,
        netMW: longMW - shortMW,
      };
    }
    return r;
  }, [trades, date]);

  const grandPnL = useMemo(
    () => Object.values(regionStats).reduce((s, x) => s + x.totalPnL, 0),
    [regionStats]
  );

  /* データ取得 */
  const fetchData = useCallback(async () => {
    setFetchStatus({ state: 'loading', message: 'インバランス料金単価を取得中...' });
    try {
      const ym = date.slice(0, 7).replace('-', '');
      let url = `https://www.imbalanceprices-cs.jp/api/1.0/imb/price/${ym}`;
      if (revision.trim()) url += `/${revision.trim()}`;

      let fetchUrl;
      if (proxy && proxy.trim()) {
        const p = proxy.trim();
        fetchUrl = p.includes('{url}')
          ? p.replace('{url}', encodeURIComponent(url))
          : p + encodeURIComponent(url);
      } else {
        fetchUrl = url;
      }

      const text = await fetchDecoded(fetchUrl);
      const data = parseImbalanceCsv(text);
      if (data.length === 0) {
        throw new Error('レスポンスに有効なデータ行(D行)がありません。年月・リビジョン・プロキシ設定を確認してください。');
      }
      setImbalanceData(data);
      setLastUpdated(new Date());
      setFetchStatus({
        state: 'success',
        message: `取得成功 — ${ym} のCSV: ${data.length}行 (うち本日対象=${data.filter(r => r.date === date.replace(/-/g, '')).length}コマ)`
      });
    } catch (e) {
      setFetchStatus({
        state: 'error',
        message: `${e.message}  ※CORSエラーの場合: プロキシURLを変更、または下のCSVアップロードをご利用ください。`
      });
    }
  }, [date, revision, proxy]);

  /* オート更新 */
  useEffect(() => {
    if (!autoRefresh) return;
    const id = setInterval(() => fetchData(), Math.max(15, autoRefreshSec) * 1000);
    return () => clearInterval(id);
  }, [autoRefresh, autoRefreshSec, fetchData]);

  /* ファイル取込 */
  function handleFileUpload(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setFetchStatus({ state: 'loading', message: `読込中: ${file.name}` });
    const reader = new FileReader();
    reader.onload = ev => {
      try {
        const buf = ev.target.result;
        let text = '';
        try { text = new TextDecoder('shift_jis').decode(buf); } catch {}
        // ASCII行のみのCSVではShift_JISでもUTF-8でも動くが、念のため判定
        if (!text || (!text.includes('D,') && !text.includes('"D"'))) {
          text = new TextDecoder('utf-8').decode(buf);
        }
        const data = parseImbalanceCsv(text);
        if (data.length === 0) throw new Error('有効なD行が見つかりません');
        setImbalanceData(data);
        setLastUpdated(new Date());
        setFetchStatus({ state: 'success', message: `${file.name} 読込成功 — ${data.length}行` });
      } catch (err) {
        setFetchStatus({ state: 'error', message: `読込エラー: ${err.message}` });
      }
    };
    reader.readAsArrayBuffer(file);
    e.target.value = ''; // 同じファイル再選択を許可
  }

  /* 発注 */
  function placeOrder() {
    const price = parseFloat(orderPrice);
    const qty   = parseFloat(orderQty);
    if (!Number.isFinite(price)) { setFetchStatus({ state: 'error', message: 'BID価格(円/kWh)を入力してください' }); return; }
    if (!Number.isFinite(qty) || qty <= 0) { setFetchStatus({ state: 'error', message: '数量(MW)は正の数を入力してください' }); return; }

    const d = dailyData.find(x => x.period === orderPeriod);
    const sp = d
      ? (orderSide === 'buy' ? d.prices[activeRegion]?.shortage : d.prices[activeRegion]?.surplus)
      : null;

    let pnl = null;
    if (Number.isFinite(sp)) {
      pnl = orderSide === 'buy'
        ? (sp - price) * 500 * qty
        : (price - sp) * 500 * qty;
    }

    const trade = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      region: activeRegion,
      date,
      period: orderPeriod,
      side: orderSide,
      price, quantity: qty,
      settlementPrice: Number.isFinite(sp) ? sp : null,
      pnl,
      timestamp: new Date().toISOString(),
    };
    setTrades(prev => ({ ...prev, [activeRegion]: [...(prev[activeRegion] || []), trade] }));
    setOrderPrice('');
    setOrderQty('');
    setFetchStatus({
      state: 'success',
      message: `発注 ${REGION_BY_ID[activeRegion].name} P${String(orderPeriod).padStart(2, '0')} ${orderSide === 'buy' ? '買い' : '売り'} @${price}円/kWh × ${qty}MW${pnl !== null ? ` → PnL ${fmtJPY(pnl)}` : ' (約定価格未公表 — オープン)'}`
    });
  }

  function deleteTrade(tradeId) {
    setTrades(prev => ({
      ...prev,
      [activeRegion]: (prev[activeRegion] || []).filter(t => t.id !== tradeId),
    }));
  }

  function resetActiveRegion() {
    if (!confirm(`${REGION_BY_ID[activeRegion].name}エリアの全取引履歴を削除します。よろしいですか?`)) return;
    setTrades(prev => ({ ...prev, [activeRegion]: [] }));
  }
  function resetAll() {
    if (!confirm('全エリアの全取引履歴を削除します。よろしいですか?')) return;
    setTrades({});
  }

  const activeRegionObj = REGION_BY_ID[activeRegion];
  const activeRegionTrades = (trades[activeRegion] || [])
    .filter(t => t.date === date)
    .sort((a, b) => a.period - b.period || a.timestamp.localeCompare(b.timestamp));

  /* ────────────────────────────────────────────────────────────
     UI
     ──────────────────────────────────────────────────────────── */
  return (
    <div className="min-h-screen text-slate-100 relative overflow-x-hidden"
      style={{
        background: 'radial-gradient(ellipse 80% 60% at 50% -20%, #1e293b 0%, #020617 70%)',
        fontFamily: '"DM Sans", system-ui, sans-serif',
      }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600;700&display=swap');
        .mono { font-family: 'JetBrains Mono', ui-monospace, monospace; font-variant-numeric: tabular-nums; }
        .grid-bg::before {
          content: '';
          position: absolute; inset: 0; pointer-events: none;
          background-image:
            linear-gradient(rgba(148,163,184,0.04) 1px, transparent 1px),
            linear-gradient(90deg, rgba(148,163,184,0.04) 1px, transparent 1px);
          background-size: 32px 32px;
          mask-image: radial-gradient(ellipse 100% 80% at 50% 0%, black 0%, transparent 90%);
        }
        .card { background: linear-gradient(180deg, rgba(30,41,59,0.55) 0%, rgba(15,23,42,0.55) 100%); backdrop-filter: blur(8px); border: 1px solid rgba(148,163,184,0.10); }
        .card-accent { box-shadow: 0 0 0 1px rgba(240,181,65,0.18), 0 8px 32px -8px rgba(240,181,65,0.10); }
        .pulse-dot { animation: pulse-dot 1.6s ease-in-out infinite; }
        @keyframes pulse-dot { 0%,100%{opacity:1;transform:scale(1)} 50%{opacity:.4;transform:scale(0.85)} }
        .btn { transition: all .15s ease; }
        .btn:hover { transform: translateY(-1px); }
        .btn:active { transform: translateY(0); }
        input, select { color-scheme: dark; }
        input:focus, select:focus { outline: 2px solid rgba(240,181,65,0.5); outline-offset: 1px; }
      `}</style>

      <div className="grid-bg" />

      {/* ───── ヘッダー ───── */}
      <header className="relative border-b border-slate-800/50 backdrop-blur-sm">
        <div className="max-w-[1600px] mx-auto px-6 py-4 flex items-center justify-between gap-6 flex-wrap">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg flex items-center justify-center"
              style={{ background: 'linear-gradient(135deg, #f0b541, #fbbf24)', boxShadow: '0 0 24px rgba(240,181,65,0.4)' }}>
              <Zap size={22} className="text-slate-900" strokeWidth={2.5} />
            </div>
            <div>
              <div className="text-xs uppercase tracking-[0.2em] text-amber-400/80 mono">JEPX × ICS</div>
              <div className="text-xl font-bold leading-tight">Intraday Imbalance Trader</div>
            </div>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-slate-800/60 border border-slate-700/50">
              <label className="text-xs text-slate-400 mono">DATE</label>
              <input type="date" value={date} onChange={e => setDate(e.target.value)}
                className="bg-transparent text-sm mono outline-none" />
            </div>

            <button onClick={fetchData}
              className="btn flex items-center gap-2 px-4 py-2 rounded-lg bg-amber-500 hover:bg-amber-400 text-slate-900 font-semibold text-sm">
              <RefreshCw size={16} className={fetchStatus.state === 'loading' ? 'animate-spin' : ''} />
              データ取得
            </button>

            <label className="btn flex items-center gap-2 px-4 py-2 rounded-lg bg-slate-700/80 hover:bg-slate-600/80 text-slate-100 font-semibold text-sm cursor-pointer">
              <Upload size={16} />
              CSV取込
              <input type="file" accept=".csv,text/csv" onChange={handleFileUpload} className="hidden" />
            </label>

            <button onClick={() => setAutoRefresh(v => !v)}
              className={`btn flex items-center gap-2 px-3 py-2 rounded-lg font-semibold text-sm border ${
                autoRefresh ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40' : 'bg-slate-800/60 text-slate-400 border-slate-700/50'
              }`}>
              {autoRefresh ? <Pause size={14} /> : <Play size={14} />}
              <span className="mono text-xs">AUTO {autoRefresh ? `(${autoRefreshSec}s)` : 'OFF'}</span>
            </button>

            <button onClick={() => setShowSettings(v => !v)}
              className="btn flex items-center justify-center w-9 h-9 rounded-lg bg-slate-800/60 hover:bg-slate-700/60 border border-slate-700/50">
              <Settings2 size={16} />
            </button>

            <button onClick={resetAll}
              className="btn flex items-center gap-1.5 px-3 py-2 rounded-lg bg-rose-500/10 hover:bg-rose-500/20 text-rose-300 border border-rose-500/30 font-semibold text-sm">
              <Trash2 size={14} /> 全リセット
            </button>
          </div>
        </div>

        {/* ───── 設定パネル ───── */}
        {showSettings && (
          <div className="border-t border-slate-800/50 bg-slate-900/40">
            <div className="max-w-[1600px] mx-auto px-6 py-4 grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <label className="text-xs text-slate-400 mono mb-1.5 block">リビジョン (省略可・最新)</label>
                <input type="text" value={revision} onChange={e => setRevision(e.target.value)}
                  placeholder="例: 2"
                  className="w-full bg-slate-800/60 border border-slate-700/50 rounded px-3 py-2 text-sm mono" />
              </div>
              <div>
                <label className="text-xs text-slate-400 mono mb-1.5 block">CORSプロキシ URL ({'{url}'}またはサフィックス)</label>
                <input type="text" value={proxy} onChange={e => setProxy(e.target.value)}
                  placeholder="https://corsproxy.io/?url="
                  className="w-full bg-slate-800/60 border border-slate-700/50 rounded px-3 py-2 text-sm mono" />
                <p className="text-[10px] text-slate-500 mt-1">空欄=直接アクセス。CORS失敗時はプロキシを使用。</p>
              </div>
              <div>
                <label className="text-xs text-slate-400 mono mb-1.5 block">自動更新間隔 (秒)</label>
                <input type="number" min="15" value={autoRefreshSec} onChange={e => setAutoRefreshSec(parseInt(e.target.value || 60, 10))}
                  className="w-full bg-slate-800/60 border border-slate-700/50 rounded px-3 py-2 text-sm mono" />
              </div>
            </div>
          </div>
        )}

        {/* ステータスバー */}
        <div className={`border-t text-xs px-6 py-2 flex items-center gap-3 ${
          fetchStatus.state === 'error' ? 'bg-rose-900/30 text-rose-200 border-rose-800/50' :
          fetchStatus.state === 'success' ? 'bg-emerald-900/20 text-emerald-200 border-emerald-800/40' :
          fetchStatus.state === 'loading' ? 'bg-amber-900/20 text-amber-200 border-amber-800/40' :
          'bg-slate-900/40 text-slate-400 border-slate-800/50'
        }`}>
          <CircleDot size={12} className={fetchStatus.state === 'loading' ? 'pulse-dot text-amber-400' : ''} />
          <span className="mono">{fetchStatus.message}</span>
          {lastUpdated && (
            <span className="ml-auto text-slate-500 mono text-[10px]">
              最終更新: {lastUpdated.toLocaleTimeString('ja-JP')}
            </span>
          )}
        </div>
      </header>

      {/* ───── エリアタブ ───── */}
      <div className="max-w-[1600px] mx-auto px-6 pt-5">
        <div className="flex gap-1 overflow-x-auto pb-1">
          {REGIONS.map(r => {
            const active = r.id === activeRegion;
            const s = regionStats[r.id];
            return (
              <button key={r.id} onClick={() => setActiveRegion(r.id)}
                className={`btn flex flex-col items-start gap-0.5 px-4 py-2.5 rounded-t-lg border-b-2 min-w-[120px] ${
                  active
                    ? 'bg-slate-800/80 border-amber-400'
                    : 'bg-slate-900/40 border-transparent hover:bg-slate-800/40'
                }`}
                style={active ? { boxShadow: `inset 0 -2px 0 0 ${r.color}` } : {}}>
                <div className="flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full" style={{ background: r.color }} />
                  <span className="text-sm font-semibold">{r.name}</span>
                </div>
                <div className={`mono text-xs ${s.totalPnL > 0 ? 'text-emerald-400' : s.totalPnL < 0 ? 'text-rose-400' : 'text-slate-500'}`}>
                  {fmtJPY(s.totalPnL)}
                </div>
                {s.count > 0 && (
                  <div className="text-[9px] text-slate-500 mono">
                    {s.count}件 / 開{s.open}
                  </div>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* ───── メインコンテンツ ───── */}
      <main className="max-w-[1600px] mx-auto px-6 py-5 grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-5">

        {/* === 左カラム === */}
        <div className="space-y-5">

          {/* チャート */}
          <div className="card rounded-xl p-5">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <Activity size={18} style={{ color: activeRegionObj.color }} />
                <h3 className="font-bold text-base">
                  {activeRegionObj.name} エリア —
                  <span className="text-slate-400 font-normal text-sm ml-1.5">
                    インバランス料金単価 & 約定価格
                  </span>
                </h3>
              </div>
              <div className="text-xs mono text-slate-500">{date}</div>
            </div>

            <div style={{ width: '100%', height: 360 }}>
              <ResponsiveContainer>
                <ComposedChart data={chartData} margin={{ top: 10, right: 16, left: 0, bottom: 20 }}>
                  <defs>
                    <linearGradient id="gShort" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%"  stopColor="#f0b541" stopOpacity={0.6} />
                      <stop offset="100%" stopColor="#f0b541" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid stroke="#1e293b" strokeDasharray="3 6" />
                  <XAxis dataKey="time" stroke="#64748b" fontSize={10}
                    tick={{ fontFamily: 'JetBrains Mono', fill: '#64748b' }}
                    interval={5} />
                  <YAxis stroke="#64748b" fontSize={10}
                    tick={{ fontFamily: 'JetBrains Mono', fill: '#64748b' }}
                    label={{ value: '円/kWh', angle: -90, position: 'insideLeft', fill: '#64748b', fontSize: 10, fontFamily: 'JetBrains Mono' }} />
                  <Tooltip
                    contentStyle={{
                      background: 'rgba(2,6,23,0.95)', border: '1px solid #334155',
                      borderRadius: 8, fontFamily: 'JetBrains Mono', fontSize: 12,
                    }}
                    labelFormatter={(_, p) => {
                      const d = p?.[0]?.payload;
                      return d ? `Period ${String(d.period).padStart(2, '0')} (${d.label})` : '';
                    }}
                    formatter={(v, n) => {
                      if (v === null || v === undefined) return ['—', n];
                      return [`${fmtNum(v, 2)} 円/kWh`, n];
                    }}
                  />
                  <Legend wrapperStyle={{ fontSize: 12, paddingTop: 8, fontFamily: 'DM Sans' }} />
                  <Line type="monotone" dataKey="shortage" name="不足単価 (Buy決済)" stroke="#f0b541" strokeWidth={2} dot={false} connectNulls />
                  <Line type="monotone" dataKey="surplus"  name="余剰単価 (Sell決済)" stroke="#22d3ee" strokeWidth={2} dot={false} strokeDasharray="4 4" connectNulls />
                  <Line dataKey="buyPrice"  name="買い注文 (Bid)"  stroke="#22c55e" strokeWidth={0} dot={{ r: 6, fill: '#22c55e', stroke: '#022c1a', strokeWidth: 2 }} connectNulls={false} legendType="circle" />
                  <Line dataKey="sellPrice" name="売り注文 (Bid)" stroke="#ef4444" strokeWidth={0} dot={{ r: 6, fill: '#ef4444', stroke: '#2c0808', strokeWidth: 2 }} connectNulls={false} legendType="circle" />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* 発注フォーム */}
          <div className="card card-accent rounded-xl p-5">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <FileCode2 size={18} className="text-amber-400" />
                <h3 className="font-bold text-base">発注</h3>
                <span className="text-xs text-slate-500 mono">— {activeRegionObj.name}</span>
              </div>
            </div>

            <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
              {/* Period */}
              <div className="md:col-span-1">
                <label className="text-[10px] text-slate-400 mono uppercase tracking-wider mb-1 block">コマ (1–48)</label>
                <select value={orderPeriod} onChange={e => setOrderPeriod(parseInt(e.target.value, 10))}
                  className="w-full bg-slate-800/60 border border-slate-700/50 rounded px-2 py-2 text-sm mono">
                  {PERIODS.map(p => (
                    <option key={p.period} value={p.period}>
                      P{String(p.period).padStart(2, '0')} · {p.label}
                    </option>
                  ))}
                </select>
              </div>

              {/* Side */}
              <div>
                <label className="text-[10px] text-slate-400 mono uppercase tracking-wider mb-1 block">サイド</label>
                <div className="flex gap-1">
                  <button onClick={() => setOrderSide('buy')}
                    className={`btn flex-1 py-2 rounded text-sm font-semibold flex items-center justify-center gap-1 ${
                      orderSide === 'buy' ? 'bg-emerald-500 text-slate-900' : 'bg-slate-800/60 text-slate-400 hover:bg-slate-700/60'
                    }`}>
                    <TrendingUp size={14} />買い
                  </button>
                  <button onClick={() => setOrderSide('sell')}
                    className={`btn flex-1 py-2 rounded text-sm font-semibold flex items-center justify-center gap-1 ${
                      orderSide === 'sell' ? 'bg-rose-500 text-white' : 'bg-slate-800/60 text-slate-400 hover:bg-slate-700/60'
                    }`}>
                    <TrendingDown size={14} />売り
                  </button>
                </div>
              </div>

              {/* Price */}
              <div>
                <label className="text-[10px] text-slate-400 mono uppercase tracking-wider mb-1 block">BID価格 (円/kWh)</label>
                <input type="number" step="0.01" value={orderPrice} onChange={e => setOrderPrice(e.target.value)}
                  placeholder="例: 12.5"
                  className="w-full bg-slate-800/60 border border-slate-700/50 rounded px-2 py-2 text-sm mono" />
              </div>

              {/* Quantity */}
              <div>
                <label className="text-[10px] text-slate-400 mono uppercase tracking-wider mb-1 block">数量 (MW)</label>
                <input type="number" step="0.1" min="0" value={orderQty} onChange={e => setOrderQty(e.target.value)}
                  placeholder="例: 5"
                  className="w-full bg-slate-800/60 border border-slate-700/50 rounded px-2 py-2 text-sm mono" />
              </div>

              {/* Submit */}
              <div className="flex items-end">
                <button onClick={placeOrder}
                  className={`btn w-full py-2 rounded font-bold text-sm flex items-center justify-center gap-1.5 ${
                    orderSide === 'buy'
                      ? 'bg-emerald-500 hover:bg-emerald-400 text-slate-900'
                      : 'bg-rose-500 hover:bg-rose-400 text-white'
                  }`}>
                  {orderSide === 'buy' ? '買い発注' : '売り発注'}
                  <ChevronRight size={16} />
                </button>
              </div>
            </div>

            {/* プレビュー */}
            {orderPrice && orderQty && Number.isFinite(parseFloat(orderPrice)) && Number.isFinite(parseFloat(orderQty)) && (() => {
              const d = dailyData.find(x => x.period === orderPeriod);
              const sp = d ? (orderSide === 'buy' ? d.prices[activeRegion]?.shortage : d.prices[activeRegion]?.surplus) : null;
              const price = parseFloat(orderPrice), qty = parseFloat(orderQty);
              const pnl = Number.isFinite(sp)
                ? (orderSide === 'buy' ? (sp - price) * 500 * qty : (price - sp) * 500 * qty)
                : null;
              return (
                <div className="mt-3 p-3 rounded-lg bg-slate-900/60 border border-slate-700/40 text-xs mono space-y-1">
                  <div className="text-slate-400">想定PnL =
                    {orderSide === 'buy'
                      ? <> (不足単価 <span className="text-amber-300">{fmtNum(sp, 2)}</span> − BID <span className="text-slate-200">{price}</span>) × 500 × <span className="text-slate-200">{qty}</span></>
                      : <> (BID <span className="text-slate-200">{price}</span> − 余剰単価 <span className="text-cyan-300">{fmtNum(sp, 2)}</span>) × 500 × <span className="text-slate-200">{qty}</span></>}
                  </div>
                  <div className="text-base">
                    →
                    <span className={`ml-2 font-bold ${pnl > 0 ? 'text-emerald-400' : pnl < 0 ? 'text-rose-400' : 'text-slate-300'}`}>
                      {pnl !== null ? fmtJPY(pnl) : '— (約定価格未公表 / オープン)'}
                    </span>
                  </div>
                </div>
              );
            })()}
          </div>

          {/* 取引履歴 */}
          <div className="card rounded-xl p-5">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <Database size={18} className="text-slate-400" />
                <h3 className="font-bold text-base">取引履歴</h3>
                <span className="text-xs text-slate-500 mono">— {activeRegionObj.name} / {date}</span>
              </div>
              {activeRegionTrades.length > 0 && (
                <button onClick={resetActiveRegion}
                  className="btn flex items-center gap-1 px-2.5 py-1 rounded text-xs bg-rose-500/10 text-rose-300 border border-rose-500/30 hover:bg-rose-500/20">
                  <Trash2 size={11} /> エリアリセット
                </button>
              )}
            </div>

            {activeRegionTrades.length === 0 ? (
              <div className="text-center py-8 text-slate-500 text-sm mono">取引なし</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm mono">
                  <thead>
                    <tr className="text-xs text-slate-500 border-b border-slate-800">
                      <th className="text-left  py-2 px-2 font-medium">コマ</th>
                      <th className="text-left  py-2 px-2 font-medium">時間帯</th>
                      <th className="text-center py-2 px-2 font-medium">Side</th>
                      <th className="text-right py-2 px-2 font-medium">BID価格</th>
                      <th className="text-right py-2 px-2 font-medium">数量(MW)</th>
                      <th className="text-right py-2 px-2 font-medium">約定価格</th>
                      <th className="text-right py-2 px-2 font-medium">PnL</th>
                      <th className="text-right py-2 px-2 font-medium"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {activeRegionTrades.map(t => (
                      <tr key={t.id} className="border-b border-slate-800/40 hover:bg-slate-800/30">
                        <td className="py-2 px-2 text-slate-300">P{String(t.period).padStart(2, '0')}</td>
                        <td className="py-2 px-2 text-slate-400 text-xs">{PERIODS[t.period - 1]?.label}</td>
                        <td className="py-2 px-2 text-center">
                          <span className={`inline-block px-2 py-0.5 rounded text-[10px] font-bold ${
                            t.side === 'buy' ? 'bg-emerald-500/20 text-emerald-300' : 'bg-rose-500/20 text-rose-300'
                          }`}>{t.side === 'buy' ? '買' : '売'}</span>
                        </td>
                        <td className="py-2 px-2 text-right text-slate-200">{fmtNum(t.price, 2)}</td>
                        <td className="py-2 px-2 text-right text-slate-200">{fmtNum(t.quantity, 2)}</td>
                        <td className="py-2 px-2 text-right text-slate-400">
                          {Number.isFinite(t.settlementPrice) ? fmtNum(t.settlementPrice, 2) : <span className="text-amber-400 text-xs">未公表</span>}
                        </td>
                        <td className={`py-2 px-2 text-right font-bold ${
                          t.pnl === null ? 'text-amber-400' :
                          t.pnl > 0 ? 'text-emerald-400' :
                          t.pnl < 0 ? 'text-rose-400' : 'text-slate-300'
                        }`}>
                          {t.pnl === null ? 'OPEN' : fmtJPY(t.pnl)}
                        </td>
                        <td className="py-2 px-2 text-right">
                          <button onClick={() => deleteTrade(t.id)}
                            className="text-slate-600 hover:text-rose-400" title="削除">
                            <Trash2 size={12} />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="border-t-2 border-slate-700/50 font-bold">
                      <td colSpan={6} className="py-3 px-2 text-right text-slate-400">エリア合計:</td>
                      <td className={`py-3 px-2 text-right ${
                        regionStats[activeRegion].totalPnL > 0 ? 'text-emerald-400' :
                        regionStats[activeRegion].totalPnL < 0 ? 'text-rose-400' : 'text-slate-300'
                      }`}>{fmtJPY(regionStats[activeRegion].totalPnL)}</td>
                      <td></td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
          </div>
        </div>

        {/* === 右カラム: ポジション/PnL ===== */}
        <aside className="space-y-5">
          {/* 累積PnL */}
          <div className="card card-accent rounded-xl p-5"
            style={{ background: 'linear-gradient(135deg, rgba(240,181,65,0.08) 0%, rgba(15,23,42,0.5) 60%)' }}>
            <div className="text-[10px] uppercase tracking-[0.2em] text-amber-400/80 mono mb-1">Grand Total PnL</div>
            <div className={`text-4xl font-bold mono ${
              grandPnL > 0 ? 'text-emerald-400' : grandPnL < 0 ? 'text-rose-400' : 'text-slate-300'
            }`}>
              {fmtJPY(grandPnL)}
            </div>
            <div className="text-xs text-slate-500 mono mt-2">{date} · 9エリア合算</div>
          </div>

          {/* エリア別ポジション */}
          <div className="card rounded-xl p-4">
            <div className="text-[10px] uppercase tracking-[0.2em] text-slate-400 mono mb-3">エリア別ポジション</div>
            <div className="space-y-1.5">
              {REGIONS.map(r => {
                const s = regionStats[r.id];
                const isActive = r.id === activeRegion;
                return (
                  <button key={r.id} onClick={() => setActiveRegion(r.id)}
                    className={`btn w-full flex items-center gap-2 px-2.5 py-2 rounded-lg text-left ${
                      isActive ? 'bg-slate-800/80' : 'bg-slate-900/40 hover:bg-slate-800/40'
                    }`}>
                    <div className="w-1 h-7 rounded-full" style={{ background: r.color }} />
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-semibold leading-tight">{r.name}</div>
                      <div className="text-[10px] text-slate-500 mono flex gap-1.5">
                        {s.count > 0 ? (
                          <>
                            <span className="text-emerald-400/80">L{fmtNum(s.longMW, 1)}MW</span>
                            <span className="text-rose-400/80">S{fmtNum(s.shortMW, 1)}MW</span>
                          </>
                        ) : (
                          <span>—</span>
                        )}
                      </div>
                    </div>
                    <div className="text-right">
                      <div className={`mono text-sm font-bold ${
                        s.totalPnL > 0 ? 'text-emerald-400' : s.totalPnL < 0 ? 'text-rose-400' : 'text-slate-500'
                      }`}>{fmtJPY(s.totalPnL)}</div>
                      {s.open > 0 && (
                        <div className="text-[9px] text-amber-400 mono">OPEN×{s.open}</div>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* PnL計算式メモ */}
          <div className="card rounded-xl p-4">
            <div className="text-[10px] uppercase tracking-[0.2em] text-slate-400 mono mb-3">PnL計算式</div>
            <div className="space-y-2 text-xs mono leading-relaxed">
              <div className="p-2 rounded bg-emerald-500/5 border border-emerald-500/20">
                <div className="text-emerald-400 font-bold mb-1">買い (Buy)</div>
                <div className="text-slate-300 text-[11px]">
                  (不足単価 − BID) × 500 × MW
                </div>
              </div>
              <div className="p-2 rounded bg-rose-500/5 border border-rose-500/20">
                <div className="text-rose-400 font-bold mb-1">売り (Sell)</div>
                <div className="text-slate-300 text-[11px]">
                  (BID − 余剰単価) × 500 × MW
                </div>
              </div>
              <div className="text-[10px] text-slate-500 pt-1">
                ※ 500 = 0.5h × 1000 kW/MW<br />
                ※ 単位: 円/kWh × MW → 円
              </div>
            </div>
          </div>

          {/* API情報 */}
          <div className="card rounded-xl p-4">
            <div className="text-[10px] uppercase tracking-[0.2em] text-slate-400 mono mb-2">データソース</div>
            <div className="text-[11px] text-slate-400 leading-relaxed">
              <a href="https://www.imbalanceprices-cs.jp/" target="_blank" rel="noreferrer"
                className="text-amber-400 hover:underline">imbalanceprices-cs.jp</a> /api/1.0/imb/price/<span className="mono text-slate-500">{date.slice(0, 7).replace('-', '')}</span>
              <br /><br />
              <span className="text-slate-500">エンコード: MS932/Shift_JIS<br />
              更新頻度: 30分 (実需給後)<br />
              リトライ: 30秒間隔×5回 まで</span>
            </div>
          </div>
        </aside>
      </main>

      <footer className="max-w-[1600px] mx-auto px-6 py-6 text-[10px] text-slate-600 mono border-t border-slate-800/40 mt-4">
        ICS WebAPI 第2版準拠 · データは <a href="https://www.imbalanceprices-cs.jp/show/footer/terms_of_use.pdf" target="_blank" rel="noreferrer" className="underline hover:text-slate-400">利用規約</a> に従って使用 · 本ツールはバックテスト用シミュレータ
      </footer>
    </div>
  );
}
