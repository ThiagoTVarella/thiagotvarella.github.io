// Ordens de apuração alternativas a partir da apuração de 2022: cada estado segue o cronograma de outro estado
// (permutação), mantendo a progressão real de cada município dentro do estado. Mede erro, cobertura da faixa de 90%
// e largura por faixa de % nacional apurado. Com "live", aplica o andamento por estado de um cache ao vivo de 2026
// aos votos de 2022 (multiplicado por 0,5…4).
// uso: node scripts/count/backtest_paths.js '{opts}' [caminhos=10] [sorteios=400] [perm|live] [cache.json]
const fs = require("fs"), path = require("path");
const M = require("../../count.js");
const opts = JSON.parse(process.argv[2] || "{}");
const NP = parseInt(process.argv[3] || "10"), DR = parseInt(process.argv[4] || "400"), MODE = process.argv[5] || "perm";
const dir = path.join(__dirname, "../../data/count/replay2022");
const B = M.prepBaseline(JSON.parse(fs.readFileSync(path.join(dir, "baseline.json"))));
const TRUTH = 50.902, PRIOR = 52.19;
const files = fs.readdirSync(dir).filter(f => f.startsWith("snap_")).sort((a, b) => parseFloat(a.slice(5).replace("_", ".")) - parseFloat(b.slice(5).replace("_", ".")));
const snaps = files.map(f => JSON.parse(fs.readFileSync(path.join(dir, f))));
const ufs = [...new Set(B.mun.map(m => m.uf))];
const Fst = snaps.map(s => { const o = {}; for (const uf of ufs) { const v = s.states[uf]; o[uf] = v ? v[1] / v[0] : 0; } return o; });
const rand = seed => { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
const nearest = (uf, target) => { let best = 0, bd = 1e9; for (let c = 0; c < snaps.length; c++) { const d = Math.abs(Fst[c][uf] - target); if (d < bd - 1e-12) { bd = d; best = c; } } return best; };
const unitsAt = cOf => B.mun.map(m => { const v = snaps[cOf[m.uf]].units[m.key] || [m.sec, 0, 0, 0]; return Object.assign({}, m, {K: v[0] || m.sec, k: v[1], l: v[2], f: v[3]}); });
const scen = [];
if (MODE === "live") {
    const S = JSON.parse(fs.readFileSync(process.argv[6]));
    const tgt = {}; for (const uf of ufs) { const v = S.stU[uf]; tgt[uf] = v && v.ts ? v.st / v.ts : 0; }
    for (const mult of [0.5, 1, 1.5, 2, 3, 4]) { const cOf = {}; for (const uf of ufs) cOf[uf] = nearest(uf, Math.min(1, tgt[uf] * mult)); scen.push(cOf); }
} else {
    for (let p = 0; p < NP; p++) {
        const r = rand(1000 + p), others = ufs.filter(u => u !== "zz"), perm = others.slice();
        for (let i = perm.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [perm[i], perm[j]] = [perm[j], perm[i]]; }
        const pi = Object.fromEntries(others.map((u, i) => [u, perm[i]])); pi.zz = "zz";
        for (const c of [2, 4, 6, 8, 10, 12, 14, 16, 18]) { const cOf = {}; for (const uf of ufs) cOf[uf] = nearest(uf, Fst[c][pi[uf]]); scen.push(cOf); }
    }
}
const buckets = [[1, 3], [3, 7], [7, 15], [15, 35], [35, 60], [60, 85], [85, 97]];
const res = buckets.map(() => ({n: 0, se: 0, ae: 0, cov: 0, w: 0, bias: 0, max: 0}));
for (const cOf of scen) {
    const units = unitsAt(cOf);
    let st = 0, ts = 0; for (const u of units) { st += u.k; ts += u.K; }
    const pct = 100 * st / ts, R = M.project(units, Object.assign({prior: PRIOR, draws: DR}, opts));
    const err = R.nat.mean - TRUTH, cov = TRUTH >= R.nat.p05 && TRUTH <= R.nat.p95 ? 1 : 0, w = R.nat.p95 - R.nat.p05;
    if (MODE === "live") console.log("  pct", pct.toFixed(1), "err", err.toFixed(2), "faixa", w.toFixed(2), cov ? "ok" : "FORA");
    const b = buckets.findIndex(([lo, hi]) => pct >= lo && pct < hi);
    if (b >= 0) { const q = res[b]; q.n++; q.se += err * err; q.ae += Math.abs(err); q.cov += cov; q.w += w; q.bias += err; q.max = Math.max(q.max, Math.abs(err)); }
}
console.log(JSON.stringify(opts), MODE, "cenários", scen.length);
let tot = {n: 0, se: 0, cov: 0, w: 0};
buckets.forEach(([lo, hi], i) => { const q = res[i]; if (!q.n) return; tot.n += q.n; tot.se += q.se; tot.cov += q.cov; tot.w += q.w;
    console.log(`  ${String(lo).padStart(2)}-${String(hi).padEnd(3)} n ${String(q.n).padStart(3)} viés ${(q.bias / q.n).toFixed(2).padStart(6)} rmse ${Math.sqrt(q.se / q.n).toFixed(2)} máx ${q.max.toFixed(2)} cobre90 ${(q.cov / q.n).toFixed(2)} largura ${(q.w / q.n).toFixed(2)}`); });
console.log(`  todos n ${tot.n} rmse ${Math.sqrt(tot.se / tot.n).toFixed(3)} cobre90 ${(tot.cov / tot.n).toFixed(2)} largura ${(tot.w / tot.n).toFixed(2)}`);
