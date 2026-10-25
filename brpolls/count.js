/* Apuração ao vivo. Lê o boletim do TSE por estado e por município, compara o que já foi apurado em cada lugar com o que
   se esperava daquele lugar (1º turno + média das pesquisas) e projeta o resultado final.

   Modelo, na escala logit da fatia do Lula entre os dois:
     fatia final do município i  θ_i = x_i + X_i·β + γ_uf + ε_i
       x_i   ponto de partida: fatia do Lula entre Lula e Flávio no 1º turno naquele município
       β     deslocamento nacional (β0, ajustado para a média das pesquisas) e, opcionalmente, efeitos por tipo de município
       γ_uf  deslocamento próprio de cada estado
       ε_i   o que sobra de cada município
     contagem parcial: z_i ~ N(θ_i, τ_i²/k·(1−k/K) + ordem²·(1−k/K) + binomial), com k de K seções apuradas
   Tudo é normal, então a posteriori sai em fórmula fechada e a projeção sai de sorteios. */
(function (root) {
    "use strict";
    const DEF = {
        prior: 49.20,       // média das pesquisas (fatia do Lula entre os dois, %)
        priorSd: 1.9,       // erro típico dessa média, em pontos
        sdState: 0.03,      // desvio dos deslocamentos estaduais (logit); 2022: 0,023
        sdAbroad: 0.25,     // exterior
        eps0: 0.028,        // resíduo municipal: sqrt(eps0² + eps1²·1000/votos), ajustado em 2022
        eps1: 0.071,
        tauDefault: 0.25,   // heterogeneidade entre seções quando não sei
        orderSd: 0.15,      // seções apuradas primeiro não são típicas do município (2022: puxam para o Bolsonaro)
        sdCov: 0,           // prior dos efeitos por tipo de município (0 = desligado)
        sdRemain: 0.07,     // choque comum no que falta apurar: o resto do país pode votar diferente do que já veio
        sdRemainState: 0.04,// idem, por estado
        rho0: 0.97,         // votos em Lula+Flávio no 2º turno ÷ votos válidos no 1º
        draws: 1000,
        seed: 20261025
    };
    const lg = p => Math.log(p / (1 - p)), il = x => 1 / (1 + Math.exp(-x));

    function rng(seed) {
        let a = seed >>> 0;
        const u = () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1);
            t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
        let spare = null;
        u.normal = () => {
            if (spare !== null) { const s = spare; spare = null; return s; }
            let x, y, r; do { x = 2 * u() - 1; y = 2 * u() - 1; r = x * x + y * y; } while (!r || r >= 1);
            const f = Math.sqrt(-2 * Math.log(r) / r); spare = y * f; return x * f;
        };
        return u;
    }

    /* baseline JSON → lista de municípios com o ponto de partida */
    function prepBaseline(json) {
        const c = json.cols, ix = n => c.indexOf(n);
        const I = {uf: ix("uf"), cd: ix("cd"), nm: ix("nm"), sec: ix("sec"), v1: ix("v1"), l1: ix("l1"), f1: ix("f1"), o1: ix("o1"), sd: ix("sd")};
        let L = 0, F = 0, V = 0, O = 0;
        for (const r of json.mun) { L += r[I.l1]; F += r[I.f1]; V += r[I.v1]; O += r[I.o1]; }
        const s1 = L / (L + F), o1 = O / V;
        const mun = json.mun.map(r => {
            const l1 = r[I.l1], f1 = r[I.f1], v1 = Math.max(r[I.v1], 1);
            return {key: r[I.uf] + r[I.cd], uf: r[I.uf], cd: r[I.cd], nm: r[I.nm], sec: Math.max(r[I.sec], 1), v1, l1, f1,
                x: lg((l1 + 4 * s1) / (l1 + f1 + 4)), oth: r[I.o1] / v1 - o1, lsize: Math.log10(v1) - 4, sd: r[I.sd]};
        });
        return {mun, s1, o1, byKey: Object.fromEntries(mun.map(m => [m.key, m]))};
    }

    /* Cholesky de uma matriz pequena (p×p, array de arrays); devolve L com A = L·Lᵀ */
    function chol(A) {
        const p = A.length, L = A.map(() => new Array(p).fill(0));
        for (let i = 0; i < p; i++) for (let j = 0; j <= i; j++) {
            let s = A[i][j]; for (let k = 0; k < j; k++) s -= L[i][k] * L[j][k];
            L[i][j] = i === j ? Math.sqrt(Math.max(s, 1e-12)) : s / L[j][j];
        }
        return L;
    }
    function cholSolve(L, b) {   // resolve L·Lᵀ·x = b
        const p = L.length, y = new Array(p), x = new Array(p);
        for (let i = 0; i < p; i++) { let s = b[i]; for (let k = 0; k < i; k++) s -= L[i][k] * y[k]; y[i] = s / L[i][i]; }
        for (let i = p - 1; i >= 0; i--) { let s = y[i]; for (let k = i + 1; k < p; k++) s -= L[k][i] * x[k]; x[i] = s / L[i][i]; }
        return x;
    }
    function cholInvT(L, z) {   // x = L⁻ᵀ z, para sortear de N(0, (L·Lᵀ)⁻¹)
        const p = L.length, x = new Array(p);
        for (let i = p - 1; i >= 0; i--) { let s = z[i]; for (let k = i + 1; k < p; k++) s -= L[k][i] * x[k]; x[i] = s / L[i][i]; }
        return x;
    }

    /* units: [{x, v1, sec, sd, oth, lsize, uf, K, k, l, f}] — K/k seções totais/apuradas, l/f votos apurados.
       Unidades agrupadas (vários municípios de uma vez) funcionam igual, com sd maior. */
    function project(units, o) {
        o = Object.assign({}, DEF, o || {});
        const n = units.length, P = o.sdCov > 0 ? 3 : 1;
        const feat = u => P === 1 ? [1] : [1, u.oth, u.lsize];
        const sdE = u => Math.sqrt(o.eps0 * o.eps0 + o.eps1 * o.eps1 * 1000 / Math.max(u.v1 * o.rho0, 50));
        const sdG = uf => uf === "zz" ? o.sdAbroad : o.sdState;

        // deslocamento nacional a priori: aquele que leva o total esperado à média das pesquisas
        const target = o.prior / 100;
        let lo = -2, hi = 2;
        for (let it = 0; it < 60; it++) {
            const mid = (lo + hi) / 2; let a = 0, b = 0;
            for (const u of units) { a += u.v1 * il(u.x + mid); b += u.v1; }
            if (a / b > target) hi = mid; else lo = mid;
        }
        const d0 = (lo + hi) / 2, sdD = o.priorSd / 100 / (target * (1 - target));

        // comparecimento: votos em Lula+Flávio por voto válido do 1º turno, por estado, encolhido para o nacional
        const T = {};
        for (const u of units) {
            const t = T[u.uf] || (T[u.uf] = {A: 0, B: 0, W: 0, R: 0, S: new Array(P).fill(0), obs: []});
            if (u.k > 0 && u.l + u.f > 0) { t.A += u.l + u.f; t.B += u.v1 * u.k / u.K; }
        }
        let A = 0, B = 0; for (const uf in T) { A += T[uf].A; B += T[uf].B; }
        const rhoN = (A + 2e5 * o.rho0) / (B + 2e5);
        for (const uf in T) T[uf].rho = (T[uf].A + 5e4 * rhoN) / (T[uf].B + 5e4);

        // observações
        const obs = [];
        for (let i = 0; i < n; i++) {
            const u = units[i], nv = u.l + u.f;
            if (!(u.k > 0 && nv > 0)) continue;
            const p = (u.l + 0.5) / (nv + 1), z = lg(p), rest = Math.max(0, 1 - u.k / u.K);
            const tau = u.sd != null ? Math.max(u.sd, 0.05) : o.tauDefault;
            const w = Math.max(tau * tau / u.k * rest + o.orderSd * o.orderSd * rest + 1 / (nv * p * (1 - p)) * rest, 1e-9);
            const e = sdE(u), v = e * e + w, X = feat(u), r = z - u.x;
            const t = T[u.uf]; t.W += 1 / v; t.R += r / v; for (let j = 0; j < P; j++) t.S[j] += X[j] / v;
            obs.push({i, z, w, r, X, e}); t.obs.push(obs.length - 1);
        }

        // posteriori de β, integrando γ_uf: precisão = prior + Σ_uf (Σ X Xᵀ/v − S Sᵀ/(1/σγ² + W))
        const prec = Array.from({length: P}, (_, a) => Array.from({length: P}, (_, b) => a === b ? (a === 0 ? 1 / (sdD * sdD) : 1 / (o.sdCov * o.sdCov)) : 0));
        const rhs = new Array(P).fill(0); rhs[0] = d0 / (sdD * sdD);
        for (const ob of obs) { const v = ob.e * ob.e + ob.w; for (let a = 0; a < P; a++) { rhs[a] += ob.X[a] * ob.r / v; for (let b = 0; b < P; b++) prec[a][b] += ob.X[a] * ob.X[b] / v; } }
        for (const uf in T) {
            const t = T[uf]; if (!t.obs.length) continue;
            const g = 1 / (sdG(uf) ** 2) + t.W;
            for (let a = 0; a < P; a++) { rhs[a] -= t.S[a] * t.R / g; for (let b = 0; b < P; b++) prec[a][b] -= t.S[a] * t.S[b] / g; }
        }
        const Lc = chol(prec), mB = cholSolve(Lc, rhs);

        // sorteios
        const rand = rng(o.seed), D = o.draws, ufs = Object.keys(T), ufIx = Object.fromEntries(ufs.map((u, j) => [u, j]));
        const natL = new Float64Array(D), natF = new Float64Array(D), stL = ufs.map(() => new Float64Array(D)), stF = ufs.map(() => new Float64Array(D));
        const unitMean = new Float64Array(n);   // fatia final esperada por unidade (média dos sorteios)
        const obsOf = new Int32Array(n).fill(-1); obs.forEach((ob, j) => { obsOf[ob.i] = j; });
        const remOf = units.map(u => (T[u.uf].rho) * u.v1 * Math.max(0, 1 - u.k / u.K));
        const featOf = units.map(feat), sdEOf = units.map(sdE);
        for (let d = 0; d < D; d++) {
            const zz = new Array(P); for (let a = 0; a < P; a++) zz[a] = rand.normal();
            const dz = cholInvT(Lc, zz), beta = mB.map((m, a) => m + dz[a]);
            const gam = new Float64Array(ufs.length);
            for (let j = 0; j < ufs.length; j++) {
                const t = T[ufs[j]], g = 1 / (sdG(ufs[j]) ** 2) + t.W;
                let m = t.R; for (let a = 0; a < P; a++) m -= t.S[a] * beta[a];
                gam[j] = m / g + rand.normal() / Math.sqrt(g);
            }
            const shockN = o.sdRemain * rand.normal(), shockS = ufs.map(() => o.sdRemainState * rand.normal());
            let L = 0, F = 0;
            for (let i = 0; i < n; i++) {
                const u = units[i], X = featOf[i], j = ufIx[u.uf];
                let mu = u.x + gam[j]; for (let a = 0; a < P; a++) mu += X[a] * beta[a];
                const e = sdEOf[i], k = obsOf[i];
                let th;
                if (k >= 0) {
                    const ob = obs[k], pr = 1 / (e * e) + 1 / ob.w;
                    th = mu + ((ob.z - mu) / ob.w) / pr + rand.normal() / Math.sqrt(pr);
                } else th = mu + e * rand.normal();
                const rem = remOf[i], nv = u.l + u.f;
                if (rem > 0) th += (shockN + shockS[j]) * rem / (rem + nv);
                const s = il(th);
                // fatia final s ⇒ votos do Lula no que falta = s·(apurado + resto) − já apurado, limitado ao possível
                let lr = Math.min(rem, Math.max(0, s * (nv + rem) - u.l));
                if (k < 0) lr = s * rem;
                L += u.l + lr; F += u.f + rem - lr;
                stL[j][d] += u.l + lr; stF[j][d] += u.f + rem - lr;
                unitMean[i] += s / D;
            }
            natL[d] = L; natF[d] = F;
        }
        const summ = (Lv, Fv) => {
            const sh = Array.from(Lv, (l, d) => 100 * l / (l + Fv[d])).sort((a, b) => a - b);
            const q = p => sh[Math.min(D - 1, Math.max(0, Math.round(p * (D - 1))))];
            const mean = sh.reduce((a, b) => a + b, 0) / D;
            return {mean, p05: q(.05), p10: q(.10), p25: q(.25), p50: q(.5), p75: q(.75), p90: q(.90), p95: q(.95),
                pLula: sh.filter(x => x > 50).length / D, votes: (Lv.reduce((a, b) => a + b, 0) + Fv.reduce((a, b) => a + b, 0)) / D};
        };

        // apurado, esperado para o apurado (antes de olhar os votos) e o que falta
        let cl = 0, cf = 0, exp = 0, rem = 0;
        const states = {};
        units.forEach((u, i) => {
            const s = states[u.uf] || (states[u.uf] = {l: 0, f: 0, exp: 0, K: 0, k: 0, rem: 0, v1: 0});
            const nv = u.l + u.f, e0 = il(u.x + d0);
            cl += u.l; cf += u.f; exp += nv * e0; rem += remOf[i];
            s.l += u.l; s.f += u.f; s.exp += nv * e0; s.K += u.K; s.k += u.k; s.rem += remOf[i]; s.v1 += u.v1;
        });
        for (const uf of ufs) Object.assign(states[uf], summ(stL[ufIx[uf]], stF[ufIx[uf]]), {gamma: T[uf].obs.length ? (T[uf].R - T[uf].S[0] * mB[0]) / (1 / (sdG(uf) ** 2) + T[uf].W) : 0});
        const nat = summ(natL, natF);
        const total = cl + cf + rem;
        return {
            nat, states, d0, beta: mB, rhoN,
            counted: {l: cl, f: cf, share: cl + cf ? 100 * cl / (cl + cf) : null, expected: cl + cf ? 100 * exp / (cl + cf) : null},
            remaining: rem, totalExpected: total,
            needLula: rem > 0 ? 100 * (total / 2 - cl) / rem : null,   // % do que falta que o Lula precisa
            shift: 100 * (il(lg(target) + (mB[0] - d0)) - target),       // deslocamento nacional em pontos, além das pesquisas
            unitMean
        };
    }

    const api = {DEF, prepBaseline, project, lg, il, rng};
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    else root.CountModel = api;
})(typeof window !== "undefined" ? window : this);

