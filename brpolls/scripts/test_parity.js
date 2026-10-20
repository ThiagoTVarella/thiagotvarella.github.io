#!/usr/bin/env node
// Parity check: the browser model (app.js) must reproduce the Python outputs
// in data/average.json and data/forecast.json under DEFAULTS.
// Run from brpolls/:  node scripts/test_parity.js
const path = require("path");
const {prepare, compute, DEFAULTS, toDay} = require("../app.js");
const avg = require(path.join(__dirname, "../data/average.json"));
const fc = require(path.join(__dirname, "../data/forecast.json"));

const runoff = prepare(avg.polls, "runoff"), r1 = prepare(avg.first_round_polls, "r1");
const data = {runoff, r1, start: toDay(avg.params.start), lastDay: toDay(avg.as_of),
    pollsters: [...new Set(runoff.map(p => p.pollster))].sort()};
const R = compute(data, JSON.parse(JSON.stringify(DEFAULTS)));

let failed = false;
function check(name, got, want, tol) {
    const diff = Math.abs(got - want);
    const ok = Number.isFinite(diff) && diff < tol;
    if (!ok) failed = true;
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}: js=${got.toFixed(4)} ref=${want.toFixed(4)} |diff|=${diff.toFixed(4)} (tol ${tol})`);
}

check("average (Lula share)", R.current.v, avg.current.lula, 0.05);

let worst = 0, worstName = "-";
for (const [k, h] of Object.entries(avg.house_effects)) {
    const d = Math.abs((R.house[k] || 0) - h.effect);
    if (!(d <= worst)) { worst = d; worstName = k; }
}
const okH = Number.isFinite(worst) && worst < 0.05;
if (!okH) failed = true;
console.log(`${okH ? "PASS" : "FAIL"}  house effects: max |diff|=${worst.toFixed(4)} (${worstName}) over ${Object.keys(avg.house_effects).length} pollsters (tol 0.05)`);

check("win probability (Lula)", R.current.p, fc.base.p_lula, 0.03);

process.exit(failed ? 1 : 0);
