// Builds src/municipalities.ts for the "europe" pack:
//   * Europe: municipality-like areas ("concelhos") — official municipalities where they are PT-sized, and
//     small municipalities agglomerated around their main town (same district) where they are tiny (ES, FR, IT, CZ…).
//   * Rest of the world: first-level divisions only (districts / provinces / states, Natural Earth admin-1), kind "d".
// Usage: node tools/buildeuro.js [srcDir]
// Sources: geoBoundaries gbOpen (per-country licences, see README), CAOP (PT), Natural Earth admin-1 (public domain),
// GeoNames cities1000 (CC BY 4.0, population of the main towns).
const fs = require('fs');
// raw source data (geoBoundaries, Natural Earth, CAOP, GeoNames postal codes) — not in the repository, see README › Data
const DATA = process.env.GEO_DATA_DIR || require('path').join(__dirname, '..', 'data');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');
const { topology } = require('topojson-server');
const { presimplify, simplify } = require('topojson-simplify');
const { quantize, merge, neighbors, feature } = require('topojson-client');
const d3geo = require('d3-geo');

const SRC = process.argv[2] || path.join(__dirname, '..', 'src');
const GB = path.join(DATA, 'src_data/gb');
const TMP = path.join(os.tmpdir(), 'geocascade-euro');
fs.mkdirSync(TMP, { recursive: true });
const MAPSHAPER = process.env.MAPSHAPER || 'npx mapshaper';

// ---- parameters ----
// MUNI_SET=europe → municipalities for Europe only (the rest of the world gets districts): the light AppSource build
const MUNI_SET = process.env.MUNI_SET || 'full';
const AMIN = +(process.env.AMIN || 150);    // km²: a municipality smaller than this…
const PMIN = +(process.env.PMIN || 20);     // …and with less than this population (thousands) joins a neighbour
const AMAX = +(process.env.AMAX || 1500);   // km²: an agglomerated area never grows beyond this (unless it is an isolated tiny unit)
const GRID = +(process.env.GRID || 0.003); // quantization grid in degrees (~300 m)
const MAX_ALIASES = +(process.env.MAX_ALIASES || 1e9); // agglomerated member names kept per area (matching aliases)
const TOL_M = +(process.env.TOL_M || 2.5e-6), Q_M = +(process.env.Q_M || 2e4);   // municipality simplification (planar triangle area, deg²) and quantization
const TOL_D = +(process.env.TOL_D || 3e-5), Q_D = +(process.env.Q_D || 1e4);     // world admin-1

// ---- European sources: ISO2 -> geoBoundaries file (or custom) ----
const gbFile = (iso3, adm) => path.join(GB, `geoBoundaries-${iso3}-ADM${adm}_simplified.geojson`);
const EUROPE = {
  AL: gbFile('ALB', 3), AD: gbFile('AND', 1), AT: gbFile('AUT', 3), BE: gbFile('BEL', 4), BG: gbFile('BGR', 2), BA: gbFile('BIH', 3),
  BY: gbFile('BLR', 2), CH: gbFile('CHE', 3), CY: gbFile('CYP', 2), CZ: gbFile('CZE', 3), DE: gbFile('DEU', 3), DK: gbFile('DNK', 2),
  EE: gbFile('EST', 2), FI: gbFile('FIN', 3), FR: gbFile('FRA', 5), GB: gbFile('GBR', 3), GR: gbFile('GRC', 3), HR: gbFile('HRV', 2),
  HU: gbFile('HUN', 3), IE: gbFile('IRL', 2), IS: gbFile('ISL', 2), IT: gbFile('ITA', 4), LI: gbFile('LIE', 1), LT: gbFile('LTU', 2),
  LU: gbFile('LUX', 3), LV: gbFile('LVA', 2), MC: gbFile('MCO', 1), MD: gbFile('MDA', 1), MK: gbFile('MKD', 2), MT: gbFile('MLT', 1),
  ME: gbFile('MNE', 1), NL: gbFile('NLD', 2), NO: gbFile('NOR', 2), PL: gbFile('POL', 3), RO: gbFile('ROU', 2), SM: gbFile('SMR', 1),
  RS: gbFile('SRB', 2), SK: gbFile('SVK', 3), SI: gbFile('SVN', 2), SE: gbFile('SWE', 2), UA: gbFile('UKR', 2),
  ES: path.join(DATA, 'gb/esp3.geojson'), PT: path.join(DATA, 'nmota_caop/Portugal_Municipalities_clean.geojson'),
  // outside Europe: countries where Power BI is widely used (counties / municipalities / districts)
  US: gbFile('USA', 2), MX: gbFile('MEX', 2), BR: gbFile('BRA', 2), CN: gbFile('CHN', 2), IN: gbFile('IND', 2), JP: gbFile('JPN', 2),
  AU: gbFile('AUS', 2), TR: gbFile('TUR', 2), AR: gbFile('ARG', 2), CO: gbFile('COL', 2), KR: gbFile('KOR', 2)
};
if (MUNI_SET === 'europe') for (const cc of ['US', 'MX', 'BR', 'CN', 'IN', 'JP', 'AU', 'TR', 'AR', 'CO', 'KR']) delete EUROPE[cc];
// names of these sources are unreliable (encoding / electoral-area codes): the main town name is used instead
const TOWN_NAMED = new Set(['CZ', 'HU', 'IE', 'EE', 'LV', 'SK', 'CN']);
// large units outside Europe: a coarser simplification keeps the size reasonable
const COARSE = new Set(['US', 'MX', 'BR', 'CN', 'IN', 'JP', 'AU', 'TR', 'AR', 'CO', 'KR']);
// PT concelhos are the reference size: kept as they are
const NO_AGG = new Set(['PT']);
// admin-1 that is a municipality list in Natural Earth: districts = its regions
const DISSOLVE_BY_REGION = new Set(['LV', 'MK', 'SI', 'MT']);

