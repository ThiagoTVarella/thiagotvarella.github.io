/* Apuração ao vivo. Lê o boletim do TSE por estado e por município, compara o que já foi apurado em cada lugar com o que
   se esperava daquele lugar (1º turno + média das pesquisas) e projeta o resultado final.

   Modelo, na escala logit da fatia do Lula entre os dois:
     fatia final do município i  θ_i = x_i + X_i·β + η_região + γ_uf + ε_i
       x_i   ponto de partida: fatia do Lula entre Lula e Flávio no 1º turno naquele município
       β     deslocamento nacional (β0, ajustado para a média das pesquisas) e efeitos por tipo de município
             (tamanho e inclinação no 1º turno, centrados)
       η, γ  deslocamentos próprios de cada região e de cada estado
       ε_i   o que sobra de cada município (caudas pesadas: t, por repesagem)
     contagem parcial: z_i = θ_i + (1−k/K)·(b0 + b1·inclinação_i) + ruído τ_i²/k·(1−k/K) + ordem²·(1−k/K) + binomial,
       com k de K seções apuradas; o viés b das primeiras seções é estimado ao vivo (parciais x completos)
   Tudo é normal dado os pesos, então a posteriori sai em fórmula fechada e a projeção sai de sorteios. */
(function (root) {
    "use strict";
    const DEF = {
        prior: 49.20,       // média das pesquisas (fatia do Lula entre os dois, %)
        priorSd: 1.9,       // erro típico dessa média, em pontos
        sdState: 0.03,      // desvio dos deslocamentos estaduais (logit) quando não há efeito de região; 2022: 0,023
        sdRegion: 0.015,    // deslocamento por região (N, NE, CO, SE, S); 0 = desligado. 2022: ~0,015
        sdStateR: 0.025,    // desvio do estado dentro da região (com sdRegion > 0)
        sdAbroad: 0.25,     // exterior
        eps0: 0.028,        // resíduo municipal: sqrt(eps0² + eps1²·1000/votos), ajustado em 2022
        eps1: 0.071,
        tdf: 4,             // caudas pesadas: resíduos t com tdf graus de liberdade (repesagem EM); 0 = normal
        tIter: 3,
        tauDefault: 0.25,   // heterogeneidade entre seções quando não sei
        orderSd: 0.15,      // seções apuradas primeiro não são típicas do município (2022: puxam para o Bolsonaro)
        // efeitos por tipo de município no voto de verdade (centrados na média ponderada por votos)
        sdCov: 0,           // atalho antigo: liga sdOth e sdSize com o mesmo desvio
        sdOth: null,        // fatia dos outros candidatos no 1º turno (desvio da média); testado, não ajudou
        sdSize: 0.05,       // tamanho (log10 dos votos): em 2026 o Lula cresce mais nas cidades grandes; 2022: ~0
        sdLean: 0.05,       // inclinação no 1º turno (logit − média), regressão à média; 2022: −0,03
        // viés das contagens parciais: só na observação, proporcional ao que falta apurar (1 − f)
        sdBias: 0.15,       // viés comum (estimado ao vivo: parciais x municípios completos)
        biasShape: "lin",   // "lin" = 1−f, "hump" = 4f(1−f) (testado, pior)
        sdBiasSize: 0,      // viés que varia com o tamanho (testado, não ajudou com sdSize ligado)
        sdBiasLean: 0.05,   // viés que varia com a inclinação: as primeiras seções de um município forte de um lado
                            // tendem a ser menos fortes (2022); sem isso a inclinação fica enviesada no começo
        sdBiasState: 0,     // viés próprio de cada estado (testado, não ajudou)
        sdRemain: 0.05,     // choque comum no que falta apurar: o resto do país pode votar diferente do que já veio
        sdRemainState: 0.03,// idem, por estado (2022, com ordens de apuração trocadas: faixas de 90% antigas ~5× o erro)
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

    /* regiões (o exterior fica fora): N, NE, CO, SE, S */
    const REGION = {ac: 0, am: 0, ap: 0, pa: 0, ro: 0, rr: 0, to: 0, al: 1, ba: 1, ce: 1, ma: 1, pb: 1, pe: 1, pi: 1, rn: 1, se: 1,
        df: 2, go: 2, ms: 2, mt: 2, es: 3, mg: 3, rj: 3, sp: 3, pr: 4, rs: 4, sc: 4};

    /* units: [{x, v1, sec, sd, oth, lsize, uf, K, k, l, f}] — K/k seções totais/apuradas, l/f votos apurados.
       Unidades agrupadas (vários municípios de uma vez) funcionam igual, com sd maior.
       Todos os efeitos (nacional, covariáveis, viés da contagem parcial, região, estado) formam um único vetor gaussiano;
       o resíduo de cada município é integrado analiticamente e depois sorteado condicionado aos efeitos e à contagem. */
    function project(units, o) {
        o = Object.assign({}, DEF, o || {});
        const n = units.length;
        const sdE = u => Math.sqrt(o.eps0 * o.eps0 + o.eps1 * o.eps1 * 1000 / Math.max(u.v1 * o.rho0, 50));
        const frac = u => u.K > 0 ? Math.min(1, u.k / u.K) : 0;

        // covariáveis centradas na média ponderada por votos, para β0 continuar sendo o deslocamento nacional
        let V = 0, mO = 0, mS = 0, mX = 0;
        for (const u of units) { V += u.v1; mO += u.v1 * (u.oth || 0); mS += u.v1 * (u.lsize || 0); mX += u.v1 * u.x; }
        mO /= V; mS /= V; mX /= V;
        const sdOth = o.sdOth != null ? o.sdOth : o.sdCov, sdSize = o.sdSize != null ? o.sdSize : o.sdCov;
        const covs = [];   // afetam o voto de verdade
        if (sdOth > 0) covs.push({f: u => (u.oth || 0) - mO, sd: sdOth});
        if (sdSize > 0) covs.push({f: u => (u.lsize || 0) - mS, sd: sdSize});
        if (o.sdLean > 0) covs.push({f: u => u.x - mX, sd: o.sdLean});
        const PT = 1 + covs.length;
        // viés da contagem parcial: só na observação, com forma g(fração apurada)
        const shape = f => o.biasShape === "hump" ? 4 * f * (1 - f) : 1 - f;
        const bfs = [];
        if (o.sdBias > 0) bfs.push({f: () => 1, sd: o.sdBias});
        if (o.sdBiasSize > 0) bfs.push({f: u => (u.lsize || 0) - mS, sd: o.sdBiasSize});
        if (o.sdBiasLean > 0) bfs.push({f: u => u.x - mX, sd: o.sdBiasLean});
        const PB = bfs.length;
        // efeitos aleatórios: região, estado e (opcional) viés por estado
        const ufs = [...new Set(units.map(u => u.uf))], ufIx = Object.fromEntries(ufs.map((u, j) => [u, j]));
        const useReg = o.sdRegion > 0, iReg = PT + PB, NR = useReg ? 5 : 0, iSt = iReg + NR, NS = ufs.length;
        const useBS = o.sdBiasState > 0 && PB > 0, iBS = iSt + NS, Q = iBS + (useBS ? NS : 0);
        const sdSt = uf => uf === "zz" ? o.sdAbroad : (useReg ? o.sdStateR : o.sdState);

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
        for (const uf of ufs) T[uf] = {A: 0, B: 0, nobs: 0};
        for (const u of units) if (u.k > 0 && u.l + u.f > 0) { T[u.uf].A += u.l + u.f; T[u.uf].B += u.v1 * frac(u); }
        let A = 0, B = 0; for (const uf in T) { A += T[uf].A; B += T[uf].B; }
        const rhoN = (A + 2e5 * o.rho0) / (B + 2e5);
        for (const uf in T) T[uf].rho = (T[uf].A + 5e4 * rhoN) / (T[uf].B + 5e4);

        // vetor de efeitos de cada unidade (esparso): idx/val para o voto de verdade e para a observação
        const featTrue = u => {
            const idx = [0], val = [1];
            covs.forEach((c, j) => { idx.push(1 + j); val.push(c.f(u)); });
            if (useReg && REGION[u.uf] != null) { idx.push(iReg + REGION[u.uf]); val.push(1); }
            idx.push(iSt + ufIx[u.uf]); val.push(1);
            return {idx, val};
        };
        const featObs = u => {
            const t = featTrue(u), g = shape(frac(u));
            bfs.forEach((b, j) => { t.idx.push(PT + j); t.val.push(g * b.f(u)); });
            if (useBS) { t.idx.push(iBS + ufIx[u.uf]); t.val.push(g); }
            return t;
        };

        // observações
        const obs = [];
        for (let i = 0; i < n; i++) {
            const u = units[i], nv = u.l + u.f;
            if (!(u.k > 0 && nv > 0)) continue;
            // xo: ponto de partida da parte já apurada (difere de x só nos blocos); z vai para a escala da unidade inteira
            const p = (u.l + 0.5) / (nv + 1), xo = u.xo != null ? u.xo : u.x, z = lg(p) + u.x - xo, rest = Math.max(0, 1 - frac(u));
            const tau = u.sd != null ? Math.max(u.sd, 0.05) : o.tauDefault;
            const w = Math.max(tau * tau / u.k * rest + o.orderSd * o.orderSd * rest + 1 / (nv * p * (1 - p)) * rest, 1e-9);
            const e = sdE(u), F = featObs(u);
            obs.push({i, z, w, r: z - u.x, e, v: e * e + w, lam: 1, idx: F.idx, val: F.val});
            T[u.uf].nobs++;
        }

        // posteriori gaussiana dos efeitos; com caudas pesadas (t), repesa as observações discrepantes (EM)
        const prior0 = new Array(Q).fill(0), m0 = new Array(Q).fill(0);
        prior0[0] = 1 / (sdD * sdD); m0[0] = d0;
        covs.forEach((c, j) => { prior0[1 + j] = 1 / (c.sd * c.sd); });
        bfs.forEach((b, j) => { prior0[PT + j] = 1 / (b.sd * b.sd); });
        for (let r = 0; r < NR; r++) prior0[iReg + r] = 1 / (o.sdRegion * o.sdRegion);
        ufs.forEach((uf, j) => { prior0[iSt + j] = 1 / (sdSt(uf) ** 2); if (useBS) prior0[iBS + j] = 1 / (o.sdBiasState * o.sdBiasState); });
        let Lc, mB;
        const iters = o.tdf > 0 ? 1 + o.tIter : 1;
        for (let it = 0; it < iters; it++) {
            if (it > 0) for (const ob of obs) {
                let pr = 0; for (let a = 0; a < ob.idx.length; a++) pr += ob.val[a] * mB[ob.idx[a]];
                const res = ob.r - pr; ob.lam = (o.tdf + 1) / (o.tdf + res * res / ob.v);
            }
            const prec = Array.from({length: Q}, (_, a) => { const row = new Array(Q).fill(0); row[a] = prior0[a]; return row; });
            const rhs = prior0.map((p, a) => p * m0[a]);
            for (const ob of obs) {
                const iv = ob.lam / ob.v, I = ob.idx, Vv = ob.val, L = I.length;
                for (let a = 0; a < L; a++) { rhs[I[a]] += Vv[a] * ob.r * iv; for (let b = 0; b < L; b++) prec[I[a]][I[b]] += Vv[a] * Vv[b] * iv; }
            }
            Lc = chol(prec); mB = cholSolve(Lc, rhs);
        }

        // sorteios
        const rand = rng(o.seed), D = o.draws;
        const natL = new Float64Array(D), natF = new Float64Array(D), stL = ufs.map(() => new Float64Array(D)), stF = ufs.map(() => new Float64Array(D));
        const unitMean = new Float64Array(n);   // fatia final esperada por unidade (média dos sorteios)
        const obsOf = new Int32Array(n).fill(-1); obs.forEach((ob, j) => { obsOf[ob.i] = j; });
        const remOf = units.map(u => T[u.uf].rho * u.v1 * Math.max(0, 1 - frac(u)));
        const ftOf = units.map(featTrue), sdEOf = units.map(sdE), ujOf = units.map(u => ufIx[u.uf]);
        const nBiasIdx = obs.map(ob => ob.idx.length - (featTrue(units[ob.i]).idx.length));
        const zz = new Array(Q);
        for (let d = 0; d < D; d++) {
            for (let a = 0; a < Q; a++) zz[a] = rand.normal();
            const dz = cholInvT(Lc, zz), th0 = mB.map((m, a) => m + dz[a]);
            const shockN = o.sdRemain * rand.normal(), shockS = ufs.map(() => o.sdRemainState * rand.normal());
            let L = 0, F = 0;
            for (let i = 0; i < n; i++) {
                const u = units[i], ft = ftOf[i], j = ujOf[i];
                let mu = u.x; for (let a = 0; a < ft.idx.length; a++) mu += ft.val[a] * th0[ft.idx[a]];
                const e = sdEOf[i], k = obsOf[i];
                let th;
                if (k >= 0) {
                    const ob = obs[k], L0 = ob.idx.length, nb = nBiasIdx[k];
                    let zb = ob.z; for (let a = L0 - nb; a < L0; a++) zb -= ob.val[a] * th0[ob.idx[a]];
                    const pr = 1 / (e * e) + 1 / ob.w;
                    th = mu + ((zb - mu) / ob.w) / pr + rand.normal() / Math.sqrt(pr * ob.lam);
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
            const nv = u.l + u.f, e0 = il((u.xo != null ? u.xo : u.x) + d0);
            cl += u.l; cf += u.f; exp += nv * e0; rem += remOf[i];
            s.l += u.l; s.f += u.f; s.exp += nv * e0; s.K += u.K; s.k += u.k; s.rem += remOf[i]; s.v1 += u.v1;
        });
        for (const uf of ufs) {
            const j = ufIx[uf], g = mB[iSt + j] + (useReg && REGION[uf] != null ? mB[iReg + REGION[uf]] : 0);
            Object.assign(states[uf], summ(stL[j], stF[j]), {gamma: g, rho: T[uf].rho});
        }
        const nat = summ(natL, natF);
        const total = cl + cf + rem;
        const coef = {};
        covs.forEach((c, j) => { coef["cov" + j] = mB[1 + j]; });
        bfs.forEach((b, j) => { coef["bias" + j] = mB[PT + j]; });
        if (useReg) ["N", "NE", "CO", "SE", "S"].forEach((r, j) => { coef["reg" + r] = mB[iReg + j]; });
        return {
            nat, states, d0, beta: mB.slice(0, PT + PB), coef, rhoN, bias: PB ? 100 * mB[PT] / 4 : 0,
            counted: {l: cl, f: cf, share: cl + cf ? 100 * cl / (cl + cf) : null, expected: cl + cf ? 100 * exp / (cl + cf) : null},
            remaining: rem, totalExpected: total,
            needLula: rem > 0 ? 100 * (total / 2 - cl) / rem : null,   // % do que falta que o Lula precisa
            shift: 100 * (il(lg(target) + (mB[0] - d0)) - target),       // deslocamento nacional em pontos, além das pesquisas
            unitMean, rem: remOf
        };
    }

    /* junta o que se sabe do boletim em unidades para o modelo: municípios lidos + um bloco por estado com os que
       já andaram mas ainda não li. S = {munAb: {chave: {ts, st}}, mun: {chave: {ts, st, l, f}}, stU: {uf: {l, f}}} */
    function buildUnits(BL, S) {
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
            // o bloco inteiro (para projetar) e a parte já apurada (para comparar): cada membro pesa pela fração que já
            // apurou. Antes o apurado era comparado com o 1º turno do bloco inteiro — em SP, dominado pela capital, que
            // ainda nem tinha começado — e o "esperado" do apurado saía errado.
            let L1 = 0, F1 = 0, V = 0, K = 0, k = 0, sec = 0, oth = 0, ls = 0, Lo = 0, Fo = 0, Wo = 0, sd2 = 0;
            for (const p of mem) {
                const Km = p.a.ts || p.m.sec, fr = Km ? Math.min(1, p.a.st / Km) : 0;
                L1 += p.m.l1; F1 += p.m.f1; V += p.m.v1; K += Km; k += p.a.st; sec += p.m.sec; oth += p.m.oth * p.m.v1; ls += p.m.lsize * p.m.v1;
                Lo += fr * p.m.l1; Fo += fr * p.m.f1; Wo += fr * p.m.v1; sd2 += fr * p.m.v1 * (p.m.sd != null ? p.m.sd : 0.3) ** 2;
            }
            const x = lg((L1 + 1) / (L1 + F1 + 2)), xo = lg((Lo + 1) / (Lo + Fo + 2));
            let between = 0; for (const p of mem) between += p.m.v1 * (p.m.x - x) ** 2;
            between = Math.sqrt(between / V);
            // composição do apurado conhecida: sobra a heterogeneidade entre seções dentro dos membros e um pouco entre eles
            const tau = Math.sqrt((Wo > 0 ? sd2 / Wo : 0.09) + between * between + 0.01);
            units.push({key: uf + "_bloco", uf, nm: "bloco", x, xo, v1: V, sec, K, k, l, f, sd: tau, oth: oth / V, lsize: ls / V, pooled: mem.length});
        }
        return units;
    }

    const api = {DEF, prepBaseline, project, buildUnits, lg, il, rng};
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
            const q = SERVER[SERVER.length - 1];
            if (q && $("cLula").textContent === "–") {   // sem acesso ao TSE: mostra o último retrato guardado no site
                $("cStatus").innerHTML = `Último retrato guardado no site: boletim de <b>${q.t}</b>, ${fmt(q.pct)}% das seções apuradas. Contagem: Lula ${fmt(q.raw)}%.`;
                $("cLula").textContent = "Lula " + fmt(q.mean) + "%"; $("cFlavio").textContent = "Flávio " + fmt(100 - q.mean) + "%";
                $("cRange").textContent = `Em 90% dos cenários, o Lula termina entre ${fmt(q.lo)}% e ${fmt(q.hi)}%.`;
                const pl = 100 * q.p; $("cPL").textContent = "Lula " + fmt(pl, 1) + "%"; $("cPF").textContent = "Flávio " + fmt(100 - pl, 1) + "%";
                $("cBar").innerHTML = `<div style="width:${pl}%;background:#c0392b"></div><div style="width:${100 - pl}%;background:#1f5fa8"></div>`;
            }
        }
        busy = false;
    }

    function run() {
        const units = M.buildUnits(BL, S);
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

    let SERVER = [];
    function loadHist() { try { return JSON.parse(localStorage.getItem(HKEY)) || []; } catch (e) { return []; } }
    function saveHist(pt) {
        const h = loadHist(); if (h.length && h[h.length - 1].t === pt.t) h.pop(); h.push(pt);
        try { localStorage.setItem(HKEY, JSON.stringify(h.slice(-400))); } catch (e) {}
    }
    function allHist() {   // histórico guardado no site (a cada 5 min) + o que este navegador viu
        const by = {}; for (const p of SERVER) if (p.pct > 0) by[p.t] = p;
        return Object.values(by).sort((a, b) => a.pct - b.pct);
    }
    function drawChart() {
        const h = allHist(), box = $("cChart"), W = Math.max(300, box.clientWidth || 600), small = W < 600,
            H = small ? 240 : 300, m = {l: 34, r: small ? 10 : 70, t: 12, b: 28};
        if (!h.length) { box.innerHTML = `<p class="sub">O gráfico aparece quando a apuração andar.</p>`; return; }
        const vals = h.flatMap(p => [p.lo, p.hi, p.raw, 100 - p.lo, 100 - p.hi, 100 - p.raw].filter(v => v != null));
        const y0 = Math.max(0, Math.floor(Math.min(...vals) - 1)), y1 = Math.min(100, Math.ceil(Math.max(...vals) + 1));
        const xmax = Math.min(100, Math.max(10, Math.ceil(h[h.length - 1].pct / 10) * 10));
        const X = p => m.l + (W - m.l - m.r) * p / xmax, Y = v => m.t + (H - m.t - m.b) * (y1 - v) / (y1 - y0);
        const line = (f, col, dash, w = 2) => `<polyline points="${h.filter(p => f(p) != null).map(p => `${X(p.pct).toFixed(1)},${Y(f(p)).toFixed(1)}`).join(" ")}" fill="none" stroke="${col}" stroke-width="${w}" ${dash ? `stroke-dasharray="6 4"` : ""}/>`;
        const step = y1 - y0 > 16 ? 4 : y1 - y0 > 8 ? 2 : 1;
        let s = `<svg viewBox="0 0 ${W} ${H}" height="${H}">`;
        for (let v = Math.ceil(y0 / step) * step; v <= y1; v += step) s += `<line x1="${m.l}" x2="${W - m.r}" y1="${Y(v)}" y2="${Y(v)}" stroke="${v === 50 ? "#999" : "#eee"}"/><text x="${m.l - 4}" y="${Y(v) + 4}" font-size="10" text-anchor="end" fill="#777">${v}%</text>`;
        for (let p = 0; p <= xmax; p += xmax > 50 ? 20 : 10) s += `<text x="${X(p)}" y="${H - 10}" font-size="10" text-anchor="middle" fill="#777">${p}%</text>`;
        s += `<text x="${(m.l + W - m.r) / 2}" y="${H - 0}" font-size="10" text-anchor="middle" fill="#999">seções apuradas</text>`;
        const band = (lo, hi, col) => `<polygon points="${h.map(p => `${X(p.pct).toFixed(1)},${Y(hi(p)).toFixed(1)}`).join(" ")} ${h.slice().reverse().map(p => `${X(p.pct).toFixed(1)},${Y(lo(p)).toFixed(1)}`).join(" ")}" fill="${col}" opacity=".10"/>`;
        s += band(p => p.lo, p => p.hi, "#c0392b") + band(p => 100 - p.hi, p => 100 - p.lo, "#1f5fa8");
        s += line(p => p.raw, "#c0392b", false) + line(p => p.raw == null ? null : 100 - p.raw, "#1f5fa8", false);
        s += line(p => p.mean, "#c0392b", true) + line(p => 100 - p.mean, "#1f5fa8", true);
        const last = h[h.length - 1];
        if (!small) {
            s += `<text x="${X(last.pct) + 6}" y="${Y(last.mean) + 4}" font-size="11" fill="#c0392b">Lula ${fmt(last.mean, 1)}</text>`;
            s += `<text x="${X(last.pct) + 6}" y="${Y(100 - last.mean) + 4}" font-size="11" fill="#1f5fa8">Flávio ${fmt(100 - last.mean, 1)}</text>`;
        }
        for (const p of h) s += `<circle cx="${X(p.pct)}" cy="${Y(p.mean)}" r="6" fill="transparent"><title>${p.t}: ${fmt(p.pct)}% apurado. Contagem: Lula ${fmt(p.raw)}%. Projeção: Lula ${fmt(p.mean)}% (${fmt(p.lo)}–${fmt(p.hi)}), chance ${fmt(100 * p.p, 0)}%</title></circle>`;
        s += `</svg><div class="sub" style="margin-top:4px"><span style="color:#c0392b">━ Lula</span> &nbsp; <span style="color:#1f5fa8">━ Flávio</span> &nbsp; linha cheia: contagem do TSE até ali &nbsp; tracejada: minha projeção do resultado final naquele momento (faixa: 90% dos cenários)</div>`;
        box.innerHTML = s;
    }
    const loadServer = () => getJ("data/count/live_history.json?" + Date.now()).then(j => { SERVER = j || []; }).catch(() => {});

    /* versão simples: a página só lê os retratos publicados (a cada 5 min ou quando pedem) */
    function renderSnap(L) {
        const q = L.point;
        const gen = new Date(L.generated), ago = Math.max(0, Math.round((Date.now() - gen) / 60000));
        const hm = gen.toLocaleTimeString("pt-BR", {timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit"});
        $("cStatus").innerHTML = `<span style="font-size:14px;color:#333"><b>Última atualização: ${hm}</b> (há ${ago} min, horário de Brasília)</span><br>` +
            `Boletim do TSE das ${q.t.slice(11, 16)}: <b>${fmt(q.pct)}%</b> das seções apuradas. Contagem: Lula ${fmt(q.raw)}%, Flávio ${fmt(100 - q.raw)}%. Atualizo a cada 5 minutos.`;
        $("cLula").textContent = "Lula " + fmt(q.mean) + "%"; $("cFlavio").textContent = "Flávio " + fmt(100 - q.mean) + "%";
        $("cRange").textContent = `Em 90% dos cenários, o Lula termina entre ${fmt(q.lo)}% e ${fmt(q.hi)}%.`;
        const pl = 100 * q.p; $("cPL").textContent = "Lula " + fmt(pl, 1) + "%"; $("cPF").textContent = "Flávio " + fmt(100 - pl, 1) + "%";
        $("cBar").innerHTML = `<div style="width:${pl}%;background:#c0392b">${pl >= 12 ? fmt(pl, 0) + "%" : ""}</div><div style="width:${100 - pl}%;background:#1f5fa8">${pl <= 88 ? fmt(100 - pl, 0) + "%" : ""}</div>`;
        const d = q.raw - q.exp;
        $("cExplain").innerHTML = `<p>Nos municípios já apurados, o 1º turno indicava Lula com ${fmt(q.exp)}%; ele tem ${fmt(q.raw)}% (${sign(d)}). Faltam cerca de ${mi(q.rem)} de votos válidos.</p>`;
        $("cFetch").textContent = "";
        const rows = Object.entries(L.states).map(([uf, s]) => ({uf, s, p: 100 * s.k / Math.max(1, s.K), sh: s.l + s.f ? 100 * s.l / (s.l + s.f) : null})).sort((a, b) => b.s.K - a.s.K);
        let t = `<tr><th>Estado</th><th>Apurado</th><th>Lula na contagem</th><th>Esperado</th><th>Diferença</th><th>Projeção do Lula</th><th>Faixa de 90%</th></tr>`;
        for (const r of rows) { const dd = r.sh == null ? null : r.sh - r.s.exp;
            t += `<tr><td>${r.uf === "zz" ? "Exterior" : r.uf.toUpperCase()}</td><td>${fmt(r.p, 1)}%</td><td>${r.sh == null ? "–" : fmt(r.sh) + "%"}</td><td>${r.s.exp == null ? "–" : fmt(r.s.exp) + "%"}</td><td class="${dd > 0 ? "pos" : dd < 0 ? "neg" : ""}">${sign(dd)}</td><td>${fmt(r.s.mean)}%</td><td>${fmt(r.s.lo)}–${fmt(r.s.hi)}</td></tr>`; }
        $("cTbl").innerHTML = t;
    }
    async function refresh() {
        try {
            const [h, L] = await Promise.all([getJ("data/count/live_history.json?" + Date.now()), getJ("data/count/live_latest.json?" + Date.now())]);
            SERVER = h || []; renderSnap(L); drawChart();
        } catch (e) { $("cStatus").textContent = "Ainda não há retrato publicado (" + e.message + ")."; }
    }
    function start() {
        if (started) return; started = true;
        refresh(); timer = setInterval(() => { if (!document.hidden) refresh(); }, 60000);
    }
    function show(tab) {
        $("tabCount").hidden = tab !== "count"; $("tabPolls").hidden = tab === "count";
        document.querySelectorAll("[data-tab]").forEach(b => b.classList.toggle("on", b.dataset.tab === tab));
        if (tab === "count") { if (location.hash !== "#apuracao") history.replaceState(null, "", "#apuracao"); start(); }
        else { if (location.hash === "#apuracao") history.replaceState(null, "", location.pathname); window.dispatchEvent(new Event("resize")); }
    }
    document.querySelectorAll("[data-tab]").forEach(b => b.onclick = () => show(b.dataset.tab));
    window.addEventListener("resize", () => { if (!$("tabCount").hidden) drawChart(); });
    // abre na apuração se o link pedir, ou se o endereço não tiver nenhum ajuste da aba de pesquisas
    const h = location.hash;
    show(h === "#apuracao" || h === "" ? "count" : "polls");
})();