/* ---------- página: lê o boletim do TSE e desenha a aba de apuração */
(function () {
    "use strict";
    if (typeof document === "undefined" || !document.getElementById("tabCount")) return;
    const M = window.CountModel;
    const BASE = "https://resultados.tse.jus.br/oficial/ele2026/6258/dados/";
    const UFS = ["ac", "al", "am", "ap", "ba", "ce", "df", "es", "go", "ma", "mg", "ms", "mt", "pa", "pb", "pe", "pi", "pr", "rj", "rn", "ro", "rr", "rs", "sc", "se", "sp", "to", "zz"];
    const BUDGET = 700, CONC = 5, HKEY = "apuracao2026-hist";
    const $ = id => document.getElementById(id);
    const fmt = (x, d = 2) => (x == null || isNaN(x)) ? "–" : x.toFixed(d).replace(".", ",");
    const sign = (x, d = 2) => (x == null || isNaN(x)) ? "–" : (x > 0 ? "+" : x < 0 ? "−" : "") + fmt(Math.abs(x), d);
    const mi = x => (x / 1e6).toFixed(1).replace(".", ",") + " mi";
    const num = s => typeof s === "number" ? s : parseFloat(String(s || "0").replace(",", ".")) || 0;
    let BL = null, prior = null, busy = false, timer = null, started = false;
    const S = {br: null, ab: {}, stU: {}, munAb: {}, mun: {}, lastStHt: {}, hg: null, fetched: 0, errors: 0};

    const wait = ms => new Promise(r => setTimeout(r, ms));
    const getJ = (u, tries = 2) => fetch(u, {cache: "no-store"}).then(r => {
        if (r.status === 429 && tries > 0) return wait(1500 + 1500 * Math.random()).then(() => getJ(u, tries - 1));
        if (!r.ok) throw new Error(r.status); return r.json(); });
    async function pool(tasks, n) {
        let i = 0; const out = [];
        await Promise.all(Array.from({length: n}, async () => { while (i < tasks.length) { const j = i++; try { out[j] = await tasks[j](); } catch (e) { out[j] = null; S.errors++; } } }));
        return out;
    }
    function votes(u) {   // arquivo -u.json → {ts, st, l, f}
        const r = {ts: num(u.s && u.s.ts), st: num(u.s && u.s.st), l: 0, f: 0, hg: u.hg, dg: u.dg, ht: u.ht};
        for (const ag of (u.carg && u.carg[0] && u.carg[0].agr) || []) for (const p of ag.par || []) for (const c of p.cand || []) {
            if (c.n === "13") r.l = num(c.vap); else if (c.n === "22") r.f = num(c.vap);
        }
        return r;
    }

    async function cycle() {
        if (busy) return; busy = true; S.errors = 0;
        $("cFetch").textContent = "lendo o TSE…";
        try {
            const [br, ab] = await Promise.all([getJ(BASE + "br/br-c0001-e006258-u.json"), getJ(BASE + "br/br-e006258-ab.json")]);
            S.br = votes(br); S.hg = br.dg + " " + br.hg;
            const changed = [];
            for (const r of ab.abr) if (r.cdabr !== "br") {
                const uf = r.cdabr.toLowerCase(), key = r.dt + r.ht + r.s.st;
                if (S.lastStHt[uf] !== key) changed.push(uf);
                S.ab[uf] = r; S.lastStHt[uf] = key;
            }
            // estados que mudaram: progresso por município e totais do estado
            const res = await pool(changed.flatMap(uf => [
                () => getJ(BASE + uf + "/" + uf + "-e006258-ab.json").then(j => { for (const r of j.abr) if (r.tpabr === "mun" || r.cdabr.length === 5) S.munAb[uf + r.cdabr] = {ts: num(r.s.ts), st: num(r.s.st)}; }),
                () => getJ(BASE + uf + "/" + uf + "-c0001-e006258-u.json").then(j => { S.stU[uf] = votes(j); })
            ]), CONC);
            // municípios cujo progresso mudou desde a última leitura, maiores primeiro
            const queue = [];
            for (const m of BL.mun) {
                const a = S.munAb[m.key]; if (!a || a.st === 0) continue;
                const have = S.mun[m.key];
                if (!have || have.st !== a.st) queue.push(m);
            }
            queue.sort((a, b) => b.v1 - a.v1);
            const take = queue.slice(0, BUDGET);
            await pool(take.map(m => () => getJ(BASE + m.uf + "/" + m.key + "-c0001-e006258-u.json").then(j => { S.mun[m.key] = votes(j); })), CONC);
            S.fetched = take.length; S.pending = queue.length - take.length;
            run();
        } catch (e) {
            $("cFetch").textContent = "Não consegui ler o TSE agora (" + e.message + "). Tento de novo em um minuto.";
        }
        busy = false;
    }

    /* junta o que se sabe em unidades para o modelo: municípios lidos + um bloco por estado com os que mudaram e ainda não li */
    function buildUnits() {
        const units = [], poolBy = {};
        for (const m of BL.mun) {
            const a = S.munAb[m.key], have = S.mun[m.key];
            const K = a ? a.ts || m.sec : m.sec;
            if (have && (!a || have.st >= a.st)) { units.push(Object.assign({}, m, {K: have.ts || K, k: have.st, l: have.l, f: have.f})); continue; }
            if (!a || a.st === 0) { units.push(Object.assign({}, m, {K, k: 0, l: 0, f: 0})); continue; }
            (poolBy[m.uf] || (poolBy[m.uf] = [])).push({m, a, have});
        }
        for (const uf in poolBy) {
            const mem = poolBy[uf], st = S.stU[uf];
            let l = 0, f = 0;
            if (st) {   // votos do bloco = total do estado − municípios que entraram sozinhos
                l = st.l; f = st.f;
                for (const u of units) if (u.uf === uf) { l -= u.l; f -= u.f; }
            } else for (const p of mem) if (p.have) { l += p.have.l; f += p.have.f; }
            l = Math.max(0, l); f = Math.max(0, f);
            let L1 = 0, F1 = 0, V = 0, K = 0, k = 0, sec = 0, oth = 0, ls = 0;
            for (const p of mem) { L1 += p.m.l1; F1 += p.m.f1; V += p.m.v1; K += p.a.ts || p.m.sec; k += p.a.st; sec += p.m.sec; oth += p.m.oth * p.m.v1; ls += p.m.lsize * p.m.v1; }
            const x = M.lg((L1 + 1) / (L1 + F1 + 2));
            let between = 0; for (const p of mem) between += p.m.v1 * (p.m.x - x) ** 2;
            between = Math.sqrt(between / V);
            const tau = Math.sqrt(between * between * sec / mem.length + 0.09);
            units.push({key: uf + "_bloco", uf, nm: "bloco", x, v1: V, sec, K, k, l, f, sd: tau, oth: oth / V, lsize: ls / V, pooled: mem.length});
        }
        return units;
    }

    function run() {
        const units = buildUnits();
        const R = M.project(units, {prior: prior, draws: 600});
        const st = S.br, pst = st.ts ? 100 * st.st / st.ts : 0;
        render(R, pst);
        if (st.st > 0) saveHist({t: S.hg, pct: pst, mean: R.nat.mean, lo: R.nat.p05, hi: R.nat.p95, p: R.nat.pLula, raw: R.counted.share});
        drawChart();
    }

    function render(R, pst) {
        const n = R.nat, c = R.counted;
        $("cStatus").innerHTML = `Boletim do TSE de <b>${S.hg || "–"}</b> (horário de Brasília): <b>${fmt(pst)}%</b> das seções apuradas. ` +
            (S.br.st ? `Na contagem bruta: Lula ${fmt(c.share)}%, Flávio ${fmt(100 - c.share)}%.` : "A apuração ainda não começou; abaixo está só o ponto de partida.");
        $("cLula").textContent = "Lula " + fmt(n.mean) + "%";
        $("cFlavio").textContent = "Flávio " + fmt(100 - n.mean) + "%";
        $("cRange").textContent = `Em 90% dos cenários, o Lula termina entre ${fmt(n.p05)}% e ${fmt(n.p95)}%.`;
        const pl = 100 * n.pLula;
        $("cPL").textContent = "Lula " + fmt(pl, 1) + "%"; $("cPF").textContent = "Flávio " + fmt(100 - pl, 1) + "%";
        $("cBar").innerHTML = `<div style="width:${pl}%;background:#c0392b">${pl >= 12 ? fmt(pl, 0) + "%" : ""}</div><div style="width:${100 - pl}%;background:#1f5fa8">${pl <= 88 ? fmt(100 - pl, 0) + "%" : ""}</div>`;
        let ex = "";
        if (c.share != null) {
            const d = c.share - c.expected;
            ex += `<p>Nos municípios já apurados eu esperava o Lula com ${fmt(c.expected)}%; ele tem ${fmt(c.share)}% (${sign(d)} ponto${Math.abs(d) >= 1.995 ? "s" : ""}). `;
            ex += `Faltam cerca de ${mi(R.remaining)} de votos válidos. Para passar de 50%, o Lula precisa de ${fmt(R.needLula, 1)}% deles.</p>`;
        }
        ex += `<p class="sub">Antes de qualquer voto, a projeção parte da média das pesquisas (${fmt(prior)}%). Até agora o modelo deslocou o país ${sign(R.shift)} ponto em relação a ela. + = a favor do Lula.</p>`;
        $("cExplain").innerHTML = ex;
        $("cFetch").textContent = `Li ${S.fetched} municípios nesta rodada` + (S.pending ? `; ${S.pending} ainda na fila (entram como bloco por estado)` : "") + (S.errors ? `; ${S.errors} leituras falharam` : "") + ".";
        // tabela por estado
        const rows = Object.entries(R.states).filter(([uf]) => S.ab[uf]).map(([uf, s]) => {
            const a = S.ab[uf], p = num(a.s.st) / Math.max(1, num(a.s.ts)) * 100, sh = s.l + s.f ? 100 * s.l / (s.l + s.f) : null,
                ex = s.l + s.f ? 100 * s.exp / (s.l + s.f) : null;
            return {uf, p, sh, ex, d: sh != null ? sh - ex : null, s};
        }).sort((a, b) => b.s.v1 - a.s.v1);
        let t = `<tr><th>Estado</th><th>Apurado</th><th>Lula no apurado</th><th>Esperado</th><th>Diferença</th><th>Projeção do Lula</th><th>Faixa de 90%</th></tr>`;
        for (const r of rows) t += `<tr><td>${r.uf === "zz" ? "Exterior" : r.uf.toUpperCase()}</td><td>${fmt(r.p, 1)}%</td><td>${r.sh == null ? "–" : fmt(r.sh) + "%"}</td><td>${r.ex == null ? "–" : fmt(r.ex) + "%"}</td>` +
            `<td class="${r.d > 0 ? "pos" : r.d < 0 ? "neg" : ""}">${sign(r.d)}</td><td>${fmt(r.s.mean)}%</td><td>${fmt(r.s.p05)}–${fmt(r.s.p95)}</td></tr>`;
        $("cTbl").innerHTML = t;
    }

    function loadHist() { try { return JSON.parse(localStorage.getItem(HKEY)) || []; } catch (e) { return []; } }
    function saveHist(pt) {
        const h = loadHist(); if (h.length && h[h.length - 1].t === pt.t) h.pop(); h.push(pt);
        try { localStorage.setItem(HKEY, JSON.stringify(h.slice(-400))); } catch (e) {}
    }
    function drawChart() {
        const h = loadHist(), box = $("cChart"), W = Math.max(300, box.clientWidth || 600), H = 220, m = {l: 40, r: 10, t: 10, b: 26};
        if (h.length < 1) { box.innerHTML = `<p class="sub">O gráfico aparece quando a apuração andar.</p>`; return; }
        const vals = h.flatMap(p => [p.lo, p.hi, p.raw].filter(v => v != null)).concat([50]);
        const y0 = Math.floor(Math.min(...vals) - 0.5), y1 = Math.ceil(Math.max(...vals) + 0.5);
        const X = p => m.l + (W - m.l - m.r) * p / 100, Y = v => m.t + (H - m.t - m.b) * (y1 - v) / (y1 - y0);
        let s = `<svg viewBox="0 0 ${W} ${H}" height="${H}">`;
        for (let v = y0; v <= y1; v += (y1 - y0 > 8 ? 2 : 1)) s += `<line x1="${m.l}" x2="${W - m.r}" y1="${Y(v)}" y2="${Y(v)}" stroke="${v === 50 ? "#999" : "#eee"}"/><text x="${m.l - 4}" y="${Y(v) + 4}" font-size="10" text-anchor="end" fill="#777">${v}</text>`;
        for (const p of [0, 25, 50, 75, 100]) s += `<text x="${X(p)}" y="${H - 8}" font-size="10" text-anchor="middle" fill="#777">${p}%</text>`;
        const band = h.map(p => `${X(p.pct)},${Y(p.hi)}`).join(" ") + " " + h.slice().reverse().map(p => `${X(p.pct)},${Y(p.lo)}`).join(" ");
        s += `<polygon points="${band}" fill="#c0392b" opacity=".15"/>`;
        s += `<polyline points="${h.map(p => `${X(p.pct)},${Y(p.mean)}`).join(" ")}" fill="none" stroke="#c0392b" stroke-width="2"/>`;
        s += `<polyline points="${h.filter(p => p.raw != null).map(p => `${X(p.pct)},${Y(p.raw)}`).join(" ")}" fill="none" stroke="#555" stroke-dasharray="4 3"/>`;
        for (const p of h) s += `<circle cx="${X(p.pct)}" cy="${Y(p.mean)}" r="2.5" fill="#c0392b"><title>${p.t}: ${fmt(p.pct)}% apurado, projeção ${fmt(p.mean)}% (${fmt(p.lo)}–${fmt(p.hi)}), bruto ${fmt(p.raw)}%</title></circle>`;
        s += `<text x="${W - m.r}" y="${Y(50) - 4}" font-size="10" text-anchor="end" fill="#777">50%</text></svg>`;
        box.innerHTML = s;
    }

    async function start() {
        if (started) return; started = true;
        try {
            const [bl, fc] = await Promise.all([getJ("data/count/baseline_2026.json"), getJ("data/forecast.json").catch(() => null)]);
            BL = M.prepBaseline(bl); prior = fc && fc.poll_average_lula ? fc.poll_average_lula : M.DEF.prior;
        } catch (e) { $("cStatus").textContent = "Não consegui carregar a base do 1º turno: " + e.message; return; }
        drawChart();
        await cycle();
        timer = setInterval(() => { if ($("cAuto").checked && !document.hidden && !$("tabCount").hidden) cycle(); }, 60000);
    }
    function show(tab) {
        $("tabCount").hidden = tab !== "count"; $("tabPolls").hidden = tab === "count";
        document.querySelectorAll("[data-tab]").forEach(b => b.classList.toggle("on", b.dataset.tab === tab));
        if (tab === "count") { if (location.hash !== "#apuracao") history.replaceState(null, "", "#apuracao"); start(); }
        else { if (location.hash === "#apuracao") history.replaceState(null, "", location.pathname); window.dispatchEvent(new Event("resize")); }
    }
    document.querySelectorAll("[data-tab]").forEach(b => b.onclick = () => show(b.dataset.tab));
    $("cRefresh").onclick = () => cycle();
    window.addEventListener("resize", () => { if (!$("tabCount").hidden) drawChart(); });
    // abre na apuração se o link pedir, ou se o endereço não tiver nenhum ajuste da aba de pesquisas
    const h = location.hash;
    show(h === "#apuracao" || h === "" ? "count" : "polls");
})();