// ---- curated district aliases (PT / ES) ----
const PT_DISTRICTS = [
  ['Aveiro'], ['Beja'], ['Braga'], ['Bragança'], ['Castelo Branco'], ['Coimbra'], ['Évora'], ['Faro', 'Algarve'], ['Guarda'], ['Leiria'], ['Lisboa', 'Lisbon'],
  ['Portalegre'], ['Porto', 'Oporto'], ['Santarém'], ['Setúbal'], ['Viana do Castelo'], ['Vila Real'], ['Viseu'],
  ['Açores', 'Região Autónoma dos Açores', 'RA Açores', 'R.A. Açores', 'Azores', 'Acores'],
  ['Madeira', 'Região Autónoma da Madeira', 'RA Madeira', 'R.A. Madeira']
];
const ES_PROVINCES = [
  ['Álava', 'Araba/Álava', 'Araba', 'Alava'], ['Albacete'], ['Alicante', 'Alacant', 'Alicante/Alacant'], ['Almería'],
  ['Asturias', 'Principado de Asturias'], ['Ávila'], ['Badajoz'], ['Illes Balears', 'Baleares', 'Islas Baleares', 'Balearic Islands', 'Balears, Illes'],
  ['Barcelona'], ['Bizkaia', 'Vizcaya'], ['Burgos'], ['Cáceres'], ['Cádiz'], ['Cantabria'],
  ['Castellón', 'Castelló', 'Castellón/Castelló'], ['Ceuta'], ['Ciudad Real'], ['Córdoba'],
  ['A Coruña', 'La Coruña', 'Coruña', 'Coruna'], ['Cuenca'], ['Gipuzkoa', 'Guipúzcoa'], ['Girona', 'Gerona'],
  ['Granada'], ['Guadalajara'], ['Huelva'], ['Huesca'], ['Jaén'], ['León'], ['Lleida', 'Lérida'],
  ['Lugo'], ['Madrid', 'Comunidad de Madrid'], ['Málaga'], ['Melilla'], ['Murcia', 'Región de Murcia'],
  ['Navarra', 'Nafarroa', 'Comunidad Foral de Navarra'], ['Ourense', 'Orense'], ['Palencia'], ['Las Palmas', 'Palmas, Las'],
  ['Pontevedra'], ['La Rioja', 'Rioja'], ['Salamanca'], ['Santa Cruz de Tenerife', 'Tenerife'],
  ['Segovia'], ['Sevilla', 'Seville'], ['Soria'], ['Tarragona'], ['Teruel'], ['Toledo'],
  ['Valencia', 'València', 'Valencia/València'], ['Valladolid'], ['Zamora'], ['Zaragoza']
];
const CURATED = { PT: PT_DISTRICTS, ES: ES_PROVINCES };
const LOCAL_NAME = { IT: 'name_it', FR: 'name_fr', DE: 'name_de', ES: 'name_es', PT: 'name_pt', NL: 'name_nl', PL: 'name_pl', SE: 'name_sv', HU: 'name_hu', AT: 'name_de', CH: 'name_de' };

