// Builds src/geodata.ts, src/roads.ts and src/cities.ts for the geoDrillMap visual.
// Sources: Natural Earth 1:10m (public domain) countries + roads + populated places; GeoNames cities1000 (CC BY 4.0) via all-the-cities.
const fs = require('fs');
const { topology } = require('topojson-server');
const { presimplify, simplify, quantile } = require('topojson-simplify');
const { quantize } = require('topojson-client');
const allCities = require('all-the-cities');

const SRC = process.argv[2] || '/root/geoDrillMap/src';
const Q_COUNTRIES = 0.3, Q_ROADS = 0.15;

const ne = JSON.parse(fs.readFileSync(__dirname + '/ne_10m_admin_0_countries.geojson'));
const pp = JSON.parse(fs.readFileSync(__dirname + '/ppfull.geojson'));
const roadsSrc = JSON.parse(fs.readFileSync(__dirname + '/ne_10m_roads.geojson'));
const mu = JSON.parse(fs.readFileSync(__dirname + '/ne_10m_admin_0_map_units.geojson'));
const unitByGu = new Map(mu.features.map(f => [f.properties.GU_A3, f]));
// Sovereign countries whose overseas parts become their own entries: parent keeps only its home units
const HOME_UNITS = { FRA: ['FXX'], NLD: ['NLX'], NOR: ['NOW', 'NJM'] };
// Overseas territories added as separate "countries": GU_A3 -> [ISO2, continent, extra aliases]
const EXTRA_UNITS = {
  GUF: ['GF', 'South America', ['Guyane', 'Guyane française', 'FR-973']],
  MTQ: ['MQ', 'North America', ['FR-972']],
  GLP: ['GP', 'North America', ['Guadalupe', 'FR-971']],
  REU: ['RE', 'Africa', ['Reunion', 'La Réunion', 'Reunião', 'FR-974']],
  MYT: ['YT', 'Africa', ['Maiote', 'FR-976']],
  NLY: ['BQ', 'North America', ['Bonaire', 'Bonaire, Sint Eustatius and Saba', 'Caraíbas Neerlandesas']],
  NSV: ['SJ', 'Europe', ['Svalbard', 'Svalbard and Jan Mayen']],
  CCK: ['CC', 'Oceania', ['Cocos (Keeling) Islands', 'Cocos Islands']],
  CXR: ['CX', 'Oceania', ['Christmas Island']],
  TKL: ['TK', 'Oceania', ['Tokelau']]
};
const mergeGeoms = feats => {
  const polys = [];
  for (const f of feats) {
    const g = f.geometry;
    if (g.type === 'Polygon') polys.push(g.coordinates); else polys.push(...g.coordinates);
  }
  return { type: 'MultiPolygon', coordinates: polys };
};

const CONTINENTS = [
  ['Africa', 'África', 'Afrique', 'Afrika', 'AF'],
  ['Asia', 'Ásia', 'Asie', 'Asien', 'AS'],
  ['Europe', 'Europa', 'EU'],
  ['North America', 'América do Norte', 'América del Norte', 'Norteamérica', 'Amérique du Nord', 'Nordamerika', 'NA', 'N. America'],
  ['South America', 'América do Sul', 'América del Sur', 'Sudamérica', 'Amérique du Sud', 'Südamerika', 'SA', 'S. America', 'Latin America'],
  ['Oceania', 'Oceânia', 'Océanie', 'Ozeanien', 'OC', 'Australia and Oceania', 'Australasia']
];
const contIdx = name => CONTINENTS.findIndex(c => c[0] === name);

const EXTRA_ALIASES = {
  USA: ['USA', 'US', 'United States of America', 'Estados Unidos', 'EUA', 'U.S.A.', 'America'],
  GBR: ['UK', 'U.K.', 'Great Britain', 'Britain', 'Reino Unido', 'England', 'Inglaterra'],
  RUS: ['Russia', 'Rússia', 'Russian Federation'],
  CZE: ['Czech Republic', 'Czechia', 'República Checa', 'Chéquia'],
  NLD: ['Holland', 'Holanda', 'Netherlands', 'Países Baixos'],
  KOR: ['South Korea', 'Korea', 'Coreia do Sul', 'Republic of Korea'],
  PRK: ['North Korea', 'Coreia do Norte'],
  CIV: ["Ivory Coast", "Côte d'Ivoire", 'Costa do Marfim'],
  MKD: ['Macedonia', 'North Macedonia', 'Macedónia do Norte'],
  SWZ: ['Swaziland', 'Eswatini', 'Suazilândia'],
  MMR: ['Burma', 'Myanmar'],
  CPV: ['Cape Verde', 'Cabo Verde'],
  TLS: ['East Timor', 'Timor-Leste', 'Timor Leste'],
  VAT: ['Vatican', 'Vatican City', 'Vaticano', 'Holy See'],
  TUR: ['Türkiye', 'Turkey', 'Turquia'],
  COD: ['DR Congo', 'DRC', 'Congo (Kinshasa)', 'Democratic Republic of the Congo', 'RD Congo'],
  COG: ['Congo', 'Congo (Brazzaville)', 'Republic of the Congo'],
  ARE: ['UAE', 'Emirados Árabes Unidos', 'United Arab Emirates'],
  BIH: ['Bosnia', 'Bosnia and Herzegovina', 'Bósnia'],
  DEU: ['Germany', 'Alemanha'],
  FRA: ['France', 'França', 'Metropolitan France', 'France métropolitaine'],
  CHN: ['China', "People's Republic of China", 'PRC'],
  TWN: ['Taiwan', 'Taiwan (Province of China)'],
  IRN: ['Iran', 'Irão', 'Irã'],
  SYR: ['Syria', 'Síria'],
  LAO: ['Laos', 'Lao PDR'],
  VNM: ['Vietnam', 'Viet Nam', 'Vietname'],
  BOL: ['Bolivia', 'Bolívia'],
  VEN: ['Venezuela'],
  TZA: ['Tanzania', 'Tanzânia'],
  MDA: ['Moldova', 'Moldávia'],
  PSE: ['Palestine', 'Palestina'],
};

