// Aba "Solo e voto": seis mapas municipais ligados (passe o mouse num município e ele acende em todos).
// Dados montados por scripts/soil/build_soil.py; geometria simplificada do IBGE (malha municipal 2024, Biomas e Solos 1:5.000.000).
(function () {
    const $ = id => document.getElementById(id);
    const D = "data/soil/";
    const fmt = (x, d = 1) => x == null ? "–" : x.toLocaleString("pt-BR", { minimumFractionDigits: d, maximumFractionDigits: d });
    const LULA = "#c0392b", FLAVIO = "#1f5fa8", PALE = "#ebe7de";

    // cada painel: chave em vars.json, faixas (as mesmas do build) e cores, do claro ao escuro
    const PANELS = [
        { id: "cer", n: 1, title: "O Cerrado", kind: "bio",
          text: "A vegetação natural do Planalto Central: chapadas altas e planas, com cinco ou seis meses de seca por ano.",
          bins: [0, 1, 50, 90, 100], cols: ["#f1efe8", "#ecdcb4", "#ddb867", "#b88a2a"], unit: "% da área no Cerrado" },
        { id: "lat", n: 2, title: "Latossolos", kind: "sol",
          text: "Solos velhos, fundos, planos e bem drenados, bons para máquina. Mas ácidos e cheios de alumínio: até os anos 70, quase ninguém plantava grão neles.",
          bins: [0, 10, 40, 70, 100], cols: ["#f1efe8", "#e9c3ad", "#cf7f5a", "#a3472a"], unit: "% da área em Latossolos" },
        { id: "soy", n: 3, title: "Soja, 2024",
          text: "Com calcário, fósforo e soja adaptada ao clima tropical (Embrapa, anos 70 e 80), esse solo virou a maior área de soja do mundo.",
          bins: [0, 1, 5, 15, 30, 100], cols: ["#f1efe8", "#d6eac0", "#a3cf86", "#5ea858", "#24733a"], unit: "% da área do município plantada com soja" },
        { id: "sul", n: 4, title: "Nascidos no Sul",
          text: "Quem abriu as fazendas veio muito do Paraná, de Santa Catarina e do Rio Grande do Sul, por colonizadoras privadas e projetos do Incra.",
          bins: [0, 1, 5, 15, 30, 100], cols: ["#f1efe8", "#e2d8ee", "#bca5d9", "#8b69bb", "#573690"], unit: "% dos moradores nascidos no PR, SC ou RS (2010)" },
        { id: "pbf", n: 5, title: "Bolsa Família, 2026",
          text: "Onde a soja chegou com gente de fora, a renda subiu e o Bolsa Família é menor. É o mapa mais parecido com o do voto.",
          bins: [0, 20, 35, 50, 65, 100], cols: ["#f1efe8", "#fbd9b5", "#f3a868", "#d9702a", "#9c4410"], unit: "famílias no programa por 100 domicílios (ago/2026)" },
        { id: "fl", n: 6, title: "2º turno, 2026",
          text: "Votos válidos entre os dois. Azul: Flávio na frente; vermelho: Lula.",
          bins: [0, 30, 40, 50, 60, 70, 100], cols: ["#9e2a1f", "#d0604f", "#eeb3a8", "#a9c4e6", "#5b8fd0", "#1c4f94"], unit: "% do Flávio" },
    ];
    const LABEL = { cer: "Cerrado", lat: "Latossolos", soy: "Soja", sul: "Nascidos no Sul", pbf: "Bolsa Família", fl: "Flávio" };

    let V, K, idx, feats, ufMesh, bioF, solF, bbox, inited = false, hover = null, pinned = null;
    const views = [];   // {p, cv, ov, ctx, octx, s, tx, ty, w, h, dpr}

    function colorOf(p, x) {
        if (x == null) return "#ddd";
        for (let i = p.bins.length - 2; i >= 0; i--) if (x >= p.bins[i]) return p.cols[i];
        return p.cols[0];
    }
    function binLabel(p, i) {
        const lo = p.bins[i], hi = p.bins[i + 1];
        if (lo === 0) return "<" + hi;
        if (hi === 100) return lo + "+";
        return lo + "–" + hi;
    }

    // ---------- geometria ----------
    function ringPath(path, ring) {
        ring.forEach((pt, i) => i ? path.lineTo(pt[0], pt[1]) : path.moveTo(pt[0], pt[1]));
        path.closePath();
    }
    function geomPath(g) {
        const path = new Path2D(), polys = g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : [];
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const poly of polys) for (const ring of poly) {
            ringPath(path, ring);
            for (const [x, y] of ring) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
        }
        return { path, bb: [x0, y0, x1, y1] };
    }
    function lineMesh(m) {
        const path = new Path2D();
        for (const line of m.coordinates) line.forEach((pt, i) => i ? path.lineTo(pt[0], pt[1]) : path.moveTo(pt[0], pt[1]));
        return path;
    }

    // ---------- desenho ----------
    function layout() {
        for (const v of views) {
            const w = v.cv.parentElement.clientWidth; if (!w) continue;
            const dpr = window.devicePixelRatio || 1, pad = 4;
            const sx = (w - 2 * pad) / (bbox[2] - bbox[0]), h = Math.round((bbox[3] - bbox[1]) * sx + 2 * pad);
            for (const c of [v.cv, v.ov]) { c.width = w * dpr; c.height = h * dpr; c.style.width = w + "px"; c.style.height = h + "px"; }
            Object.assign(v, { w, h, dpr, s: sx * dpr, tx: (pad - bbox[0] * sx) * dpr, ty: (pad + bbox[3] * sx) * dpr });
            draw(v); drawOverlay(v);
        }
    }
    const setT = (ctx, v) => ctx.setTransform(v.s, 0, 0, -v.s, v.tx, v.ty);
    function draw(v) {
        const ctx = v.ctx, p = v.p;
        ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, v.cv.width, v.cv.height);
        setT(ctx, v);
        const lw = 1 / v.s;
        if (p.kind === "bio" || p.kind === "sol") {
            // mapa de verdade (polígonos do IBGE), não por município
            const list = p.kind === "bio" ? bioF : solF;
            for (const f of list) {
                const on = p.kind === "bio" ? f.props.NOM_BIOMA === "Cerrado" : f.props.k === "L";
                ctx.fillStyle = on ? p.cols[p.cols.length - 1] : PALE;
                ctx.fill(f.path); ctx.lineWidth = 0.6 * lw; ctx.strokeStyle = ctx.fillStyle; ctx.stroke(f.path);
            }
        } else {
            for (const f of feats) {
                const r = V[f.cd]; ctx.fillStyle = colorOf(p, r ? r[idx[p.id]] : null);
                ctx.fill(f.path); ctx.lineWidth = 0.5 * lw; ctx.strokeStyle = ctx.fillStyle; ctx.stroke(f.path);
            }
        }
        ctx.lineWidth = 0.9 * v.dpr * lw; ctx.strokeStyle = "rgba(255,255,255,.9)"; ctx.stroke(ufMesh);
    }
    function drawOverlay(v) {
        const ctx = v.octx;
        ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, v.ov.width, v.ov.height);
        const f = pinned || hover; if (!f) return;
        setT(ctx, v);
        ctx.lineWidth = 2.2 * v.dpr / v.s; ctx.strokeStyle = "#fff"; ctx.stroke(f.path);
        ctx.lineWidth = 1.2 * v.dpr / v.s; ctx.strokeStyle = "#111"; ctx.stroke(f.path);
        // municípios minúsculos: um círculo em volta para achar
        const [x0, y0, x1, y1] = f.bb, r = Math.max(x1 - x0, y1 - y0) * v.s / v.dpr;
        if (r < 8) { ctx.beginPath(); ctx.arc((x0 + x1) / 2, (y0 + y1) / 2, 8 * v.dpr / v.s, 0, 7); ctx.stroke(); }
    }
    function pick(v, ev) {
        const rect = v.cv.getBoundingClientRect(), px = (ev.clientX - rect.left) * v.dpr, py = (ev.clientY - rect.top) * v.dpr;
        const mx = (px - v.tx) / v.s, my = (v.ty - py) / v.s;
        setT(v.ctx, v);
        for (const f of feats) {
            const b = f.bb; if (mx < b[0] || mx > b[2] || my < b[1] || my > b[3]) continue;
            if (v.ctx.isPointInPath(f.path, px, py)) return f;
        }
        return null;
    }
    function setHover(f, ev) {
        if (f === hover && !ev) return;
        hover = f; views.forEach(drawOverlay); tip(pinned || hover, ev);
    }
    function tip(f, ev) {
        const t = $("sTip");
        if (!f) { t.hidden = true; return; }
        const r = V[f.cd] || [];
        const row = (k, txt) => `<tr><td>${LABEL[k]}</td><td>${txt}</td></tr>`;
        t.innerHTML = `<b>${f.nm} (${f.uf})</b><table>` +
            row("cer", fmt(r[idx.cer], 0) + "% da área") + row("lat", fmt(r[idx.lat], 0) + "% da área") +
            row("soy", fmt(r[idx.soy]) + "% da área") + row("sul", fmt(r[idx.sul]) + "% dos moradores") +
            row("pbf", (r[idx.pbf] >= 100 ? "100+" : fmt(r[idx.pbf], 0)) + " por 100 domicílios") +
            `<tr><td>2º turno</td><td><span class="flavio">Flávio ${fmt(r[idx.fl])}%</span> · <span class="lula">Lula ${fmt(r[idx.fl] == null ? null : 100 - r[idx.fl])}%</span></td></tr></table>`;
        t.hidden = false;
        if (ev && ev.clientX != null) {
            const W = window.innerWidth, tw = t.offsetWidth, th = t.offsetHeight;
            let x = ev.clientX + 14, y = ev.clientY + 14;
            if (x + tw > W - 8) x = ev.clientX - tw - 14;
            if (x < 8) x = 8;
            if (y + th > window.innerHeight - 8) y = ev.clientY - th - 14;
            t.style.left = x + "px"; t.style.top = y + "px";
        }
    }

    // ---------- faixas: voto do Flávio por faixa de cada variável ----------
    function strip(p) {
        if (p.id === "fl") return corrStrip();
        const st = STATS[p.id]; if (!st) return "";
        // barras saindo da linha de 50%: para cima, Flávio na frente naquela faixa; para baixo, Lula
        const W = 300, H = 104, m = { l: 26, r: 4, t: 14, b: 18 }, n = st.bins.length, bw = (W - m.l - m.r) / n;
        const Y = f => m.t + (H - m.t - m.b) * (80 - f) / 60;   // eixo de 20% a 80%
        let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Voto no Flávio por faixa de ${LABEL[p.id]}">`;
        for (const g of [30, 50, 70]) s += `<line x1="${m.l}" x2="${W - m.r}" y1="${Y(g)}" y2="${Y(g)}" stroke="${g === 50 ? "#888" : "#e6e6e6"}"${g === 50 ? ' stroke-dasharray="3 3"' : ""}/><text x="${m.l - 4}" y="${Y(g) + 3}" text-anchor="end" font-size="9" fill="#999">${g}%</text>`;
        st.bins.forEach((b, i) => {
            if (b.fl == null) return;
            const x = m.l + i * bw + 3, w = bw - 6, y0 = Y(50), y1 = Y(Math.max(20, Math.min(80, b.fl))), up = b.fl >= 50;
            s += `<rect x="${x}" y="${Math.min(y0, y1)}" width="${w}" height="${Math.max(1, Math.abs(y1 - y0))}" rx="2" fill="${p.cols[i]}" stroke="#aaa" stroke-width=".6"><title>${binLabel(p, i)}: ${b.n} municípios, Flávio ${fmt(b.fl)}%</title></rect>`;
            s += `<text x="${x + w / 2}" y="${up ? y1 - 3 : y1 + 10}" text-anchor="middle" font-size="10.5" fill="#333">${fmt(b.fl, 0)}%</text>`;
            s += `<text x="${x + w / 2}" y="${H - 4}" text-anchor="middle" font-size="10" fill="#777">${binLabel(p, i)}</text>`;
        });
        return `<div class="sub" style="margin-top:6px">Voto no Flávio por faixa (${p.unit.replace(/ \(.*\)/, "")}). Acima da linha, ele ganhou:</div>` + s + "</svg>";
    }
    function corrStrip() {
        const ks = ["cer", "lat", "soy", "sul", "pbf"], W = 300, rowH = 18, H = ks.length * rowH + 22, x0 = 104, x1 = W - 6, mid = (x0 + x1) / 2, half = (x1 - x0) / 2;
        let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Correlação de cada mapa com o voto no Flávio">`;
        s += `<line x1="${mid}" x2="${mid}" y1="0" y2="${H - 18}" stroke="#bbb"/>`;
        for (const t of [-1, -0.5, 0.5, 1]) s += `<text x="${mid + t * half}" y="${H - 4}" text-anchor="${t === 1 ? "end" : t === -1 ? "start" : "middle"}" font-size="9" fill="#999">${fmt(t, t % 1 ? 1 : 0)}</text>`;
        ks.forEach((k, i) => {
            const r = STATS[k].r, y = 2 + i * rowH, w = Math.abs(r) * half, p = PANELS.find(q => q.id === k);
            s += `<text x="${x0 - 8}" y="${y + 12}" text-anchor="end" font-size="11" fill="#333">${LABEL[k]}</text>`;
            s += `<rect x="${r < 0 ? mid - w : mid}" y="${y + 3}" width="${w}" height="11" rx="2" fill="${p.cols[p.cols.length - 1]}"/>`;
            s += `<text x="${r < 0 ? mid + 4 : mid + w + 4}" y="${y + 12}" font-size="11" fill="#333">${fmt(r, 2)}</text>`;
        });
        s += "</svg>";
        return `<div class="sub" style="margin-top:6px">Quanto cada mapa anda junto com o voto no Flávio (correlação entre municípios, pesada pelos votos):</div>` + s;
    }

    function legend(p) {
        if (p.kind === "bio") return `<span class="sw" style="background:${p.cols[3]}"></span>Cerrado <span class="sw" style="background:${PALE}"></span>outros biomas`;
        if (p.kind === "sol") return `<span class="sw" style="background:${p.cols[3]}"></span>Latossolos <span class="sw" style="background:${PALE}"></span>outros solos`;
        return p.cols.map((c, i) => `<span class="nw"><span class="sw" style="background:${c}"></span>${binLabel(p, i)}</span>`).join(" ") + `<br><span class="sub">${p.unit}</span>`;
    }

    let STATS;
    async function init() {
        inited = true;
        const grid = $("sGrid");
        grid.innerHTML = PANELS.map(p => `<div class="sPanel" data-id="${p.id}"><div class="sHead"><span class="sNum">${p.n}</span>${p.title}</div>
            <div class="sTxt">${p.text}</div><div class="sMap"><canvas></canvas><canvas class="ov"></canvas></div>
            <div class="sLeg">${legend(p)}</div><div class="sStrip"></div></div>`).join("");
        try {
            const get = f => fetch(D + f + "?v=1").then(r => { if (!r.ok) throw new Error(f + " " + r.status); return r.json(); });
            const [vars, mt, bt, stp] = await Promise.all([get("vars.json"), get("mun.topo.json"), get("bio.topo.json"), get("sol.topo.json")]);
            K = vars.keys; idx = Object.fromEntries(K.map((k, i) => [k, i])); V = vars.rows; STATS = vars.stats;
            const UF = { 11: "RO", 12: "AC", 13: "AM", 14: "RR", 15: "PA", 16: "AP", 17: "TO", 21: "MA", 22: "PI", 23: "CE", 24: "RN", 25: "PB", 26: "PE", 27: "AL", 28: "SE", 29: "BA", 31: "MG", 32: "ES", 33: "RJ", 35: "SP", 41: "PR", 42: "SC", 43: "RS", 50: "MS", 51: "MT", 52: "GO", 53: "DF" };
            feats = topojson.feature(mt, mt.objects.mun).features.map(f => Object.assign(geomPath(f.geometry), { cd: f.properties.CD_MUN, nm: f.properties.NM_MUN, uf: UF[f.properties.CD_MUN.slice(0, 2)] }));
            ufMesh = lineMesh(topojson.mesh(mt, mt.objects.uf));
            bioF = topojson.feature(bt, bt.objects.bio).features.map(f => Object.assign(geomPath(f.geometry), { props: f.properties }));
            solF = topojson.feature(stp, stp.objects.sol).features.map(f => Object.assign(geomPath(f.geometry), { props: f.properties }));
            bbox = feats.reduce((a, f) => [Math.min(a[0], f.bb[0]), Math.min(a[1], f.bb[1]), Math.max(a[2], f.bb[2]), Math.max(a[3], f.bb[3])], [Infinity, Infinity, -Infinity, -Infinity]);
        } catch (e) { $("sStatus").textContent = "Não consegui carregar os dados (" + e.message + ")."; return; }
        $("sStatus").textContent = "";
        grid.querySelectorAll(".sPanel").forEach(el => {
            const p = PANELS.find(q => q.id === el.dataset.id), [cv, ov] = el.querySelectorAll("canvas");
            const v = { p, cv, ov, ctx: cv.getContext("2d"), octx: ov.getContext("2d") };
            views.push(v);
            el.querySelector(".sStrip").innerHTML = strip(p);
            ov.addEventListener("mousemove", ev => setHover(pick(v, ev), ev));
            ov.addEventListener("mouseleave", () => setHover(null));
            ov.addEventListener("click", ev => { const f = pick(v, ev); pinned = f && f !== pinned ? f : null; hover = f; views.forEach(drawOverlay); tip(pinned || f, ev); });
        });
        // busca por município
        const dl = $("sList"), byName = new Map();
        for (const f of feats) byName.set(`${f.nm} (${f.uf})`, f);
        dl.innerHTML = [...byName.keys()].sort((a, b) => a.localeCompare(b, "pt-BR")).map(n => `<option value="${n}">`).join("");
        $("sFind").addEventListener("change", e => {
            const f = byName.get(e.target.value.trim()); if (!f) return;
            pinned = f; views.forEach(drawOverlay);
            const r = e.target.getBoundingClientRect();
            tip(f, { clientX: r.left - 14, clientY: r.bottom - 6 });
        });
        document.addEventListener("keydown", e => { if (e.key === "Escape") { pinned = null; setHover(null); } });
        window.addEventListener("scroll", () => { if (!hover) $("sTip").hidden = true; }, { passive: true });   // o contorno fica; a caixa não segue a rolagem
        layout();
    }

    let rt;
    window.addEventListener("resize", () => { if (!inited || $("tabSoil").hidden || !feats) return; clearTimeout(rt); rt = setTimeout(layout, 120); });
    window.SoilTab = { show() { if (!inited) init(); else if (feats) layout(); } };
})();