// ---- helpers ----
const normKey = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9]/g, '');
// UTF-8 read as Latin-1 in some sources ("WaitematÄ\u0081" → "Waitematā")
const unMojibake = s => /[\u00C2-\u00DF][\u0080-\u00BF]/.test(s) ? (() => { const d = Buffer.from(s, 'latin1').toString('utf8'); return d.includes('\uFFFD') ? s : d; })() : s;
const clean = s => unMojibake(String(s || '')).replace(/[|;/]/g, ' ').replace(/\s+/g, ' ').trim();
const latin = s => !!s && /^[\p{Script=Latin}\p{N}\s'’().,\-]+$/u.test(s);
function polys(g) { return !g ? [] : g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : []; }
function ringArea(r) { let a = 0; for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j][0] + r[i][0]) * (r[j][1] - r[i][1]); return Math.abs(a / 2); }
function ringIn(r, x, y) { let ins = false; for (let i = 0, j = r.length - 1; i < r.length; j = i++) { const xi = r[i][0], yi = r[i][1], xj = r[j][0], yj = r[j][1]; if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) ins = !ins; } return ins; }
const polyIn = (ps, x, y) => ps.some(p => p.filter(r => ringIn(r, x, y)).length % 2 === 1);
/** km² of a lon/lat geometry (planar with a cos(lat) correction, good enough to rank sizes) */
function areaKm2(ps) { let a = 0; for (const p of ps) { const r = p[0]; let lat = 0; for (const q of r) lat += q[1]; lat /= r.length; let s = ringArea(r); for (const h of p.slice(1)) s -= ringArea(h); a += s * 111.32 * 111.32 * Math.cos(lat * Math.PI / 180); } return a; }
function bboxOf(ps) { let b = [180, 90, -180, -90]; for (const p of ps) for (const [x, y] of p[0]) { if (x < b[0]) b[0] = x; if (y < b[1]) b[1] = y; if (x > b[2]) b[2] = x; if (y > b[3]) b[3] = y; } return b; }
function d3Wind(g) { for (const p of polys(g)) { if (d3geo.geoArea({ type: 'Polygon', coordinates: p }) > 2 * Math.PI) p.forEach(r => r.reverse()); } return g; }
function labelOf(ps) {
  if (!ps.length) return [0, 0];
  let best = ps[0]; for (const p of ps) if (ringArea(p[0]) > ringArea(best[0])) best = p;
  let x = 0, y = 0; for (const [px, py] of best[0]) { x += px; y += py; }
  const c = [x / best[0].length, y / best[0].length];
  if (polyIn([best], c[0], c[1])) return c;
  // scan lines through the bbox for an inside point
  const b = bboxOf([best]);
  for (let k = 1; k < 10; k++) {
    const yy = b[1] + (b[3] - b[1]) * k / 10;
    const xs = [];
    for (const r of best) for (let i = 0, j = r.length - 1; i < r.length; j = i++) { const [xi, yi] = r[i], [xj, yj] = r[j]; if ((yi > yy) !== (yj > yy)) xs.push(xi + (yy - yi) * (xj - xi) / (yj - yi)); }
    xs.sort((a, b2) => a - b2);
    let bw = 0, bx = null; for (let i = 0; i + 1 < xs.length; i += 2) if (xs[i + 1] - xs[i] > bw) { bw = xs[i + 1] - xs[i]; bx = (xs[i] + xs[i + 1]) / 2; }
    if (bx !== null) return [bx, yy];
  }
  return best[0][0];
}
const r4 = v => +(+v).toFixed(4);
// compact arc encoding: per arc a varint point count, then zig-zag varints of the delta-encoded integer coordinates
// (5 payload bits per char, bit 5 = continuation); ~2–3 chars per point instead of ~8 in JSON
const B64 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_-';
function encVar(v, outArr) { while (v >= 32) { outArr.push(B64[32 | (v & 31)]); v = Math.floor(v / 32); } outArr.push(B64[v]); }
function encodeArcs(arcs) {
  const o = [];
  for (const a of arcs) { encVar(a.length, o); for (const [x, y] of a) { encVar(x < 0 ? -2 * x - 1 : 2 * x, o); encVar(y < 0 ? -2 * y - 1 : 2 * y, o); } }
  return o.join('');
}
/** topology -> JSON string with the arcs replaced by the compact string "A" */
/** geometries -> compact string "G": per geometry (in id order) varint polygon count, per polygon ring count, per ring arc count,
 *  then each arc reference as zig-zag(delta to the previous arc number) * 2 + reversed */