const clean = t => { const u = quantize(t, t.__q || 1e5); u.arcs = u.arcs.map(a => a.map(p => [p[0], p[1]])); return u; };

// ---- countries --------------------------------------------------------------
const cnt3 = {}, cnt2 = {};
for (const f of ne.features) { const p = f.properties; cnt3[p.ISO_A3_EH] = (cnt3[p.ISO_A3_EH] || 0) + 1; cnt2[p.ISO_A2_EH] = (cnt2[p.ISO_A2_EH] || 0) + 1; }
const countries = [];
const feats = [];
const usedIds = new Set();
for (const f of ne.features) {
  const p = f.properties;
  if (p.CONTINENT === 'Antarctica') continue;
  let iso3 = p.ISO_A3_EH && p.ISO_A3_EH !== '-99' && cnt3[p.ISO_A3_EH] === 1 ? p.ISO_A3_EH : p.ADM0_A3;
  if (usedIds.has(iso3)) iso3 = p.ADM0_A3 + '_' + countries.length;
  usedIds.add(iso3);
  const iso2 = p.ISO_A2_EH && p.ISO_A2_EH !== '-99' && cnt2[p.ISO_A2_EH] === 1 ? p.ISO_A2_EH : (p.ADM0_A3 === p.ISO_A3_EH ? p.ISO_A2_EH : '');
  const cont = p.CONTINENT === 'Seven seas (open ocean)' ? 'Oceania' : p.CONTINENT;
  const names = [p.NAME_EN, p.NAME, p.NAME_LONG, p.ADMIN, p.FORMAL_EN, p.NAME_PT, p.NAME_ES, p.NAME_FR, p.NAME_DE, p.NAME_IT, p.NAME_NL,
    p.BRK_NAME, p.NAME_SORT, p.NAME_ALT, p.GEOUNIT, p.SUBUNIT, p.NAME_CIAWF, iso3, iso2,
    ...(EXTRA_ALIASES[iso3] || [])];
  const uniq = [...new Set(names.filter(x => x && typeof x === 'string' && x !== '-99'))];
  countries.push([iso3, iso2 === '-99' ? '' : iso2, contIdx(cont), p.NAME_EN || p.NAME, p.NAME_PT || p.NAME, +(+p.LABEL_X).toFixed(2), +(+p.LABEL_Y).toFixed(2), uniq.join('|'), p.MIN_LABEL || 5]);
  const home = HOME_UNITS[p.ADM0_A3];
  const geom = home ? mergeGeoms(home.map(g => unitByGu.get(g)).filter(Boolean)) : f.geometry;
  feats.push({ type: 'Feature', id: iso3, properties: {}, geometry: geom });
}
for (const gu of Object.keys(EXTRA_UNITS)) {
  const u = unitByGu.get(gu);
  if (!u) { console.warn('missing unit', gu); continue; }
  const p = u.properties;
  const [iso2, cont, extra] = EXTRA_UNITS[gu];
  const iso3 = gu === 'NSV' ? 'SJM' : gu === 'NLY' ? 'BES' : gu;
  if (usedIds.has(iso3)) continue;
  usedIds.add(iso3);
  const names = [p.NAME_EN, p.NAME, p.NAME_LONG, p.GEOUNIT, p.NAME_PT, p.NAME_ES, p.NAME_FR, p.NAME_DE, p.NAME_IT, iso3, gu, iso2, ...extra];
  const uniq = [...new Set(names.filter(x => x && typeof x === 'string' && x !== '-99'))];
  countries.push([iso3, iso2, contIdx(cont), p.NAME_EN || p.NAME, p.NAME_PT || p.NAME, +(+p.LABEL_X).toFixed(2), +(+p.LABEL_Y).toFixed(2), uniq.join('|'), p.MIN_LABEL || 5]);
  feats.push({ type: 'Feature', id: iso3, properties: {}, geometry: u.geometry });
}
let t = presimplify(topology({ c: { type: 'FeatureCollection', features: feats } }));
t = simplify(t, quantile(t, Q_COUNTRIES));
t = clean(t);
t.objects.c.geometries.forEach(g => delete g.properties);

