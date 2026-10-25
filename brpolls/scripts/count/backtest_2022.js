// Refaz a apuração de 2022 com o modelo da página: em cada ponto (% de seções recebidas), projeta o final e compara.
// uso: node scripts/count/backtest_2022.js '{"sdState":0.03}' [prior]
const fs = require("fs"), path = require("path");
const M = require("../../count.js");
const dir = path.join(__dirname, "../../data/count/replay2022");
const B = M.prepBaseline(JSON.parse(fs.readFileSync(path.join(dir, "baseline.json"))));
const opts = JSON.parse(process.argv[2] || "{}");
const prior = parseFloat(process.argv[3] || "52.6");
const truth = JSON.parse(fs.readFileSync(path.join(dir, "truth.json")));
const TL = truth.br ? (Array.isArray(truth.br) ? truth.br : null) : null;
const tr = TL ? 100 * TL[1] / (TL[1] + TL[2]) : 50.902;
const files = fs.readdirSync(dir).filter(f => f.startsWith("snap_")).sort((a, b) => parseFloat(a.slice(5).replace("_", ".")) - parseFloat(b.slice(5).replace("_", ".")));
let out = [];
for (const f of files) {
    const s = JSON.parse(fs.readFileSync(path.join(dir, f)));
    const units = B.mun.map(m => { const v = s.units[m.key] || [m.sec, 0, 0, 0]; return Object.assign({}, m, {K: v[0] || m.sec, k: v[1], l: v[2], f: v[3]}); });
    const R = M.project(units, Object.assign({prior, draws: 600}, opts));
    const raw = R.counted.share;
    out.push({pct: s.pct, raw, mean: R.nat.mean, lo: R.nat.p05, hi: R.nat.p95, p: R.nat.pLula, err: R.nat.mean - tr, cover: tr >= R.nat.p05 && tr <= R.nat.p95});
}
console.log("final real", tr.toFixed(3), "prior", prior, JSON.stringify(opts));
for (const o of out) console.log(String(o.pct).padStart(5), "raw", o.raw == null ? "  -  " : o.raw.toFixed(2), "proj", o.mean.toFixed(2), "[" + o.lo.toFixed(2) + "," + o.hi.toFixed(2) + "]", "err", (o.err >= 0 ? "+" : "") + o.err.toFixed(2), o.cover ? "ok " : "OUT", "P(Lula)", o.p.toFixed(3));