function encodeGeoms(geoms) {
  const o = []; let prev = 0;
  const ref = r => { const rev = r < 0 ? 1 : 0, a = rev ? ~r : r, d = a - prev; prev = a; encVar((d < 0 ? -2 * d - 1 : 2 * d) * 2 + rev, o); };
  for (const g of geoms) {
    const polys = !g || !g.arcs ? [] : g.type === 'Polygon' ? [g.arcs] : g.type === 'MultiPolygon' ? g.arcs : [];
    encVar(polys.length, o);
    for (const p of polys) { encVar(p.length, o); for (const ring of p) { encVar(ring.length, o); ring.forEach(ref); } }
  }
  return o.join('');
}
function packTopo(t) {
  const arcs = t.arcs; const c = Object.assign({}, t, { arcs: [] }); c.A = encodeArcs(arcs);
  const gs = t.objects.m.geometries.slice().sort((a, b) => a.id - b.id);
  if (gs.every((g, i) => g.id === i)) { c.G = encodeGeoms(gs); c.objects = { m: { type: 'GeometryCollection', geometries: [] } }; }
  return JSON.stringify(c);
}

/** spatial grid over items with .bb */
function makeGrid(items, cell) {
  const g = new Map();
  for (const it of items) for (let gx = Math.floor(it.bb[0] / cell); gx <= Math.floor(it.bb[2] / cell); gx++)
    for (let gy = Math.floor(it.bb[1] / cell); gy <= Math.floor(it.bb[3] / cell); gy++) { const k = gx + ':' + gy; const a = g.get(k); if (a) a.push(it); else g.set(k, [it]); }
  return { at(x, y) { return (g.get(Math.floor(x / cell) + ':' + Math.floor(y / cell)) || []).filter(it => x >= it.bb[0] && x <= it.bb[2] && y >= it.bb[1] && y <= it.bb[3] && polyIn(it.ps, x, y)); } };
}

// ---- reference data ----
const geodataSrc = fs.readFileSync(path.join(__dirname, '..', 'src/geodata.ts'), 'utf8');
const COUNTRIES = JSON.parse(/export const COUNTRIES[^=]*=\s*(\[[\s\S]*?\]);\s*\n/.exec(geodataSrc)[1]);
const byIso3 = new Map(COUNTRIES.map(c => [c[0], c])), byIso2 = new Map(COUNTRIES.map(c => [c[1], c]));
const TOPO_JSON = JSON.parse(JSON.parse(/export const TOPO_JSON[^=]*=\s*("(?:[^"\\]|\\.)*")/.exec(geodataSrc)[1]));
const countryFeat = new Map(feature(TOPO_JSON, TOPO_JSON.objects.c).features.map(f => [String(f.id), f]));

const CITIES = (() => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/cities.ts'), 'utf8');
  const obj = JSON.parse(/export const CITIES[^=]*=\s*(\{[\s\S]*\});?\s*$/.exec(src)[1].replace(/;\s*$/, ''));
  const out = {};
  for (const [cc, s] of Object.entries(obj)) out[cc] = s.split(';').map(e => { const [names, lon, lat, pop] = e.split('|'); return { name: names.split('/')[0], x: +lon, y: +lat, pop: +pop || 0 }; });
  return out;
})();

console.log('loading Natural Earth admin-1…');
const NE = JSON.parse(fs.readFileSync(path.join(DATA, 'src_data/ne_admin1.geojson'), 'utf8'));
const neByCC = new Map();
for (const f of NE.features) {
  const p = f.properties;
  const c = byIso2.get(p.iso_a2) || byIso3.get(p.adm0_a3) || byIso3.get(p.gu_a3);
  if (!c || !f.geometry) continue;
  const cc = c[1];
  if (!neByCC.has(cc)) neByCC.set(cc, []);
  neByCC.get(cc).push(f);
}

