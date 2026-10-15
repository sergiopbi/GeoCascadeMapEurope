// Test harness: runs the real Visual class in a browser with a fake Power BI host + dataView
import { Visual } from "../src/visual";

const PALETTE = ["#118DFF", "#12239E", "#E66C37", "#6B007B", "#E044A7", "#744EC2", "#D9B300", "#D64550"];

function makeId(key: string): any {
    return { key, equals: (o: any) => o && o.key === key, getSelector: () => ({ key }), includes: () => false };
}

function makeHost(log: string[]): any {
    let pi = 0;
    const colors = new Map<string, string>();
    const selected: any[] = [];
    return {
        locale: "pt-PT",
        hostCapabilities: { allowInteractions: true },
        persistProperties: () => { /* noop */ },
        createLocalizationManager: () => ({ getDisplayName: (k: string) => (window as any).__res?.[k] ?? k }),
        applyJsonFilter: (f: any, _o: string, _p: string, a: number) => log.push("filter " + (a === 1 ? "REMOVE" : JSON.stringify((Array.isArray(f) ? f : [f]).map((x: any) => [x.target.column, x.values])))),
        colorPalette: {
            isHighContrast: false,
            foreground: { value: "#000000" }, background: { value: "#FFFFFF" }, foregroundSelected: { value: "#000" },
            getColor: (k: string) => { if (!colors.has(k)) colors.set(k, PALETTE[pi++ % PALETTE.length]); return { value: colors.get(k) }; }
        },
        createSelectionManager: () => ({
            registerOnSelectCallback() { /* */ },
            clear: () => { selected.length = 0; return Promise.resolve(); },
            select: (ids: any, multi: boolean) => { if (!multi) selected.length = 0; (Array.isArray(ids) ? ids : [ids]).forEach(i => selected.push(i)); log.push("select " + selected.length); return Promise.resolve(); },
            getSelectionIds: () => selected.slice(),
            showContextMenu: () => Promise.resolve()
        }),
        createSelectionIdBuilder: () => {
            const parts: string[] = [];
            const b: any = {
                withCategory: (c: any, i: number) => { parts.push(c.source.displayName + "=" + c.values[i]); return b; },
                withSeries: (_v: any, g: any) => { parts.push("s=" + g.name); return b; },
                withMeasure: (m: string) => { parts.push("m=" + m); return b; },
                createSelectionId: () => makeId(parts.join("|"))
            };
            return b;
        },
        displayWarningIcon: (a: string, b: string) => log.push("warnicon " + a + " / " + b),
        tooltipService: { show: (o: any) => log.push("tooltip " + JSON.stringify(o.dataItems)), move: () => { /* */ }, hide: () => { /* */ } },
        eventService: { renderingStarted() { /* */ }, renderingFinished() { /* */ }, renderingFailed: (_o: any, m: string) => log.push("FAILED " + m) }
    };
}

export interface Scenario {
    title: string;
    width?: number;
    height?: number;
    levels: { name: string; values: string[]; role?: string }[];
    measures: { role: string; name: string; format?: string; values: (number | string | null)[] }[];
    legend?: { name: string; categories: string[]; split: (row: number, cat: number) => number };
    objects?: any;
}

function buildDataView(sc: Scenario): any {
    const categories = sc.levels.map(l => ({ source: { displayName: l.name, roles: { [l.role || "location"]: true }, queryName: "Geo." + l.name, expr: { source: { entity: "Geo" }, ref: l.name } }, values: l.values }));
    const metaCols: any[] = categories.map(c => c.source);
    const mkCol = (m: any, vals: any[], groupName?: string) => ({ source: { displayName: m.name, roles: { [m.role]: true }, format: m.format, groupName }, values: vals });
    let groups: any[]; let flat: any[];
    if (sc.legend) {
        metaCols.push({ displayName: sc.legend.name, roles: { legend: true } });
        groups = sc.legend.categories.map((cname, ci) => ({
            name: cname, identity: { key: "s" + ci },
            values: sc.measures.map(m => mkCol(m, m.values.map((v, ri) => (typeof v === "number" && (m.role === "color" || m.role === "size")) ? v * sc.legend!.split(ri, ci) : v), cname))
        }));
        flat = groups.reduce((a, g) => a.concat(g.values), []);
    } else {
        flat = sc.measures.map(m => mkCol(m, m.values));
        groups = [{ name: undefined, identity: undefined, values: flat }];
    }
    sc.measures.forEach(m => metaCols.push({ displayName: m.name, roles: { [m.role]: true }, isMeasure: true }));
    const values: any = flat.slice();
    values.grouped = () => groups;
    return { metadata: { columns: metaCols, objects: sc.objects || {} }, categorical: { categories, values } };
}

(window as any).runScenario = (sc: Scenario) => {
    const el = document.createElement("div");
    el.className = "visual-host";
    el.style.cssText = `width:${sc.width || 800}px;height:${sc.height || 520}px;position:relative;border:1px solid #ccc;margin:10px;background:#fff`;
    const title = document.createElement("h3");
    title.textContent = sc.title;
    title.style.cssText = "font:14px sans-serif;margin:16px 10px 0";
    document.body.appendChild(title);
    document.body.appendChild(el);
    const log: string[] = [];
    const host = makeHost(log);
    const v = new Visual({ element: el, host } as any);
    const t0 = performance.now();
    v.update({ viewport: { width: sc.width || 800, height: sc.height || 520 }, dataViews: [buildDataView(sc)], type: 2 } as any);
    (el as any).__ms = Math.round(performance.now() - t0);
    (el as any).__visual = v;
    (el as any).__log = log;
    try { (el as any).__fm = (v as any).getFormattingModel(); } catch (e) { log.push("FAILED fmt " + (e as Error).message); }
    return true;
};
(window as any).__harness = { makeHost, buildDataView };
