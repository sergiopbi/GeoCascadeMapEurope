"use strict";

export type Units = "auto" | "none" | "thousands" | "millions" | "billions";

function parseFormatSection(section: string): { prefix: string; suffix: string; decimals: number; group: boolean } {
    const s = section || "";
    const match = /[#0][#0,. ]*[#0]|[#0]/.exec(s);
    if (!match) return { prefix: s.trim(), suffix: "", decimals: -1, group: true };
    const num = match[0];
    const dot = num.indexOf(".");
    const decimals = dot >= 0 ? num.length - dot - 1 : 0;
    // thousands grouping only when the format string asks for it ("#,0.00" yes, "0.00" no)
    const group = /[,\s]/.test(dot >= 0 ? num.slice(0, dot) : num);
    const strip = (t: string) => t.replace(/"/g, "").replace(/\\(.)/g, "$1");
    return { prefix: strip(s.slice(0, match.index)), suffix: strip(s.slice(match.index + num.length)), decimals, group };
}

const sepCache = new Map<string, { dec: string; grp: string }>();
/** Decimal and thousands separators of the report culture, as Power BI shows them
 *  (the browser's pt-PT uses a space and skips 4-digit grouping; Power BI uses "." always). */
function separators(locale?: string): { dec: string; grp: string } {
    const key = locale || "";
    let s = sepCache.get(key);
    if (!s) {
        let dec = ".", grp = ",";
        try {
            for (const p of new Intl.NumberFormat(locale || undefined).formatToParts(12345678.9)) {
                if (p.type === "decimal") dec = p.value;
                if (p.type === "group") grp = p.value;
            }
        } catch { /* default separators */ }
        if (/^pt/i.test(key)) { dec = ","; grp = "."; }
        s = { dec, grp };
        sepCache.set(key, s);
    }
    return s;
}

/** Number text with Power BI-like separators: fixed decimals, thousands grouped every 3 digits when asked. */
function numText(v: number, decimals: number, locale: string | undefined, group: boolean): string {
    const { dec, grp } = separators(locale);
    const neg = v < 0;
    const fixed = Math.abs(v).toFixed(Math.max(0, decimals));
    const [int, frac] = fixed.split(".");
    const intTxt = group ? int.replace(/\B(?=(\d{3})+(?!\d))/g, grp) : int;
    return (neg ? "-" : "") + intTxt + (frac ? dec + frac : "");
}

function sectionFor(value: number, formatString: string): string {
    const parts = (formatString || "").split(";");
    if (value < 0 && parts.length > 1 && parts[1]) return parts[1];
    if (value === 0 && parts.length > 2 && parts[2]) return parts[2];
    return parts[0];
}

/** Display formatter with K/M/B units (labels, legend). */
export function formatValue(value: number | null | undefined, formatString: string | undefined, unit: Units, decimals: number, locale?: string): string {
    if (value === null || value === undefined || isNaN(value as number)) return "";
    const fs = formatString || "";
    if (/%/.test(fs)) {
        return numText(value * 100, decimals, locale, true) + "%";
    }
    const sec = sectionFor(value, fs);
    const { prefix, suffix, group } = parseFormatSection(sec);
    const negativeHandledBySection = value < 0 && fs.split(";").length > 1;
    const v = negativeHandledBySection ? Math.abs(value) : value;
    const abs = Math.abs(v);
    let divisor = 1, letter = "";
    if (unit === "thousands" || (unit === "auto" && abs >= 1e3 && abs < 1e6)) { divisor = 1e3; letter = "K"; }
    else if (unit === "millions" || (unit === "auto" && abs >= 1e6 && abs < 1e9)) { divisor = 1e6; letter = "M"; }
    else if (unit === "billions" || (unit === "auto" && abs >= 1e9)) { divisor = 1e9; letter = "B"; }
    const d = divisor === 1 && unit !== "none" && Number.isInteger(v) ? 0 : decimals;
    const txt = numText(v / divisor, d, locale, group || !fs);
    return `${prefix}${txt}${letter}${suffix}`;
}

/** Exact formatter (tooltips): no unit scaling, decimals from the format string (default 2 when not integer). */
export function formatExact(value: number | null | undefined, formatString: string | undefined, locale?: string): string {
    if (value === null || value === undefined) return "";
    if (typeof value !== "number") return String(value);
    const fs = formatString || "";
    if (/%/.test(fs)) {
        const p = parseFormatSection(sectionFor(value, fs).replace("%", ""));
        const d = p.decimals >= 0 ? p.decimals : 1;
        return numText(value * 100, d, locale, p.group) + "%";
    }
    const sec = sectionFor(value, fs);
    const { prefix, suffix, decimals, group } = parseFormatSection(sec);
    const negativeHandledBySection = value < 0 && fs.split(";").length > 1;
    const v = negativeHandledBySection ? Math.abs(value) : value;
    const d = decimals >= 0 ? decimals : (Number.isInteger(v) ? 0 : 2);
    const txt = numText(v, d, locale, group || !fs);
    return `${prefix}${txt}${suffix}`;
}

export function safeMin(values: number[]): number { let m = Infinity; for (const v of values) if (v < m) m = v; return m; }
export function safeMax(values: number[]): number { let m = -Infinity; for (const v of values) if (v > m) m = v; return m; }