/** Districts of a country from Natural Earth: [{ names: [display, ...aliases], ps, bb, c }] */
function districtsFromNE(cc) {
  let feats = neByCC.get(cc) || [];
  const groups = new Map();
  for (const f of feats) {
    const p = f.properties;
    const key = DISSOLVE_BY_REGION.has(cc) && p.region ? 'r:' + p.region : 'f:' + p.adm1_code;
    if (!groups.has(key)) groups.set(key, { props: p, region: DISSOLVE_BY_REGION.has(cc) && p.region ? p.region : null, ps: [] });
    groups.get(key).ps.push(...polys(f.geometry));
  }
  const curated = CURATED[cc];
  const list = [];
  for (const gr of groups.values()) {
    const p = gr.props;
    let names;
    if (gr.region) names = [gr.region];
    else {
      const loc = LOCAL_NAME[cc] && latin(p[LOCAL_NAME[cc]]) ? p[LOCAL_NAME[cc]] : null;
      const cands = [loc, latin(p.name_local) ? p.name_local : null, p.name, p.name_en, p.name_pt, p.name_es, p.name_fr, p.name_de, p.name_it, p.woe_name, p.gn_name, ...String(p.name_alt || '').split('|')];
      names = [...new Set(cands.filter(s => latin(s)).map(s => clean(s)))];
    }
    if (curated) {
      const keys = new Set(names.map(normKey));
      const hit = curated.find(a => a.some(n => keys.has(normKey(n))));
      if (hit) names = [...new Set([...hit.map(clean), ...names])];
    }
    if (!names.length) names = [clean(p.name) || '?'];
    const bb = bboxOf(gr.ps);
    list.push({ names, ps: gr.ps, bb, c: labelOf(gr.ps) });
  }
  return list;
}

/** District index of a geometry: votes of its label + sampled vertices; fallback nearest district label */
function assignDistrict(dists, grid, label, ps) {
  const votes = new Map();
  const pts = [label];
  for (const p of ps) { const r = p[0]; const step = Math.max(1, Math.floor(r.length / 12)); for (let i = 0; i < r.length; i += step) pts.push(r[i]); }
  for (const [x, y] of pts) for (const d of grid.at(x, y)) votes.set(d.i, (votes.get(d.i) || 0) + 1);
  if (votes.size) return [...votes.entries()].sort((a, b) => b[1] - a[1])[0][0];
  const [x, y] = label;
  let best = 0, bd = Infinity;
  dists.forEach((d, i) => { const dd = (d.c[0] - x) ** 2 + (d.c[1] - y) ** 2; if (dd < bd) { bd = dd; best = i; } });
  return best;
}

function mapshaperClean(file, cc) {
  const out = path.join(TMP, `clean-${cc}.json`);
  if (!fs.existsSync(out) || fs.statSync(out).mtimeMs < fs.statSync(file).mtimeMs)
    execSync(`${MAPSHAPER} -i "${file}" snap snap-interval=0.0001 -clean gap-fill-area=1km2 sliver-control=1 allow-empty -o "${out}" format=geojson force`, { stdio: ['ignore', 'ignore', 'inherit'] });
  return JSON.parse(fs.readFileSync(out, 'utf8'));
}

