// BRNet - tiny dependency-free MLP (matches the UE brain: 19 -> 64 -> 64 -> N, ReLU hidden).
const BRNet = (() => {
  function make(sizes) {
    const layers = [];
    for (let l = 0; l < sizes.length - 1; l++) {
      const nin = sizes[l], nout = sizes[l + 1];
      const w = new Float32Array(nin * nout), b = new Float32Array(nout);
      for (let i = 0; i < w.length; i++) w[i] = (Math.random() * 2 - 1) * Math.sqrt(2 / nin);
      layers.push({ nin, nout, w, b });
    }
    return wrap({ sizes, layers });
  }
  function wrap(net) {
    net.forward = x => {
      let v = x;
      net.layers.forEach((L, li) => {
        const out = new Float32Array(L.nout);
        for (let o = 0; o < L.nout; o++) {
          let s = L.b[o];
          for (let i = 0; i < L.nin; i++) s += L.w[o * L.nin + i] * v[i];
          out[o] = (li < net.layers.length - 1) ? Math.max(0, s) : s; // ReLU hidden, linear out
        }
        v = out;
      });
      return v;
    };
    net.flat = () => {
      const arr = [net.sizes.length, ...net.sizes];
      for (const L of net.layers) { arr.push(...L.w, ...L.b); }
      return arr;
    };
    return net;
  }
  function fromFlat(arr) {
    const nSizes = arr[0], sizes = arr.slice(1, 1 + nSizes);
    const net = { sizes, layers: [] };
    let p = 1 + nSizes;
    for (let l = 0; l < sizes.length - 1; l++) {
      const nin = sizes[l], nout = sizes[l + 1];
      const w = Float32Array.from(arr.slice(p, p + nin * nout)); p += nin * nout;
      const b = Float32Array.from(arr.slice(p, p + nout)); p += nout;
      net.layers.push({ nin, nout, w, b });
    }
    return wrap(net);
  }
  // Load the UE-exported brain.json ({features, actions, layers:[{w:[[out][in]], b:[]}]}).
  function fromBrainJson(j) {
    const sizes = [j.layers[0].w[0].length];
    for (const L of j.layers) sizes.push(L.w.length);
    const net = { sizes, layers: [] };
    for (const L of j.layers) {
      const nout = L.w.length, nin = L.w[0].length;
      const w = new Float32Array(nin * nout);
      for (let o = 0; o < nout; o++) for (let i = 0; i < nin; i++) w[o * nin + i] = L.w[o][i];
      net.layers.push({ nin, nout, w, b: Float32Array.from(L.b) });
    }
    return wrap(net);
  }
  function mutate(net, sigma = 0.05, resetP = 0.02) {
    const c = fromFlat(net.flat());
    for (const L of c.layers) {
      for (let i = 0; i < L.w.length; i++) {
        if (Math.random() < resetP) L.w[i] = (Math.random() * 2 - 1) * 0.5;
        else L.w[i] += (Math.random() * 2 - 1) * sigma;
      }
      for (let i = 0; i < L.b.length; i++) L.b[i] += (Math.random() * 2 - 1) * sigma * 0.5;
    }
    return c;
  }
  const argmax = v => { let bi = 0; for (let i = 1; i < v.length; i++) if (v[i] > v[bi]) bi = i; return bi; };
  return { make, fromFlat, fromBrainJson, mutate, argmax };
})();
if (typeof module !== 'undefined') module.exports = BRNet;
