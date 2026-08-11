(() => {
  'use strict';

  const video = document.getElementById('video');
  const statusEl = document.getElementById('status');
  const errorEl = document.getElementById('error');
  const infoEl = document.getElementById('info');
  const startBtn = document.getElementById('startBtn');
  const stopBtn = document.getElementById('stopBtn');
  const snapBtn = document.getElementById('snapBtn');
  const deviceSelect = document.getElementById('deviceSelect');

  let currentStream = null;
  let devices = [];
  let currentIndex = 0;

  // 与服务器通信的 socket (camera.js 上报按钮事件, charts.js 复用)
  const socket = io();
  window.socket = socket;

  // === 顶部状态栏: 实时时钟 ===
  const clockEl = document.getElementById('clock');
  function updateClock() {
    const d = new Date();
    const p = n => String(n).padStart(2, '0');
    if (clockEl) clockEl.textContent = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }
  updateClock();
  setInterval(updateClock, 1000);

  // === 顶部状态栏: 后端连接状态 ===
  const backendDot = document.getElementById('backendDot');
  const backendLabel = document.getElementById('backendLabel');
  socket.on('connect', () => {
    if (backendDot) backendDot.classList.add('ok');
    if (backendLabel) backendLabel.textContent = '已连接';
  });
  socket.on('disconnect', () => {
    if (backendDot) backendDot.classList.remove('ok');
    if (backendLabel) backendLabel.textContent = '已断开';
  });

  // === 病害详情弹窗 ===
  let lastDisease = [];
  const diseaseBtn = document.getElementById('diseaseBtn');
  const diseaseModal = document.getElementById('diseaseModal');
  const diseaseList = document.getElementById('diseaseList');
  const diseaseClose = document.getElementById('diseaseClose');

  function renderDisease() {
    if (!diseaseList) return;
    if (!lastDisease.length) {
      diseaseList.innerHTML = '<div class="modal-empty">暂无病害 🌿</div>';
      return;
    }
    diseaseList.innerHTML = lastDisease.map(d =>
      `<div class="disease-row"><span>${d.name}</span><span class="count">${d.count} 处</span></div>`
    ).join('');
  }
  if (diseaseBtn) diseaseBtn.addEventListener('click', () => {
    renderDisease();
    if (diseaseModal) diseaseModal.classList.add('active');
  });
  if (diseaseClose) diseaseClose.addEventListener('click', () => {
    if (diseaseModal) diseaseModal.classList.remove('active');
  });
  socket.on('disease', arr => {
    lastDisease = arr || [];
    console.log('[disease]', lastDisease);
  });

  // === AI 对话与建议 ===
  const chatBox = document.getElementById('chatBox');
  const aiInput = document.getElementById('aiInput');
  const aiSendBtn = document.getElementById('aiSendBtn');
  const adviceText = document.getElementById('adviceText');
  const valueText = document.getElementById('valueText');
  const refreshAdviceBtn = document.getElementById('refreshAdvice');
  const refreshValueBtn = document.getElementById('refreshValue');

  function addChat(text, who) {
    if (!chatBox) return;
    const div = document.createElement('div');
    div.className = 'chat-message ' + who;
    div.textContent = text;
    chatBox.appendChild(div);
    chatBox.scrollTop = chatBox.scrollHeight;
  }
  function sendChat() {
    const q = aiInput ? aiInput.value.trim() : '';
    if (!q) return;
    addChat(q, 'user');
    aiInput.value = '';
    socket.emit('chat', q);
  }
  if (aiSendBtn) aiSendBtn.addEventListener('click', sendChat);
  if (aiInput) aiInput.addEventListener('keydown', e => { if (e.key === 'Enter') sendChat(); });
  document.querySelectorAll('.q-bubble').forEach(b => {
    b.addEventListener('click', () => { if (aiInput) aiInput.value = b.dataset.q; sendChat(); });
  });
  socket.on('chat_reply', msg => addChat(msg, 'ai'));
  socket.on('advice', msg => { if (adviceText) adviceText.textContent = msg; });
  socket.on('value', msg => { if (valueText) valueText.textContent = msg; });
  if (refreshAdviceBtn) refreshAdviceBtn.addEventListener('click', () => socket.emit('refresh_advice'));
  if (refreshValueBtn) refreshValueBtn.addEventListener('click', () => socket.emit('refresh_value'));

  function setStatus(text, recording = false) {
    statusEl.textContent = text;
    statusEl.classList.toggle('recording', recording);
  }

  function showError(msg) {
    errorEl.textContent = msg;
    if (msg) console.error('[camera]', msg);
  }

  function setInfo(msg) {
    infoEl.textContent = msg;
  }

  function stopStream() {
    if (currentStream) {
      currentStream.getTracks().forEach(t => t.stop());
      currentStream = null;
    }
    video.srcObject = null;
    stopBtn.disabled = true;
    snapBtn.disabled = true;
    startBtn.disabled = false;
  }

  async function enumerateCameras() {
    try {
      // 必须先有授权才能拿到 videoinput 的 label
      devices = (await navigator.mediaDevices.enumerateDevices())
        .filter(d => d.kind === 'videoinput');

      deviceSelect.innerHTML = '';
      devices.forEach((d, i) => {
        const opt = document.createElement('option');
        opt.value = String(i);
        opt.textContent = d.label || `摄像头 ${i + 1}`;
        deviceSelect.appendChild(opt);
      });
      deviceSelect.disabled = devices.length < 2;
      return devices;
    } catch (e) {
      showError('枚举设备失败: ' + e.message);
      return [];
    }
  }

  async function startCamera(deviceId) {
    showError('');
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      showError('当前浏览器不支持 getUserMedia，请使用 Chrome / Edge / Firefox。');
      return;
    }

    if (currentStream) stopStream();

    const constraints = {
      video: deviceId
        ? { deviceId: { exact: deviceId } }
        : { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false
    };

    try {
      setStatus('请求权限中…');
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      currentStream = stream;
      video.srcObject = stream;
      await video.play().catch(() => {});

      const track = stream.getVideoTracks()[0];
      const settings = track.getSettings();
      setInfo(`分辨率: ${settings.width || '?'}×${settings.height || '?'} | 设备: ${track.label || '(未知)'}`);

      startBtn.disabled = true;
      stopBtn.disabled = false;
      snapBtn.disabled = false;
      setStatus('直播中', true);

      await enumerateCameras();

      const idx = devices.findIndex(d => d.label === track.label);
      if (idx >= 0) {
        currentIndex = idx;
        deviceSelect.value = String(idx);
      }
    } catch (err) {
      setStatus('未启动');
      if (err.name === 'NotAllowedError' || err.name === 'SecurityError') {
        showError('权限被拒绝。请允许浏览器访问摄像头（注意：本地 file:// 打开也可能受限，建议用 localhost 或 https）。');
      } else if (err.name === 'NotFoundError' || err.name === 'OverconstrainedError') {
        showError('未找到符合条件的摄像头。');
      } else if (err.name === 'NotReadableError') {
        showError('摄像头被其他程序占用。');
      } else {
        showError('启动失败: ' + err.message);
      }
    }
  }

  startBtn.addEventListener('click', () => startCamera());

  stopBtn.addEventListener('click', () => {
    stopStream();
    setStatus('已停止');
    setInfo('');
  });

  deviceSelect.addEventListener('change', () => {
    const idx = Number(deviceSelect.value);
    if (!Number.isNaN(idx)) {
      currentIndex = idx;
      startCamera(devices[idx].deviceId);
    }
  });

  snapBtn.addEventListener('click', () => {
    if (!currentStream) return;
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    // 与 video 的 CSS 镜像保持一致
    ctx.translate(canvas.width, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    canvas.toBlob(blob => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `snapshot-${Date.now()}.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }, 'image/png');
  });

  // btn1: 自动/手动模式切换
  let isAuto = true; // 初始为自动模式
  const btn1 = document.getElementById('btn1');
  btn1.addEventListener('click', () => {
    isAuto = !isAuto;
    btn1.textContent = isAuto ? '自动模式' : '手动模式';
    btn1.style.background = isAuto ? '' : '#f1c40f';
    updateModeUI();
  });

  // btn2: 正在浇水/停止浇水切换 + 缺水超时警告 + 状态点
  let isWatering = false; // 初始未浇水
  let waterTimer = null;
  const btn2 = document.getElementById('btn2');
  const waterWarning = document.getElementById('waterWarning');
  const dotWater = document.getElementById('dotWater');
  btn2.addEventListener('click', () => {
    isWatering = !isWatering;
    btn2.textContent = isWatering ? '正在浇水' : '停止浇水';
    btn2.style.background = isWatering ? '#2ea043' : ''; // 浇水中=绿
    if (dotWater) dotWater.classList.toggle('on', isWatering);
    if (waterTimer) { clearTimeout(waterTimer); waterTimer = null; }
    if (waterWarning) waterWarning.classList.remove('show');
    if (isWatering) {
      waterTimer = setTimeout(() => {
        if (isWatering && waterWarning) waterWarning.classList.add('show');
      }, 30000);
    }
  });

  // btnHarvest: 开始/结束自动采摘切换 (仅自动模式可用) + 状态点
  let isHarvesting = false;
  const btnHarvest = document.getElementById('btnHarvest');
  const dotHarvest = document.getElementById('dotHarvest');
  btnHarvest.addEventListener('click', () => {
    if (!isAuto) return;            // 仅自动模式可触发
    isHarvesting = !isHarvesting;
    btnHarvest.textContent = isHarvesting ? '结束自动采摘' : '开始自动采摘';
    btnHarvest.style.background = isHarvesting ? '#2ea043' : '';
    if (dotHarvest) dotHarvest.classList.toggle('on', isHarvesting);
  });

  // btnGrip: 张开/夹紧夹爪切换 + 状态点
  let isGripper = false;
  const btnGrip = document.getElementById('btnGrip');
  const dotGrip = document.getElementById('dotGrip');
  btnGrip.addEventListener('click', () => {
    isGripper = !isGripper;
    btnGrip.textContent = isGripper ? '夹紧夹爪' : '张开夹爪';
    btnGrip.style.background = isGripper ? '#2e7d32' : '';
    if (dotGrip) dotGrip.classList.toggle('on', isGripper);
  });

  // 根据模式更新 UI: 手动→方向键可用; 自动→采摘按钮可用
  function updateModeUI() {
    document.querySelectorAll('.dkey').forEach(k => { k.disabled = isAuto; });
    if (btnHarvest) btnHarvest.disabled = !isAuto;
    // 切到自动模式时, 若正在采摘则复位
    if (isAuto && isHarvesting) {
      isHarvesting = false;
      btnHarvest.textContent = '开始自动采摘';
      btnHarvest.style.background = '';
    }
  }
  updateModeUI(); // 初始为自动模式

  // 所有按钮点击统一上报服务器
  document.addEventListener('click', e => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const time = Date.now();
    // 方向控制器: 发 direction 事件
    if (btn.dataset.dir) {
      socket.emit('direction', { dir: btn.dataset.dir, time });
      return;
    }
    if (!btn.id) return;
    const payload = {
      id: btn.id,
      label: btn.textContent.trim(),
      time,
    };
    if (btn.id === 'btn1') payload.mode = isAuto ? 'auto' : 'manual';
    if (btn.id === 'btn2') payload.watering = isWatering;
    if (btn.id === 'btnHarvest') payload.harvesting = isHarvesting;
    if (btn.id === 'btnGrip') payload.gripping = isGripper;
    socket.emit('button', payload);
    const lastActionEl = document.getElementById('lastAction');
    if (lastActionEl) lastActionEl.textContent = `上次操作: ${btn.textContent.trim()} (${new Date().toLocaleTimeString()})`;
  });

  // === 俯仰角滚轮: 上报 server ===
  const pitchRange = document.getElementById('pitchRange');
  const pitchVal = document.getElementById('pitchVal');
  if (pitchRange) {
    pitchRange.addEventListener('input', () => {
      const v = +pitchRange.value;
      if (pitchVal) pitchVal.textContent = v;
      socket.emit('pitch', { value: v, time: Date.now() });
    });
  }

  // 设备热插拔
  navigator.mediaDevices?.addEventListener?.('devicechange', enumerateCameras);

  setStatus('未启动');
  setInfo('点击"启动摄像头"开始');
})();
