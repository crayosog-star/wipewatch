'use strict';
// Raid cost calculator. Renderer-only; depends on helpers from app.js (h, $, $$).
// IMPORTANT: the default numbers are community figures written from memory and were NOT verified against the
// current game patch (the online cross-check was refused). Every number can be edited and is saved locally.

const RAID_DEFAULT = {
  explosives: [
    { id: 'c4', name: 'C4 (timed explosive)', sulfur: 2200 },
    { id: 'rocket', name: 'Rocket', sulfur: 1400 },
    { id: 'satchel', name: 'Satchel charge', sulfur: 480 },
    { id: 'ammo', name: 'Explosive 5.56 ammo', sulfur: 50 },
  ],
  // counts[explosive id] = how many it takes to destroy ONE of the target. approx = less certain figure.
  targets: [
    { id: 'stone', name: 'Stone wall / foundation / floor', counts: { c4: 2, rocket: 4, satchel: 10, ammo: 185 } },
    { id: 'metal', name: 'Sheet metal wall / foundation / floor', counts: { c4: 4, rocket: 8, satchel: 23, ammo: 400 } },
    { id: 'hqm', name: 'Armored (HQM) wall / foundation / floor', counts: { c4: 8, rocket: 15, satchel: 46, ammo: 799 } },
    { id: 'wooddoor', name: 'Wooden door', approx: true, counts: { c4: 1, rocket: 1, satchel: 2, ammo: 23 } },
    { id: 'metaldoor', name: 'Sheet metal door', approx: true, counts: { c4: 1, rocket: 2, satchel: 4, ammo: 63 } },
  ],
};
const RAID_KEY = 'rdt-raid-v1';
let raidState = null;     // { explosives, targets, qty:{id:n} }
let raidEdit = false;

function raidLoad() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(RAID_KEY) || 'null'); } catch (_) { /* storage unavailable */ }
  const base = JSON.parse(JSON.stringify(RAID_DEFAULT));
  raidState = { explosives: base.explosives, targets: base.targets, qty: {} };
  if (saved && typeof saved === 'object') {
    if (Array.isArray(saved.explosives)) for (const e of saved.explosives) { const t = raidState.explosives.find((x) => x.id === e.id); if (t && Number.isFinite(+e.sulfur)) t.sulfur = Math.max(0, +e.sulfur); }
    if (Array.isArray(saved.targets)) {
      for (const s of saved.targets) {
        if (!s || typeof s.id !== 'string' || typeof s.name !== 'string') continue;
        const t = raidState.targets.find((x) => x.id === s.id);
        const counts = {}; for (const e of raidState.explosives) counts[e.id] = Math.max(0, Math.round(+((s.counts || {})[e.id]) || 0));
        if (t) { t.counts = counts; t.name = s.name.slice(0, 80); } else raidState.targets.push({ id: s.id.slice(0, 40), name: s.name.slice(0, 80), custom: true, counts });
      }
    }
    if (saved.qty && typeof saved.qty === 'object') for (const [k, v] of Object.entries(saved.qty)) if (Number.isFinite(+v) && +v > 0) raidState.qty[k] = Math.min(999, Math.round(+v));
  }
}
function raidSave() { try { localStorage.setItem(RAID_KEY, JSON.stringify(raidState)); } catch (_) { /* ignore */ } }

// Pure maths (also used by the headless test): totals per explosive for the chosen quantities.
function raidCompute(state) {
  const rows = state.explosives.map((e) => {
    let count = 0;
    for (const t of state.targets) count += (state.qty[t.id] || 0) * (t.counts[e.id] || 0);
    return { id: e.id, name: e.name, count, sulfur: count * e.sulfur };
  });
  const used = rows.filter((r) => r.count > 0);
  const best = used.length ? used.reduce((a, b) => (b.sulfur < a.sulfur ? b : a)) : null;
  return { rows, best };
}

