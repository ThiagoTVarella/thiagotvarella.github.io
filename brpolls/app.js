/* Interactive poll aggregator for the 2026 Brazilian runoff (Lula vs Flávio Bolsonaro).
 *
 * The engine below mirrors scripts/average.py and scripts/forecast.py so the reader can
 * change the model (smoothing, house effects, weights, which polls count, error size) and
 * see the average, the trend and the win probability recomputed in the browser.
 * The UI part only runs in a browser; the engine can be required from Node for testing.
 */
"use strict";

/* ------------------------------------------------------------------ engine */

const DAY_MS = 86400000;
const toDay = s => Math.round(Date.parse(s + "T00:00:00Z") / DAY_MS);
const fromDay = d => new Date(d * DAY_MS).toISOString().slice(0, 10);
const FREQ_WINDOW = 10;
const R1_END = toDay("2026-10-03");
const ELECTION = toDay("2026-10-25");
const FIRST_ROUND = toDay("2026-10-04");

const DEFAULTS = {
    halfLife: 8,        // days for a poll's weight to halve
    house: true,        // correct pollster house effects
    shrink: 3,          // house effects shrink as if each pollster had this many extra polls at zero
    useR1: true,        // let first-round polls inform house effects
    r1Weight: 0.5,      // ...and how much each of them counts relative to a runoff poll
    window: 15,         // length in days of the simple moving window
    splineLog: 3.5,     // cubic smoothing spline stiffness, log10(lambda); csaps p = 1 / (1 + lambda)
    houseStrength: 1,   // how much of each estimated house effect to remove (1 = all of it)
    smoother: "exp",    // exp: exponential decay, past only · gauss: centred Gaussian · window: simple moving window
    rating: true,       // weight by pollster rating
    size: true,         // weight by sqrt(sample size), capped at 5,000
    freq: true,         // penalise pollsters publishing many polls close together
    pre: true,          // include runoff polls taken before the first round
    unverified: true,   // include the two polls not confirmed against a primary source
    errSd: 2.0,         // shared polling error, points of Lula's two-candidate share
    shift: 0,           // assume polls overstate Lula by this much (stress test)
    minGrade: "",       // keep only pollsters graded at least this ("" = all)
    keepUnrated: true,  // with a grade filter, keep pollsters that have no grade yet
    exclude: [],        // pollsters left out
    excludeModes: [],   // survey modes left out
    asOf: null,         // last day of polls to use (null = latest)
};

function prepare(raw, series) {
    return raw.map(p => {
        const a = toDay(p.start), b = toDay(p.end);
        return Object.assign({}, p, {
            a, b, series,
            t: a + Math.floor((b - a) / 2),
            y: series === "runoff" ? 100 * p.lula / (p.lula + p.flavio) : p.y,
            nCap: Math.min(p.n || 1500, 5000),
        });
    });
}

function setWeights(list, opt) {
    for (const p of list) {
        let k = 0;
        for (const q of list) if (q.pollster === p.pollster && Math.abs(q.t - p.t) <= FREQ_WINDOW) k++;
        p.wf = opt.freq ? 1 / Math.sqrt(Math.max(1, k / 2)) : 1;
        p.bw = (opt.rating ? p.rating : 1) * (opt.size ? Math.sqrt(p.nCap / 2000) : 1) * p.wf;
    }
}

// recency kernel: how much a poll fielded `age` days before `day` counts (negative age = after)
function kernel(age, H, smoother) {
    if (smoother === "gauss") return Math.exp(-0.5 * (age / H) * (age / H));
    if (age < 0) return 0;
    if (smoother === "window") return age < H ? 1 : 0;   // H is the window length here
    return Math.pow(0.5, age / H);
}

function trendAt(day, list, house, H, skip, smoother = "exp", strength = 1) {
    let num = 0, den = 0, den2 = 0;
    for (const p of list) {
        if (p === skip) continue;
        const k = kernel(day - p.t, H, smoother);
        if (k === 0) continue;
        const w = p.bw * k;
        num += w * (p.y - strength * (house[p.pollster] || 0));
        den += w;
        den2 += w * w;
    }
    return den ? {v: num / den, den, nEff: den * den / den2} : {v: null, den: 0, nEff: 0};
}

/* Weighted cubic smoothing spline (what MATLAB's / Python's csaps fits), via the Reinsch
 * algorithm as in Green & Silverman (1994): minimise sum w_i (y_i - f(x_i))^2 + lambda * int f''^2.
 * Polls on the same day are merged first. Returns f evaluated at any day, held flat outside the data
 * (a natural spline would extrapolate linearly, which is a forecast we do not want to make). */
function splineFit(pts, lambda) {
    const by = new Map();
    for (const p of pts) {
        const e = by.get(p.x) || {x: p.x, sw: 0, swy: 0};
        e.sw += p.w; e.swy += p.w * p.y;
        by.set(p.x, e);
    }
    const k = [...by.values()].sort((a, b) => a.x - b.x);
    const n = k.length;
    if (n === 0) return () => null;
    const x = k.map(e => e.x), w = k.map(e => e.sw), y = k.map(e => e.swy / e.sw);
    const wm = w.reduce((s, v) => s + v, 0) / n;
    for (let i = 0; i < n; i++) w[i] /= wm;               // so lambda does not depend on the weight scale
    if (n < 3) { const m = y.reduce((s, v, i) => s + v * w[i], 0) / w.reduce((s, v) => s + v, 0); return () => m; }
    const h = [];
    for (let i = 0; i < n - 1; i++) h.push(x[i + 1] - x[i]);
    // Q (n x n-2) is tridiagonal by columns, R (n-2 x n-2) tridiagonal
    const m = n - 2, A = Array.from({length: m}, () => new Float64Array(m)), rhs = new Float64Array(m);
    const q = (i, j) => {            // entry Q[i][j], column j corresponds to interior knot j+1
        if (i === j) return 1 / h[j];
        if (i === j + 1) return -1 / h[j] - 1 / h[j + 1];
        if (i === j + 2) return 1 / h[j + 1];
        return 0;
    };
    for (let j = 0; j < m; j++) {
        A[j][j] += (h[j] + h[j + 1]) / 3;
        if (j + 1 < m) { A[j][j + 1] += h[j + 1] / 6; A[j + 1][j] += h[j + 1] / 6; }
        for (let i = j; i <= j + 2; i++) rhs[j] += q(i, j) * y[i];
        for (let l = Math.max(0, j - 2); l <= Math.min(m - 1, j + 2); l++) {   // lambda * Q' W^-1 Q (pentadiagonal)
            let sum = 0;
            for (let i = Math.max(j, l); i <= Math.min(j, l) + 2; i++) sum += q(i, j) * q(i, l) / w[i];
            A[j][l] += lambda * sum;
        }
    }
    // symmetric positive definite: Gaussian elimination without pivoting is safe
    for (let c = 0; c < m; c++) {
        for (let r = c + 1; r < Math.min(m, c + 3); r++) {
            const f = A[r][c] / A[c][c];
            if (!f) continue;
            for (let cc = c; cc < Math.min(m, c + 3); cc++) A[r][cc] -= f * A[c][cc];
            rhs[r] -= f * rhs[c];
        }
    }
    const gam = new Float64Array(n);                       // second derivatives; zero at both ends
    for (let c = m - 1; c >= 0; c--) {
        let sum = rhs[c];
        for (let cc = c + 1; cc < Math.min(m, c + 3); cc++) sum -= A[c][cc] * gam[cc + 1];
        gam[c + 1] = sum / A[c][c];
    }
    const g = y.slice();
    for (let i = 0; i < n; i++) {
        let qg = 0;
        for (let j = Math.max(0, i - 2); j <= Math.min(m - 1, i); j++) qg += q(i, j) * gam[j + 1];
        g[i] = y[i] - lambda * qg / w[i];
    }
    return t => {
        if (t <= x[0]) return g[0];
        if (t >= x[n - 1]) return g[n - 1];
        let i = 0;
        while (x[i + 1] < t) i++;
        const hi = h[i], a = t - x[i], b = x[i + 1] - t;
        return (a * g[i + 1] + b * g[i]) / hi - a * b / 6 * ((1 + a / hi) * gam[i + 1] + (1 + b / hi) * gam[i]);
    };
}

