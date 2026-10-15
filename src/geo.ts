"use strict";

import { feature, merge, mesh } from "topojson-client";
import { geoArea, geoBounds, geoContains, geoDistance } from "d3-geo";
import { CONTINENTS, COUNTRIES, TOPO_JSON } from "./geodata";
import { CITIES } from "./cities";
import { ROADS_JSON } from "./roads";
import { POSTAL } from "./postal";
import { MUNI } from "./municipalities";

/** "point" = anything below the city (postal code, customer, store…), placed by postal code or lat/lon. */
export type Level = "continent" | "country" | "district" | "city" | "point";

export interface CountryInfo {
    iso3: string;
    iso2: string;
    continent: number;
    nameEN: string;
    namePT: string;
    label: [number, number];
    minLabelZoom: number;
    /** longitude span (degrees) of the home cluster, used to skip labels of tiny countries */
    lonSpan: number;
    feature: GeoJSON.Feature;
    /** polygons of the "home" cluster (drops far-away overseas territories) used for zoom-to-fit */
    fitFeature: GeoJSON.Feature;
}

export interface ContinentInfo {
    index: number;
    name: string;
    feature: GeoJSON.Feature;
    label: [number, number];
}

export interface CityInfo {
    name: string;
    names: string[];
    iso2: string;
    lon: number;
    lat: number;
    popK: number;
}

const CONTINENT_LABELS: [number, number][] = [[20, 5], [92, 45], [15, 52], [-100, 46], [-60, -15], [138, -24]];

export function normalize(s: unknown): string {
    if (s === null || s === undefined) return "";
    return String(s)
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .toLowerCase()
        .replace(/&/g, "and")
        .replace(/[^a-z0-9]+/g, "");
}

function ringArea(ring: number[][]): number {
    let a = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1]);
    return Math.abs(a / 2);
}

function ringMean(ring: number[][]): [number, number] {
    let x = 0, y = 0;
    for (const p of ring) { x += p[0]; y += p[1]; }
    return [x / ring.length, y / ring.length];
}

/** Keeps only the polygons near the main (largest) polygon so that e.g. France fits to mainland France.
 *  Planar lon/lat maths on purpose: spherical area is winding-sensitive and picks the wrong polygon. */
function homeCluster(f: GeoJSON.Feature): GeoJSON.Feature {
    const g = f.geometry;
    if (!g || g.type !== "MultiPolygon" || g.coordinates.length < 2) return f;
    const polys = g.coordinates.map(c => ({ c, area: ringArea(c[0] as number[][]), mean: ringMean(c[0] as number[][]) }));
    let main = polys[0];
    for (const p of polys) if (p.area > main.area) main = p;
    const keep = polys.filter(p => p === main || geoDistance(main.mean, p.mean) < 0.15).map(p => p.c); // ~11.5 degrees of arc
    return { type: "Feature", properties: {}, geometry: { type: "MultiPolygon", coordinates: keep } };
}

export interface RoadLayer {
    key: string;
    kind: "M" | "S";
    minZoom: number;
    geometry: GeoJSON.MultiLineString;
}

