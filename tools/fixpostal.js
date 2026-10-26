// Corrects GeoNames postal-code coordinates for countries that have embedded municipality polygons.
// Some codes carry a province-level coordinate (e.g. ES 12006 Castellón de la Plana sits at the province centroid):
// when a code's coordinate falls outside the municipality the code belongs to, it is moved to that municipality's label point.
// Usage: node tools/fixpostal.js <postal csv dir (data/x)>  — rewrites x/PT and x/ES CSVs in place.
const fs = require('fs');
// raw source data (geoBoundaries, Natural Earth, CAOP, GeoNames postal codes) — not in the repository, see README › Data
const DATA = process.env.GEO_DATA_DIR || require('path').join(__dirname, '..', 'data');
const path = require('path');

const X = process.argv[2] || path.join(DATA, 'zauberware/postal-codes-json-xml-csv/data/x');
const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '');
/** "Regueras, Las" -> "Las Regueras"; "Castellón de la Plana/Castelló de la Plana" -> both */
const variants = s => {
  const out = [];
  for (const part of String(s || '').split('/')) {
    const m = /^(.*),\s*(la|el|los|las|l'|les|els|a|o|os|as|lo)$/i.exec(part.trim());
    out.push(norm(part));
    if (m) out.push(norm(m[2] + ' ' + m[1]), norm(m[2] + m[1]));
  }
  return out.filter(Boolean);
};

function polysOf(g) { return !g ? [] : g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : []; }
function ringContains(r, x, y) {
  let inside = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const xi = r[i][0], yi = r[i][1], xj = r[j][0], yj = r[j][1];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
const contains = (m, x, y) => x >= m.bb[0] && x <= m.bb[2] && y >= m.bb[1] && y <= m.bb[3] &&
  m.polys.some(p => p.filter(r => ringContains(r, x, y)).length % 2 === 1);
function ringArea(r) { let a = 0; for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j][0] + r[i][0]) * (r[j][1] - r[i][1]); return Math.abs(a / 2); }
function labelOf(polys) {
  let best = polys[0]; for (const p of polys) if (ringArea(p[0]) > ringArea(best[0])) best = p;
  let x = 0, y = 0; for (const [px, py] of best[0]) { x += px; y += py; }
  const c = [x / best[0].length, y / best[0].length];
  if (best.filter(r => ringContains(r, c[0], c[1])).length % 2 === 1) return c;
  return best[0][Math.floor(best[0].length / 2)];
}
function load(file, keyFn) {
  const fc = JSON.parse(fs.readFileSync(file, 'utf8'));
  return fc.features.filter(f => f.geometry).map(f => {
    const polys = polysOf(f.geometry);
    let bb = [180, 90, -180, -90];
    for (const p of polys) for (const [x, y] of p[0]) bb = [Math.min(bb[0], x), Math.min(bb[1], y), Math.max(bb[2], x), Math.max(bb[3], y)];
    return { keys: keyFn(f.properties || {}), polys, bb, label: labelOf(polys) };
  });
}

const COUNTRIES = {
  PT: { munis: () => load(path.join(DATA, 'nmota_caop/Portugal_Municipalities.geojson'), p => [String(p.DICO || ''), ...variants(p.Concelho || p.MUNICIPIO)]),
        key: r => [r.province_code, ...variants(r.province)] },
  ES: { munis: () => load(path.join(DATA, 'gb/esp3.geojson'), p => variants(p.shapeName)),
        key: r => variants(r.community) }
};

function edgeKm(m, x, y) {
  if (x < m.bb[0] - 0.1 || x > m.bb[2] + 0.1 || y < m.bb[1] - 0.1 || y > m.bb[3] + 0.1) return Infinity;
  const kx = 111.32 * Math.cos(y * Math.PI / 180), ky = 110.57;
  let best = Infinity;
  for (const p of m.polys) for (const r of p) for (let i = 1; i < r.length; i++) {
    const ax = (r[i - 1][0] - x) * kx, ay = (r[i - 1][1] - y) * ky, bx = (r[i][0] - x) * kx, by = (r[i][1] - y) * ky;
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
    let t = l2 ? -(ax * dx + ay * dy) / l2 : 0; t = Math.max(0, Math.min(1, t));
    best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
  }
  return best;
}

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter(Boolean);
  const head = lines[0].split(',');
  const rows = lines.slice(1).map(l => {
    const out = []; let cur = '', q = false;
    for (let i = 0; i < l.length; i++) {
      const ch = l[i];
      if (q) { if (ch === '"' && l[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
      else if (ch === '"') q = true; else if (ch === ',') { out.push(cur); cur = ''; } else cur += ch;
    }
    out.push(cur);
    const o = {}; head.forEach((h, i) => o[h] = out[i] ?? ''); return o;
  });
  return { head, rows };
}
const csvCell = v => /[",\n]/.test(v) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v);

for (const [cc, cfg] of Object.entries(COUNTRIES)) {
  const dir = path.join(X, cc);
  const file = fs.readdirSync(dir).find(f => f.endsWith('.csv'));
  const full = path.join(dir, file);
  const { head, rows } = parseCsv(fs.readFileSync(full, 'utf8'));
  const munis = cfg.munis();
  const byKey = new Map();
  for (const m of munis) for (const k of m.keys) if (k) { const a = byKey.get(k); if (a) a.push(m); else byKey.set(k, [m]); }
  // a coordinate shared by codes of several different municipalities is a coarse (province/area) coordinate
  const muniKey = r => (cfg.key(r)[0] || '');
  const share = new Map();
  for (const r of rows) { const k = r.latitude + ',' + r.longitude; const set = share.get(k) || new Set(); set.add(muniKey(r)); share.set(k, set); }
  const suspect = r => { const set = share.get(r.latitude + ',' + r.longitude); const named = [...set].filter(Boolean); return named.length >= 2 || set.size >= 3; };
  let moved = 0, ok = 0, unknown = 0, trusted = 0;
  for (const r of rows) {
    const x = +r.longitude, y = +r.latitude;
    if (!isFinite(x) || !isFinite(y)) continue;
    let cands = [];
    for (const k of cfg.key(r)) { const a = byKey.get(k); if (a) { cands = a; break; } }
    if (!cands.length) { unknown++; continue; }
    if (cands.some(m => contains(m, x, y))) { ok++; continue; }
    // precise coordinate that disagrees with the municipality name: the name is the likelier error (keep the point)
    // a point just outside its own municipality (< 3 km: centroid precision at the border) is moved inside it
    const near = cands.some(m => edgeKm(m, x, y) < 3);
    if (!suspect(r) && !near) { trusted++; continue; }
    // several municipalities with the same name: take the closest one
    const m = cands.reduce((best, c) => ((c.label[0] - x) ** 2 + (c.label[1] - y) ** 2) < ((best.label[0] - x) ** 2 + (best.label[1] - y) ** 2) ? c : best);
    r.longitude = m.label[0].toFixed(4); r.latitude = m.label[1].toFixed(4);
    moved++;
  }
  fs.writeFileSync(full, [head.join(','), ...rows.map(r => head.map(h => csvCell(r[h])).join(','))].join('\n') + '\n');
  console.log(cc, 'rows', rows.length, 'ok', ok, 'moved', moved, 'kept (precise point, other municipality name)', trusted, 'no municipality match', unknown);
}
