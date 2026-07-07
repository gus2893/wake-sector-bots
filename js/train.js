// BRWeb in-browser trainer: evolution strategy over the web gym, policy cohort vs scripted.
(() => {
  const SIZES = [19, 64, 64, 13];
  let pop = [], gen = 0, running = false, history = [];
  const runId = 'run_' + Date.now().toString(36);

  const $ = id => document.getElementById(id);
  const log = s => {
    const div = document.createElement('div');
    div.textContent = s;
    $('runLog').prepend(div);
  };

  function loadState() {
    try {
      const best = localStorage.getItem('brweb_best_genome');
      const hist = localStorage.getItem('brweb_history');
      if (hist) history = JSON.parse(hist);
      if (history.length) {
        gen = history[history.length - 1].gen;
        $('stGen').textContent = gen;
        $('stFit').textContent = history[history.length - 1].fitness.toFixed(2);
        $('stWin').textContent = (history[history.length - 1].winShare * 100).toFixed(0) + '%';
        BRData.chart($('chFit'), [{ pts: history.map(h => ({ x: h.gen, y: h.fitness })), color: '#4da3ff', label: 'best fitness' }]);
      }
      for (const h of history.slice(-30)) log(`gen ${h.gen}  fit ${h.fitness.toFixed(2)}  win ${(h.winShare * 100).toFixed(0)}%`);
      return best ? BRNet.fromFlat(JSON.parse(best)) : null;
    } catch { return null; }
  }

  function initPop(size, seedNet) {
    pop = [];
    for (let i = 0; i < size; i++)
      pop.push(seedNet && i > 0 ? BRNet.mutate(seedNet, 0.08) : (seedNet && i === 0 ? seedNet : BRNet.make(SIZES)));
  }

  function evalGenome(net, nRounds, seed) {
    const fn = obs => BRNet.argmax(net.forward(obs));
    const r = BRSim.runRounds(fn, nRounds, seed);
    const winShare = (r.polWins + r.scrWins) > 0 ? r.polWins / (r.polWins + r.scrWins) : 0;
    return { fitness: r.polWins * 10 - r.polDeaths * 1 + r.dmg / 400, winShare };
  }

  async function trainLoop() {
    const nRounds = +$('selRounds').value;
    while (running) {
      gen++;
      const seed = (gen * 7919) & 0xffff;      // same rounds for every genome this generation
      const scored = [];
      for (let i = 0; i < pop.length && running; i++) {
        $('stMsg').textContent = `gen ${gen}: evaluating ${i + 1}/${pop.length}`;
        await new Promise(r => setTimeout(r, 0));       // keep the tab responsive
        scored.push({ net: pop[i], ...evalGenome(pop[i], nRounds, seed) });
      }
      if (!running) break;
      scored.sort((a, b) => b.fitness - a.fitness);
      const best = scored[0];
      history.push({ gen, fitness: best.fitness, winShare: best.winShare, at: Date.now() });
      localStorage.setItem('brweb_best_genome', JSON.stringify(best.net.flat()));
      localStorage.setItem('brweb_history', JSON.stringify(history.slice(-500)));
      $('stGen').textContent = gen;
      $('stFit').textContent = best.fitness.toFixed(2);
      $('stWin').textContent = (best.winShare * 100).toFixed(0) + '%';
      log(`gen ${gen}  fit ${best.fitness.toFixed(2)}  win ${(best.winShare * 100).toFixed(0)}%`);
      BRData.chart($('chFit'), [{ pts: history.map(h => ({ x: h.gen, y: h.fitness })), color: '#4da3ff', label: 'best fitness' }]);
      pushDb({ run_id: runId, gen, fitness: best.fitness, win_share: best.winShare });
      // next generation: elite 25% survive, the rest are mutants of the elite
      const elite = scored.slice(0, Math.max(2, Math.floor(pop.length / 4))).map(s => s.net);
      const next = [...elite];
      while (next.length < pop.length)
        next.push(BRNet.mutate(elite[Math.floor(Math.random() * elite.length)], 0.05));
      pop = next;
    }
    $('stMsg').textContent = 'stopped';
  }

  async function pushDb(row) {
    const url = localStorage.getItem('brweb_db_url'), key = localStorage.getItem('brweb_db_key');
    if (!url) return;
    try {
      await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: key || '', Authorization: 'Bearer ' + (key || '') },
        body: JSON.stringify(row),
      });
      $('dbMsg').textContent = 'pushed gen ' + row.gen;
    } catch (e) { $('dbMsg').textContent = 'push failed: ' + e.message; }
  }

  $('btnStart').onclick = () => {
    if (running) return;
    running = true;
    const seedNet = loadState();
    initPop(+$('selPop').value, seedNet);
    $('stMsg').textContent = seedNet ? 'resuming from saved best' : 'fresh population';
    trainLoop();
  };
  $('btnStop').onclick = () => { running = false; };
  $('btnExport').onclick = () => {
    const best = localStorage.getItem('brweb_best_genome');
    if (!best) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([best], { type: 'application/json' }));
    a.download = 'br_policy_gen' + gen + '.json';
    a.click();
  };
  $('fileImport').onchange = async e => {
    const f = e.target.files[0];
    if (!f) return;
    localStorage.setItem('brweb_best_genome', await f.text());
    $('stMsg').textContent = 'imported ' + f.name + ' as the seed';
  };
  $('btnDbSave').onclick = () => {
    localStorage.setItem('brweb_db_url', $('dbUrl').value.trim());
    localStorage.setItem('brweb_db_key', $('dbKey').value.trim());
    $('dbMsg').textContent = 'saved';
  };
  $('dbUrl').value = localStorage.getItem('brweb_db_url') || '';
  $('dbKey').value = localStorage.getItem('brweb_db_key') || '';
  loadState();
})();