// smoothing width: the half-life (exponential), the spread (Gaussian) or the window length
const width = opt => opt.smoother === "window" ? opt.window
    : opt.smoother === "spline" ? Math.min(40, Math.max(1, Math.pow(Math.pow(10, opt.splineLog), 0.25)))
    : opt.halfLife;
// the spline only draws the trend; house effects, noise and dot weights use its nearest kernel cousin
const kernelSmoother = opt => opt.smoother === "spline" ? "gauss" : opt.smoother;

function estimateHouse(runoff, r1, opt, iters = 40) {
    let house = {};
    if (!opt.house) return house;
    const r1w = opt.useR1 ? opt.r1Weight : 0;
    const all = r1w > 0 ? runoff.concat(r1) : runoff;
    for (let it = 0; it < iters; it++) {
        const sum = {}, wt = {};
        for (const p of all) {
            const tr = trendAt(p.t, p.series === "runoff" ? runoff : r1, house, opt.smoother === "spline" ? opt.halfLife : width(opt), p,
                opt.smoother === "spline" ? "exp" : opt.smoother);
            if (tr.v === null) continue;
            const w = p.series === "r1" ? r1w : 1;
            sum[p.pollster] = (sum[p.pollster] || 0) + w * (p.y - tr.v);
            wt[p.pollster] = (wt[p.pollster] || 0) + w;
        }
        const next = {};
        let tot = 0, mean = 0;
        for (const k in sum) {
            next[k] = sum[k] / (wt[k] + opt.shrink);
            tot += wt[k];
            mean += next[k] * wt[k];
        }
        mean /= tot || 1;
        house = {};
        for (const k in next) house[k] = next[k] - mean;
    }
    return house;
}

// Student t CDF with 4 degrees of freedom (closed form)
function t4cdf(x) {
    const u = x * x / (4 + x * x);
    return 0.5 + 0.375 * (x / Math.sqrt(1 + x * x / 4)) * (1 - u / 3);
}

// P(Lula > 50): shared t-distributed error plus normal drift and the average's own error,
// combined into one fat-tailed distribution with the same variance
function winProb(center, se, days, errSd) {
    const drift = 0.2 * Math.sqrt(Math.max(days, 0));
    const scale = Math.sqrt((errSd * errSd + drift * drift + se * se) / 2);
    return 1 - t4cdf((50 - center) / scale);
}

const GRADES = ["A+", "A", "A-", "B+", "B", "B-", "C+", "C", "C-", "D"];
function gradeOk(name, data, opt) {
    if (!opt.minGrade) return true;
    const g = (data.grades || {})[name];
    if (!g || GRADES.indexOf(g) < 0) return opt.keepUnrated;
    return GRADES.indexOf(g) <= GRADES.indexOf(opt.minGrade);
}

function compute(data, opt) {
    const asOf = opt.asOf == null ? data.lastDay : opt.asOf;
    const ex = new Set(opt.exclude.concat((data.pollsters || []).filter(n => !gradeOk(n, data, opt)))), exm = new Set(opt.excludeModes);
    const runoff = data.runoff.filter(p => p.b <= asOf && !ex.has(p.pollster) && !exm.has(p.mode)
        && (opt.pre || p.phase === "post_first_round")
        && (opt.unverified || p.verification !== "unverified"));
    const r1 = data.r1.filter(p => p.b <= Math.min(asOf, R1_END) && !ex.has(p.pollster));
    setWeights(runoff, opt);
    setWeights(r1, opt);
    const house = estimateHouse(runoff, r1, opt);

    let res = [];
    for (const p of runoff) {
        if (asOf - p.t > 21) continue;
        const tr = trendAt(p.t, runoff, house, width(opt), p, kernelSmoother(opt), opt.houseStrength);
        if (tr.v !== null) res.push(p.y - opt.houseStrength * (house[p.pollster] || 0) - tr.v);
    }
    const sd = res.length > 1 ? Math.sqrt(res.reduce((s, r) => s + r * r, 0) / (res.length - 1)) : 1.5;

    let spl = null, splRaw = null;
    if (opt.smoother === "spline") {
        const lam = Math.pow(10, opt.splineLog);
        spl = splineFit(runoff.map(p => ({x: p.t, y: p.y - opt.houseStrength * (house[p.pollster] || 0), w: p.bw})), lam);
        splRaw = splineFit(runoff.map(p => ({x: p.t, y: p.y, w: p.bw})), lam);
    }
    const series = [], raw = [];
    for (let d = data.start; d <= asOf; d++) {
        const tr = trendAt(d, runoff, house, width(opt), null, kernelSmoother(opt), opt.houseStrength);
        if (tr.v === null) continue;
        const v = spl ? spl(d) : tr.v;
        const se = sd / Math.sqrt(Math.max(1, tr.nEff));
        series.push({d, v, se, p: winProb(v + opt.shift, se, ELECTION - d, opt.errSd)});
        const r = splRaw ? {v: splRaw(d)} : trendAt(d, runoff, {}, width(opt), null, opt.smoother);   // no house-effect correction
        if (r.v !== null) raw.push({d, v: r.v});
    }
    const last = series[series.length - 1] || {v: NaN, se: NaN, p: NaN};

    let wsum = 0;
    for (const p of runoff) {
        p.w = p.t <= asOf ? p.bw * kernel(asOf - p.t, width(opt), kernelSmoother(opt)) : 0;
        wsum += p.w;
        p.adj = p.y - opt.houseStrength * (house[p.pollster] || 0);
    }
    for (const p of runoff) p.wn = wsum ? p.w / wsum : 0;
    return {asOf, runoff, r1, house, series, raw, sd, current: last, daysLeft: ELECTION - asOf};
}

function influence(data, opt) {
    const base = compute(data, opt).current.v;
    const names = [...new Set(compute(data, opt).runoff.map(p => p.pollster))];
    const out = {};
    for (const n of names) {
        const o = Object.assign({}, opt, {exclude: opt.exclude.concat([n])});
        out[n] = compute(data, o).current.v - base;
    }
    return out;
}

if (typeof module !== "undefined") {
    module.exports = {prepare, compute, influence, DEFAULTS, toDay, fromDay, winProb, t4cdf, splineFit};
}

/* ---------------------------------------------------------------------- UI */