const titleCase = s => s.toLowerCase().replace(/(^|[\s\-'(])(\p{L})/gu, (m, a, b) => a + b.toUpperCase()).replace(/\b(De|Da|Do|Das|Dos|E|Del|La|Las|Los|El|Y|I|Di|Du|Des|Le|Les|Sur|Sous|Am|An|Im|Bei|Ob|Der|Die|Und)\b/g, w => w.toLowerCase()).replace(/^./, c => c.toUpperCase());
function cleanUnitName(cc, raw) {
  let s = String(raw || '').trim();
  s = s.replace(/^(gmina|Općina|Grad|Opština|Komuna e|Bashkia)\s+/i, '')
    .replace(/\s+(vald|vallad|linn|pag\.|novads|Municipality|City|Municipio|rajono savivaldybė|miesto savivaldybė|savivaldybė|nor|kommune|kommun)$/i, '')
    .replace(/,\s*(Stadtkreis|Landkreis|Kreisfreie Stadt|Kreis)$/i, '').replace(/-(si|gun|gu)$/i, '').replace(/\s+LEA-\d+$/i, '');
  if (s && s === s.toUpperCase() && /[A-Z]{3}/.test(s)) s = titleCase(s);
  return clean(s);
}
const badName = s => !s || /[0-9©�]/.test(s);

const out = {};
const report = [];

// ===================== Europe: municipalities (agglomerated) =====================
for (const [cc, file] of Object.entries(EUROPE)) {
  if (!fs.existsSync(file)) { console.warn('missing', cc, file); continue; }
  const raw = mapshaperClean(file, cc);
  let feats = raw.features.filter(f => f.geometry && polys(f.geometry).length);
  // overseas departments are separate countries (GP, MQ, GF, RE, YT) in the visual
  if (cc === 'FR') feats = feats.filter(f => { const b = bboxOf(polys(f.geometry)); return b[0] > -6 && b[2] < 10 && b[1] > 41 && b[3] < 52; });
  // the far-west Aleutians sit beyond the antimeridian: dropped so the quantization grid stays fine
  if (cc === 'US') feats = feats.map(f => { const ps = polys(f.geometry).filter(p => bboxOf([p])[0] < 0); return ps.length ? Object.assign({}, f, { geometry: { type: 'MultiPolygon', coordinates: ps } }) : null; }).filter(Boolean);
  const dists = districtsFromNE(cc);
  if (!dists.length) { console.warn('no districts for', cc); continue; }
  dists.forEach((d, i) => d.i = i);
  const dGrid = makeGrid(dists, 0.5);
  // units
  const units = feats.map((f, i) => {
    const g = d3Wind(JSON.parse(JSON.stringify(f.geometry)));
    const ps = polys(g);
    const p = f.properties || {};
    // bilingual names ("Sagunto/Sagunt", "Alicante/Alacant"): first part displayed, the others kept as aliases
    const parts = String((cc === 'PT' ? (p.Concelho || p.MUNICIPIO) : p.shapeName) || '').split('/');
    const nm = cc === 'PT' ? titleCase(parts[0]) : cleanUnitName(cc, parts[0]);
    const alts = parts.slice(1).map(x => cc === 'PT' ? titleCase(x) : cleanUnitName(cc, x)).filter(Boolean);
    const label = labelOf(ps);
    return { i, g, ps, bb: bboxOf(ps), name: nm, alts, official: badName(nm) ? '' : nm, code: cc === 'PT' ? String(p.DICO || '') : '', label, area: areaKm2(ps), pop: 0, town: null, district: assignDistrict(dists, dGrid, label, ps) };
  });
  // population: GeoNames towns inside each unit
  const uGrid = makeGrid(units, 0.25);
  for (const c of CITIES[cc] || []) {
    let u = uGrid.at(c.x, c.y)[0];
    if (!u) continue;
    u.pop += c.pop;
    if (!u.town || c.pop > u.town.pop) u.town = c;
  }
  for (const u of units) {
    const townName = u.town ? clean(u.town.name) : '';
    if ((TOWN_NAMED.has(cc) || badName(u.name)) && townName) u.name = townName;
    if (badName(u.name) && !townName) u.name = clean(String(u.name).replace(/[0-9©�]+/g, '')) || '?';
  }
  // topology of the cleaned units (shared borders -> neighbours with shared length)
  const fc = { type: 'FeatureCollection', features: units.map(u => ({ type: 'Feature', id: u.i, properties: {}, geometry: u.g })) };
  const topo = topology({ m: fc });
  const geoms = topo.objects.m.geometries;
  // clusters
  const clusters = units.map(u => ({ id: u.i, members: [u.i], area: u.area, pop: u.pop, district: u.district, nb: new Map(), alive: true, ver: 0 }));
  if (!NO_AGG.has(cc)) {
    // shared border length between units
    const arcLen = topo.arcs.map(a => { let L = 0, x = 0, y = 0; const pts = []; for (const q of a) { x += q[0]; y += q[1]; pts.push([x, y]); } for (let k = 1; k < pts.length; k++) L += Math.hypot(pts[k][0] - pts[k - 1][0], (pts[k][1] - pts[k - 1][1])); return L; });
    // topology() without quantization keeps absolute coordinates (not delta encoded)
    const arcLenAbs = topo.arcs.map(a => { let L = 0; for (let k = 1; k < a.length; k++) L += Math.hypot(a[k][0] - a[k - 1][0], a[k][1] - a[k - 1][1]); return L; });
    const useBy = new Map();
    geoms.forEach((g, gi) => {
      const arcs = g.type === 'Polygon' ? g.arcs.flat() : g.type === 'MultiPolygon' ? g.arcs.flat(2) : [];
      for (const a of arcs) { const k = a < 0 ? ~a : a; if (!useBy.has(k)) useBy.set(k, new Set()); useBy.get(k).add(gi); }
    });
    useBy.forEach((set, k) => {
      if (set.size !== 2) return;
      const [a, b] = [...set];
      const L = (topo.transform ? arcLen[k] : arcLenAbs[k]);
      clusters[a].nb.set(b, (clusters[a].nb.get(b) || 0) + L);
      clusters[b].nb.set(a, (clusters[b].nb.get(a) || 0) + L);
    });
    // large countries with many small rural municipalities group further (fewer, PT-district-sized areas)
    const amin = { BR: 1500, MX: 800, CO: 1000 }[cc] || AMIN, pmin = { BR: 60, MX: 40, CO: 40 }[cc] || PMIN;
    const small = c => c.area < amin && c.pop < pmin;
    // min-heap by (pop, area)
    const heap = [];
    const less = (a, b) => a.pop !== b.pop ? a.pop < b.pop : a.area < b.area;
    const push = c => { heap.push({ id: c.id, ver: c.ver, pop: c.pop, area: c.area }); let i = heap.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (less(heap[i], heap[p])) { [heap[i], heap[p]] = [heap[p], heap[i]]; i = p; } else break; } };
    const pop = () => { const top = heap[0]; const last = heap.pop(); if (heap.length) { heap[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < heap.length && less(heap[l], heap[m])) m = l; if (r < heap.length && less(heap[r], heap[m])) m = r; if (m === i) break; [heap[i], heap[m]] = [heap[m], heap[i]]; i = m; } } return top; };
    clusters.forEach(c => { if (small(c)) push(c); });
    while (heap.length) {
      const e = pop();
      const c = clusters[e.id];
      if (!c.alive || c.ver !== e.ver || !small(c)) continue;
      let cands = [...c.nb.entries()].map(([id, L]) => ({ t: clusters[id], L })).filter(x => x.t.alive && x.t.district === c.district);
      const fit = cands.filter(x => x.t.area + c.area <= Math.max(AMAX, amin * 4));
      if (fit.length) cands = fit; else if (c.area >= AMIN / 3) continue;
      if (!cands.length) continue;
      // prefer the neighbour with the largest population (towns attract their villages), then the longest shared border
      cands.sort((a, b) => (b.t.pop - a.t.pop) || (b.L - a.L));
      const t = cands[0].t;
      // merge c into t
      t.members.push(...c.members); t.area += c.area; t.pop += c.pop; t.ver++;
      c.alive = false;
      c.nb.forEach((L, id) => { if (id === t.id) return; const o = clusters[id]; o.nb.delete(c.id); o.nb.set(t.id, (o.nb.get(t.id) || 0) + L); t.nb.set(id, (t.nb.get(id) || 0) + L); });
      t.nb.delete(c.id);
      if (small(t)) push(t);
    }
  }
  const alive = clusters.filter(c => c.alive);
  // cluster geometry, name, label
  const cfeats = alive.map((c, k) => {
    const g = c.members.length === 1 ? units[c.members[0]].g : merge(topo, c.members.map(i => geoms[i]));
    const ps = polys(g);
    const main = c.members.map(i => units[i]).sort((a, b) => (b.pop - a.pop) || (b.area - a.area))[0];
    let label = main.town && polyIn(ps, main.town.x, main.town.y) ? [main.town.x, main.town.y] : (c.members.length === 1 ? main.label : labelOf(ps));
    // every official municipality name of the area (data rows name municipalities far more often than towns)
    const al = new Set();
    for (const i of c.members) { const u = units[i]; if (u.official) al.add(clean(u.official)); for (const a of u.alts) al.add(clean(a)); }
    al.delete(clean(main.name));
    return { k, c, g, name: main.name, code: c.members.length === 1 ? main.code : '', label, n: c.members.length, aliases: [...al].filter(Boolean).slice(0, MAX_ALIASES) };
  });
  let t = topology({ m: { type: 'FeatureCollection', features: cfeats.map(f => ({ type: 'Feature', id: f.k, properties: {}, geometry: f.g })) } });
  t = presimplify(t);
  t = simplify(t, cc === 'PT' ? Math.min(TOL_M, 3e-6) : COARSE.has(cc) ? TOL_M * 12 : TOL_M);
  // quantization grid of ~300 m whatever the country size (Q_M is the minimum)
  const tb = (() => { let b = [180, 90, -180, -90]; for (const a of t.arcs) for (const [x, y] of a) { if (x < b[0]) b[0] = x; if (y < b[1]) b[1] = y; if (x > b[2]) b[2] = x; if (y > b[3]) b[3] = y; } return b; })();
  t = quantize(t, Math.max(Q_M, Math.ceil(Math.max(tb[2] - tb[0], tb[3] - tb[1]) / GRID)));
  t.objects.m.geometries = t.objects.m.geometries.map(g => ({ type: g.type, arcs: g.arcs, id: g.id }));
  delete t.bbox;
  const used = new Set(alive.map(c => c.district));
  const meta = cfeats.map(f => [clean(f.name), clean(dists[f.c.district].names[0]), clean(f.code), r4(f.label[0]), r4(f.label[1]), f.c.district, f.n > 1 ? f.n : '', f.aliases.join('/')].join('|').replace(/\|+$/, ''));
  out[cc] = { meta: meta.join(';'), topo: packTopo(t), districts: dists.map(d => d.names.map(clean).filter(Boolean).join('/')).join(';') };
  const sz = (out[cc].meta.length + out[cc].topo.length + out[cc].districts.length) / 1e6;
  report.push([cc, units.length, alive.length, used.size + '/' + dists.length, sz.toFixed(2)]);
  console.log(cc, 'units', units.length, '-> areas', alive.length, 'districts', dists.length, sz.toFixed(2), 'MB');
}

// ===================== Rest of the world: districts only =====================
let worldSize = 0;
for (const c of COUNTRIES) {
  const cc = c[1];
  if (!cc || out[cc]) continue;
  let dists = districtsFromNE(cc);
  if (!dists.length) {
    // no admin-1 (small territories): the country itself is its only district
    const f = countryFeat.get(c[0]);
    if (!f || !f.geometry) continue;
    const ps = polys(f.geometry);
    dists = [{ names: [clean(c[3])], ps, bb: bboxOf(ps), c: labelOf(ps) }];
  }
  const feats = dists.map((d, i) => ({ type: 'Feature', id: i, properties: {}, geometry: d3Wind({ type: 'MultiPolygon', coordinates: JSON.parse(JSON.stringify(d.ps)) }) }));
  let t = topology({ m: { type: 'FeatureCollection', features: feats } }, 1e6);
  t = presimplify(t);
  t = simplify(t, TOL_D);
  t = quantize(t, Q_D);
  t.objects.m.geometries = t.objects.m.geometries.map(g => ({ type: g.type, arcs: g.arcs, id: g.id }));
  delete t.bbox;
  const meta = dists.map((d, i) => [clean(d.names[0]), '', '', r4(d.c[0]), r4(d.c[1]), i].join('|'));
  out[cc] = { k: 'd', meta: meta.join(';'), topo: packTopo(t), districts: dists.map(d => d.names.map(clean).filter(Boolean).join('/')).join(';') };
  worldSize += out[cc].meta.length + out[cc].topo.length + out[cc].districts.length;
}
console.log('world districts', Object.values(out).filter(x => x.k === 'd').length, 'countries', (worldSize / 1e6).toFixed(2), 'MB');
console.table(report);

fs.writeFileSync(path.join(SRC, 'municipalities.ts'),
  '/* Generated by tools/buildeuro.js — do not edit. */\n' +
  '/* Europe: municipality-like areas from geoBoundaries gbOpen (licences per country: see README) and CAOP (PT); small municipalities agglomerated\n' +
  '   around their main town. World: first-level divisions from Natural Earth admin-1 (public domain). Town populations: GeoNames (CC BY 4.0). */\n' +
  '// per ISO2: meta "name|parent|code|labelLon|labelLat|districtIndex[|members]" (position = geometry id), topo = TopoJSON (objects.m),\n' +
  '// districts "Display name/alias/...;..." (position = districtIndex); k "d" = district-only country (each geometry is a district)\n' +
  `export const MUNI_PACK: string = "europe";\n` +
  `export const MUNI: { [cc: string]: { meta: string; topo: string; districts: string; k?: string } } = ${JSON.stringify(out)};\n`);
console.log('municipalities.ts', (fs.statSync(path.join(SRC, 'municipalities.ts')).size / 1e6).toFixed(2), 'MB');
