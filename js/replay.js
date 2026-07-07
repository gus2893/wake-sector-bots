// BRWeb replay viewer - renders real UE match NDJSON on a top-down canvas.
(() => {
  const cv = document.getElementById('world');
  const ctx = cv.getContext('2d');
  const feedEl = document.getElementById('feed');
  const agentsEl = document.getElementById('agents');
  let match = null;         // {header, snaps, events, tMax}
  let t = 0, playing = false, speed = 4, lastFrame = 0, feedIdx = 0;
  let view = { cx: 0, cy: 0, scale: 0.08 }; // world cm -> px

  // ---------- loading ----------
  async function loadUrl(url) {
    document.getElementById('loadMsg').textContent = 'loading ' + url + ' ...';
    match = await BRData.match(url, p => {
      document.getElementById('loadMsg').textContent = 'parsing ' + Math.round(p * 100) + '%';
    });
    onLoaded(url);
  }
  function onLoaded(name) {
    t = 0; feedIdx = 0; feedEl.innerHTML = '';
    fitView();
    document.getElementById('loadMsg').textContent =
      `${name} - ${match.snaps.size} agents, ${match.events.length} events, ${fmt(match.tMax)} long`;
    buildAgentPanel();
    draw();
  }
  function fitView() {
    // gym records live within ~ +-5200; field records span +-25000 (POIs in header)
    let ext = 5600;
    for (const arr of match.snaps.values())
      for (let i = 0; i < arr.length; i += 50)
        ext = Math.max(ext, Math.abs(arr[i].x), Math.abs(arr[i].y));
    view.scale = (cv.width / 2 - 20) / ext;
    view.cx = 0; view.cy = 0;
  }
  const X = wx => cv.width / 2 + (wx - view.cx) * view.scale;
  const Y = wy => cv.height / 2 - (wy - view.cy) * view.scale;

  // ---------- render ----------
  function draw() {
    ctx.clearRect(0, 0, cv.width, cv.height);
    if (!match) return;
    const isGym = view.scale > 0.05;
    // arena wall / POI markers
    ctx.strokeStyle = '#26314a'; ctx.lineWidth = 2;
    if (isGym) {
      ctx.beginPath(); ctx.arc(X(0), Y(0), 5000 * view.scale, 0, 7); ctx.stroke();
    } else if (match.header && match.header.pois) {
      ctx.fillStyle = '#7c8aa5'; ctx.font = '11px Consolas';
      for (const p of match.header.pois) {
        ctx.strokeRect(X(p.x) - 8, Y(p.y) - 8, 16, 16);
        ctx.fillText(p.name, X(p.x) + 10, Y(p.y) + 4);
      }
    }
    // recent fire/hit tracers + deaths (events within the last 0.6s window)
    for (let i = feedIdx; i < match.events.length; i++) {
      const e = match.events[i];
      if (e.t > t) break;
      if (e.t < t - 0.7) continue;
      if (e.k === 'hit') {
        const a = BRData.snapAt(match.snaps.get(e.a), e.t), v = BRData.snapAt(match.snaps.get(e.v), e.t);
        if (a && v) {
          ctx.strokeStyle = 'rgba(255,184,77,.8)'; ctx.lineWidth = 1;
          ctx.beginPath(); ctx.moveTo(X(a.x), Y(a.y)); ctx.lineTo(X(v.x), Y(v.y)); ctx.stroke();
        }
      } else if (e.k === 'death') {
        ctx.strokeStyle = '#ff5d5d'; ctx.lineWidth = 2.5;
        const px = X(e.x), py = Y(e.y);
        ctx.beginPath(); ctx.moveTo(px - 8, py - 8); ctx.lineTo(px + 8, py + 8);
        ctx.moveTo(px + 8, py - 8); ctx.lineTo(px - 8, py + 8); ctx.stroke();
      }
    }
    // agents
    for (const [a, arr] of match.snaps) {
      const s = BRData.snapAt(arr, t);
      if (!s) continue;
      const px = X(s.x), py = Y(s.y);
      const col = BRData.agentColor(a);
      const dead = isDeadAt(a, t);
      ctx.globalAlpha = dead ? 0.25 : 1;
      // heading wedge
      const yaw = (s.yaw || 0) * Math.PI / 180;
      ctx.strokeStyle = col; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(px, py);
      ctx.lineTo(px + Math.cos(yaw) * 14, py - Math.sin(yaw) * 14); ctx.stroke();
      // body
      ctx.fillStyle = col;
      ctx.beginPath(); ctx.arc(px, py, s.firing ? 7 : 5.5, 0, 7); ctx.fill();
      if (s.firing) { ctx.strokeStyle = '#ffb84d'; ctx.beginPath(); ctx.arc(px, py, 10, 0, 7); ctx.stroke(); }
      // hp bar + shield tick
      if (!dead) {
        ctx.fillStyle = '#26314a'; ctx.fillRect(px - 12, py - 16, 24, 3);
        ctx.fillStyle = s.hp > 40 ? '#46d18c' : '#ff5d5d';
        ctx.fillRect(px - 12, py - 16, 24 * Math.max(0, s.hp) / 100, 3);
        if (s.sh > 0) { ctx.fillStyle = '#4da3ff'; ctx.fillRect(px - 12, py - 20, 24 * s.sh / (s.shm > 0 ? s.shm : 40), 2); }
      }
      // label
      ctx.globalAlpha = dead ? 0.3 : 0.9;
      ctx.fillStyle = '#d7e0f0'; ctx.font = '11px Consolas';
      ctx.fillText(`B${a + 1}${s.goal ? ' ' + s.goal.split(':')[0] : ''}`, px + 10, py - 6);
      ctx.globalAlpha = 1;
    }
    document.getElementById('clock').textContent = fmt(t);
    document.getElementById('scrub').value = Math.round(t / match.tMax * 1000);
    updateAgentPanel();
  }
  const deathTimes = () => {
    const m = new Map();
    for (const e of match.events) if (e.k === 'death') {
      if (!m.has(e.a)) m.set(e.a, []);
      m.get(e.a).push(e.t);
    }
    return m;
  };
  let deaths = null;
  function isDeadAt(a, tt) {
    if (!deaths) deaths = deathTimes();
    const arr = deaths.get(a);
    if (!arr) return false;
    // dead if a death happened within the last 6s (gym recycles pawns per round)
    return arr.some(dt => tt >= dt && tt < dt + 6);
  }

  // ---------- panels ----------
  function buildAgentPanel() {
    agentsEl.innerHTML = '';
    for (const a of [...match.snaps.keys()].sort((x, y) => x - y)) {
      const div = document.createElement('div');
      div.className = 'kv'; div.id = 'ag' + a;
      div.innerHTML = `<span style="color:${BRData.agentColor(a)}">BR-Bot-${a + 1}</span><span></span>`;
      agentsEl.appendChild(div);
    }
  }
  function updateAgentPanel() {
    for (const [a, arr] of match.snaps) {
      const s = BRData.snapAt(arr, t);
      const el = document.getElementById('ag' + a);
      if (el && s) el.lastElementChild.textContent =
        `${s.hp}hp ${s.sh > 0 ? '+' + s.sh + 'sh ' : ''}${s.wpn || 'unarmed'} ${s.goal || ''}`;
    }
  }
  function pumpFeed() {
    while (feedIdx < match.events.length && match.events[feedIdx].t <= t) {
      const e = match.events[feedIdx++];
      if (e.k === 'snap' || e.k === 'fire') continue;
      const div = document.createElement('div');
      if (e.k === 'death') { div.className = 'kill'; div.textContent = `${fmt(e.t)}  BR-Bot-${e.a + 1} died`; }
      else if (e.k === 'loot') { div.className = 'loot'; div.textContent = `${fmt(e.t)}  B${e.a + 1} looted ${e.item} x${e.count}`; }
      else if (e.k === 'round') div.textContent = `${fmt(e.t)}  -- round ${e.n} --`;
      else if (e.k === 'cast') div.textContent = `${fmt(e.t)}  B${e.a + 1} cast ${e.ability || ''}`;
      else if (e.k === 'end') div.textContent = `${fmt(e.t)}  match end (${e.reason})`;
      else continue;
      feedEl.appendChild(div);
      feedEl.scrollTop = feedEl.scrollHeight;
    }
  }
  const fmt = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

  // ---------- transport ----------
  function frame(ts) {
    if (playing && match) {
      if (lastFrame) t = Math.min(match.tMax, t + (ts - lastFrame) / 1000 * speed);
      lastFrame = ts;
      pumpFeed();
      draw();
      if (t >= match.tMax) playing = false;
    } else lastFrame = ts;
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  document.getElementById('btnPlay').onclick = () => {
    playing = !playing;
    document.getElementById('btnPlay').textContent = playing ? 'Pause' : 'Play';
  };
  document.getElementById('selSpeed').onchange = e => speed = +e.target.value;
  document.getElementById('scrub').oninput = e => {
    if (!match) return;
    t = e.target.value / 1000 * match.tMax;
    feedIdx = 0; feedEl.innerHTML = ''; pumpFeed(); draw();
  };
  document.getElementById('fileLocal').onchange = async e => {
    const f = e.target.files[0];
    if (!f) return;
    const text = await f.text();
    const blob = new Blob([text]); // reuse the same parser via object URL
    match = await BRData.match(URL.createObjectURL(blob));
    deaths = null;
    onLoaded(f.name);
  };

  // ---------- boot ----------
  (async () => {
    try {
      const list = await BRData.json('data/manifest.json');
      const sel = document.getElementById('selMatch');
      for (const r of (Array.isArray(list) ? list : [list])) {
        const o = document.createElement('option');
        o.value = 'data/' + r.file; o.textContent = `${r.id} (${r.map}, ${r.kills} kills)`;
        sel.appendChild(o);
      }
      sel.onchange = () => { deaths = null; loadUrl(sel.value); };
      const q = new URLSearchParams(location.search).get('m');
      if (q) { sel.value = 'data/' + q; deaths = null; await loadUrl('data/' + q); }
      else if (sel.options.length) { await loadUrl(sel.value); }
    } catch (e) {
      document.getElementById('loadMsg').textContent = 'No manifest - run Tools/BRWeb/sync.ps1, or open a local .ndjson.';
    }
  })();
})();
