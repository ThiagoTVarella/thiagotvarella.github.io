// Uma rodada de leitura do boletim do TSE + projeção, para guardar o histórico da apuração no repositório.
// uso: node scripts/count/live.js <arquivo-de-cache.json>
const fs = require("fs"), path = require("path");
const M = require("../../count.js");
const ROOT = path.join(__dirname, "../..");
const BASE = "https://resultados.tse.jus.br/oficial/ele2026/6258/dados/";
const CACHE = process.argv[2] || path.join(ROOT, "data/count/.live_cache.json");
const HIST = path.join(ROOT, "data/count/live_history.json"), LATEST = path.join(ROOT, "data/count/live_latest.json");
const BUDGET_MS = 150000, CONC = 3;
const wait = ms => new Promise(r => setTimeout(r, ms));
const num = s => typeof s === "number" ? s : parseFloat(String(s || "0").replace(",", ".")) || 0;
async function getJ(u, tries = 4) {
    for (let i = 0; i <= tries; i++) {
        try { const r = await fetch(u, {cache: "no-store"}); if (r.ok) return await r.json(); if (r.status !== 429 && r.status < 500) throw new Error("HTTP " + r.status); }
        catch (e) { if (i === tries) throw e; }
        await wait(1000 * 2 ** i + 500 * Math.random());
    }
    throw new Error("429");
}
function votes(u) {
    const r = {ts: num(u.s && u.s.ts), st: num(u.s && u.s.st), l: 0, f: 0};
    for (const ag of (u.carg && u.carg[0] && u.carg[0].agr) || []) for (const p of ag.par || []) for (const c of p.cand || []) {
        if (c.n === "13") r.l = num(c.vap); else if (c.n === "22") r.f = num(c.vap);
    }
    return r;
}
(async () => {
    const t0 = Date.now();
    const BL = M.prepBaseline(JSON.parse(fs.readFileSync(path.join(ROOT, "data/count/baseline_2026.json"))));
    const S = fs.existsSync(CACHE) ? JSON.parse(fs.readFileSync(CACHE)) : {munAb: {}, mun: {}, stU: {}, stKey: {}};
    const br = await getJ(BASE + "br/br-c0001-e006258-u.json"), ab = await getJ(BASE + "br/br-e006258-ab.json");
    const brV = votes(br), hg = br.dg + " " + br.hg;
    const changed = ab.abr.filter(r => r.cdabr !== "br").map(r => [r.cdabr.toLowerCase(), r.dt + r.ht + r.s.st]).filter(([uf, k]) => S.stKey[uf] !== k);
    for (const [uf, k] of changed) {
        try {
            const j = await getJ(BASE + uf + "/" + uf + "-e006258-ab.json");
            for (const r of j.abr) if (r.cdabr.length === 5) S.munAb[uf + r.cdabr] = {ts: num(r.s.ts), st: num(r.s.st)};
            S.stU[uf] = votes(await getJ(BASE + uf + "/" + uf + "-c0001-e006258-u.json"));
            S.stKey[uf] = k;
        } catch (e) { console.error("estado", uf, e.message); }
    }
    const queue = BL.mun.filter(m => { const a = S.munAb[m.key]; if (!a || !a.st) return false; const h = S.mun[m.key]; return !h || h.st !== a.st; }).sort((a, b) => b.v1 - a.v1);
    let i = 0, got = 0, fail = 0;
    await Promise.all(Array.from({length: CONC}, async () => {
        while (i < queue.length && Date.now() - t0 < BUDGET_MS) {
            const m = queue[i++];
            try { S.mun[m.key] = votes(await getJ(BASE + m.uf + "/" + m.key + "-c0001-e006258-u.json", 2)); got++; } catch (e) { fail++; }
            await wait(120);
        }
    }));
    fs.writeFileSync(CACHE, JSON.stringify(S));
    const fc = JSON.parse(fs.readFileSync(path.join(ROOT, "data/forecast.json")));
    const R = M.project(M.buildUnits(BL, S), {prior: fc.poll_average_lula, draws: 1500});
    const pct = brV.ts ? 100 * brV.st / brV.ts : 0, raw = brV.l + brV.f ? 100 * brV.l / (brV.l + brV.f) : null;
    const r2 = x => x == null ? null : Math.round(x * 100) / 100;
    const pt = {t: hg, pct: r2(pct), raw: r2(raw), mean: r2(R.nat.mean), lo: r2(R.nat.p05), hi: r2(R.nat.p95), p: Math.round(R.nat.pLula * 1000) / 1000,
        shift: r2(R.shift), exp: r2(R.counted.expected), need: r2(R.needLula), rem: Math.round(R.remaining), read: got, pending: queue.length - got};
    const hist = fs.existsSync(HIST) ? JSON.parse(fs.readFileSync(HIST)) : [];
    if (hist.length && hist[hist.length - 1].t === pt.t) hist.pop();
    hist.push(pt);
    fs.writeFileSync(HIST, JSON.stringify(hist));
    // trajetória prevista da contagem: sem saber a ordem, o que falta entra misturado na proporção em que vai terminar
    const units = M.buildUnits(BL, S), R2 = M.project(units, {prior: fc.poll_average_lula, draws: 400});
    let Lc = 0, Fc = 0, Lr = 0, Nr = 0;
    units.forEach((u, i) => {
        const rem = R2.rem[i], nv = u.l + u.f, sh = R2.unitMean[i];
        const remShare = rem > 0 ? Math.min(1, Math.max(0, (sh * (nv + rem) - u.l) / rem)) : 0;
        Lc += u.l; Fc += u.f; Lr += rem * remShare; Nr += rem;
    });
    const traj = [];
    for (let j = 1; j <= 20; j++) { const a = j / 20; traj.push([r2(pct + a * (100 - pct)), r2(100 * (Lc + a * Lr) / (Lc + Fc + a * Nr))]); }
    const states = {};
    for (const [uf, s] of Object.entries(R.states)) states[uf] = {l: s.l, f: s.f, exp: r2(s.l + s.f ? 100 * s.exp / (s.l + s.f) : null), mean: r2(s.mean), lo: r2(s.p05), hi: r2(s.p95), k: s.k, K: s.K};
    fs.writeFileSync(LATEST, JSON.stringify({point: pt, states, traj, generated: new Date().toISOString()}));
    console.log(JSON.stringify(pt), "fail", fail, "secs", ((Date.now() - t0) / 1000).toFixed(0));
})().catch(e => { console.error("falhou:", e.message); process.exit(1); });