const fmtN = (n) => Number(n).toLocaleString();
function renderRaid() {
  if (!raidState) raidLoad();
  const st = raidState;
  // ---- targets table
  const head = h('div', { class: 'rd-row rd-head' }, h('span', {}, 'Target'), h('span', {}, 'How many'), ...st.explosives.map((e) => h('span', { class: 'rd-c' }, { c4: 'C4', rocket: 'Rocket', satchel: 'Satchel', ammo: 'Ammo' }[e.id] || e.name)));
  const rows = st.targets.map((t) => {
    const q = st.qty[t.id] || 0;
    const qty = h('input', { type: 'number', min: '0', max: '999', value: String(q), class: 'rd-q', oninput: (e) => { const v = Math.max(0, Math.min(999, parseInt(e.target.value, 10) || 0)); if (v) st.qty[t.id] = v; else delete st.qty[t.id]; raidSave(); renderRaidResults(); } });
    const step = (d) => h('button', { class: 'btn ghost sm', onclick: () => { const v = Math.max(0, Math.min(999, (st.qty[t.id] || 0) + d)); if (v) st.qty[t.id] = v; else delete st.qty[t.id]; raidSave(); renderRaid(); } }, d > 0 ? '+' : '−');
    const cells = st.explosives.map((e) => raidEdit
      ? h('input', { type: 'number', min: '0', class: 'rd-n', value: String(t.counts[e.id] || 0), onchange: (ev) => { t.counts[e.id] = Math.max(0, parseInt(ev.target.value, 10) || 0); raidSave(); renderRaidResults(); } })
      : h('span', { class: 'rd-c' }, (t.approx ? '~' : '') + fmtN(t.counts[e.id] || 0)));
    const nameEl = raidEdit
      ? h('input', { class: 'rd-name', value: t.name, onchange: (ev) => { t.name = ev.target.value.slice(0, 80) || t.name; raidSave(); } })
      : h('span', { class: 'rd-nm' }, t.name, t.approx ? h('em', { title: 'Less certain figure - check it in game' }, ' ~') : null);
    return h('div', { class: 'rd-row' }, nameEl, h('div', { class: 'rd-qty' }, step(-1), qty, step(1)), ...cells,
      raidEdit && !RAID_DEFAULT.targets.some((d) => d.id === t.id) ? h('button', { class: 'btn ghost sm', title: 'Remove', onclick: () => { st.targets = st.targets.filter((x) => x.id !== t.id); delete st.qty[t.id]; raidSave(); renderRaid(); } }, 'x') : null);
  });
  $('#rd-table').replaceChildren(head, ...rows);

  // ---- explosive costs (editable)
  $('#rd-costs').replaceChildren(...st.explosives.map((e) => h('div', { class: 'rd-cost' }, h('span', {}, e.name),
    raidEdit ? h('input', { type: 'number', min: '0', class: 'rd-n', value: String(e.sulfur), onchange: (ev) => { e.sulfur = Math.max(0, parseInt(ev.target.value, 10) || 0); raidSave(); renderRaidResults(); } })
      : h('b', {}, fmtN(e.sulfur) + ' sulfur'))));
  $('#rd-edit').textContent = raidEdit ? 'Done editing' : 'Edit numbers';
  $('#rd-addrow').hidden = !raidEdit; $('#rd-reset').hidden = !raidEdit;
  renderRaidResults();
}

function renderRaidResults() {
  const { rows, best } = raidCompute(raidState);
  const box = $('#rd-results');
  if (!best) { box.replaceChildren(h('div', { class: 'muted' }, 'Pick how many of each target you want to raid and the cost appears here.')); return; }
  box.replaceChildren(
    ...rows.filter((r) => r.count > 0).sort((a, b) => a.sulfur - b.sulfur).map((r) => h('div', { class: 'rd-res' + (r === best || r.id === best.id ? ' best' : '') },
      h('div', {}, h('b', {}, `${fmtN(r.count)} × ${r.name}`), r.id === best.id ? h('span', { class: 'badge live', style: 'margin-left:8px' }, 'Cheapest') : null),
      h('div', { class: 'rd-sul' }, fmtN(r.sulfur), h('small', {}, ' sulfur')))),
    h('div', { class: 'muted', style: 'margin-top:10px' }, `Using only one explosive type. The cheapest option here is ${best.name} at ${fmtN(best.sulfur)} sulfur (about ${fmtN(Math.round(best.sulfur / 2))} gunpowder).`));
}

(function bindRaid() {
  const edit = $('#rd-edit'); if (!edit) return;
  edit.addEventListener('click', () => { raidEdit = !raidEdit; renderRaid(); });
  $('#rd-clear').addEventListener('click', () => { if (!raidState) raidLoad(); raidState.qty = {}; raidSave(); renderRaid(); });
  $('#rd-reset').addEventListener('click', () => { if (!confirm('Reset all numbers to the built-in defaults?')) return; raidState = null; try { localStorage.removeItem(RAID_KEY); } catch (_) { /* ignore */ } raidLoad(); renderRaid(); });
  $('#rd-addrow').addEventListener('click', () => { const id = 'c' + Date.now().toString(36); const counts = {}; for (const e of raidState.explosives) counts[e.id] = 0; raidState.targets.push({ id, name: 'New target', custom: true, counts }); raidSave(); renderRaid(); });
})();