// ---- roads (bucketed by type + min zoom, no per-feature properties) ---------
const buckets = {};
for (const f of roadsSrc.features) {
  const p = f.properties;
  let kind;
  if (/Major Highway|Beltway|Bypass/.test(p.type)) kind = 'M';
  else if (/Secondary Highway/.test(p.type)) kind = 'S';
  else continue;
  const z = Math.min(8, Math.max(3, Math.floor(p.min_zoom || 7)));
  const key = kind + z;
  (buckets[key] = buckets[key] || []).push({ type: 'Feature', properties: {}, geometry: f.geometry });
}
const roadObjs = {};
for (const k of Object.keys(buckets)) roadObjs[k] = { type: 'FeatureCollection', features: buckets[k] };
let rt = presimplify(topology(roadObjs));
rt = simplify(rt, quantile(rt, Q_ROADS));
rt.__q = 5e4;
rt = clean(rt);
for (const k of Object.keys(rt.objects)) rt.objects[k].geometries.forEach(g => delete g.properties);

// ---- cities (full GeoNames cities1000 + admin seats) --------------------------
const neById = new Map();
for (const f of pp.features) if (f.properties.GEONAMESID > 0) neById.set(f.properties.GEONAMESID, f.properties);
const keep = new Map();
for (const c of allCities) {
  if (!c.country) continue;
  keep.set(c.cityId, { n: [c.name], cc: c.country, x: c.loc.coordinates[0], y: c.loc.coordinates[1], pop: c.population || 0 });
}
for (const [id, p] of neById) {
  const k = keep.get(id);
  if (!k) continue;
  for (const nm of [p.NAME, p.NAMEASCII, p.NAME_EN, p.NAME_PT, p.NAME_ES, p.NAME_FR, p.NAME_DE, p.NAME_IT, p.NAME_NL, ...(p.NAMEALT ? String(p.NAMEALT).split('|') : [])])
    if (nm && !k.n.includes(nm)) k.n.push(nm);
}
const byCC = {};
for (const k of keep.values()) (byCC[k.cc] = byCC[k.cc] || []).push(k);
const citiesOut = {};
for (const cc of Object.keys(byCC)) {
  citiesOut[cc] = byCC[cc].sort((a, b) => b.pop - a.pop)
    .map(k => `${k.n.map(s => s.replace(/[|;/]/g, ' ')).join('/')}|${k.x.toFixed(3)}|${k.y.toFixed(3)}|${Math.round(k.pop / 1000)}`).join(';');
}

// ---- write -----------------------------------------------------------------
const hdr = '/* Generated by buildgeo.js — do not edit. */\n';
fs.writeFileSync(SRC + '/geodata.ts', hdr +
  `/* Country shapes: Natural Earth 1:10m (public domain). */\n` +
  `export const CONTINENTS: string[][] = ${JSON.stringify(CONTINENTS)};\n` +
  `// [iso3, iso2, continentIdx, nameEN, namePT, labelLon, labelLat, aliases joined by |, minLabelZoom]\n` +
  `export const COUNTRIES: any[] = ${JSON.stringify(countries)};\n` +
  `export const TOPO_JSON = ${JSON.stringify(JSON.stringify(t))};\n`);
fs.writeFileSync(SRC + '/roads.ts', hdr +
  `/* Roads: Natural Earth 1:10m roads (public domain). Objects keyed M|S + min zoom (M = major highway, S = secondary). */\n` +
  `export const ROADS_JSON = ${JSON.stringify(JSON.stringify(rt))};\n`);
fs.writeFileSync(SRC + '/cities.ts', hdr +
  `/* Cities: GeoNames cities1000 (CC BY 4.0) via all-the-cities, names enriched with Natural Earth populated places. */\n` +
  `// per ISO2: "name/alias/...|lon|lat|popK;..." sorted by population desc\n` +
  `export const CITIES: { [cc: string]: string } = ${JSON.stringify(citiesOut)};\n`);

const sz = f => (fs.statSync(SRC + '/' + f).size / 1e6).toFixed(2) + 'MB';
console.log('countries', countries.length, 'cities', keep.size, 'roads buckets', Object.keys(roadObjs).join(','),
  '| geodata', sz('geodata.ts'), 'roads', sz('roads.ts'), 'cities', sz('cities.ts'));
const ids = countries.map(c => c[0]); console.log('dup iso3', ids.filter((x, i) => ids.indexOf(x) !== i));
