/* charts.js — 三张折线图
 * 横轴: 整分钟固定刻度(10:00, 10:01, ...), 每 1 分钟一个数据点
 * 每个分钟只初始化一次, 之后永不覆盖
 * 显示窗口: 最近 60 个分钟点, 超出滑出但全量保留在 localStorage 后台
 * 数据来源: server.py 通过 socket.io (snapshot 全量 / point 新分钟)
 */
(() => {
  'use strict';

  if (typeof Chart === 'undefined' || typeof io === 'undefined') {
    console.error('[charts] Chart.js 或 socket.io 未加载, 图表不可用');
    return;
  }

  const WINDOW_MIN = 60;                 // 显示最近 60 个分钟点
  const BUFFER_MIN = 120;                // chart 内保留 120 分钟数据(缓冲, 防边界抖动)
  const TITLES = ['数据1', '数据2', '数据3'];
  const STORE_KEYS = ['cam_chart_0', 'cam_chart_1', 'cam_chart_2'];
  const COLORS = ['#2e7d32', '#f9a825', '#43a047'];

  const charts = [];
  // 每个图一个 Map: minuteTs -> line 值  (全量内存, 不限窗口)
  const allData = [];

  function fmtMin(sec) {
    const d = new Date(sec * 1000);
    const pad = n => String(n).padStart(2, '0');
    return pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function curMinute() {
    return Math.floor(Date.now() / 1000 / 60) * 60;
  }

  function makeChart(ctx, idx) {
    return new Chart(ctx, {
      type: 'line',
      data: {
        datasets: [
          {
            label: TITLES[idx],
            data: [],
            borderColor: COLORS[idx],
            backgroundColor: COLORS[idx] + '33',
            tension: 0.3,
            pointRadius: 2,
            borderWidth: 2,
            fill: true,
            yAxisID: 'y',
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        interaction: { mode: 'nearest', axis: 'x', intersect: false },
        scales: {
          x: {
            type: 'linear',
            title: { display: true, text: '时间 (HH:MM)', color: '#5a7a6a' },
            ticks: {
              color: '#5a7a6a',
              stepSize: 60,                 // 每分钟一刻度
              callback: v => fmtMin(v),
              maxRotation: 0,
              autoSkipPadding: 8,
            },
            grid: { color: 'rgba(0,40,20,.08)' },
          },
          y: {
            beginAtZero: true,
            suggestedMax: 1,
            ticks: { color: '#5a7a6a' },
            grid: { color: 'rgba(0,40,20,.08)' },
          },
        },
        plugins: {
          legend: { labels: { color: '#2a5a3a', font: { size: 11 }, boxWidth: 12 } },
          tooltip: { callbacks: { title: items => fmtMin(items[0].parsed.x) } },
        },
      },
    });
  }

  function loadStored(idx) {
    try {
      const raw = localStorage.getItem(STORE_KEYS[idx]);
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  }

  function persist(idx) {
    // 全量保存(不限窗口), 供"后台保留"
    try {
      const arr = [...allData[idx].entries()]
        .map(([t, v]) => ({ t, line: v }))
        .sort((a, b) => a.t - b.t);
      localStorage.setItem(STORE_KEYS[idx], JSON.stringify(arr));
    } catch (e) {
      console.warn('[charts] persist failed', e);
    }
  }

  // 把内存中最近 BUFFER_MIN 分钟的点重建进 chart.data
  function rebuild(idx) {
    const ch = charts[idx];
    if (!ch) return;
    const minTs = curMinute() - (BUFFER_MIN - 1) * 60;
    const pts = [...allData[idx].entries()]
      .filter(([t]) => t >= minTs)
      .sort((a, b) => a[0] - b[0]);
    ch.data.datasets[0].data = pts.map(([t, v]) => ({ x: t, y: v }));
  }

  // 锁定横轴窗口到最近 WINDOW_MIN 分钟(整分钟对齐)
  function updateWindow() {
    const c = curMinute();
    charts.forEach(ch => {
      if (!ch) return;
      ch.options.scales.x.min = c - (WINDOW_MIN - 1) * 60;
      ch.options.scales.x.max = c;
      ch.update('none');
    });
  }

  function refreshAll() {
    for (let i = 0; i < charts.length; i++) rebuild(i);
    charts.forEach(ch => ch && ch.update('none'));
    updateWindow();
  }

  // 初始化三张图, 并从 localStorage 恢复全量历史
  for (let i = 0; i < 3; i++) {
    const el = document.getElementById('chart' + i);
    if (!el) continue;
    allData[i] = new Map(loadStored(i).map(p => [p.t, p.line]));
    charts.push(makeChart(el.getContext('2d'), i));
  }
  refreshAll();
  // 每秒检查窗口是否需要右移(跨分钟时滑动)
  setInterval(updateWindow, 1000);

  // === 图表轮播切换(左右箭头/指示点, 一次只显示一个) ===
  const chartCards = document.querySelectorAll('.canvas-charts .chart-card');
  const chartTitleEl = document.getElementById('chartTitle');
  const chartInds = document.querySelectorAll('#chartIndicators .ci');
  const CHART_NAMES = ['数据1', '数据2', '数据3'];
  let curChartIdx = 0;
  function showChart(i) {
    if (!chartCards.length) return;
    curChartIdx = (i + chartCards.length) % chartCards.length;
    chartCards.forEach((c, idx) => { c.hidden = idx !== curChartIdx; });
    if (chartTitleEl) chartTitleEl.textContent = CHART_NAMES[curChartIdx] || '';
    chartInds.forEach((d, idx) => d.classList.toggle('active', idx === curChartIdx));
    // 切换后 resize 当前图(此前 hidden 的 canvas 尺寸为 0)
    if (charts[curChartIdx]) setTimeout(() => charts[curChartIdx].resize(), 0);
  }
  const prevBtn = document.getElementById('chartPrev');
  const nextBtn = document.getElementById('chartNext');
  if (prevBtn) prevBtn.addEventListener('click', () => showChart(curChartIdx - 1));
  if (nextBtn) nextBtn.addEventListener('click', () => showChart(curChartIdx + 1));
  chartInds.forEach(d => d.addEventListener('click', () => showChart(+d.dataset.i)));
  showChart(0);

  // 连接 socket (复用 camera.js 建立的连接)
  const socket = window.socket || io();
  socket.on('connect', () => console.log('[charts] socket connected'));
  socket.on('disconnect', () => console.warn('[charts] socket disconnected'));

  // 全量历史: [{t, charts:[{line}x3]}, ...]
  socket.on('snapshot', arr => {
    arr.forEach(pt => {
      const cs = pt.charts || [];
      for (let i = 0; i < 3; i++) {
        if (!allData[i].has(pt.t) && cs[i]) {     // 只初始化一次
          allData[i].set(pt.t, cs[i].line);
        }
      }
    });
    for (let i = 0; i < 3; i++) persist(i);
    refreshAll();
    console.log('[charts] snapshot applied', arr.length, 'minutes');
  });

  // 新分钟增量: {t, charts:[{line}x3]}
  socket.on('point', pt => {
    const cs = pt.charts || [];
    for (let i = 0; i < 3; i++) {
      if (!allData[i].has(pt.t) && cs[i]) {       // 只初始化一次
        allData[i].set(pt.t, cs[i].line);
        persist(i);
      }
    }
    refreshAll();
  });

  // 清单数据: [v0..v5] -> 更新清单 + 状态色 + 联动告警铃
  socket.on('list', arr => {
    arr.forEach((v, i) => {
      const el = document.getElementById('lv' + i);
      if (el) {
        el.textContent = v;
        el.classList.remove('warn', 'danger');
        if (i === 0 && v < 30) el.classList.add('danger');      // 土壤湿度低
        else if (i === 1 && v < 20) el.classList.add('warn');   // 水箱水位低
        else if (i === 5 && v > 0) el.classList.add('danger');  // 有病害
      }
    });
    updateAlert(arr);
    console.log('[list] updated', arr);
  });

  // 告警铃: 清单超阈值时显示 (土壤湿度<30, 水箱水位<20)
  function updateAlert(arr) {
    const bell = document.getElementById('alertBell');
    const txt = document.getElementById('alertText');
    if (!bell || !txt) return;
    const alerts = [];
    if (arr[0] !== undefined && arr[0] < 30) alerts.push('土壤湿度低');
    if (arr[1] !== undefined && arr[1] < 20) alerts.push('水箱水位低');
    if (alerts.length) {
      txt.textContent = alerts.join('、');
      bell.classList.add('show');
    } else {
      bell.classList.remove('show');
    }
  }

  console.log('[charts] initialized', charts.length, 'charts');
})();
