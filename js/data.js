// BRWeb shared data helpers (plain script, no modules).
const BRData = {
  async json(url) {
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) throw new Error(url + ' -> ' + r.status);
    return r.json();
  },
  // Parse an NDJSON match record into { header, snaps (by agent, time-sorted), events }.
  async match(url, onProgress) {
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) throw new Error(url + ' -> ' + r.status);
    const text = await r.text();
    const lines = text.split('\n');
    let header = null;
    const snaps = new Map();      // agent -> [snap...]
    const events = [];            // everything that isn't a snap
    let tMax = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line || line[0] !== '{') continue;
      let o;
      try { o = JSON.parse(line); } catch { continue; }
      if (o.k === 'match') { header = o; continue; }
      if (o.t > tMax) tMax = o.t;
      if (o.k === 'snap') {
        let arr = snaps.get(o.a);
        if (!arr) { arr = []; snaps.set(o.a, arr); }
        arr.push(o);
      } else {
        events.push(o);
      }
      if (onProgress && (i & 8191) === 0) onProgress(i / lines.length);
    }
    for (const arr of snaps.values()) arr.sort((a, b) => a.t - b.t);
    events.sort((a, b) => a.t - b.t);
    return { header, snaps, events, tMax };
  },
  // Binary search the latest snap at or before time t.
  snapAt(arr, t) {
    if (!arr || !arr.length) return null;
    let lo = 0, hi = arr.length - 1, ans = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid].t <= t) { ans = arr[mid]; lo = mid + 1; } else { hi = mid - 1; }
    }
    return ans;
  },
  agentColor(i) {
    const hues = [205, 25, 130, 55, 285, 165, 340, 95, 230, 0];
    return `hsl(${hues[i % hues.length]}, 75%, 60%)`;
  },
  // Minimal line chart on a canvas: series = [{pts:[{x,y}], color, label}]
  chart(canvas, series, opts = {}) {
    const ctx = canvas.getContext('2d');
    const W = canvas.width = canvas.clientWidth * devicePixelRatio;
    const H = canvas.height = (opts.height || 220) * devicePixelRatio;
    canvas.style.height = (opts.height || 220) + 'px';
    ctx.clearRect(0, 0, W, H);
    const all = series.flatMap(s => s.pts);
    if (!all.length) { return; }
    const pad = 34 * devicePixelRatio;
    let xMin = Math.min(...all.map(p => p.x)), xMax = Math.max(...all.map(p => p.x));
    let yMin = Math.min(...all.map(p => p.y)), yMax = Math.max(...all.map(p => p.y));
    if (xMax === xMin) xMax = xMin + 1;
    if (yMax === yMin) yMax = yMin + 1;
    const X = x => pad + (x - xMin) / (xMax - xMin) * (W - pad * 1.4);
    const Y = y => H - pad + (y - yMin) / (yMax - yMin) * (pad * 1.6 - H);
    ctx.strokeStyle = '#26314a'; ctx.fillStyle = '#7c8aa5';
    ctx.font = `${11 * devicePixelRatio}px Consolas`;
    for (let g = 0; g <= 4; g++) {
      const y = yMin + (yMax - yMin) * g / 4;
      ctx.beginPath(); ctx.moveTo(pad, Y(y)); ctx.lineTo(W, Y(y)); ctx.globalAlpha = .35; ctx.stroke(); ctx.globalAlpha = 1;
      ctx.fillText(y.toFixed(Math.abs(yMax - yMin) < 5 ? 2 : 0), 4, Y(y) + 4);
    }
    for (const s of series) {
      ctx.strokeStyle = s.color; ctx.lineWidth = 1.6 * devicePixelRatio;
      ctx.beginPath();
      s.pts.forEach((p, i) => i ? ctx.lineTo(X(p.x), Y(p.y)) : ctx.moveTo(X(p.x), Y(p.y)));
      ctx.stroke();
    }
    let lx = pad + 6 * devicePixelRatio;
    for (const s of series) {
      ctx.fillStyle = s.color; ctx.fillText(s.label || '', lx, 14 * devicePixelRatio);
      lx += ctx.measureText(s.label || '').width + 18 * devicePixelRatio;
    }
  },
};