if (typeof document !== "undefined") (function () {
    const $ = id => document.getElementById(id);
    const fmt = (x, d = 1) => (x == null || isNaN(x)) ? "–" : x.toFixed(d).replace(".", ",");
    const pct = (x, d = 1) => fmt(x, d) + "%";
    const sign = (x, d = 1) => (x > 0 ? "+" : "") + fmt(x, d);
    const fd = d => { const s = fromDay(d); return s.slice(8, 10) + "/" + s.slice(5, 7); };   // dd/mm
    const fdl = d => { const s = fromDay(d); return s.slice(8, 10) + "/" + s.slice(5, 7) + "/" + s.slice(0, 4); };
    const esc = s => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;"}[c]));
    const LULA = "#c0392b", FLAVIO = "#1f5fa8";
    const PALETTE = ["#4e79a7", "#f28e2b", "#e15759", "#76b7b2", "#59a14f", "#edc948", "#b07aa1", "#ff9da7",
        "#9c755f", "#bab0ac", "#1b9e77", "#d95f02", "#7570b3", "#e7298a", "#66a61e", "#e6ab02", "#a6761d",
        "#666666", "#17becf", "#bcbd22", "#8c564b", "#393b79"];
    const MODE_LABEL = {"face-to-face": "Presencial", "phone-live": "Telefone (entrevistador)", "phone-ivr": "Telefone (robô)",
        "online-panel": "Painel online", "online-rdd": "Online (aleatório)", "mixed": "Misto", "unknown": "Não informado"};
    const MODE_COLOR = {"face-to-face": "#59a14f", "phone-live": "#4e79a7", "phone-ivr": "#f28e2b",
        "online-panel": "#b07aa1", "online-rdd": "#76b7b2", "mixed": "#9c755f", "unknown": "#999"};
    const EVENTS = [{d: FIRST_ROUND, label: "1º turno"}, {d: toDay("2026-10-18"), label: "Debate"}];

    let DATA, OFFICIAL, FC, FH, RAT, CYC, opt, R, view = {metric: "share", color: "lean", adjusted: false,
        band: true, sized: true, rawLine: false, mode: "simple", w0: null, w1: null}, sel = {poll: null, pollster: null}, hover = null,
        infl = null, playing = null;

    /* ---------- state in the URL, so a view can be shared */
    function readHash() {
        const o = JSON.parse(JSON.stringify(DEFAULTS));
        const h = new URLSearchParams(location.hash.slice(1));
        for (const [k, v] of h) {
            if (k in o) {
                if (Array.isArray(o[k])) o[k] = v ? v.split("|") : [];
                else if (typeof o[k] === "string") o[k] = v;
                else if (typeof o[k] === "boolean") o[k] = v === "1";
                else if (k === "asOf") o[k] = v ? toDay(v) : null;
                else o[k] = parseFloat(v);
            } else if (k in view) {
                view[k] = typeof view[k] === "boolean" ? v === "1" : (k === "w0" || k === "w1" ? toDay(v) : v);
            }
        }
        return o;
    }
    function writeHash() {
        const h = new URLSearchParams();
        for (const k in DEFAULTS) {
            const v = opt[k], d = DEFAULTS[k];
            if (JSON.stringify(v) === JSON.stringify(d)) continue;
            h.set(k, Array.isArray(v) ? v.join("|") : typeof v === "boolean" ? (v ? "1" : "0") : k === "asOf" ? fromDay(v) : v);
        }
        for (const k of ["metric", "color", "adjusted", "band", "sized", "rawLine", "mode"]) {
            const d = {metric: "share", color: "lean", adjusted: false, band: true, sized: true, rawLine: false, mode: "simple"}[k];
            if (view[k] !== d) h.set(k, typeof view[k] === "boolean" ? (view[k] ? "1" : "0") : view[k]);
        }
        if (view.w0 != null) h.set("w0", fromDay(view.w0));
        if (view.w1 != null) h.set("w1", fromDay(view.w1));
        history.replaceState(null, "", h.toString() ? "#" + h.toString() : location.pathname);
    }
    const isDefault = () => Object.keys(DEFAULTS).every(k => JSON.stringify(opt[k]) === JSON.stringify(DEFAULTS[k]));

    /* ---------- recompute + redraw */
    // coalesce bursts of slider events into one recompute per animation frame
    let pending = false;
    function recompute() {
        if (pending) return;
        pending = true;
        requestAnimationFrame(() => {
            pending = false;
            R = compute(DATA, opt);
            infl = null;
            render();
            writeHash();
        });
    }
    function render() {
        renderKpis();
        renderChart();
        renderProbChart();
        renderDetail();
        renderPollsterTable();
        renderPollTable();
        syncControls();
    }

    const metricVal = share => view.metric === "share" ? share : 2 * share - 100;
    const metricLabel = () => view.metric === "share" ? "Fatia do Lula entre os dois candidatos (%)" : "Lula menos Flávio, em pontos (negativo = Flávio na frente)";

    function renderKpis() {
        const c = R.current;
        $("kLula").textContent = pct(c.v + opt.shift);
        $("kFlavio").textContent = pct(100 - c.v - opt.shift);
        $("kPL").textContent = pct(100 * c.p, 0);
        $("kPF").textContent = pct(100 * (1 - c.p), 0);
        const lw = c.v + opt.shift;
        $("avgBar").innerHTML = `<div style="width:${lw}%;background:${LULA}">Lula ${pct(lw)}</div><div style="width:${100 - lw}%;background:${FLAVIO}">Flávio ${pct(100 - lw)}</div>`;
        $("pBar").innerHTML = `<div style="width:${100 * c.p}%;background:${LULA}">${pct(100 * c.p, 0)}</div><div style="width:${100 - 100 * c.p}%;background:${FLAVIO}">${pct(100 - 100 * c.p, 0)}</div>`;
        $("asofLine").textContent = `Pesquisas até ${fdl(R.asOf)} · ${R.runoff.length} pesquisas de 2º turno · faltam ${R.daysLeft} dias para a eleição (25/10/2026)`;
        const gap = 50 - (c.v + opt.shift);
        $("probExplain").textContent = `Como calculo: a média deixa o Lula ${fmt(Math.abs(gap))} ponto ${gap >= 0 ? "abaixo" : "acima"} de 50%. ` +
            `Somo a ela um erro que todas as pesquisas podem cometer juntas (${fmt(opt.errSd)} pontos, com caudas largas), a oscilação até a eleição ` +
            `e o ruído da própria média, e conto em que fração dos cenários o Lula passa de 50%.`;
        $("kNote").textContent = `±${fmt(1.96 * c.se)} ponto só pelo ruído das pesquisas; a previsão ainda soma um erro comum de ${fmt(opt.errSd)} pontos.`;
        const changed = !isDefault();
        $("custom").style.display = changed ? "block" : "none";
        if (changed) {
            $("custom").innerHTML = `Você está vendo <b>os seus próprios ajustes</b>. No modelo que eu publiquei, o Lula tem ${pct(OFFICIAL.current.lula)} da média e ` +
                `${pct(100 * FC.base.p_lula, 0)} de chance. <a href="#" id="resetLink">Voltar ao original</a>`;
            $("resetLink").onclick = e => { e.preventDefault(); resetAll(); };
        }
    }

    /* ---------- main chart */
    function colorOf(p) {
        if (view.color === "mode") return MODE_COLOR[p.mode] || "#999";
        if (view.color === "phase") return p.phase === "post_first_round" ? "#6a3d9a" : "#b2abd2";
        if (view.color === "pollster") return PALETTE[DATA.pollsters.indexOf(p.pollster) % PALETTE.length];
        const h = R.house[p.pollster] || 0;  // lean: red toward Lula, blue toward Flávio
        const s = Math.min(1, Math.abs(h) / 2);
        return h >= 0 ? mix("#bbbbbb", LULA, s) : mix("#bbbbbb", FLAVIO, s);
    }
    function mix(a, b, t) {
        const pa = [1, 3, 5].map(i => parseInt(a.slice(i, i + 2), 16)), pb = [1, 3, 5].map(i => parseInt(b.slice(i, i + 2), 16));
        return "rgb(" + pa.map((x, i) => Math.round(x + (pb[i] - x) * t)).join(",") + ")";
    }

    let geom = null;
    function renderChart() {
        const box = $("chart");
        const W = Math.max(300, box.clientWidth), small = W < 600;
        const H = small ? 300 : 380, m = {l: small ? 34 : 44, r: 12, t: 14, b: 26};
        const w0 = view.w0 != null ? view.w0 : DATA.start, w1 = Math.min(view.w1 != null ? view.w1 : R.asOf, R.asOf);
        const vis = R.runoff.filter(p => p.t >= w0 && p.t <= w1);
        const yv = p => metricVal(view.adjusted ? p.adj : p.y);
        const ser = R.series.filter(s => s.d >= w0 && s.d <= w1);
        let lo = Math.min(...vis.map(yv), ...ser.map(s => metricVal(s.v - 1.96 * s.se))), hi = Math.max(...vis.map(yv), ...ser.map(s => metricVal(s.v + 1.96 * s.se)));
        const mid = metricVal(50);
        lo = Math.min(lo, mid) - (view.metric === "share" ? 0.6 : 1.2); hi = Math.max(hi, mid) + (view.metric === "share" ? 0.6 : 1.2);
        if (!isFinite(lo)) { lo = metricVal(44); hi = metricVal(56); }
        const x = d => m.l + (d - w0) / Math.max(1, w1 - w0) * (W - m.l - m.r);
        const y = v => m.t + (hi - v) / (hi - lo) * (H - m.t - m.b);
        geom = {x, y, W, H, m, w0, w1, vis, yv, small};

        let s = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" id="mainSvg" role="img" aria-label="Gráfico da tendência das pesquisas">`;
        const step = niceStep(hi - lo, small ? 5 : 7);
        for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) {
            const isMid = Math.abs(v - mid) < 1e-9;
            s += `<line x1="${m.l}" x2="${W - m.r}" y1="${y(v)}" y2="${y(v)}" stroke="${isMid ? "#777" : "#eee"}" ${isMid ? 'stroke-dasharray="4 3"' : ""}/>` +
                `<text x="${m.l - 5}" y="${y(v) + 3}" text-anchor="end">${String(+v.toFixed(1)).replace(".", ",")}</text>`;
        }
        const span = w1 - w0, tick = span > 50 ? 14 : span > 20 ? 7 : span > 8 ? 3 : 1;
        for (let d = w1; d >= w0; d -= tick) s += `<text x="${x(d)}" y="${H - 7}" text-anchor="middle">${fd(d)}</text>`;
        for (const e of EVENTS) if (e.d >= w0 && e.d <= w1) {
            s += `<line x1="${x(e.d)}" x2="${x(e.d)}" y1="${m.t}" y2="${H - m.b}" stroke="#bbb" stroke-dasharray="3 3"/>` +
                `<text x="${x(e.d) + 3}" y="${m.t + 9}">${e.label}</text>`;
        }
        if (view.band && ser.length) {
            const up = ser.map(p => `${x(p.d)},${y(metricVal(p.v + opt.shift + 1.96 * p.se))}`), dn = ser.map(p => `${x(p.d)},${y(metricVal(p.v + opt.shift - 1.96 * p.se))}`).reverse();
            s += `<polygon points="${up.concat(dn).join(" ")}" fill="${LULA}" fill-opacity=".10"/>`;
        }
        if (view.rawLine && R.raw.length) {
            const rs = R.raw.filter(p => p.d >= w0 && p.d <= w1);
            s += `<polyline fill="none" stroke="#7a7a7a" stroke-width="2" stroke-dasharray="2 3" points="${rs.map(p => `${x(p.d)},${y(metricVal(p.v + opt.shift))}`).join(" ")}"/>`;
            const lr = rs[rs.length - 1];
            if (lr) s += `<text x="${x(lr.d) - 4}" y="${y(metricVal(lr.v + opt.shift)) - 6}" text-anchor="end" style="fill:#555">sem correção ${fmt(lr.v + opt.shift)}</text>`;
        }
        if (!isDefault() && OFFICIAL.series) {
            const os = OFFICIAL.series.filter(p => toDay(p.date) >= w0 && toDay(p.date) <= w1);
            s += `<polyline fill="none" stroke="#999" stroke-width="1.5" stroke-dasharray="5 4" points="${os.map(p => `${x(toDay(p.date))},${y(metricVal(p.lula))}`).join(" ")}"/>`;
        }
        const maxw = Math.max(...vis.map(p => p.wn), 1e-9);
        const spot = sel.pollster;
        if (view.adjusted) for (const p of vis) {
            if (Math.abs(p.adj - p.y) > 0.05) s += `<line x1="${x(p.t)}" x2="${x(p.t)}" y1="${y(metricVal(p.y))}" y2="${y(metricVal(p.adj))}" stroke="#ccc"/>`;
        }
        // dots, faded when another pollster is in the spotlight; spotlight drawn last
        const order = vis.slice().sort((a, b) => (a.pollster === spot) - (b.pollster === spot));
        for (const p of order) {
            const r = view.sized ? 2.5 + 8 * Math.sqrt(p.wn / maxw) : 4.5;
            const faded = spot && p.pollster !== spot;
            const isSel = sel.poll && sel.poll.id === p.id;
            s += `<circle cx="${x(p.t)}" cy="${y(yv(p))}" r="${r}" fill="${colorOf(p)}" fill-opacity="${faded ? 0.12 : 0.75}" ` +
                `stroke="${isSel ? "#000" : "#fff"}" stroke-width="${isSel ? 2 : 0.8}"/>`;
        }
        if (spot) {
            const mine = vis.filter(p => p.pollster === spot).sort((a, b) => a.t - b.t);
            s += `<polyline fill="none" stroke="${colorOf(mine[0] || {pollster: spot})}" stroke-width="1.5" points="${mine.map(p => `${x(p.t)},${y(yv(p))}`).join(" ")}"/>`;
        }
        s += `<polyline fill="none" stroke="${LULA}" stroke-width="2.6" points="${ser.map(p => `${x(p.d)},${y(metricVal(p.v + opt.shift))}`).join(" ")}"/>`;
        if (hover && hover.kind === "x") {
            const p = R.series.find(q => q.d === hover.d);
            if (p) s += `<line x1="${x(p.d)}" x2="${x(p.d)}" y1="${m.t}" y2="${H - m.b}" stroke="#333" stroke-opacity=".35"/>` +
                `<circle cx="${x(p.d)}" cy="${y(metricVal(p.v + opt.shift))}" r="4" fill="${LULA}"/>`;
        }
        s += `<text x="${m.l + 4}" y="${H - m.b - 6}" style="font-size:10px;fill:#999">${esc(metricLabel())}</text></svg>`;
        box.innerHTML = s;
        attachChartEvents();
        $("legend").innerHTML = legendHtml();
    }
    function niceStep(range, n) {
        const raw = range / n, p = Math.pow(10, Math.floor(Math.log10(raw))), f = raw / p;
        return (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * p;
    }
    function legendHtml() {
        if (view.color === "mode") return Object.keys(MODE_LABEL).filter(k => R.runoff.some(p => p.mode === k))
            .map(k => `<span><i style="background:${MODE_COLOR[k]}"></i>${MODE_LABEL[k]}</span>`).join("");
        if (view.color === "phase") return `<span><i style="background:#b2abd2"></i>Antes do 1º turno (cenário hipotético)</span><span><i style="background:#6a3d9a"></i>Depois do 1º turno</span>`;
        if (view.color === "pollster") return [...new Set(R.runoff.map(p => p.pollster))].map(n =>
            `<span class="lg" data-p="${esc(n)}"><i style="background:${PALETTE[DATA.pollsters.indexOf(n) % PALETTE.length]}"></i>${esc(n)}</span>`).join("");
        return `<span><i style="background:${FLAVIO}"></i>Instituto puxa para o Flávio</span><span><i style="background:#bbb"></i>Neutro</span><span><i style="background:${LULA}"></i>Puxa para o Lula</span>`;
    }

    function nearestPoll(px, py, radius) {
        let best = null, bd = radius * radius;
        for (const p of geom.vis) {
            const dx = geom.x(p.t) - px, dy = geom.y(geom.yv(p)) - py, d = dx * dx + dy * dy;
            if (d < bd) { bd = d; best = p; }
        }
        return best;
    }
    function svgPoint(e) {
        const svg = $("mainSvg"), r = svg.getBoundingClientRect();
        return [(e.clientX - r.left) * geom.W / r.width, (e.clientY - r.top) * geom.H / r.height];
    }
    function attachChartEvents() {
        const svg = $("mainSvg"), tip = $("tip");
        svg.addEventListener("pointermove", e => {
            if (e.pointerType !== "mouse") return;
            const [px, py] = svgPoint(e);
            const p = nearestPoll(px, py, 12);
            if (p) {
                hover = {kind: "poll", p};
                showTip(e, `<b>${esc(p.pollster)}</b> · ${fd(p.a)} a ${fd(p.b)}<br>Lula ${fmt(p.lula)} · Flávio ${fmt(p.flavio)}<br>` +
                    `Entre os dois: ${fmt(p.y)}% · corrigido ${fmt(p.adj)}%<br><span class="sub">Clique para ver detalhes</span>`);
                svg.style.cursor = "pointer";
            } else {
                svg.style.cursor = "crosshair";
                const d = Math.round(geom.w0 + (px - geom.m.l) / (geom.W - geom.m.l - geom.m.r) * (geom.w1 - geom.w0));
                const pt = R.series.find(q => q.d === d);
                if (pt) {
                    const prev = hover && hover.kind === "x" && hover.d === d;
                    hover = {kind: "x", d};
                    if (!prev) renderChartKeepTip();
                    showTip(e, `<b>${fdl(d)}</b><br>Média: Lula ${pct(pt.v + opt.shift)} · Flávio ${pct(100 - pt.v - opt.shift)}<br>Chance do Lula: ${pct(100 * pt.p, 0)}`);
                } else hideTip();
            }
        });
        svg.addEventListener("pointerleave", () => { hover = null; hideTip(); renderChartKeepTip(); });
        svg.addEventListener("click", e => {
            const [px, py] = svgPoint(e);
            const p = nearestPoll(px, py, e.pointerType === "mouse" ? 12 : 24);
            if (p) { sel.poll = p; sel.pollster = p.pollster; }
            else { sel.poll = null; sel.pollster = null; }
            hideTip();
            render();
            if (p && geom.small) $("detail").scrollIntoView({behavior: "smooth", block: "nearest"});
        });
    }
    function renderChartKeepTip() { const t = $("tip").innerHTML; renderChart(); $("tip").innerHTML = t; }
    function showTip(e, html) {
        const tip = $("tip"), wrap = $("chartWrap").getBoundingClientRect();
        tip.innerHTML = html;
        tip.style.display = "block";
        let left = e.clientX - wrap.left + 14, top = e.clientY - wrap.top + 14;
        if (left + tip.offsetWidth > wrap.width) left = e.clientX - wrap.left - tip.offsetWidth - 14;
        tip.style.left = left + "px";
        tip.style.top = top + "px";
    }
    function hideTip() { $("tip").style.display = "none"; }

    /* ---------- selected poll / pollster card */
    function renderDetail() {
        const el = $("detail");
        const p = sel.poll ? R.runoff.find(q => q.id === sel.poll.id) : null;
        const name = sel.pollster;
        if (!p && !name) { el.innerHTML = `<span class="sub">Toque ou clique num ponto para ver a pesquisa. Cada ponto é uma pesquisa; os maiores pesam mais na média de hoje.</span>`; return; }
        const rat = RAT[name] || {}, cyc = (CYC.pollsters || []).find(c => c.pollster === name);
        const mine = R.runoff.filter(q => q.pollster === name);
        let h = `<div class="detail-head"><b>${esc(name)}</b> <button class="chip" id="clearSel">Limpar ✕</button></div>`;
        if (p) {
            const other = p.blank != null || p.undecided != null ? `brancos/nulos ${fmt(p.blank)} · indecisos ${fmt(p.undecided)}` : `outros/indecisos ${fmt(100 - p.lula - p.flavio)}`;
            h += `<div class="dgrid">
                <div><span class="sub">Campo</span><br>${fdl(p.a)} a ${fdl(p.b)}</div>
                <div><span class="sub">Amostra</span><br>${p.n ? p.n.toLocaleString("pt-BR") : "–"}${p.moe ? ` (±${fmt(p.moe)})` : ""}</div>
                <div><span class="sub">Método</span><br>${MODE_LABEL[p.mode] || p.mode}</div>
                <div><span class="sub">Votos totais</span><br><span style="color:${LULA}">Lula ${fmt(p.lula)}</span> · <span style="color:${FLAVIO}">Flávio ${fmt(p.flavio)}</span><br><span class="sub">${other}</span></div>
                <div><span class="sub">Fatia entre os dois</span><br>Lula ${fmt(p.y)}% → ${fmt(p.adj)}% depois de corrigir o viés</div>
                <div><span class="sub">Peso hoje</span><br>${pct(100 * p.wn)} da média</div>
                <div><span class="sub">Fase</span><br>${p.phase === "post_first_round" ? "Depois do 1º turno" : "Antes do 1º turno (cenário hipotético)"}</div>
                <div><span class="sub">Fonte</span><br>${p.url ? `<a href="${esc(p.url)}" target="_blank" rel="noopener">${verif(p.verification)}</a>` : verif(p.verification)}${p.tse ? `<br><span class="sub">TSE ${esc(p.tse)}</span>` : ""}</div>
            </div>`;
        }
        h += `<div class="sub" style="margin-top:8px">Este instituto: ${mine.length} pesquisas de 2º turno · viés de ${sign(R.house[name] || 0)} ponto (${(R.house[name] || 0) >= 0 ? "puxa para o Lula" : "puxa para o Flávio"}) · ` +
            `${grade(rat.grade) === "sem nota" ? "ainda sem nota (histórico curto demais" : `nota ${grade(rat.grade)} (`}${rat.polls ? `${grade(rat.grade) === "sem nota" ? ", " : ""}${rat.polls} pesquisas antigas)` : ")"}` +
            `${cyc ? ` · erro no 1º turno de ${sign(-cyc.mean_margin_error)} pontos na diferença Lula − Flávio` : ""}. As outras pesquisas dele estão destacadas no gráfico.</div>`;
        el.innerHTML = h;
        $("clearSel").onclick = () => { sel.poll = null; sel.pollster = null; render(); };
    }

    /* ---------- probability chart */
    function renderProbChart() {
        const box = $("pChart");
        const W = Math.max(300, box.clientWidth), small = W < 600, H = small ? 170 : 200, m = {l: small ? 34 : 44, r: 12, t: 10, b: 22};
        const ser = R.series.filter(p => p.d >= toDay("2026-09-01"));
        if (!ser.length) { box.innerHTML = ""; return; }
        const d0 = ser[0].d, d1 = ser[ser.length - 1].d;
        const x = d => m.l + (d - d0) / Math.max(1, d1 - d0) * (W - m.l - m.r), y = v => m.t + (1 - v) * (H - m.t - m.b);
        let s = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Chance de vitória ao longo do tempo">`;
        for (const v of [0, .25, .5, .75, 1]) s += `<line x1="${m.l}" x2="${W - m.r}" y1="${y(v)}" y2="${y(v)}" stroke="${v === .5 ? "#888" : "#eee"}"/><text x="${m.l - 5}" y="${y(v) + 3}" text-anchor="end">${v * 100}%</text>`;
        const span = d1 - d0, tick = span > 40 ? 14 : 7;
        for (let d = d1; d >= d0; d -= tick) s += `<text x="${x(d)}" y="${H - 6}" text-anchor="middle">${fd(d)}</text>`;
        if (!isDefault() && FH) s += `<polyline fill="none" stroke="#999" stroke-dasharray="5 4" points="${FH.series.filter(p => toDay(p.date) <= d1).map(p => `${x(toDay(p.date))},${y(p.p_lula)}`).join(" ")}"/>`;
        s += `<polyline fill="none" stroke="${FLAVIO}" stroke-width="2.2" points="${ser.map(p => `${x(p.d)},${y(1 - p.p)}`).join(" ")}"/>`;
        s += `<polyline fill="none" stroke="${LULA}" stroke-width="2.2" points="${ser.map(p => `${x(p.d)},${y(p.p)}`).join(" ")}"/>`;
        const lp = ser[ser.length - 1];
        s += `<text x="${x(lp.d) - 4}" y="${y(lp.p) - 5}" text-anchor="end" style="fill:${LULA};font-weight:bold">Lula ${pct(100 * lp.p, 0)}</text>` +
            `<text x="${x(lp.d) - 4}" y="${y(1 - lp.p) + 13}" text-anchor="end" style="fill:${FLAVIO};font-weight:bold">Flávio ${pct(100 - 100 * lp.p, 0)}</text></svg>`;
        box.innerHTML = s;
    }

    /* ---------- tables */
    let pSort = {k: "lean", dir: 1}, tSort = {k: "end", dir: -1};
    const grade = g => !g ? "–" : g.startsWith("unrated") ? "sem nota" : g;
    const verif = v => ({"verified-primary": "conferida na fonte", "verified-secondary": "conferida na imprensa", "unverified": "não confirmada"}[v] || esc(v));
    function renderPollsterTable() {
        const names = [...new Set(DATA.runoff.map(p => p.pollster))];
        const rows = names.map(n => {
            const mine = R.runoff.filter(p => p.pollster === n), cyc = (CYC.pollsters || []).find(c => c.pollster === n), r = RAT[n] || {};
            return {n, polls: mine.length, lean: R.house[n], grade: grade(r.grade), pm: r.plus_minus, past: r.polls || 0,
                r1: cyc ? -cyc.mean_margin_error : null, wt: mine.reduce((s, p) => s + p.wn, 0), infl: infl ? infl[n] : null,
                excluded: opt.exclude.includes(n) || !gradeOk(n, DATA, opt)};
        });
        const key = pSort.k;
        rows.sort((a, b) => ((a[key] ?? -1e9) > (b[key] ?? -1e9) ? 1 : (a[key] ?? -1e9) < (b[key] ?? -1e9) ? -1 : 0) * pSort.dir);
        const th = (k, l, t) => `<th data-k="${k}" title="${t || ""}">${l}${pSort.k === k ? (pSort.dir > 0 ? " ▲" : " ▼") : ""}</th>`;
        let h = `<tr>${th("n", "Instituto")}<th>Usar</th>${th("polls", "Pesquisas")}${th("lean", "Viés", "Pontos na fatia do Lula em relação ao consenso; negativo puxa para o Flávio")}${th("wt", "Peso", "Fatia na média de hoje")}` +
            `${th("grade", "Nota")}${th("pm", "Mais-menos", "Acerto histórico comparado aos outros institutos; quanto menor, melhor")}${th("r1", "Erro no 1º turno", "Erro na diferença Lula − Flávio nas últimas pesquisas do 1º turno: + exagerou o Lula, − exagerou o Flávio")}` +
            `${th("infl", "Mexe na média", "Quanto este instituto puxa a média: + para o Lula, − para o Flávio (comparado com a média sem ele)")}</tr>`;
        for (const r of rows) {
            h += `<tr class="${sel.pollster === r.n ? "on" : ""} ${r.excluded ? "off" : ""}" data-p="${esc(r.n)}"><td>${esc(r.n)}</td>` +
                `<td><input type="checkbox" class="use" data-p="${esc(r.n)}" ${r.excluded ? "" : "checked"} aria-label="Usar ${esc(r.n)}"></td>` +
                `<td>${r.polls}</td><td style="color:${(r.lean || 0) >= 0 ? LULA : FLAVIO}">${r.lean == null ? "–" : sign(r.lean)}</td><td>${pct(100 * r.wt)}</td>` +
                `<td>${esc(r.grade)}</td><td>${r.pm == null ? "–" : sign(r.pm, 2)}</td><td style="color:${(r.r1 || 0) >= 0 ? LULA : FLAVIO}">${r.r1 == null ? "–" : sign(r.r1)}</td>` +
                `<td style="color:${r.infl == null || -r.infl >= 0 ? LULA : FLAVIO}">${r.infl == null ? "–" : sign(-r.infl, 2)}</td></tr>`;
        }
        $("pollsterTbl").innerHTML = h;
        $("pollsterTbl").querySelectorAll("th[data-k]").forEach(t => t.onclick = () => { pSort = {k: t.dataset.k, dir: pSort.k === t.dataset.k ? -pSort.dir : 1}; renderPollsterTable(); });
        $("pollsterTbl").querySelectorAll("tr[data-p]").forEach(t => t.onclick = e => {
            if (e.target.classList.contains("use")) return;
            sel.pollster = sel.pollster === t.dataset.p ? null : t.dataset.p; sel.poll = null; render();
            $("chartCard").scrollIntoView({behavior: "smooth", block: "start"});
        });
        $("pollsterTbl").querySelectorAll("input.use").forEach(c => c.onchange = () => {
            const n = c.dataset.p;
            opt.exclude = c.checked ? opt.exclude.filter(x => x !== n) : opt.exclude.concat([n]);
            recompute();
        });
    }
    function renderPollTable() {
        let rows = DATA.runoff.map(p => {
            const live = R.runoff.find(q => q.id === p.id);
            return {p, live, pollster: p.pollster, end: p.b, n: p.n || 0, lula: p.lula, flavio: p.flavio, lead: p.lula - p.flavio,
                y: p.y, adj: live ? live.adj : null, w: live ? live.wn : 0};
        });
        if (sel.pollster) rows = rows.filter(r => r.pollster === sel.pollster);
        const k = tSort.k;
        rows.sort((a, b) => (a[k] > b[k] ? 1 : a[k] < b[k] ? -1 : 0) * tSort.dir);
        const th = (k, l) => `<th data-k="${k}">${l}${tSort.k === k ? (tSort.dir > 0 ? " ▲" : " ▼") : ""}</th>`;
        let h = `<tr>${th("pollster", "Instituto")}${th("end", "Campo")}${th("n", "Amostra")}${th("lula", "Lula")}${th("flavio", "Flávio")}${th("lead", "Lula − Flávio")}${th("w", "Peso")}<th>Fonte</th></tr>`;
        for (const r of rows) {
            const p = r.p;
            h += `<tr data-id="${esc(p.id)}" class="${sel.poll && sel.poll.id === p.id ? "on" : ""} ${r.live ? "" : "off"}"><td>${esc(p.pollster)}</td><td>${fd(p.a)} a ${fd(p.b)}</td>` +
                `<td>${p.n ? p.n.toLocaleString("pt-BR") : "–"}</td><td>${fmt(p.lula)}</td><td>${fmt(p.flavio)}</td><td style="color:${r.lead >= 0 ? LULA : FLAVIO}">${sign(r.lead)}</td>` +
                `<td>${r.live ? pct(100 * r.w) : "fora"}</td><td>${p.url ? `<a href="${esc(p.url)}" target="_blank" rel="noopener">${verif(p.verification)}</a>` : verif(p.verification)}</td></tr>`;
        }
        $("pollTbl").innerHTML = h;
        $("pollFilter").textContent = sel.pollster ? `Mostrando só ${sel.pollster}. ` : "";
        $("pollTbl").querySelectorAll("th[data-k]").forEach(t => t.onclick = () => { tSort = {k: t.dataset.k, dir: tSort.k === t.dataset.k ? -tSort.dir : 1}; renderPollTable(); });
        $("pollTbl").querySelectorAll("tr[data-id]").forEach(t => t.onclick = e => {
            if (e.target.tagName === "A") return;
            const p = R.runoff.find(q => q.id === t.dataset.id);
            if (!p) return;
            sel.poll = p; sel.pollster = p.pollster;
            if (view.w0 != null && p.t < view.w0) view.w0 = null;
            render();
            $("chartCard").scrollIntoView({behavior: "smooth", block: "start"});
        });
    }

    /* ---------- controls */
    function syncControls() {
        const win = opt.smoother === "window", sp = opt.smoother === "spline";
        $("halfLife").min = sp ? 1 : win ? 3 : 2; $("halfLife").max = sp ? 6 : win ? 45 : 30; $("halfLife").step = sp ? 0.1 : 1;
        $("halfLife").value = sp ? opt.splineLog : win ? opt.window : opt.halfLife;
        $("smoother").value = opt.smoother;
        $("halfLifeL").textContent = {exp: "Meia-vida", gauss: "Desvio da gaussiana", window: "Tamanho da janela", spline: "Rigidez da spline"}[opt.smoother];
        if (sp) {
            const lam = Math.pow(10, opt.splineLog), pp = 1 / (1 + lam);
            $("halfLifeV").textContent = `λ = ${lam >= 100 ? Math.round(lam).toLocaleString("pt-BR") : fmt(lam)} · p = ${pp.toExponential(1).replace(".", ",")} · ~${fmt(width(opt), 0)} dias`;
        } else $("halfLifeV").textContent = `${win ? opt.window : opt.halfLife} dias`;
        $("winPresets").style.display = win ? "block" : "none";
        document.querySelectorAll("[data-wlen]").forEach(b => b.classList.toggle("on", +b.dataset.wlen === opt.window));
        $("smootherV").textContent = {exp: "padrão", gauss: "usa pesquisas dos dois lados", window: "todas pesam igual", spline: "curva suave pelos dois lados"}[opt.smoother];
        $("houseStrength").value = opt.houseStrength; $("houseStrengthV").textContent = `${Math.round(100 * opt.houseStrength)}%`;
        $("r1Weight").value = opt.r1Weight; $("r1WeightV").textContent = `${Math.round(100 * opt.r1Weight)}%`;
        $("shrink").value = opt.shrink; $("shrinkV").textContent = fmt(opt.shrink);
        $("errSd").value = opt.errSd; $("errSdV").textContent = `${fmt(opt.errSd)} pontos`;
        $("shift").value = opt.shift;
        $("shiftV").textContent = opt.shift === 0 ? "nenhum (padrão)"
            : opt.shift < 0 ? `${fmt(-opt.shift)} ponto a favor do Flávio (como se as pesquisas exagerassem o Lula)`
            : `${fmt(opt.shift)} ponto a favor do Lula (como se as pesquisas subestimassem o Lula)`;
        const r1shift = FC && FC.stress ? FC.stress.shift_pts : -1.7;
        document.querySelectorAll("[data-shift]").forEach(b => b.classList.toggle("on",
            Math.abs(opt.shift - (b.dataset.shift === "r1" ? Math.round(r1shift * 10) / 10 : 0)) < 1e-9));
        for (const k of ["house", "useR1", "rating", "size", "freq", "pre", "unverified"]) $(k).checked = opt[k];
        for (const k of ["shrink", "houseStrength", "useR1"]) $(k).disabled = !opt.house;
        $("r1Weight").disabled = !opt.house || !opt.useR1;
        const asOf = R.asOf;
        $("asOf").value = asOf - DATA.start; $("asOfV").textContent = asOf === DATA.lastDay ? "hoje" : fdl(asOf);
        document.body.classList.toggle("simple", view.mode === "simple");
        document.body.classList.toggle("pro", view.mode === "pro");
        document.querySelectorAll("[data-view]").forEach(b => b.classList.toggle("on", b.dataset.view === view.mode));
        $("modeHint").textContent = {
            simple: "Mostra o essencial.",
            pro: "Os ajustes principais, as tabelas dos institutos e a máquina do tempo.",
            full: "O painel inteiro, com uma explicação curta para cada ajuste.",
        }[view.mode] || "";
        $("minGrade").value = opt.minGrade; $("keepUnrated").checked = opt.keepUnrated; $("keepUnrated").disabled = !opt.minGrade;
        const kept = DATA.pollsters.filter(n => gradeOk(n, DATA, opt) && !opt.exclude.includes(n)).length;
        $("minGradeV").textContent = `${kept} de ${DATA.pollsters.length} institutos`;
        document.querySelectorAll("[data-metric]").forEach(b => b.classList.toggle("on", b.dataset.metric === view.metric));
        document.querySelectorAll("[data-win]").forEach(b => b.classList.toggle("on", b.dataset.win === currentWin()));
        $("colorBy").value = view.color;
        $("adjusted").checked = view.adjusted; $("band").checked = view.band; $("sized").checked = view.sized; $("rawLine").checked = view.rawLine;
        const w0 = view.w0 != null ? view.w0 : DATA.start, w1 = view.w1 != null ? view.w1 : DATA.lastDay;
        $("win0").value = w0 - DATA.start; $("win1").value = w1 - DATA.start;
        $("winV").textContent = `${fdl(w0)} → ${fdl(Math.min(w1, R.asOf))}`;
        $("modes").innerHTML = Object.keys(MODE_LABEL).filter(k => DATA.runoff.some(p => p.mode === k)).map(k =>
            `<button class="chip ${opt.excludeModes.includes(k) ? "" : "on"}" data-mode="${k}">${MODE_LABEL[k]}</button>`).join("");
        document.querySelectorAll("[data-mode]").forEach(b => b.onclick = () => {
            const k = b.dataset.mode;
            opt.excludeModes = opt.excludeModes.includes(k) ? opt.excludeModes.filter(x => x !== k) : opt.excludeModes.concat([k]);
            recompute();
        });
    }
    function currentWin() {
        if (view.w0 == null && view.w1 == null) return "all";
        if (view.w1 == null && view.w0 === FIRST_ROUND) return "r2";
        if (view.w1 == null && view.w0 === DATA.lastDay - 30) return "30";
        if (view.w1 == null && view.w0 === DATA.lastDay - 14) return "14";
        return "";
    }
    function bindControls() {
        const num = (id, k, live) => $(id).addEventListener(live ? "input" : "change", () => { opt[k] = parseFloat($(id).value); recompute(); });
        $("halfLife").addEventListener("input", () => {
            opt[{window: "window", spline: "splineLog"}[opt.smoother] || "halfLife"] = parseFloat($("halfLife").value); recompute();
        });
        document.querySelectorAll("[data-wlen]").forEach(b => b.onclick = () => { opt.window = +b.dataset.wlen; recompute(); });
        num("shrink", "shrink", true); num("errSd", "errSd", true); num("shift", "shift", true);
        num("houseStrength", "houseStrength", true); num("r1Weight", "r1Weight", true);
        $("smoother").onchange = () => { opt.smoother = $("smoother").value; recompute(); };
        for (const k of ["house", "useR1", "rating", "size", "freq", "pre", "unverified"]) $(k).onchange = () => { opt[k] = $(k).checked; recompute(); };
        $("asOf").addEventListener("input", () => { stopPlay(); const d = DATA.start + parseInt($("asOf").value, 10); opt.asOf = d >= DATA.lastDay ? null : d; recompute(); });
        $("play").onclick = () => playing ? stopPlay() : startPlay();
        document.querySelectorAll("[data-metric]").forEach(b => b.onclick = () => { view.metric = b.dataset.metric; render(); writeHash(); });
        document.querySelectorAll("[data-view]").forEach(b => b.onclick = () => { view.mode = b.dataset.view; render(); writeHash(); });
        $("minGrade").onchange = () => { opt.minGrade = $("minGrade").value; recompute(); };
        document.querySelectorAll("[data-shift]").forEach(b => b.onclick = () => {
            opt.shift = b.dataset.shift === "r1" ? Math.round((FC && FC.stress ? FC.stress.shift_pts : -1.7) * 10) / 10 : 0;
            recompute();
        });
        $("keepUnrated").onchange = () => { opt.keepUnrated = $("keepUnrated").checked; recompute(); };
        document.querySelectorAll("[data-win]").forEach(b => b.onclick = () => {
            const w = b.dataset.win;
            view.w1 = null;
            view.w0 = w === "all" ? null : w === "r2" ? FIRST_ROUND : DATA.lastDay - parseInt(w, 10);
            render(); writeHash();
        });
        const winSlide = () => {
            let a = DATA.start + parseInt($("win0").value, 10), b = DATA.start + parseInt($("win1").value, 10);
            if (b - a < 3) { if (document.activeElement === $("win0")) a = b - 3; else b = a + 3; }
            view.w0 = a <= DATA.start ? null : a; view.w1 = b >= DATA.lastDay ? null : b;
            render(); writeHash();
        };
        $("win0").addEventListener("input", winSlide); $("win1").addEventListener("input", winSlide);
        $("colorBy").onchange = () => { view.color = $("colorBy").value; render(); writeHash(); };
        for (const k of ["adjusted", "band", "sized", "rawLine"]) $(k).onchange = () => { view[k] = $(k).checked; render(); writeHash(); };
        $("reset").onclick = resetAll;
        $("share").onclick = () => {
            writeHash();
            const done = () => { $("share").textContent = "Link copiado ✓"; setTimeout(() => $("share").textContent = "Copiar link desta visualização", 1800); };
            if (navigator.clipboard) navigator.clipboard.writeText(location.href).then(done, () => prompt("Copie este link:", location.href));
            else prompt("Copie este link:", location.href);
        };
        $("inflBtn").onclick = () => {
            $("inflBtn").textContent = "Calculando…";
            setTimeout(() => { infl = influence(DATA, opt); renderPollsterTable(); $("inflBtn").textContent = "Recalcular a influência"; pSort = {k: "infl", dir: 1}; renderPollsterTable(); }, 20);
        };
        let rt;
        window.addEventListener("resize", () => { clearTimeout(rt); rt = setTimeout(render, 120); });
    }
    function resetAll() {
        opt = JSON.parse(JSON.stringify(DEFAULTS));
        view = {metric: "share", color: "lean", adjusted: false, band: true, sized: true, rawLine: false, mode: view.mode, w0: null, w1: null};
        sel = {poll: null, pollster: null};
        stopPlay();
        recompute();
    }
    function startPlay() {
        $("play").textContent = "❚❚ Pausar";
        let d = opt.asOf == null || opt.asOf >= DATA.lastDay ? DATA.start + 10 : opt.asOf;
        playing = setInterval(() => {
            d += 1;
            if (d >= DATA.lastDay) { opt.asOf = null; recompute(); stopPlay(); return; }
            opt.asOf = d; recompute();
        }, 140);
    }
    function stopPlay() { if (playing) clearInterval(playing); playing = null; $("play").textContent = "▶ Rever a campanha"; }

    /* ---------- static extras */
    function renderExtras(bt, sens, diag) {
        if (bt) {
            let t = `<tr><th>2º turno</th><th>Média 5 dias antes (fatia do PT)</th><th>Resultado</th><th>Erro</th><th>Chance do PT</th></tr>`;
            for (const r of bt.races) t += `<tr><td>${r.year} ${esc(r.pt_candidate)} x ${esc(r.opponent)}</td><td>${fmt(r.average_pt_share)}</td><td>${fmt(r.actual_pt_share)}</td><td>${sign(r.error)}</td><td>${pct(100 * r.p_pt_win, 0)} (${r.pt_won ? "venceu" : "perdeu"})</td></tr>`;
            $("btTbl").innerHTML = t;
        }
        let c = `<tr><th>Instituto</th><th>Pesquisas</th><th>Erro (Lula − Flávio)</th><th>Erro absoluto</th></tr>`;
        for (const q of CYC.pollsters || []) c += `<tr><td>${esc(q.pollster)}</td><td>${q.polls}</td><td style="color:${q.mean_margin_error <= 0 ? LULA : FLAVIO}">${sign(-q.mean_margin_error)}</td><td>${fmt(q.mean_abs_error)}</td></tr>`;
        $("cycTbl").innerHTML = c;
    }

    /* ---------- boot */
    const get = u => fetch(u).then(r => r.ok ? r.json() : null).catch(() => null);
    Promise.all(["data/average.json", "data/forecast.json", "data/forecast_history.json", "data/pollster_ratings.json",
        "data/cycle2026_first_round.json", "data/backtest.json", "data/ratings_sensitivity.json", "data/house_diagnostics.json"].map(get))
        .then(([avg, fc, fh, rat, cyc, bt, sens, diag]) => {
            OFFICIAL = avg; FC = fc; FH = fh; RAT = rat || {}; CYC = cyc || {pollsters: []};
            const runoff = prepare(avg.polls, "runoff"), r1 = prepare(avg.first_round_polls, "r1");
            DATA = {runoff, r1, start: toDay(avg.params.start), lastDay: toDay(avg.as_of),
                pollsters: [...new Set(runoff.map(p => p.pollster))].sort(), grades: {}};
            for (const n of DATA.pollsters) DATA.grades[n] = ((RAT[n] || {}).grade || "").split(" ")[0];
            const span = DATA.lastDay - DATA.start;
            for (const id of ["asOf", "win0", "win1"]) { $(id).max = span; $(id).min = id === "asOf" ? 10 : 0; }
            opt = readHash();
            bindControls();
            renderExtras(bt, sens, diag);
            recompute();
        })
        .catch(e => { $("asofLine").textContent = "Não consegui carregar os dados: " + e; });
})();