/** Name variants tried in order when an exact match fails ("Lisboa (Sede)", "Porto, PT", "Braga - Centro"). */
function nameVariants(v: unknown): string[] {
    let s = String(v ?? "").trim();
    const out = [s];
    // "VALL D'UIXO (LA)-(CASTELLON)" -> drop a trailing "-(PROVINCE)" / "(PROVINCE)" qualifier
    const noProv = s.replace(/\s*-?\s*\([^)]*\)\s*$/, "").trim();
    // trailing article in brackets: "VALL D'UIXO (LA)" -> "LA VALL D'UIXO" (ES/PT/CA/GL/FR/IT)
    const art = /^(.*?)\s*\((LA|EL|LOS|LAS|L'|LES|ELS|O|A|OS|AS|LE|IL|LO|GLI|I)\)\s*$/i;
    for (const cand of [s, noProv]) {
        const m = art.exec(cand);
        if (m) {
            const a = m[2].toUpperCase() === "L'" ? "L'" : m[2] + " ";
            out.push((a + m[1]).trim());
            out.push(m[1].trim());
        }
    }
    if (noProv && !out.includes(noProv)) out.push(noProv);
    s = noProv || s;
    const noParen = s.replace(/\(.*?\)/g, " ").trim();
    if (noParen && noParen !== s) out.push(noParen);
    for (const sep of [",", " - ", "/"]) {
        const first = s.split(sep)[0].trim();
        if (first && !out.includes(first)) out.push(first);
    }
    // trailing municipality abbreviation: "SERZEDO VNG", "MEIXEDO VCT", "LUZ LGS"
    const abbr = /^(.*\S)\s+-?\s*[B-DF-HJ-NP-TV-Z]{2,4}$/i.exec(s);
    if (abbr && /[aeiou]/i.test(abbr[1])) { const a = abbr[1].trim(); if (!out.includes(a)) out.push(a); }
    // abbreviated saints: "S. MAMEDE", "STO ANDRE", "STA MARIA", "ST MARTIN"
    const sa = /^(S\.|S|STO\.?|STA\.?|ST\.?|STE\.?)\s*(\S.*)$/i.exec(s);
    if (sa && sa[1].length <= 4 && /[.\s]/.test(s.slice(sa[1].length - 1, sa[1].length + 1))) {
        const k = sa[1].replace(".", "").toUpperCase();
        const exp = k === "S" ? ["São", "San", "Santo", "Saint", "Sant"] : k === "STO" ? ["Santo"] : k === "STA" ? ["Santa"] : k === "STE" ? ["Sainte"] : ["Saint", "Santo", "Sankt"];
        for (const e of exp) { const v = e + " " + sa[2]; if (!out.includes(v)) out.push(v); }
    }
    // "BARROS-LANGREO", "OZA-CESURAS": try each part of a hyphenated compound
    if (/[A-Za-zÀ-ÿ]-[A-Za-zÀ-ÿ]/.test(s)) for (const part of s.split("-").map(x => x.trim()).reverse()) if (part.length > 2 && !out.includes(part)) out.push(part);
    return out;
}

export interface MuniInfo {
    cc: string;
    id: number;
    name: string;
    parent: string;
    code: string;
    label: [number, number];
    feature: GeoJSON.Feature;
    /** index into districtsOf(cc) */
    district: number;
    /** "m" municipality-like area, "d" district-only country (the area is the district itself) */
    kind: "m" | "d";
    /** number of official municipalities agglomerated in this area (1 = a single municipality) */
    n: number;
    /** other official municipality names inside this area (agglomerated members, bilingual names) */
    aliases: string[];
    bbox: [number, number, number, number];
    /** polygons as rings of [lon,lat] (planar point-in-polygon, even-odd) */
    polys: number[][][][];
}

/** PT distrito / região autónoma, ES provincia: the union of its municipalities. */
export interface DistrictInfo {
    cc: string;
    index: number;
    name: string;
    names: string[];
    /** merged geometry, built on first use */
    feature: GeoJSON.Feature;
    label: [number, number];
}

interface MuniGrid { cell: number; x0: number; y0: number; bbox: [number, number, number, number]; cells: Map<string, MuniInfo[]> }

function ringContains(ring: number[][], x: number, y: number): boolean {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
        if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
}

function segDist2(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
    const dx = bx - ax, dy = by - ay;
    const l2 = dx * dx + dy * dy;
    let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
    t = Math.max(0, Math.min(1, t));
    const qx = ax + t * dx - px, qy = ay + t * dy - py;
    return qx * qx + qy * qy;
}

const B64 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_-";
const B64V: { [c: string]: number } = {};
for (let i = 0; i < 64; i++) B64V[B64[i]] = i;
/** Compact arcs (see scripts_buildeuro.js): per arc a varint count, then zig-zag varints of delta-encoded integers. */
function decodeArcs(str: string): number[][][] {
    const arcs: number[][][] = [];
    let i = 0;
    const rd = (): number => { let v = 0, m = 1, c: number; do { c = B64V[str[i++]]; v += (c & 31) * m; m *= 32; } while (c & 32); return v; };
    const zz = (v: number) => (v % 2 ? -(v + 1) / 2 : v / 2);
    while (i < str.length) {
        const n = rd();
        const a: number[][] = new Array(n);
        for (let k = 0; k < n; k++) { const x = zz(rd()); const y = zz(rd()); a[k] = [x, y]; }
        arcs.push(a);
    }
    return arcs;
}
/** d3-geo wants clockwise exteriors: a polygon covering more than a hemisphere was inverted by simplification. */
function fixWinding(g: GeoJSON.Geometry | null): void {
    if (!g) return;
    const ps = g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : [];
    for (const p of ps) if (geoArea({ type: "Polygon", coordinates: p } as any) > 2 * Math.PI) p.forEach(r => r.reverse());
}

export class GeoIndex {
    public countries: CountryInfo[] = [];
    public continents: ContinentInfo[] = [];
    private countryByKey = new Map<string, CountryInfo>();
    private countryByIso2 = new Map<string, CountryInfo>();
    private continentByKey = new Map<string, ContinentInfo>();
    private citiesByIso2 = new Map<string, CityInfo[]>();
    private cityKeyByIso2 = new Map<string, Map<string, CityInfo>>();
    private globalCityIndex: Map<string, CityInfo[]> | null = null;
    private allCitiesByPop: CityInfo[] | null = null;
    private roads: RoadLayer[] | null = null;
    private postalMaps = new Map<string, { L: number; M: number; map: Map<string, [number, number]>; keys: string[] }>();

    constructor() {
        const topo = JSON.parse(TOPO_JSON);
        const fc = feature(topo, topo.objects.c) as unknown as GeoJSON.FeatureCollection;
        const featById = new Map<string, GeoJSON.Feature>();
        fc.features.forEach(f => featById.set(String(f.id), f));

        // countries; explicit aliases (last segment of list) should win over generic collisions, so insert in two passes
        for (const row of COUNTRIES) {
            const [iso3, iso2, cont, nameEN, namePT, lx, ly, , minLabel] = row;
            const f = featById.get(iso3);
            if (!f) continue;
            const fit = homeCluster(f);
            const b = geoBounds(fit as any);
            const lonSpan = b[1][0] >= b[0][0] ? b[1][0] - b[0][0] : b[1][0] + 360 - b[0][0];
            const info: CountryInfo = {
                iso3, iso2, continent: cont, nameEN, namePT, label: [lx, ly], minLabelZoom: +minLabel || 5,
                lonSpan, feature: f, fitFeature: fit
            };
            this.countries.push(info);
            if (iso2) this.countryByIso2.set(iso2, info);
        }
        const aliasRows = COUNTRIES.map((r: any[]) => (r[7] as string).split("|"));
        // pass 1: all aliases, only if free
        this.countries.forEach((c, i) => {
            for (const a of aliasRows[i]) {
                const k = normalize(a);
                if (k && !this.countryByKey.has(k)) this.countryByKey.set(k, c);
            }
        });
        // pass 2: primary names and ISO codes always win
        this.countries.forEach(c => {
            for (const a of [c.nameEN, c.namePT, c.iso3, c.iso2]) {
                const k = normalize(a);
                if (k) this.countryByKey.set(k, c);
            }
        });

        // continents (merged at runtime from country shapes, shares the same arcs)
        CONTINENTS.forEach((aliases, idx) => {
            const geoms = topo.objects.c.geometries.filter((g: any) => {
                const c = this.countries.find(x => x.iso3 === String(g.id));
                return c && c.continent === idx;
            });
            const geom = merge(topo, geoms) as unknown as GeoJSON.MultiPolygon;
            const info: ContinentInfo = {
                index: idx, name: aliases[0],
                feature: { type: "Feature", id: aliases[0], properties: {}, geometry: geom },
                label: CONTINENT_LABELS[idx]
            };
            this.continents.push(info);
            for (const a of aliases) this.continentByKey.set(normalize(a), info);
        });
    }

    public findContinent(v: unknown): ContinentInfo | undefined {
        return this.continentByKey.get(normalize(v));
    }

    public findCountry(v: unknown): CountryInfo | undefined {
        return this.countryByKey.get(normalize(v));
    }

    public countryByIso2Code(iso2: string): CountryInfo | undefined {
        return this.countryByIso2.get(iso2);
    }

    public citiesOf(iso2: string): CityInfo[] {
        let list = this.citiesByIso2.get(iso2);
        if (list) return list;
        list = [];
        const raw = (CITIES as any)[iso2] as string | undefined;
        const keyMap = new Map<string, CityInfo>();
        if (raw) {
            for (const entry of raw.split(";")) {
                const [names, lon, lat, pop] = entry.split("|");
                const all = names.split("/");
                const c: CityInfo = { name: all[0], names: all, iso2, lon: +lon, lat: +lat, popK: +pop };
                list.push(c);
                for (const n of all) {
                    const k = normalize(n);
                    if (k && !keyMap.has(k)) keyMap.set(k, c); // list is sorted by population: biggest wins
                }
            }
        }
        this.citiesByIso2.set(iso2, list);
        this.cityKeyByIso2.set(iso2, keyMap);
        return list;
    }

    public findCityIn(iso2: string, name: unknown): CityInfo | undefined {
        if (!iso2) return undefined;
        this.citiesOf(iso2);
        const map = this.cityKeyByIso2.get(iso2);
        if (!map) return undefined;
        for (const v of nameVariants(name)) {
            const hit = map.get(normalize(v));
            if (hit) return hit;
        }
        return undefined;
    }

    /** All candidate cities (any country) with this name. Built lazily on first use. */
    public findCityAnywhere(name: unknown): CityInfo[] {
        if (!this.globalCityIndex) {
            this.globalCityIndex = new Map();
            for (const iso2 of Object.keys(CITIES)) {
                this.citiesOf(iso2);
                this.cityKeyByIso2.get(iso2)?.forEach((c, k) => {
                    const arr = this.globalCityIndex!.get(k);
                    if (arr) arr.push(c); else this.globalCityIndex!.set(k, [c]);
                });
            }
        }
        for (const v of nameVariants(name)) {
            const hit = this.globalCityIndex.get(normalize(v));
            if (hit) return hit;
        }
        return [];
    }

    public static normalizePostal(v: unknown): string {
        return String(v ?? "").toUpperCase().replace(/[^0-9A-Z]/g, "");
    }

    /** Postal-code centroid (lon/lat) for a country; codes are matched on the country's stored prefix length,
     *  and shorter inputs (e.g. Portuguese CP4 "4700") average every stored code sharing that prefix. */
    public findPostal(iso2: string, code: unknown, loose = false): [number, number] | undefined {
        const raw = (POSTAL as any)[iso2] as { L: number; M: number; d: string } | undefined;
        if (!raw) return undefined;
        let pm = this.postalMaps.get(iso2);
        if (!pm) {
            const map = new Map<string, [number, number]>();
            for (const e of raw.d.split(";")) {
                const [k, lon, lat] = e.split("|");
                map.set(k, [+lon, +lat]);
            }
            pm = { L: raw.L, M: raw.M || raw.L, map, keys: [...map.keys()] };
            this.postalMaps.set(iso2, pm);
        }
        let c = GeoIndex.normalizePostal(code);
        if (!c) return undefined;
        // tolerate a leading country prefix ("PT-4700-001", "D-80331")
        if (/^[A-Z]+/.test(c) && !/^[A-Z]/.test(pm.keys[0] || "")) c = c.replace(/^[A-Z]+/, "");
        // a code longer than the stored prefix must have this country's usual length (PT "4700-001" = 7, ES "28001" = 5)
        if (/^\d+$/.test(c) && /^\d+$/.test(pm.keys[0] || "")) {
            if (c.length >= pm.L && c.length !== pm.M && c.length !== pm.L) return undefined;
            if (c.length >= pm.L && c.length === pm.L && pm.M !== pm.L) return undefined;
        }
        const exact = pm.map.get(c.slice(0, pm.L));
        if (exact) return exact;
        // prefix averaging only for inputs shorter than the stored granularity (e.g. a 4-digit CP4);
        // a full-length code that does not exist is a miss (avoids "28001" (ES) matching Portugal's "2800x")
        // loose (the row's own country is known): a code missing from the list (e.g. PT company codes "4416-901")
        // falls back to the average of its area (CP4 / first digits)
        if (c.length >= pm.L && !loose) return undefined;
        for (let len = Math.min(c.length, pm.L - 1); len >= Math.max(2, pm.L - 3); len--) {
            const pre = c.slice(0, len);
            let x = 0, y = 0, n = 0;
            for (const k of pm.keys) if (k.startsWith(pre)) { const v = pm.map.get(k)!; x += v[0]; y += v[1]; n++; }
            if (n) return [x / n, y / n];
        }
        return undefined;
    }

    /** ISO2 codes of every country where this postal code exists (used to tell "outside the focus" from "unknown"). */
    public postalCountries(code: unknown): string[] {
        const out: string[] = [];
        for (const cc of Object.keys(POSTAL)) if (this.findPostal(cc, code)) out.push(cc);
        return out;
    }

    /** Best-guess country for a postal code from its shape when nothing else is known. */
    public static postalCountryGuess(code: unknown): string | undefined {
        const s = String(code ?? "").trim();
        if (/^\d{4}-\d{3}$/.test(s)) return "PT";
        if (/^[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}$/i.test(s)) return "GB";
        if (/^\d{5}-\d{3}$/.test(s)) return "BR";
        return undefined;
    }

    /** Every known city sorted by population (desc), used for basemap place labels. */
    // ---- municipalities (LAU) ----------------------------------------------------------------

    private muniCache = new Map<string, MuniInfo[]>();
    private muniTopos = new Map<string, any>();
    private districtCache = new Map<string, DistrictInfo[]>();
    private districtByKey: Map<string, DistrictInfo> | null = null;

    private muniTopo(iso2: string): any {
        let t = this.muniTopos.get(iso2);
        if (!t) {
            t = JSON.parse((MUNI as any)[iso2].topo);
            if (typeof t.A === "string") { t.arcs = decodeArcs(t.A); delete t.A; }
            this.muniTopos.set(iso2, t);
        }
        return t;
    }

    /** Districts / provinces of a country; geometry = union of their municipalities (same borders). */
    public districtsOf(iso2: string): DistrictInfo[] {
        const cached = this.districtCache.get(iso2);
        if (cached) return cached;
        const pack = (MUNI as any)[iso2] as { districts: string; k?: string } | undefined;
        const list: DistrictInfo[] = [];
        if (pack) {
            // names only: geometry and members are parsed on first use (the name index spans every country)
            const geo = this;
            pack.districts.split(";").forEach((entry, index) => {
                const names = entry.split("/");
                let feat: GeoJSON.Feature | null = null;
                let label: [number, number] | null = null;
                const members = () => geo.municipalitiesOf(iso2).filter(m => m.district === index);
                const info: DistrictInfo = {
                    cc: iso2, index, name: names[0], names,
                    get feature(): GeoJSON.Feature {
                        if (!feat) {
                            const ms = members();
                            if (pack.k === "d" && ms.length === 1) feat = ms[0].feature;
                            else {
                                const topo = geo.muniTopo(iso2);
                                const ids = new Set(ms.map(m => m.id));
                                const geoms = topo.objects.m.geometries.filter((g: any) => ids.has(Number(g.id)));
                                const g = merge(topo, geoms) as any;
                                fixWinding(g);
                                feat = { type: "Feature", properties: {}, geometry: g };
                            }
                        }
                        return feat;
                    },
                    get label(): [number, number] {
                        if (!label) label = geo.districtLabel(members());
                        return label;
                    }
                };
                list.push(info);
            });
        }
        this.districtCache.set(iso2, list);
        return list;
    }

    /** Label point: the member municipality closest to the area-weighted centre (always inside the district). */
    private districtLabel(members: MuniInfo[]): [number, number] {
        if (!members.length) return [0, 0];
        let x = 0, y = 0, w = 0;
        for (const m of members) { const a = Math.max(1e-6, (m.bbox[2] - m.bbox[0]) * (m.bbox[3] - m.bbox[1])); x += m.label[0] * a; y += m.label[1] * a; w += a; }
        x /= w; y /= w;
        // ignore far islands: use the members of the largest connected bbox cluster around the centre
        let best = members[0], bd = Infinity;
        for (const m of members) { const d = (m.label[0] - x) ** 2 + (m.label[1] - y) ** 2; if (d < bd) { bd = d; best = m; } }
        return best.label;
    }

    /** District / province by name or alias (PT and ES). */
    public findDistrict(v: unknown, iso2?: string): DistrictInfo | undefined {
        if (!this.districtByKey) {
            this.districtByKey = new Map();
            for (const cc of this.districtCountries()) for (const d of this.districtsOf(cc)) for (const n of d.names) {
                const k = normalize(n);
                if (k && !this.districtByKey.has(k)) this.districtByKey.set(k, d);
                const kc = cc + ":" + k;
                if (k) this.districtByKey.set(kc, d);
            }
        }
        const k = normalize(v);
        return iso2 ? (this.districtByKey.get(iso2 + ":" + k) || this.districtByKey.get(k)) : this.districtByKey.get(k);
    }
    private muniGrids = new Map<string, MuniGrid>();
    private muniMeshes = new Map<string, GeoJSON.MultiLineString>();

    private districtMeshes = new Map<string, GeoJSON.MultiLineString>();

    /** Borders between districts / provinces (and the coast) as one line geometry. */
    public districtMesh(iso2: string): GeoJSON.MultiLineString | undefined {
        if (!this.hasDistricts(iso2)) return undefined;
        let m = this.districtMeshes.get(iso2);
        if (!m) {
            const topo = this.muniTopo(iso2);
            const byId = new Map(this.municipalitiesOf(iso2).map(x => [x.id, x.district]));
            m = mesh(topo, topo.objects.m, (a: any, b: any) => a === b || byId.get(Number(a.id)) !== byId.get(Number(b.id))) as unknown as GeoJSON.MultiLineString;
            this.districtMeshes.set(iso2, m);
        }
        return m;
    }

    private outlineMeshes = new Map<string, GeoJSON.MultiLineString>();
    /** Outer boundary of a country from its own areas (matches its district / municipality borders exactly). */
    public countryOutline(iso2: string): GeoJSON.MultiLineString | undefined {
        if (!this.hasDistricts(iso2)) return undefined;
        let m = this.outlineMeshes.get(iso2);
        if (!m) {
            const topo = this.muniTopo(iso2);
            m = mesh(topo, topo.objects.m, (a: any, b: any) => a === b) as unknown as GeoJSON.MultiLineString;
            this.outlineMeshes.set(iso2, m);
        }
        return m;
    }

    /** lon/lat bounds of a country (cached). */
    public countryBounds(c: CountryInfo): [[number, number], [number, number]] {
        if (!this.countryBoxes) this.countryBoxes = this.countries.map(x => ({ c: x, b: geoBounds(x.feature as any) as [[number, number], [number, number]] }));
        const e = this.countryBoxes.find(x => x.c === c);
        return e ? e.b : [[-180, -90], [180, 90]];
    }

    /** All municipal borders of a country as one line geometry (fast to draw as context). */
    public municipalityMesh(iso2: string): GeoJSON.MultiLineString | undefined {
        if (!this.hasMunicipalities(iso2)) return undefined;
        let m = this.muniMeshes.get(iso2);
        if (!m) {
            const topo = this.muniTopo(iso2);
            m = mesh(topo, topo.objects.m) as unknown as GeoJSON.MultiLineString;
            this.muniMeshes.set(iso2, m);
        }
        return m;
    }

    /** Countries with municipality-like areas (Europe). */
    public hasMunicipalities(iso2?: string): boolean {
        const M = MUNI as any;
        return iso2 ? !!M[iso2] && M[iso2].k !== "d" : this.municipalityCountries().length > 0;
    }

    private muniCountryList: string[] | null = null;
    public municipalityCountries(): string[] {
        if (!this.muniCountryList) this.muniCountryList = Object.keys(MUNI).filter(cc => (MUNI as any)[cc].k !== "d");
        return this.muniCountryList;
    }

    /** Countries with first-level divisions (every country with a pack, municipality countries included). */
    public hasDistricts(iso2?: string): boolean {
        return iso2 ? !!(MUNI as any)[iso2] : Object.keys(MUNI).length > 0;
    }

    public districtCountries(): string[] {
        return Object.keys(MUNI);
    }

    private areaNameIndex = new Map<string, Map<string, MuniInfo[]>>();
    /** Municipality-like areas whose own name or member municipality name matches (municipality countries only).
     *  Several candidates (same name in two provinces): the one nearest to "near" first. */
    public findAreasByName(iso2: string, name: unknown, near?: [number, number]): MuniInfo[] {
        if (!this.hasMunicipalities(iso2)) return [];
        let idx = this.areaNameIndex.get(iso2);
        if (!idx) {
            idx = new Map();
            const add = (k: string, m: MuniInfo) => { if (!k) return; const arr = idx!.get(k); if (!arr) idx!.set(k, [m]); else if (!arr.includes(m)) arr.push(m); };
            for (const m of this.municipalitiesOf(iso2)) for (const n of [m.name, ...m.aliases]) {
                add(normalize(n), m);
                // "l'Hospitalet de Llobregat" / "O Carballiño" / "La Almunia…" also without the article
                const noArt = n.replace(/^(l'|l’|la |el |les |els |lo |los |las |o |a |os |as |il |le |i )/i, "");
                if (noArt !== n) add(normalize(noArt), m);
            }
            this.areaNameIndex.set(iso2, idx);
        }
        const vars = nameVariants(name);
        for (const v of vars.slice()) { const na = v.replace(/^(l'|l’|la |el |les |els |lo |los |las |o |a |os |as |il |le |i )/i, ""); if (na !== v && !vars.includes(na)) vars.push(na); }
        for (const v of vars) {
            const hit = idx.get(normalize(v));
            if (hit) {
                if (hit.length > 1 && near) return hit.slice().sort((a, b) => geoDistance(a.label, near) - geoDistance(b.label, near));
                return hit;
            }
        }
        return [];
    }

    /** District-or-municipality area containing a point (any country with a pack). */
    public findArea(iso2: string, pt: [number, number], strict = false): MuniInfo | undefined {
        return this.hasDistricts(iso2) ? this.findAreaIn(iso2, pt, strict) : undefined;
    }

    private countryBoxes: { c: CountryInfo; b: [[number, number], [number, number]] }[] | null = null;
    /** Country under a lon/lat point, bbox-prefiltered (fast enough for hover). */
    public countryAtFast(lon: number, lat: number): CountryInfo | undefined {
        if (!this.countryBoxes) this.countryBoxes = this.countries.map(c => ({ c, b: geoBounds(c.feature as any) as [[number, number], [number, number]] }));
        for (const { c, b } of this.countryBoxes) {
            const inLon = b[0][0] <= b[1][0] ? lon >= b[0][0] && lon <= b[1][0] : lon >= b[0][0] || lon <= b[1][0];
            if (inLon && lat >= b[0][1] && lat <= b[1][1] && geoContains(c.feature as any, [lon, lat])) return c;
        }
        return undefined;
    }

    /** All municipalities of a country (parsed lazily on first use). */
    public municipalitiesOf(iso2: string): MuniInfo[] {
        const cached = this.muniCache.get(iso2);
        if (cached) return cached;
        const pack = (MUNI as any)[iso2] as { meta: string; topo: string; k?: string } | undefined;
        const list: MuniInfo[] = [];
        if (pack) {
            const topo = this.muniTopo(iso2);
            const fc = feature(topo, topo.objects.m) as unknown as GeoJSON.FeatureCollection;
            const meta = pack.meta.split(";");
            const cell = 0.25;
            let bx0 = 180, by0 = 90, bx1 = -180, by1 = -90;
            fc.features.forEach(f => {
                const id = Number(f.id);
                const [name, parent, code, lx, ly, di, nn, al] = (meta[id] || "").split("|");
                const g = f.geometry as GeoJSON.Polygon | GeoJSON.MultiPolygon;
                if (!g) return;
                fixWinding(g);
                const polys = (g.type === "Polygon" ? [g.coordinates] : g.coordinates) as number[][][][];
                let x0 = 180, y0 = 90, x1 = -180, y1 = -90;
                for (const p of polys) for (const [x, y] of p[0]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
                bx0 = Math.min(bx0, x0); by0 = Math.min(by0, y0); bx1 = Math.max(bx1, x1); by1 = Math.max(by1, y1);
                list.push({ cc: iso2, id, name, parent, code, label: [+lx, +ly], feature: f, district: +di || 0, kind: pack.k === "d" ? "d" : "m", n: +nn || 1, aliases: al ? al.split("/") : [], bbox: [x0, y0, x1, y1], polys });
            });
            const grid: MuniGrid = { cell, x0: bx0, y0: by0, bbox: [bx0, by0, bx1, by1], cells: new Map() };
            for (const m of list) {
                for (let gx = Math.floor((m.bbox[0] - bx0) / cell); gx <= Math.floor((m.bbox[2] - bx0) / cell); gx++)
                    for (let gy = Math.floor((m.bbox[1] - by0) / cell); gy <= Math.floor((m.bbox[3] - by0) / cell); gy++) {
                        const k = gx + ":" + gy;
                        const arr = grid.cells.get(k);
                        if (arr) arr.push(m); else grid.cells.set(k, [m]);
                    }
            }
            this.muniGrids.set(iso2, grid);
        }
        this.muniCache.set(iso2, list);
        return list;
    }

    /** Municipality containing a lon/lat point; points just off a simplified coastline snap to the nearest one (≤ ~2 km). */
    public findMunicipality(iso2: string, pt: [number, number], strict = false): MuniInfo | undefined {
        return this.hasMunicipalities(iso2) ? this.findAreaIn(iso2, pt, strict) : undefined;
    }

    private findAreaIn(iso2: string, pt: [number, number], strict: boolean): MuniInfo | undefined {
        this.municipalitiesOf(iso2);
        const grid = this.muniGrids.get(iso2)!;
        const [x, y] = pt;
        const b = grid.bbox, tol = 0.05;
        if (x < b[0] - tol || x > b[2] + tol || y < b[1] - tol || y > b[3] + tol) return undefined;
        const gx = Math.floor((x - grid.x0) / grid.cell), gy = Math.floor((y - grid.y0) / grid.cell);
        const inside = (m: MuniInfo) => x >= m.bbox[0] && x <= m.bbox[2] && y >= m.bbox[1] && y <= m.bbox[3] &&
            m.polys.some(p => { let c = 0; for (const r of p) if (ringContains(r, x, y)) c++; return c % 2 === 1; });
        for (const m of grid.cells.get(gx + ":" + gy) || []) if (inside(m)) return m;
        if (strict) return undefined;
        // nearest edge among neighbouring cells
        let best: MuniInfo | undefined, bestD = tol * tol;
        for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
            for (const m of grid.cells.get((gx + dx) + ":" + (gy + dy)) || []) {
                if (x < m.bbox[0] - tol || x > m.bbox[2] + tol || y < m.bbox[1] - tol || y > m.bbox[3] + tol) continue;
                for (const p of m.polys) for (const r of p) for (let i = 1; i < r.length; i++) {
                    const d2 = segDist2(x, y, r[i - 1][0], r[i - 1][1], r[i][0], r[i][1]);
                    if (d2 < bestD) { bestD = d2; best = m; }
                }
            }
        }
        return best;
    }

    public citiesByPopulation(): CityInfo[] {
        if (!this.allCitiesByPop) {
            const all: CityInfo[] = [];
            for (const iso2 of Object.keys(CITIES)) for (const c of this.citiesOf(iso2)) all.push(c);
            all.sort((a, b) => b.popK - a.popK);
            this.allCitiesByPop = all;
        }
        return this.allCitiesByPop;
    }

    /** Road layers (one merged MultiLineString per type + min zoom), parsed lazily. */
    public roadLayers(): RoadLayer[] {
        if (!this.roads) {
            const topo = JSON.parse(ROADS_JSON);
            this.roads = Object.keys(topo.objects).map(key => {
                const fc = feature(topo, topo.objects[key]) as unknown as GeoJSON.FeatureCollection;
                const lines: GeoJSON.Position[][] = [];
                for (const f of fc.features) {
                    const g = f.geometry as GeoJSON.LineString | GeoJSON.MultiLineString;
                    if (!g) continue;
                    if (g.type === "LineString") lines.push(g.coordinates);
                    else lines.push(...g.coordinates);
                }
                return { key, kind: key[0] as "M" | "S", minZoom: +key.slice(1), geometry: { type: "MultiLineString", coordinates: lines } };
            });
            this.roads.sort((a, b) => (a.kind === b.kind ? b.minZoom - a.minZoom : a.kind === "S" ? -1 : 1)); // secondary first, major on top
        }
        return this.roads;
    }

    /** Country containing a lon/lat point (slow path, used only when coordinates are given without a known country). */
    public countryAt(lon: number, lat: number): CountryInfo | undefined {
        for (const c of this.countries) if (geoContains(c.feature, [lon, lat])) return c;
        return undefined;
    }
}
