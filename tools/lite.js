// Light data for the AppSource build (Power BI Service imports visuals up to ~2 MB):
//   cities  — places with at least LITE_MIN_POPK thousand inhabitants (2 names each)
//   postal  — one digit coarser prefixes (centroid of the merged codes)
//   roads   — major highways only
// Usage: node tools/lite.js [srcDir]   (run after tools/buildgeo.js / buildpostal.py / buildeuro.js)
const fs = require('fs');
const path = require('path');
const SRC = process.argv[2] || path.join(__dirname, '..', 'src');
const MIN_POPK = +(process.env.LITE_MIN_POPK || 30);
const POSTAL_DROP = +(process.env.LITE_POSTAL_DROP || 1);   // prefix digits removed
const COUNTRY_TOL = +(process.env.LITE_COUNTRY_TOL || 0.003), COUNTRY_Q = +(process.env.LITE_COUNTRY_Q || 2e4);

// cities
{
  const f = path.join(SRC, 'cities.ts'); const src = fs.readFileSync(f, 'utf8');
  const head = src.slice(0, src.indexOf('export const CITIES'));
  const o = JSON.parse(/export const CITIES[^=]*=\s*(\{[\s\S]*\});?\s*$/.exec(src)[1].replace(/;\s*$/, ''));
  const out = {};
  for (const [cc, s] of Object.entries(o)) {
    const e = s.split(';').map(x => x.split('|')).filter(p => (+p[3] || 0) >= MIN_POPK).map(p => [p[0].split('/').slice(0, 2).join('/'), p[1], p[2], p[3]].join('|'));
    if (e.length) out[cc] = e.join(';');
  }
  fs.writeFileSync(f, head.replace(/\*\/\s*$/m, '*/') + `// light build: places with ${MIN_POPK}k+ inhabitants\nexport const CITIES: { [cc: string]: string } = ${JSON.stringify(out)};\n`);
}
// postal
const MUNI_CC = (() => { const t = fs.readFileSync(path.join(SRC, 'municipalities.ts'), 'utf8'); const i = t.indexOf('export const MUNI:'); const o = JSON.parse(t.slice(t.indexOf('} = ', i) + 4).trim().replace(/;\s*$/, '')); return new Set(Object.keys(o).filter(k => o[k].k !== 'd')); })();
{
  const f = path.join(SRC, 'postal.ts'); const src = fs.readFileSync(f, 'utf8');
  const i = src.indexOf('export const POSTAL'); const head = src.slice(0, i);
  const o = JSON.parse(src.slice(src.indexOf('} = ', i) + 4).trim().replace(/;\s*$/, ''));
  const out = {};
  for (const [cc, v] of Object.entries(o)) {
    // municipality countries keep the finer prefix (it decides the municipality); district-only countries one digit coarser still
    const L = Math.max(2, v.L - (MUNI_CC.has(cc) ? POSTAL_DROP : POSTAL_DROP + 1)); const g = new Map();
    for (const e of v.d.split(';')) { const [c, x, y] = e.split('|'); const k = c.slice(0, L); const a = g.get(k) || [0, 0, 0]; a[0] += +x; a[1] += +y; a[2]++; g.set(k, a); }
    out[cc] = { L, M: v.M, d: [...g].map(([k, a]) => `${k}|${(a[0] / a[2]).toFixed(2)}|${(a[1] / a[2]).toFixed(2)}`).join(';') };
  }
  fs.writeFileSync(f, head + `export const POSTAL: { [cc: string]: { L: number; M: number; d: string } } = ${JSON.stringify(out)};\n`);
}
// countries: coarser outlines
{
  const { presimplify, simplify } = require('topojson-simplify');
  const { quantize } = require('topojson-client');
  const f = path.join(SRC, 'geodata.ts'); const src = fs.readFileSync(f, 'utf8');
  const m = /export const TOPO_JSON[^=]*=\s*("(?:[^"\\]|\\.)*")/.exec(src);
  let t = JSON.parse(JSON.parse(m[1]));
  t = quantize(simplify(presimplify(t), COUNTRY_TOL), COUNTRY_Q);
  fs.writeFileSync(f, src.slice(0, m.index) + 'export const TOPO_JSON = ' + JSON.stringify(JSON.stringify(t)) + src.slice(m.index + m[0].length));
}
// roads
{
  const f = path.join(SRC, 'roads.ts'); const src = fs.readFileSync(f, 'utf8');
  const m = /export const ROADS_JSON = (".*");/s.exec(src); const t = JSON.parse(JSON.parse(m[1]));
  for (const k of Object.keys(t.objects)) delete t.objects[k]; t.arcs = []; // basemap roads left out of the light build
  fs.writeFileSync(f, src.slice(0, m.index) + `export const ROADS_JSON = ${JSON.stringify(JSON.stringify(t))};\n`);
}
for (const n of ['cities', 'postal', 'roads', 'municipalities', 'geodata']) console.log(n, (fs.statSync(path.join(SRC, n + '.ts')).size / 1e6).toFixed(2), 'MB');
