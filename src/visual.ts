"use strict";

import powerbi from "powerbi-visuals-api";
import { FormattingSettingsService, formattingSettings } from "powerbi-visuals-utils-formattingmodel";
import * as d3 from "./d3";
import "./../style/visual.less";
import { BasicFilter, TupleFilter } from "powerbi-models";

import { VisualFormattingSettingsModel, localizeDropdownItems } from "./settings";
import { GeoIndex, Level, CountryInfo, ContinentInfo, CityInfo, MuniInfo, DistrictInfo, normalize } from "./geo";
import { formatValue, formatExact, safeMin, safeMax, Units } from "./format";

import VisualConstructorOptions = powerbi.extensibility.visual.VisualConstructorOptions;
import VisualUpdateOptions = powerbi.extensibility.visual.VisualUpdateOptions;
import IVisual = powerbi.extensibility.visual.IVisual;
import IVisualHost = powerbi.extensibility.visual.IVisualHost;
import ISelectionManager = powerbi.extensibility.ISelectionManager;
import ISelectionId = powerbi.visuals.ISelectionId;
import DataView = powerbi.DataView;
import DataViewValueColumn = powerbi.DataViewValueColumn;
import DataViewValueColumnGroup = powerbi.DataViewValueColumnGroup;
import DataViewCategoryColumn = powerbi.DataViewCategoryColumn;
import VisualTooltipDataItem = powerbi.extensibility.VisualTooltipDataItem;

// ---------------------------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------------------------

interface SliceDatum {
    key: string;
    name: string;
    value: number;
    displayValue: string;
    color: string;
    selectionId: ISelectionId;
    parent?: DataPoint;
}

interface DataPoint {
    index: number;
    label: string;
    level: Level;
    colorValue: number | null;
    sizeValue: number | null;
    colorFormat: string;
    sizeFormat: string;
    fxColor: string | null;
    slices: SliceDatum[];
    selectionId: ISelectionId;
    highlighted: boolean;
    tooltipExtras: VisualTooltipDataItem[];
    country?: CountryInfo;
    continent?: ContinentInfo;
    city?: CityInfo;
    raw?: string | number | boolean;
    /** raw value of the Country grouping column of this row */
    groupRaw?: string | number | boolean;
    postalUsed?: string;
    point?: [number, number];        // lon/lat for bubble anchor
    /** unique key for d3 joins (rows: their label; aggregated municipalities: "m:CC:id") */
    uid?: string;
    /** aggregated municipality: the municipality and the data rows that fall inside it */
    muni?: MuniInfo;
    /** district / province (data level "district", or rows aggregated by district) */
    district?: DistrictInfo;
    /** area (municipality, or district in district-only countries) a located row falls into */
    muniRef?: MuniInfo;
    /** rows aggregated by country (Europe map, country view) */
    countryAgg?: boolean;
    /** Europe map: the location was not found but its country is known (counts only in the country view) */
    countryOnly?: boolean;
    members?: DataPoint[];
    // render-time
    fill?: string;
    radius?: number;
    xy?: [number, number];
}

interface LegendItem {
    name: string;
    color: string;
    selectionId: ISelectionId;
    selector: powerbi.data.Selector;
}

interface Model {
    level: Level;
    points: DataPoint[];
    unmatched: UnmatchedItem[];
    hasLegend: boolean;
    hasColor: boolean;
    hasSize: boolean;
    hasHighlights: boolean;
    legendItems: LegendItem[];
    legendTitle: string;
    colorName: string;
    sizeName: string;
    locationName: string;
    colorMin: number;
    colorMax: number;
    colorFormat: string;
    involvedCountries: CountryInfo[];
    /** every data row (points may aggregate several rows into one municipality) */
    rows: DataPoint[];
    /** rows + rows that could not be placed (selectable from the "not found" list) */
    allRows: DataPoint[];
    /** ISO2 of the countries drawn with municipality polygons */
    muniCountries: string[];
    /** city level: rows shown aggregated by country, district or municipality */
    view?: "country" | "district" | "municipality";
    /** districts the city level is restricted to (drill into districts) */
    districtFocus: DistrictInfo[];
}

/** Countries whose municipality-level areas are counties / districts, not named after their towns. */
const AREA_NAMES_NOT_CITIES = new Set(["US", "CN", "IN", "AU"]);

/** Data rows behind a rendered item (a municipality aggregates several). */
const rowsOf = (d: DataPoint): DataPoint[] => d.members || [d];

/** Persisted "drill only into the selected items" state. depth = number of location levels visible when the button was used. */
interface ColorScaleInfo {
    color: (v: number) => string;
    kind: "continuous" | "classes";
    stops: string[];
    ticks: { t: number; v: number }[];
    classes?: { color: string; from: number; to: number }[];
    note?: string;
    /** negative values: own colour (stops absent) or a diverging ramp from the most negative value to 0 */
    negative?: { color: string; from: number; stops?: string[] };
}

interface UnmatchedItem {
    label: string;
    value: number | null;
    format: string;
    /** the data row (click in the list = select / filter it, so its values can be checked in the other visuals) */
    row?: DataPoint;
}

/** Drill focus: the items that were selected at a level when the user drilled below it.
 *  Stored as geography (continent names / ISO3 codes) so it filters correctly whatever drill button
 *  Power BI used (next level, expand all, double-click) — no parent column needed. */
interface DrillFocus {
    /** city focus: coordinates of the chosen cities (used to keep the points below them) */
    pts?: [number, number][];
    /** filter target of the level column the focus was made on, and the raw values (page filter) */
    target?: any;
    values?: (string | number | boolean)[];
    level: "continent" | "country" | "district" | "city";
    /** made by the view buttons of the Europe map (not by a Power BI drill) */
    view?: boolean;
    /** values of the Country grouping column of the focused rows (page filter together with values) */
    cvalues?: (string | number | boolean)[];
    /** (country, location) pairs of the focused rows (exact filter over several countries) */
    tuples?: [any, any][];
    /** whole countries (Europe map, country view): the page filter is the Country column only */
    countryOnly?: boolean;
    keys: string[];
    labels: string[];
}

const LEVEL_ORDER: { [k: string]: number } = { continent: 0, country: 1, district: 1.5, city: 2, point: 3 };
const isPointish = (l: Level) => l === "city" || l === "point";

interface BaseStyle {
    ocean: string;
    land: string;
    landFocus: string;
    border: string;
    roadM: string;
    roadMCase: string;
    roadS: string;
    place: string;
    placeHalo: string;
    country: string;
}

const BASE_STYLES: { [k: string]: BaseStyle } = {
    light: { ocean: "#AAD3EE", land: "#F2EFE9", landFocus: "#FBFAF7", border: "#B9A9C2", roadM: "#F6C46A", roadMCase: "#D9A24A", roadS: "#FFFFFF", place: "#3B3B3B", placeHalo: "#FFFFFF", country: "#6E5A7A" },
    grey: { ocean: "#DCE2E7", land: "#F7F7F7", landFocus: "#FFFFFF", border: "#C3C9CF", roadM: "#D2D2D2", roadMCase: "#BDBDBD", roadS: "#E6E6E6", place: "#555555", placeHalo: "#FFFFFF", country: "#7A7F85" },
    dark: { ocean: "#1D2731", land: "#2F3A45", landFocus: "#3A4652", border: "#5A6876", roadM: "#8C7442", roadMCase: "#6B5A35", roadS: "#4C5A68", place: "#D8DEE4", placeHalo: "#1D2731", country: "#AEB8C2" }
};

/** Minimum population (thousands) for a basemap place label at an effective web-mercator zoom level. */
function placeThresholdK(z: number, density: string): number {
    const f = density === "low" ? 3 : density === "high" ? 1 / 3 : 1;
    if (z <= 2.5) return 5000 * f;
    return 5000 / Math.pow(3, z - 2.5) * f;
}

// ---------------------------------------------------------------------------------------------
// Visual
// ---------------------------------------------------------------------------------------------

export class Visual implements IVisual {
    private host: IVisualHost;
    private root: HTMLElement;
    private selectionManager: ISelectionManager;
    private formattingSettings: VisualFormattingSettingsModel;
    private formattingSettingsService: FormattingSettingsService;
    private geo: GeoIndex | null = null;

    private container: d3.Selection<HTMLDivElement, unknown, null, undefined>;
    private legendTop: d3.Selection<HTMLDivElement, unknown, null, undefined>;
    private legendBottom: d3.Selection<HTMLDivElement, unknown, null, undefined>;
    private svg: d3.Selection<SVGSVGElement, unknown, null, undefined>;
    private gMap: d3.Selection<SVGGElement, unknown, null, undefined>;
    private gContext: d3.Selection<SVGGElement, unknown, null, undefined>;
    private gAreas: d3.Selection<SVGGElement, unknown, null, undefined>;
    private gMuni: d3.Selection<SVGGElement, unknown, null, undefined>;
    private viewToggle: d3.Selection<HTMLDivElement, unknown, null, undefined>;
    /** city-level view chosen with the buttons (null = default for the situation) */
    private cityView: "country" | "district" | "municipality" | null = null;
    private lastOptions: VisualUpdateOptions | null = null;
    /** focus JSON written with persistProperties and not yet echoed back by the host */
    private pendingFocusJson: string | null = null;
    private meshPathCache = new Map<string, { k: string; d: string }>();
    private gRoads: d3.Selection<SVGGElement, unknown, null, undefined>;
    private gPlaces: d3.Selection<SVGGElement, unknown, null, undefined>;
    private baseStyle: BaseStyle | null = null;
    private labelFrame = 0;
    private focusChip: d3.Selection<HTMLDivElement, unknown, null, undefined>;
    private chipList: d3.Selection<HTMLDivElement, unknown, null, undefined> | null = null;
    private labelBtn: d3.Selection<HTMLButtonElement, unknown, null, undefined>;
    private searchBox: d3.Selection<HTMLDivElement, unknown, null, undefined>;
    private searchInput: d3.Selection<HTMLInputElement, unknown, null, undefined>;
    private searchOp: d3.Selection<HTMLSelectElement, unknown, null, undefined>;
    private searchScope: d3.Selection<HTMLSelectElement, unknown, null, undefined>;
    private searchScopeTouched = false;
    private searchCount: d3.Selection<HTMLSpanElement, unknown, null, undefined>;
    private searchTimer: number | null = null;
    /** the current selection was made by the search box (cleared again when the search is emptied) */
    private searchApplied = false;
    private donutBtn: d3.Selection<HTMLButtonElement, unknown, null, undefined>;
    private donutsOverride: boolean | null = null;
    private overrideAt = 0;
    private note: d3.Selection<HTMLDivElement, unknown, null, undefined>;
    /** cities read without the Country column although they come from several countries */
    private needCountryColumn = false;
    /** label toggle clicked on the map, until the host sends the persisted value back */
    private labelsOverride: boolean | null = null;
    private focus: DrillFocus[] = [];
    /** filter mode: labels of the current level that filter the page */
    private filterLabels = new Set<string>();
    private leafTarget: any = null;
    /** filter target of the optional Country grouping column */
    private groupTarget: any = null;
    /** our own last page-filter change, until Power BI echoes it back (stale echoes must not re-apply an old filter) */
    private ownFilter: { key: string; t: number } | null = null;
    private lastFilterJson = "";
    private persistedSelJson = "";
    /** selection we persisted, until Power BI hands it back (older values arriving meanwhile are stale echoes) */
    private pendingSelEcho: { json: string; t: number } | null = null;
    private pendingFocusT = 0;
    private pendingRestore: { level: Level; labels: string[] } | null = null;
    /** last selection made inside the visual (becomes a focus when the next update is one level deeper) */
    private pendingSel: DrillFocus | null = null;
    private lastLevel: Level | null = null;
    private focusDirty = false;
    private levelChanged = false;
    // zone (lasso) selection
    private gZones: d3.Selection<SVGGElement, unknown, null, undefined>;
    private drawBtn: d3.Selection<HTMLButtonElement, unknown, null, undefined>;
    private clearZoneBtn: d3.Selection<HTMLButtonElement, unknown, null, undefined>;
    private zones: [number, number][][] = [];
    private drawing = false;
    private lastDrawEnd = 0;
    private drawPts: [number, number][] = [];
    private zoneLevel: Level | null = null;
    private categoryDepth = 0;
    private gMarks: d3.Selection<SVGGElement, unknown, null, undefined>;
    private gLabels: d3.Selection<SVGGElement, unknown, null, undefined>;
    private resetBtn: d3.Selection<HTMLButtonElement, unknown, null, undefined>;
    private zoomInBtn: d3.Selection<HTMLButtonElement, unknown, null, undefined>;
    private zoomOutBtn: d3.Selection<HTMLButtonElement, unknown, null, undefined>;
    /** where an animated zoom is heading (geographic centre + absolute scale, or a reset): a re-render that
     *  interrupts the animation (e.g. the filter echo from Power BI) jumps straight there instead of stopping half-way */
    private zoomTarget: { c: [number, number]; s: number } | "reset" | null = null;
    private warning: d3.Selection<HTMLDivElement, unknown, null, undefined>;
    private unmatchedPanel: d3.Selection<HTMLDivElement, unknown, null, undefined>;
    private landing: d3.Selection<HTMLDivElement, unknown, null, undefined>;

    private zoom: d3.ZoomBehavior<SVGSVGElement, unknown>;
    private transform: d3.ZoomTransform = d3.zoomIdentity;
    private fitKey = "";
    private projection: d3.GeoProjection;
    private model: Model | null = null;
    /** key of the no-data area whose name tooltip is showing (null = none) */
    private noDataKey: string | null = null;
    private mapW = 0;
    private mapH = 0;
    private locale: string;
    private loc: powerbi.extensibility.ILocalizationManager;

    /** Localised runtime string (stringResources) with an en-US fallback; {0}, {1}… are replaced by args. */
    private tr(key: string, en: string, ...args: (string | number)[]): string {
        let txt = en;
        try {
            const v = this.loc ? this.loc.getDisplayName(key) : "";
            if (v && v !== key) txt = v;
        } catch { /* fall back to English */ }
        args.forEach((a, i) => { txt = txt.split(`{${i}}`).join(String(a)); });
        return txt;
    }
    private bubbleSet = new Set<DataPoint>();
    private colorScale: ColorScaleInfo | null = null;

    constructor(options: VisualConstructorOptions) {
        this.host = options.host;
        this.root = options.element;
        this.locale = this.host.locale;
        this.selectionManager = this.host.createSelectionManager();
        this.loc = this.host.createLocalizationManager();
        this.formattingSettingsService = new FormattingSettingsService(this.loc);
        localizeDropdownItems((key, en) => this.tr(key, en));
        this.selectionManager.registerOnSelectCallback(() => { this.applySelectionStyles(); this.updateDrillUi(); });

        this.container = d3.select(this.root).append("div").classed("gdm-root", true);
        this.legendTop = this.container.append("div").classed("gdm-legend gdm-legend-top", true);
        const mapWrap = this.container.append("div").classed("gdm-mapwrap", true);
        this.legendBottom = this.container.append("div").classed("gdm-legend gdm-legend-bottom", true);

        this.svg = mapWrap.append("svg").classed("gdm-svg", true).attr("role", "img").attr("aria-label", "Map");
        this.gMap = this.svg.append("g").classed("gdm-map", true);
        this.gContext = this.gMap.append("g").classed("gdm-context", true);
        this.gMuni = this.gMap.append("g").classed("gdm-muni", true);
        this.gAreas = this.gMap.append("g").classed("gdm-areas", true);
        this.gRoads = this.gMap.append("g").classed("gdm-roads", true);
        this.gPlaces = this.svg.append("g").classed("gdm-places", true);
        this.gZones = this.svg.append("g").classed("gdm-zones", true);
        this.gMarks = this.svg.append("g").classed("gdm-marks", true);
        this.gLabels = this.svg.append("g").classed("gdm-labels", true);

        this.resetBtn = mapWrap.append("button").classed("gdm-reset", true)
            .attr("title", this.tr("Rt_ResetZoom", "Reset zoom")).attr("aria-label", this.tr("Rt_ResetZoom", "Reset zoom"));
        this.resetBtn.append("span").text("⤢");
        this.resetBtn.on("click", (e: MouseEvent) => {
            e.stopPropagation();
            this.animateZoom(d3.zoomIdentity, 350);
        });

        this.warning = mapWrap.append("div").classed("gdm-warning", true).attr("role", "button").attr("tabindex", 0);
        this.note = mapWrap.append("div").classed("gdm-note", true).style("display", "none");
        this.unmatchedPanel = mapWrap.append("div").classed("gdm-unmatched", true).style("display", "none");
        const toggle = (e: Event) => {
            e.stopPropagation();
            const open = this.unmatchedPanel.style("display") !== "none";
            this.unmatchedPanel.style("display", open ? "none" : null);
        };
        this.warning.on("click", toggle).on("keydown", (e: KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") toggle(e); });
        this.unmatchedPanel.on("click", (e: MouseEvent) => e.stopPropagation()).on("wheel", (e: WheelEvent) => e.stopPropagation());
        this.focusChip = mapWrap.append("div").classed("gdm-focuschip", true).style("display", "none");
        this.buildSearch(mapWrap);
        this.viewToggle = mapWrap.append("div").classed("gdm-viewtoggle", true).attr("role", "group").style("display", "none");
        const tools = mapWrap.append("div").classed("gdm-tools", true);
        // zoom buttons for people without a mouse wheel / trackpad pinch
        this.zoomInBtn = tools.append("button").classed("gdm-toolbtn gdm-zoombtn", true)
            .attr("title", this.tr("Rt_ZoomIn", "Zoom in")).attr("aria-label", this.tr("Rt_ZoomIn", "Zoom in")).text("+");
        this.zoomInBtn.on("click", (e: MouseEvent) => { e.stopPropagation(); this.zoomBy(1.6); });
        this.zoomOutBtn = tools.append("button").classed("gdm-toolbtn gdm-zoombtn", true)
            .attr("title", this.tr("Rt_ZoomOut", "Zoom out")).attr("aria-label", this.tr("Rt_ZoomOut", "Zoom out")).text("−");
        this.zoomOutBtn.on("click", (e: MouseEvent) => { e.stopPropagation(); this.zoomBy(1 / 1.6); });
        this.drawBtn = tools.append("button").classed("gdm-toolbtn", true)
            .attr("title", this.tr("Rt_DrawZone_Tip", "Draw a selection zone (drag to draw; each zone adds to the selection; Esc cancels)"))
            .attr("aria-label", this.tr("Rt_DrawZone", "Draw selection zone")).text("✎");
        this.drawBtn.on("click", (e: MouseEvent) => { e.stopPropagation(); this.setDrawing(!this.drawing); });
        // data labels on / off from the map itself (the label style stays in the format pane)
        this.labelBtn = tools.append("button").classed("gdm-toolbtn gdm-labelbtn", true)
            .attr("title", this.tr("Rt_Labels_Tip", "Show / hide data labels"))
            .attr("aria-label", this.tr("Rt_Labels_Tip", "Show / hide data labels")).text("Aa");
        this.labelBtn.on("click", (e: MouseEvent) => {
            e.stopPropagation();
            if (!this.formattingSettings) return;
            const next = !this.formattingSettings.labelsCard.show.value;
            this.labelsOverride = next; this.overrideAt = Date.now();
            this.host.persistProperties({ merge: [{ objectName: "labelsCard", selector: undefined as any, properties: { show: next } }] });
            this.formattingSettings.labelsCard.show.value = next;
            this.labelBtn.classed("gdm-active", next).attr("aria-pressed", String(next));
            this.renderLabels();
        });
        // donuts of the Detail (legend) field on / off from the map
        this.donutBtn = tools.append("button").classed("gdm-toolbtn gdm-donutbtn", true).style("display", "none")
            .attr("title", this.tr("Rt_Donuts_Tip", "Show / hide donuts (Detail)"))
            .attr("aria-label", this.tr("Rt_Donuts_Tip", "Show / hide donuts (Detail)"));
        this.donutBtn.append("span").classed("gdm-donut-icon", true);
        this.donutBtn.on("click", (e: MouseEvent) => {
            e.stopPropagation();
            if (!this.formattingSettings) return;
            const next = !this.formattingSettings.donutCard.showDonuts.value;
            this.donutsOverride = next; this.overrideAt = Date.now();
            this.host.persistProperties({ merge: [{ objectName: "donutCard", selector: undefined as any, properties: { showDonuts: next } }] });
            this.formattingSettings.donutCard.showDonuts.value = next;
            this.rerender();
        });
        this.clearZoneBtn = tools.append("button").classed("gdm-toolbtn", true).style("display", "none")
            .attr("title", this.tr("Rt_ClearZones", "Clear drawn zones")).attr("aria-label", this.tr("Rt_ClearZones", "Clear drawn zones")).text("⌫");
        this.clearZoneBtn.on("click", (e: MouseEvent) => {
            e.stopPropagation();
            this.clearAll();
        });
        d3.select(this.root).on("keydown.draw", (e: KeyboardEvent) => { if (e.key === "Escape" && this.drawing) this.setDrawing(false); });
        this.svg.on("pointerdown.draw", (e: PointerEvent) => this.drawStart(e))
            .on("pointermove.draw", (e: PointerEvent) => this.drawMove(e))
            .on("pointerup.draw", (e: PointerEvent) => this.drawEnd(e))
            .on("pointerleave.draw", (e: PointerEvent) => this.drawEnd(e))
            .on("mousemove.nodata", (e: MouseEvent) => this.noDataHover(e))
            .on("mouseleave.nodata", () => this.hideNoData());
        this.landing = mapWrap.append("div").classed("gdm-landing", true);

        this.zoom = d3.zoom<SVGSVGElement, unknown>()
            .scaleExtent([1, 60])
            .on("zoom", (e: d3.D3ZoomEvent<SVGSVGElement, unknown>) => {
                if (e.sourceEvent) this.zoomTarget = null;
                this.transform = e.transform;
                this.gMap.attr("transform", e.transform.toString());
                this.positionMarks();
                this.updateRoadVisibility();
                this.updateMuniVisibility();
                this.scheduleLabels();
                this.renderZones();
                this.updateResetButton();
            });

        this.svg.on("click", () => {
            if (!this.interactive) return;
            if (this.drawing || Date.now() - this.lastDrawEnd < 400) return;
            if (this.filterMode) { if (this.filterLabels.size) this.setFilterLabels(new Set()); }
            else this.selectionManager.clear().then(() => { this.recordSelection(); this.applySelectionStyles(); this.updateDrillUi(); });
        });
        this.svg.on("contextmenu", (e: MouseEvent) => {
            e.preventDefault();
            this.selectionManager.showContextMenu({} as ISelectionId, { x: e.clientX, y: e.clientY });
        });
    }

    // -----------------------------------------------------------------------------------------
    public update(options: VisualUpdateOptions): void {
        this.lastOptions = options;
        this.process(options, true);
    }

    /** Re-run the data + render pipeline with the last data (in-visual state changed, nothing new from the host). */
    private rerender(): void {
        if (this.lastOptions) this.process(this.lastOptions, false);
    }

    private process(options: VisualUpdateOptions, fromHost: boolean): void {
        this.host.eventService?.renderingStarted(options);
        try {
            if (!this.geo) this.geo = new GeoIndex();
            const dataView: DataView | undefined = options.dataViews?.[0];
            this.formattingSettings = this.formattingSettingsService.populateFormattingSettingsModel(VisualFormattingSettingsModel, dataView);
            const ls = this.formattingSettings.labelsCard.show;
            // an in-visual toggle wins until Power BI echoes it back (or for 3 s), never longer
            if (this.labelsOverride !== null) { if (ls.value === this.labelsOverride || (fromHost && Date.now() - this.overrideAt > 3000)) this.labelsOverride = null; else ls.value = this.labelsOverride; }
            this.labelBtn?.classed("gdm-active", ls.value).attr("aria-pressed", String(ls.value));
            const ds = this.formattingSettings.donutCard.showDonuts;
            if (this.donutsOverride !== null) { if (ds.value === this.donutsOverride || (fromHost && Date.now() - this.overrideAt > 3000)) this.donutsOverride = null; else ds.value = this.donutsOverride; }

            if (fromHost) this.readDrillState(dataView);
            let model: Model | null = null;
            try { model = this.buildModel(dataView); } catch (e) { throw new Error(`[DATA] ${(e as Error).message}`); }
            this.model = model;
            // only real host updates carry the current filters; an in-visual re-render still holds the previous ones
            if (fromHost) this.syncFromJsonFilters((options as any).jsonFilters);
            const mustRefilter = this.focusDirty || this.levelChanged;
            if (this.focusDirty) { this.focusDirty = false; this.persistFocus(this.focus); }
            if (this.levelChanged) { this.levelChanged = false; this.persistSel(); }
            if (mustRefilter) this.applyPageFilter();
            this.updateCategoryColorsCard(model);

            try { this.render(options.viewport, model); } catch (e) { throw new Error(`[RENDER] ${(e as Error).message}`); }
            this.updateDrillUi();
            // Power BI header warning icon: missing Country column, or locations that could not be placed
            if (model && this.needCountryColumn) this.host.displayWarningIcon(this.tr("Rt_WarnCountryTitle", "Country column missing"), this.tr("Rt_NeedCountryCol", "Put the country column in “Country”."));
            else if (model && model.unmatched.length) this.host.displayWarningIcon(this.tr("Rt_WarnUnmatchedTitle", "Locations not found"), this.tr("Rt_NotFoundN", "{0} locations not found", model.unmatched.length));
            this.donutBtn.style("display", model && model.hasLegend && model.legendItems.length ? null : "none")
                .classed("gdm-active", !!model && this.donutsOn(model)).attr("aria-pressed", String(!!model && this.donutsOn(model)));
            this.note.style("display", this.needCountryColumn && model ? null : "none")
                .text(this.tr("Rt_NeedCountryCol", "⚠ Put the country column in “Country (column)”: without it, cities with the same name in different countries are summed and filtered together."));
            this.host.eventService?.renderingFinished(options);
        } catch (e) {
            this.showError(e as Error);
            this.host.eventService?.renderingFailed(options, (e as Error).message);
        }
    }

    public getFormattingModel(): powerbi.visuals.FormattingModel {
        return this.formattingSettingsService.buildFormattingModel(this.formattingSettings);
    }

    // -----------------------------------------------------------------------------------------
    // Data
    // -----------------------------------------------------------------------------------------

    private buildModel(dataView: DataView | undefined): Model | null {
        const cat = dataView?.categorical;
        const categories = cat?.categories;
        if (!cat || !categories || categories.length === 0) return null;
        const geo = this.geo!;

        // optional "Country" grouping column: splits same-named cities of different countries (Madrid ES / Madrid CO)
        const groupCol = categories.find(c => c.source.roles && c.source.roles["countryGroup"]);
        const locCats = categories.filter(c => c !== groupCol);
        const leaf: DataViewCategoryColumn = locCats.length ? locCats[locCats.length - 1] : categories[categories.length - 1];
        const parents = categories.filter(c => c !== leaf);
        const n = leaf.values.length;


        // ---- value groups (legend or plain) ----
        let groups: DataViewValueColumnGroup[] = [];
        const values = cat.values;
        if (values) {
            try { groups = values.grouped() || []; } catch { groups = []; }
            if (groups.length === 0 || !groups.some(g => g.values && g.values.length)) {
                groups = [{ name: undefined, identity: undefined, values: values.slice() } as any];
            }
        }
        const hasLegend = !!dataView.metadata.columns.some(c => c.roles && c.roles["legend"]);
        const byRole = (g: DataViewValueColumnGroup, role: string) => (g.values || []).find(c => c.source.roles && c.source.roles[role]);
        const tooltipCols = (g: DataViewValueColumnGroup) => (g.values || []).filter(c => c.source.roles && c.source.roles["tooltips"]);

        const g0 = groups[0];
        const hasColor = !!(g0 && byRole(g0, "color"));
        const hasSize = !!(g0 && byRole(g0, "size"));
        const hasLatLon = !!(g0 && byRole(g0, "latitude") && byRole(g0, "longitude"));
        const colorName = g0 && byRole(g0, "color")?.source.displayName || "";
        const sizeName = g0 && byRole(g0, "size")?.source.displayName || "";
        const legendCol = dataView.metadata.columns.find(c => c.roles && c.roles["legend"]);

        const fmtOf = (col: DataViewValueColumn | undefined, i: number): string => {
            if (!col) return "";
            const dyn = (col as any).objects?.[i]?.general?.formatString || (col as any).objects?.[0]?.general?.formatString;
            return dyn || col.source.format || "";
        };
        const num = (v: any): number | null => (v === null || v === undefined || v === "" || isNaN(+v)) ? null : +v;

        // ---- legend items ----
        const legendItems: LegendItem[] = [];
        if (hasLegend && values) {
            groups.forEach((g, gi) => {
                const name = g.name === null || g.name === undefined ? this.tr("Rt_Blank", "(Blank)") : String(g.name);
                const objColor = (g as any).objects?.categoryColors?.fill?.solid?.color as string | undefined;
                const color = objColor || this.host.colorPalette.getColor(name).value;
                let sid: ISelectionId;
                try { sid = this.host.createSelectionIdBuilder().withSeries(values, g).createSelectionId(); }
                catch { sid = this.host.createSelectionIdBuilder().createSelectionId(); }
                legendItems.push({ name, color, selectionId: sid, selector: sid.getSelector() });
                (g as any).__legendIndex = gi;
            });
        }

        const isPostalLike = (v: string) => /^[A-Z]{0,2}[- ]?\d{3,6}([- ]\d{2,4})?$/i.test(v.trim());
        // ---- level detection ----
        const sampleVals = leaf.values.filter(v => v !== null && v !== undefined && String(v).trim() !== "");
        const sample = sampleVals.slice(0, 400);
        const contHits = sample.filter(v => !!geo.findContinent(v)).length;
        const ctryHits = sample.filter(v => !!geo.findCountry(v)).length;
        const distHits = sample.filter(v => !!geo.findDistrict(v)).length;
        const distinctVals = new Set(sampleVals.map(v => normalize(v))).size;
        const distName = /distr|provin|regi|estado|county|condado/i.test(`${leaf.source.displayName} ${(leaf.source as any).queryName || ""}`);
        let level: Level;
        if (sample.length && contHits / sample.length >= 0.6 && contHits >= ctryHits) level = "continent";
        else if (sample.length && ctryHits / sample.length >= 0.5) level = "country";
        else if (sample.length && ((distName && distHits / sample.length >= 0.6) || (distHits / sample.length >= 0.95 && distinctVals >= 15))) level = "district";
        else {
            // below country: postal codes / anything placed by lat-lon -> "point"; recognisable city names -> "city"
            const postalHits = sample.filter(v => isPostalLike(String(v))).length;
            const hasPostalRole = !!(g0 && byRole(g0, "postalCode"));
            if (sample.length && postalHits / sample.length >= 0.6) level = "point";
            else {
                const probe = sample.slice(0, 150);
                const cityHits = probe.filter(v => geo.findCityAnywhere(v).length > 0).length;
                if (probe.length && cityHits / probe.length >= 0.3) level = "city";
                else if (hasLatLon || hasPostalRole) level = "point";
                else level = "city";
            }
        }
        this.leafTarget = this.targetOf(leaf);
        // without the Country column Power BI sums same-named cities of different countries before the visual sees them
        this.needCountryColumn = !(this.formattingSettings.mapCard.defaultCountry.value || "").trim() && !(groupCol && groupCol !== leaf) && level !== "continent" && level !== "country" &&
            !parents.some(p => { const sv = p.values.slice(0, 200); return sv.length > 0 && sv.filter(v => !!geo.findCountry(v)).length / sv.length >= 0.5; });
        this.groupTarget = groupCol && groupCol !== leaf ? this.targetOf(groupCol) : null;
        // a location shared by rows of different countries gets the country in its label ("OLEIROS (ES)")
        const dupCountries = new Map<string, Set<string>>();
        if (groupCol && groupCol !== leaf) for (let i = 0; i < n; i++) {
            const k = String(leaf.values[i] ?? ""); const g = String(groupCol.values[i] ?? "");
            const set = dupCountries.get(k); if (set) set.add(g); else dupCountries.set(k, new Set([g]));
        }

        this.reconcileFocus(level);
        const focusCont = this.focus.find(f => f.level === "continent");
        const focusCtry = this.focus.find(f => f.level === "country");
        const focusContSet = focusCont ? new Set(focusCont.keys) : null;
        const focusCtrySet = focusCtry ? new Set(focusCtry.keys) : null;
        const focusCountries: CountryInfo[] = focusCtry ? focusCtry.keys.map(k => geo.countries.find(c => c.iso3 === k)!).filter(Boolean) : [];
        const inFocus = (c: CountryInfo | undefined): boolean | null => {
            if (!c) return null; // unknown
            if (focusCtrySet && !focusCtrySet.has(c.iso3)) return false;
            if (focusContSet && !focusContSet.has(geo.continents[c.continent]?.name)) return false;
            return true;
        };

        // parent country column (Expand all / multi-level)
        let parentCountryCol: DataViewCategoryColumn | undefined = groupCol && groupCol !== leaf ? groupCol : undefined;
        if (!parentCountryCol) for (const p of parents) {
            const s = p.values.slice(0, 200);
            const hits = s.filter(v => !!geo.findCountry(v)).length;
            if (s.length && hits / s.length >= 0.5) parentCountryCol = p;
        }

        // ---- highlights ----
        const anyHighlights = groups.some(g => (g.values || []).some(c => !!c.highlights));

        // ---- data points ----
        const points: DataPoint[] = [];
        const unmatched: UnmatchedItem[] = [];
        const miss = (dp: DataPoint, rowCountry?: CountryInfo) => (inFocus(rowCountry) === false) ? 0 : unmatched.push({
            label: dp.label,
            value: dp.colorValue !== null ? dp.colorValue : dp.sizeValue,
            format: dp.colorValue !== null ? dp.colorFormat : dp.sizeFormat,
            row: dp
        });
        const pendingCityNames: { dp: DataPoint; name: string; postal: string | null }[] = [];
        const defIso2 = (this.formattingSettings.mapCard.defaultCountry.value || "").trim().toUpperCase();
        const defaultCountry = defIso2 ? (geo.countryByIso2Code(defIso2) || geo.findCountry(defIso2)) : undefined;
        const looksPostal = (v: string) => /^[A-Z]{0,2}[- ]?\d{3,6}([- ]\d{2,4})?$/i.test(v.trim());

        for (let i = 0; i < n; i++) {
            const raw = leaf.values[i];
            if (raw === null || raw === undefined || String(raw).trim() === "") continue;
            const name = String(raw);
            const dupSet = dupCountries.get(name);
            const label = dupSet && dupSet.size > 1 ? `${name} (${String(groupCol!.values[i] ?? "")})` : name;

            let colorValue: number | null = null, sizeValue: number | null = null;
            let lat: number | null = null, lon: number | null = null;
            let postal: string | null = null;
            let highlighted = !anyHighlights;
            const slices: SliceDatum[] = [];
            const tooltipAgg = new Map<string, { v: number | null; fmt: string }>();
            let colorFormat = "", sizeFormat = "";

            groups.forEach(g => {
                const cc = byRole(g, "color"), sc = byRole(g, "size");
                const cv = cc ? num(cc.values[i]) : null;
                const sv = sc ? num(sc.values[i]) : null;
                if (cc && !colorFormat) colorFormat = fmtOf(cc, i);
                if (sc && !sizeFormat) sizeFormat = fmtOf(sc, i);
                if (cv !== null) colorValue = (colorValue ?? 0) + cv;
                if (sv !== null) sizeValue = (sizeValue ?? 0) + sv;
                const la = byRole(g, "latitude"), lo = byRole(g, "longitude");
                if (la && lat === null) lat = num(la.values[i]);
                if (lo && lon === null) lon = num(lo.values[i]);
                const pc = byRole(g, "postalCode");
                if (pc && postal === null) {
                    const pv = pc.values[i];
                    if (pv !== null && pv !== undefined && String(pv).trim() !== "") postal = String(pv).trim();
                }
                if (anyHighlights) {
                    const hc = cc || sc;
                    if (hc && hc.highlights && hc.highlights[i] !== null && hc.highlights[i] !== undefined) highlighted = true;
                }
                for (const tc of tooltipCols(g)) {
                    const prev = tooltipAgg.get(tc.source.displayName);
                    const v = num(tc.values[i]);
                    const fmt = fmtOf(tc, i);
                    if (!prev) tooltipAgg.set(tc.source.displayName, { v, fmt });
                    else if (v !== null) prev.v = (prev.v ?? 0) + v;
                }
                if (hasLegend) {
                    const sliceVal = sv !== null ? sv : cv;
                    if (sliceVal !== null && sliceVal !== 0) {
                        const li = legendItems[(g as any).__legendIndex];
                        let sid: ISelectionId;
                        try {
                            let b = this.host.createSelectionIdBuilder();
                            for (const c of categories) b = b.withCategory(c, i);
                            sid = b.withSeries(values!, g).createSelectionId();
                        } catch { sid = li.selectionId; }
                        slices.push({
                            key: li.name, name: li.name, value: Math.abs(sliceVal),
                            displayValue: formatExact(sliceVal, sc ? fmtOf(sc, i) : fmtOf(cc, i), this.locale),
                            color: li.color, selectionId: sid
                        });
                    }
                }
            });

            // helper fields (país, código postal, lat/lon, tooltips) must not create points on their own:
            // a row only counts when the colour or size measure has a value
            if ((hasColor || hasSize) && colorValue === null && sizeValue === null) continue;

            // rows that only exist because of helper measures (country / postal / lat-lon) have no value: skip them
            if ((hasColor || hasSize) && colorValue === null && sizeValue === null) continue;

            let b = this.host.createSelectionIdBuilder();
            for (const c of categories) b = b.withCategory(c, i);
            const selectionId = b.createSelectionId();

            const fxColor = ((leaf as any).objects?.[i]?.areaCard?.fxFill?.solid?.color as string) || null;
            const tooltipExtras: VisualTooltipDataItem[] = [];
            tooltipAgg.forEach((t, name) => tooltipExtras.push({ displayName: name, value: formatExact(t.v, t.fmt, this.locale) }));

            const dp: DataPoint = {
                raw: raw as any,
                groupRaw: groupCol && groupCol !== leaf ? (groupCol.values[i] as any) : undefined,
                index: i, label, level, colorValue, sizeValue, colorFormat, sizeFormat, fxColor,
                slices, selectionId, highlighted, tooltipExtras
            };
            slices.forEach(s => s.parent = dp);

            if (level === "continent") {
                dp.continent = geo.findContinent(name);
                if (!dp.continent) { if (!focusContSet) miss(dp); continue; }
                dp.point = dp.continent.label;
            } else if (level === "country") {
                dp.country = geo.findCountry(name);
                if (!dp.country) { if (!focusContSet) miss(dp); continue; }
                dp.point = dp.country.label;
            } else if (level === "district") {
                const parentC = parentCountryCol ? geo.findCountry(parentCountryCol.values[i]) : undefined;
                const cc = parentC?.iso2;
                const d = geo.findDistrict(name, cc && geo.hasDistricts(cc) ? cc : undefined);
                if (!d || (cc && geo.hasDistricts(cc) && d.cc !== cc)) { miss(dp); continue; }
                dp.district = d;
                dp.country = geo.countryByIso2Code(d.cc);
                if (dp.country && inFocus(dp.country) === false) continue;
                dp.point = d.label;
            } else {
                const isPoint = level === "point";
                if (isPoint && postal === null && looksPostal(name)) postal = name;
                const guessed = postal ? GeoIndex.postalCountryGuess(postal) : undefined;
                // a name made only of punctuation ("." / "-") groups unrelated places: never place it
                if (!normalize(name) && !(isPoint && postal)) {
                    // Europe map: an unusable name ("--", ".") still counts in its country when the country is known
                    const pc = parentCountryCol ? geo.findCountry(parentCountryCol.values[i]) : undefined;
                    if (pc && !isPoint) { if (inFocus(pc) !== false) { dp.country = pc; dp.point = pc.label; dp.countryOnly = true; points.push(dp); } }
                    else miss(dp);
                    continue;
                }
                const parentCountry = parentCountryCol ? geo.findCountry(parentCountryCol.values[i]) : undefined;
                // a Country value that is filled in but not recognized (misspelled, unknown code): never guess the
                // country from the city name or the postal code ("Madrid" + "Spian" is not Madrid, Iowa) — not located
                const pcv = parentCountryCol ? parentCountryCol.values[i] : null;
                if (!parentCountry && pcv !== null && pcv !== undefined && normalize(String(pcv))) { miss(dp); continue; }
                if (parentCountry && inFocus(parentCountry) === false) continue;
                let knownCountry = parentCountry || (focusCountries.length === 1 ? focusCountries[0] : undefined)
                    || defaultCountry || (guessed ? geo.countryByIso2Code(guessed) : undefined);
                const la = lat as number | null, lo = lon as number | null;
                const hasLL = la !== null && lo !== null && Math.abs(la) <= 90 && Math.abs(lo) <= 180 && !(la === 0 && lo === 0);
                // several focus countries and no parent column: try each of them
                if (!knownCountry && focusCountries.length > 1 && !hasLL) {
                    for (const fc of focusCountries) {
                        if ((postal && geo.findPostal(fc.iso2, postal)) || (!isPoint && geo.findCityIn(fc.iso2, name))) { knownCountry = fc; break; }
                    }
                }
                if (knownCountry) dp.country = knownCountry;
                const byLatLon = () => { if (hasLL) { dp.point = [lo!, la!]; return true; } return false; };
                const byPostal = () => {
                    if (!postal || !knownCountry) return false;
                    // the row's own country is known: a code missing from the list falls back to its area
                    const pp = geo.findPostal(knownCountry.iso2, postal, true);
                    if (pp) { dp.point = pp; dp.postalUsed = postal; return true; }
                    return false;
                };
                const byName = () => {
                    if (!knownCountry) return false;
                    const c = geo.findCityIn(knownCountry.iso2, name);
                    if (c) { dp.city = c; dp.point = [c.lon, c.lat]; return true; }
                    return false;
                };
                // city level: the name decides (lat/lon only as fallback); below the city: coordinates / postal code decide
                // a supplied postal code is more precise than a locality name (and decides the municipality)
                // municipality countries: a name that is an official municipality wins (postal centroids are often off);
                // a homonymous municipality far from the postal code (> 40 km) is a different place, the postal code wins
                const byArea = () => {
                    if (!knownCountry || !geo.hasMunicipalities(knownCountry.iso2)) return false;
                    const pp = postal ? geo.findPostal(knownCountry.iso2, postal, true) : undefined;
                    // counties / districts (US, CN, IN, AU) are not named after their cities: no name matching there
                    if (AREA_NAMES_NOT_CITIES.has(knownCountry.iso2)) return false;
                    const areas = geo.findAreasByName(knownCountry.iso2, name, pp);
                    if (!areas.length) return false;
                    const a = areas[0];
                    // a big town of that name elsewhere wins over a small homonymous municipality
                    if (!pp) {
                        const c = geo.findCityIn(knownCountry.iso2, name);
                        if (c && c.popK >= 50 && geo.findArea(knownCountry.iso2, [c.lon, c.lat]) !== a) return false;
                    }
                    if (pp && d3.geoDistance(a.label, pp) * 6371 > 40 && geo.findArea(knownCountry.iso2, pp) !== a) return false;
                    dp.point = pp && geo.findArea(knownCountry.iso2, pp) === a ? pp : a.label;
                    if (pp) dp.postalUsed = postal!;
                    return true;
                };
                const order = isPoint ? [byLatLon, byPostal, byName] : postal ? [byArea, byPostal, byName, byLatLon] : [byArea, byName, byLatLon];
                if (!order.some(f => f())) {
                    // Europe map: a location that is not found still belongs to its country (counted in the country view)
                    if (knownCountry && !isPoint) { dp.point = knownCountry.label; dp.countryOnly = true; points.push(dp); continue; }
                    if (knownCountry || (isPoint && !postal)) { miss(dp, parentCountry); continue; }
                    pendingCityNames.push({ dp, name, postal });
                }
            }
            points.push(dp);
        }

        // ---- resolve cities without a known country (consensus country) ----
        if (pendingCityNames.length) {
            const tally = new Map<string, number>();
            const popSum = new Map<string, number>();
            const cands = pendingCityNames.map(p => geo.findCityAnywhere(p.name));
            cands.forEach(list => {
                const seen = new Set<string>();
                for (const c of list) if (!seen.has(c.iso2)) {
                    seen.add(c.iso2);
                    tally.set(c.iso2, (tally.get(c.iso2) || 0) + 1);
                    popSum.set(c.iso2, (popSum.get(c.iso2) || 0) + c.popK);
                }
            });
            let best = 0;
            tally.forEach(v => { if (v > best) best = v; });
            const strong = new Set<string>();
            tally.forEach((v, k) => { if (v >= Math.max(2, best * 0.3)) strong.add(k); });
            // ties (e.g. "Madrid" exists in ES, CO, US…) are broken by the population of the matching cities
            let ranked = [...strong].sort((a, b) => ((tally.get(b) || 0) - (tally.get(a) || 0)) || ((popSum.get(b) || 0) - (popSum.get(a) || 0)));
            const matchedNames = cands.filter(l => l.length).length;
            const dominant = ranked.length && matchedNames ? (tally.get(ranked[0]) || 0) / matchedNames : 0;
            const strict = dominant >= 0.6 || focusCountries.length > 0;
            if (dominant >= 0.6) ranked = [ranked[0]];
            // focus countries always come first
            for (const fc of focusCountries.slice().reverse()) {
                if (!fc.iso2) continue;
                const at = ranked.indexOf(fc.iso2);
                if (at >= 0) ranked.splice(at, 1);
                ranked.unshift(fc.iso2);
            }
            pendingCityNames.forEach((p, idx) => {
                const list = cands[idx];
                // postal code first, in the dominant country of this data set
                if (p.postal) {
                    for (const cc of ranked) {
                        const pp = geo.findPostal(cc, p.postal);
                        if (pp) { p.dp.point = pp; p.dp.postalUsed = p.postal; p.dp.country = geo.countryByIso2Code(cc); return; }
                    }
                }
                if (!list.length || p.dp.level === "point") {
                    // below the city with a drill focus: a code that exists elsewhere is simply outside the focus, not "not found"
                    if (p.dp.level === "point" && p.postal && focusCountries.length && geo.postalCountries(p.postal).length) return;
                    miss(p.dp); return;
                }
                let pick: CityInfo | undefined;
                for (const cc of ranked) { pick = list.find(c => c.iso2 === cc); if (pick) break; }
                if (!pick && strict) { miss(p.dp); return; } // the city must be in the data set's country, never elsewhere
                if (!pick) pick = list.reduce((a, b) => (b.popK > a.popK ? b : a));
                p.dp.city = pick;
                p.dp.country = geo.countryByIso2Code(pick.iso2);
                const pp = p.postal ? geo.findPostal(pick.iso2, p.postal) : undefined;
                if (pp) { p.dp.point = pp; p.dp.postalUsed = p.postal!; }
                else p.dp.point = [pick.lon, pick.lat];
            });
        }
        let finalPoints = points.filter(p => !!p.point);

        // ---- apply the drill focus geographically ----
        const focusCity = this.focus.find(f => f.level === "city");
        if (focusContSet || focusCtrySet || (focusCity && level === "point")) {
            const feats = focusCountries.map(c => c.feature);
            const countryOk = (p: DataPoint): boolean => {
                if (!(focusContSet || focusCtrySet)) return true;
                let ok = inFocus(p.country);
                if (level !== "country" && (ok === null || (ok === false && !p.city && !p.postalUsed))) {
                    // coordinates only: test against the focus countries' shapes
                    if (feats.length) ok = feats.some(f => d3.geoContains(f as any, p.point!));
                    else { p.country = geo.countryAt(p.point![0], p.point![1]); ok = inFocus(p.country) !== false; }
                }
                return ok !== false;
            };
            const parentCol = locCats.length > 1 ? locCats[locCats.length - 2] : undefined;
            const parentMatches = !!(focusCity && parentCol && parentCol.values.some(v => focusCity.keys.includes(normalize(v))));
            const cityOk = (p: DataPoint): boolean => {
                if (!focusCity || level !== "point") return true;
                if (parentMatches) return focusCity.keys.includes(normalize(parentCol!.values[p.index]));
                // no parent column (Power BI "next level"): keep points within 30 km of a chosen city
                return (focusCity.pts || []).some(c => d3.geoDistance(c, p.point!) * 6371 <= 30);
            };
            if (level !== "continent") finalPoints = finalPoints.filter(p => countryOk(p) && cityOk(p));
        }

        // ---- every located row gets its area (municipality in Europe, district elsewhere) ----
        const focusDist = this.focus.filter(f => f.level === "district" && LEVEL_ORDER.district < LEVEL_ORDER[level]);
        const focusDistKeys = new Set<string>();
        focusDist.forEach(f => f.keys.forEach(k => focusDistKeys.add(k)));
        if (isPointish(level)) {
            const kept: DataPoint[] = [];
            for (const p of finalPoints) {
                if (p.countryOnly) { if (!focusDistKeys.size) kept.push(p); continue; }
                if (!p.country) p.country = geo.countryAtFast(p.point![0], p.point![1]);
                const iso2 = p.country?.iso2;
                const a = iso2 ? geo.findArea(iso2, p.point!) : undefined;
                if (a) p.muniRef = a;
                if (focusDistKeys.size && !(a && focusDistKeys.has(a.cc + ":" + a.district))) continue;
                kept.push(p);
            }
            finalPoints = kept;
        }
        const districtFocus: DistrictInfo[] = [];
        focusDistKeys.forEach(k => { const [cc, ix] = k.split(":"); const d = geo.districtsOf(cc)[+ix]; if (d) districtFocus.push(d); });

        // countries for context highlighting at city level
        const involved = new Map<string, CountryInfo>();
        if (level === "district") finalPoints.forEach(p => { if (p.country) involved.set(p.country.iso3, p.country); });
        if (isPointish(level)) {
            const needLookup = finalPoints.filter(p => !p.country);
            if (needLookup.length && needLookup.length <= 400) needLookup.forEach(p => { p.country = geo.countryAt(p.point![0], p.point![1]); });
            finalPoints.forEach(p => { if (p.country) involved.set(p.country.iso3, p.country); });
        }

        // ---- city level as municipality areas: every located row falls into the municipality containing it ----
        const rows = finalPoints;
        let rendered = finalPoints;
        const muniCountries = new Set<string>();
        const model0 = { hasLegend, hasSize };
        const cityMode = this.formattingSettings.mapCard.cityMode.value.value as string;
        let view: "country" | "district" | "municipality" | undefined;
        if (level === "district") finalPoints.forEach(p => { if (p.district) muniCountries.add(p.district.cc); });
        if (level === "city") {
            // Europe map: countries › districts › municipalities (municipalities only for one country or chosen districts)
            const scope = this.municipalityScope(finalPoints, districtFocus);
            let v = this.cityView || (districtFocus.length ? "municipality" : (this.formattingSettings.mapCard.cityStart.value.value as "country" | "district"));
            if (v !== "country" && v !== "district" && v !== "municipality") v = "country";
            if (v === "municipality" && !scope) v = "district";
            view = v;
            this.cityView = v;
            const groups = new Map<string, { kind: "c" | "d" | "m"; key: any; rows: DataPoint[] }>();
            const rest: DataPoint[] = [];
            for (const p of finalPoints) {
                const m = p.muniRef;
                let k: string, kind: "c" | "d" | "m", key: any;
                if (v === "country") {
                    if (!p.country) { rest.push(p); continue; }
                    k = "c:" + p.country.iso3; kind = "c"; key = p.country;
                } else if (p.countryOnly) {
                    // not placed below the country: listed as not found in the district / municipality views
                    unmatched.push({ label: p.label, value: p.colorValue !== null ? p.colorValue : p.sizeValue, format: p.colorValue !== null ? p.colorFormat : p.sizeFormat, row: p });
                    continue;
                } else if (v === "district") {
                    if (!m) { rest.push(p); continue; }
                    k = "d:" + m.cc + ":" + m.district; kind = "d"; key = geo.districtsOf(m.cc)[m.district];
                    muniCountries.add(m.cc);
                } else {
                    if (!m || m.kind !== "m") { rest.push(p); continue; }
                    k = "m:" + m.cc + ":" + m.id; kind = "m"; key = m;
                    muniCountries.add(m.cc);
                }
                const gr = groups.get(k);
                if (gr) gr.rows.push(p); else groups.set(k, { kind, key, rows: [p] });
            }
            if (v !== "municipality" || cityMode !== "bubble") {
                const agg: DataPoint[] = [];
                groups.forEach(({ kind, key, rows: rs }) => agg.push(kind === "c" ? this.aggregateCountry(key as CountryInfo, rs, model0)
                    : kind === "d" ? this.aggregateDistrict(key as DistrictInfo, rs, model0) : this.aggregateMunicipality(key as MuniInfo, rs, model0)));
                rendered = agg.concat(rest);
            }
        }

        const cvals: number[] = [];
        rendered.forEach(p => { if (p.colorValue !== null) cvals.push(p.colorValue); });

        const rowSet = new Set(rows);
        const allRows = rows.concat(unmatched.map(u => u.row).filter((r): r is DataPoint => !!r && !rowSet.has(r)));
        return {
            rows,
            allRows,
            view,
            districtFocus,
            muniCountries: [...muniCountries],
            level,
            points: rendered,
            unmatched,
            hasLegend,
            hasColor,
            hasSize,
            hasHighlights: anyHighlights,
            legendItems,
            legendTitle: legendCol?.displayName || "",
            colorName, sizeName,
            locationName: leaf.source.displayName,
            colorMin: cvals.length ? safeMin(cvals) : 0,
            colorMax: cvals.length ? safeMax(cvals) : 0,
            colorFormat: rendered.find(p => p.colorFormat)?.colorFormat || "",
            involvedCountries: [...involved.values()]
        };
    }

    /** One rendered item for all the rows that fall inside a municipality (sums values, merges donut slices). */
    private aggregateDistrict(d: DistrictInfo, rs: DataPoint[], ctx: { hasLegend: boolean; hasSize: boolean }): DataPoint {
        const dp = this.aggregateRows(rs, ctx, d.name, d.label, "d:" + d.cc + ":" + d.index);
        dp.district = d;
        return dp;
    }

    private aggregateCountry(c: CountryInfo, rs: DataPoint[], ctx: { hasLegend: boolean; hasSize: boolean }): DataPoint {
        const dp = this.aggregateRows(rs, ctx, this.countryName(c), c.label, "c:" + c.iso3);
        dp.country = c;
        dp.countryAgg = true;
        return dp;
    }

    /** Donuts (Detail / legend field) on: a legend is bound and the user did not switch them off on the map. */
    private donutsOn(model: Model): boolean {
        return model.hasLegend && model.legendItems.length > 0 && this.formattingSettings.donutCard.showDonuts.value;
    }

    private countryName(c: CountryInfo): string {
        return /^pt/i.test(this.locale || "") ? c.namePT : c.nameEN;
    }

    /** Europe map: where municipalities can be shown — a district focus, or rows that all lie in one municipality country.
     *  Returns that scope (truthy) or null. */
    private municipalityScope(rows: DataPoint[], districtFocus: DistrictInfo[]): string | null {
        const geo = this.geo!;
        if (districtFocus.length) return districtFocus.every(d => geo.hasMunicipalities(d.cc)) ? "districts" : null;
        const ccs = new Set<string>();
        for (const p of rows) { const cc = p.muniRef?.cc || p.country?.iso2; if (cc) ccs.add(cc); if (ccs.size > 1) return null; }
        const cc = [...ccs][0];
        return cc && geo.hasMunicipalities(cc) ? cc : null;
    }

    private aggregateMunicipality(m: MuniInfo, rs: DataPoint[], ctx: { hasLegend: boolean; hasSize: boolean }): DataPoint {
        const dp = this.aggregateRows(rs, ctx, m.name, m.label, "m:" + m.cc + ":" + m.id);
        dp.muni = m;
        return dp;
    }

    private aggregateRows(rs: DataPoint[], ctx: { hasLegend: boolean; hasSize: boolean }, label: string, point: [number, number], uid: string): DataPoint {
        const sum = (f: (r: DataPoint) => number | null): number | null => {
            let t: number | null = null;
            for (const r of rs) { const v = f(r); if (v !== null && v !== undefined) t = (t ?? 0) + v; }
            return t;
        };
        const first = rs[0];
        const dp: DataPoint = {
            index: first.index,
            label,
            level: first.level,
            colorValue: sum(r => r.colorValue),
            sizeValue: sum(r => r.sizeValue),
            colorFormat: first.colorFormat,
            sizeFormat: first.sizeFormat,
            fxColor: rs.length === 1 ? first.fxColor : null,
            slices: [],
            selectionId: first.selectionId,
            highlighted: rs.some(r => r.highlighted),
            tooltipExtras: rs.length === 1 ? first.tooltipExtras : [],
            country: first.country,
            point,
            uid,
            members: rs
        };
        if (ctx.hasLegend) {
            const by = new Map<string, SliceDatum>();
            for (const r of rs) for (const sl of r.slices) {
                const cur = by.get(sl.name);
                if (cur) cur.value += sl.value;
                else by.set(sl.name, { key: sl.key, name: sl.name, value: sl.value, displayValue: "", color: sl.color, selectionId: sl.selectionId, parent: dp });
            }
            const fmt = ctx.hasSize ? first.sizeFormat : first.colorFormat;
            by.forEach(sl => { sl.displayValue = formatExact(sl.value, fmt, this.locale); dp.slices.push(sl); });
        }
        return dp;
    }

    private updateCategoryColorsCard(model: Model | null): void {
        const card = this.formattingSettings.categoryColors;
        if (!model || !model.hasLegend || !model.legendItems.length) {
            card.visible = false;
            card.slices = [];
            return;
        }
        card.visible = true;
        card.slices = model.legendItems.slice(0, 60).map(li => new formattingSettings.ColorPicker({
            name: "fill",
            displayName: li.name,
            value: { value: li.color },
            selector: li.selector
        }));
    }

    // -----------------------------------------------------------------------------------------
    // Render
    // -----------------------------------------------------------------------------------------

    private render(viewport: powerbi.IViewport, model: Model | null): void {
        // current view (projection + zoom) before re-fitting: kept when only the data changes
        const prevView = this.projection && (this.transform.k !== 1 || this.transform.x !== 0 || this.transform.y !== 0)
            ? { proj: this.projection, t: this.transform, w: this.mapW, h: this.mapH } : null;
        const s = this.formattingSettings;
        const hc = this.host.colorPalette.isHighContrast;
        const geo = this.geo!;
        this.container.style("width", `${viewport.width}px`).style("height", `${viewport.height}px`);

        // ---- landing page ----
        if (!model) {
            this.legendTop.style("display", "none");
            this.legendBottom.style("display", "none");
            this.warning.style("display", "none");
            this.resetBtn.style("display", "none");
            this.mapW = viewport.width; this.mapH = viewport.height;
            this.svg.attr("width", this.mapW).attr("height", this.mapH);
            this.projection = this.makeProjection();
            this.projection.fitExtent([[10, 10], [Math.max(20, this.mapW - 10), Math.max(20, this.mapH - 10)]],
                { type: "FeatureCollection", features: geo.continents.map(c => c.feature) } as any);
            const path = d3.geoPath(this.projection);
            this.gMarks.selectAll("*").remove();
            this.gLabels.selectAll("*").remove();
            this.gAreas.selectAll("*").remove();
            this.gMuni.selectAll("*").remove();
            this.gRoads.selectAll("*").remove();
            this.gPlaces.selectAll("*").remove();
            this.svg.style("background", null);
            this.gContext.selectAll("path").data(geo.continents).join("path")
                .attr("d", d => path(d.feature as any)).attr("fill", hc ? "none" : "#E9ECEF")
                .attr("stroke", hc ? this.host.colorPalette.foreground.value : "#FFFFFF").attr("stroke-width", 0.6);
            this.landing.style("display", null);
            this.landing.selectAll("*").remove();
            this.landing.append("div").classed("gdm-landing-title", true).text("World District Shape Map");
            this.landing.append("div").text(this.tr("Rt_Landing1", "Add the City column to “City”, the Country column to “Country” and a measure to “Value (color)”."));
            this.landing.append("div").text(this.tr("Rt_Landing2", "Optional: “Size”, “Detail (legend)”, “Postal code”, Latitude/Longitude and Tooltips."));
            return;
        }
        this.landing.style("display", "none");
        this.svg.attr("aria-label", this.tr("Rt_AriaSummary", "Map of {0}: {1} locations", model.locationName, model.points.length));

        // ---- legend (rendered first: its height defines the map area) ----
        this.colorScale = this.buildColorScale(model);
        this.renderLegend(model, viewport);
        const legendH = (this.legendTop.node()!.getBoundingClientRect().height || 0) + (this.legendBottom.node()!.getBoundingClientRect().height || 0);
        this.mapW = Math.max(10, viewport.width);
        this.mapH = Math.max(10, viewport.height - legendH);
        this.svg.attr("width", this.mapW).attr("height", this.mapH);

        // ---- color scale ----
        const maxC = s.areaCard.maxColor.value.value;
        const scale = this.colorScale!.color;
        const noData = s.areaCard.noDataColor.value.value;
        const fg = this.host.colorPalette.foreground.value;
        const bg = this.host.colorPalette.background.value;
        const colorFor = (dp: DataPoint): string => {
            if (hc) return bg;
            if (dp.fxColor) return dp.fxColor;
            if (!model.hasColor) return maxC;
            return dp.colorValue === null ? noData : scale(dp.colorValue);
        };
        const bubbleFixed = s.bubbleCard.bubbleColorMode.value.value === "fixed";
        const bubbleColorFor = (dp: DataPoint): string => {
            if (hc) return fg;
            if (bubbleFixed) return s.bubbleCard.bubbleColor.value.value;
            return colorFor(dp);
        };

        // ---- projection & fit ----
        const level = model.level;
        const mode = level === "continent" ? "area"
            : level === "country" ? s.mapCard.countryMode.value.value
                : level === "district" ? s.mapCard.districtMode.value.value : "bubble";
        const drawAreas = !isPointish(level) && (mode === "area" || mode === "both");
        const drawBubbles = isPointish(level) || mode === "bubble" || mode === "both";
        const cityMode = s.mapCard.cityMode.value.value as string;
        const districtMode = s.mapCard.districtMode.value.value as string;
        // mark type of the aggregated city level: districts follow the district setting, municipalities the city setting
        const aggMode = model.view === "country" ? s.mapCard.countryMode.value.value as string : model.view === "district" ? districtMode : cityMode;
        const drawMuni = level === "city" && (model.muniCountries.length > 0 || model.view === "country") && aggMode !== "bubble";
        const showMuniBorders = level === "city" && model.muniCountries.length > 0 && model.view !== "district";
        const showDistrictBorders = (level === "district" || level === "city") && model.muniCountries.length > 0;

        const styleKey = s.basemapCard.style.value.value as string;
        this.baseStyle = !hc && BASE_STYLES[styleKey] ? BASE_STYLES[styleKey] : null;
        this.svg.style("background", this.baseStyle ? this.baseStyle.ocean : null);

        this.projection = this.makeProjection();
        const fitFeatures: any[] = [];
        if (level === "continent") {
            geo.continents.forEach(c => fitFeatures.push(c.feature));
        } else if (level === "country") {
            // the whole country, islands included (Açores, Madeira, Canarias, Baleares…)
            model.points.forEach(p => p.country && fitFeatures.push(p.country.feature));
        } else if (level === "district") {
            model.involvedCountries.forEach(c => fitFeatures.push(c.fitFeature));
            model.points.forEach(p => p.district && fitFeatures.push(p.district.feature));
        } else if (model.districtFocus.length) {
            model.districtFocus.forEach(d => fitFeatures.push(d.feature));
        } else {
            let pts = model.points.map(p => p.point!);
            // every located row (islands included) stays inside the reset view
            model.involvedCountries.forEach(c => fitFeatures.push(c.fitFeature));
            if (pts.length === 1 && !fitFeatures.length) fitFeatures.push(d3.geoCircle().center(pts[0]).radius(1.5)());
            else if (pts.length) fitFeatures.push({ type: "Feature", properties: {}, geometry: { type: "MultiPoint", coordinates: pts } });
        }
        if (!fitFeatures.length) geo.continents.forEach(c => fitFeatures.push(c.feature));
        const pad = Math.max(12, (drawBubbles ? s.bubbleCard.maxRadius.value : 0) + 6);
        this.projection.fitExtent([[pad, pad], [Math.max(pad + 1, this.mapW - pad), Math.max(pad + 1, this.mapH - pad)]],
            { type: "FeatureCollection", features: fitFeatures } as any);
        const path = d3.geoPath(this.projection);

        // the zoom resets only when the level, the view (countries / districts / municipalities) or the drill focus changes;
        // filtering, selecting, resizing or new data keep the place the user zoomed to
        const key = `${level}|${model.view || ""}|${JSON.stringify(this.activeFocus().map(f => f.keys))}`;
        if (key !== this.fitKey) {
            this.fitKey = key;
            this.zoomTarget = null;
            this.transform = d3.zoomIdentity;
            this.svg.call(this.zoom.transform as any, d3.zoomIdentity);
        } else if (this.zoomTarget) {
            const zt = this.zoomTarget;
            this.zoomTarget = null;
            let t = d3.zoomIdentity;
            if (zt !== "reset") {
                const k = Math.max(1, Math.min(60, zt.s / this.projection.scale()));
                const pc = this.projection(zt.c);
                if (pc) t = d3.zoomIdentity.translate(this.mapW / 2 - k * pc[0], this.mapH / 2 - k * pc[1]).scale(k);
            }
            this.transform = t;
            this.svg.call(this.zoom.transform as any, t);
        } else if (prevView && prevView.proj.invert) {
            const c = prevView.proj.invert(prevView.t.invert([prevView.w / 2, prevView.h / 2]));
            const k = prevView.proj.scale() * prevView.t.k / this.projection.scale();
            const pc = c ? this.projection(c) : null;
            if (pc && isFinite(k) && k >= 1 && k <= 60) {
                const t = d3.zoomIdentity.translate(this.mapW / 2 - k * pc[0], this.mapH / 2 - k * pc[1]).scale(k);
                this.transform = t;
                this.svg.call(this.zoom.transform as any, t);
            }
        }
        if (s.mapCard.enableZoom.value && this.interactive && !this.drawing) {
            this.zoom.extent([[0, 0], [this.mapW, this.mapH]]).translateExtent([[-this.mapW, -this.mapH], [2 * this.mapW, 2 * this.mapH]]);
            this.svg.call(this.zoom).on("dblclick.zoom", null);
        } else {
            this.svg.on(".zoom", null);
            this.transform = d3.zoomIdentity;
            this.gMap.attr("transform", null);
        }

        // ---- context layer ----
        const borderColor = hc ? fg : s.areaCard.borderColor.value.value;
        const borderW = s.areaCard.borderWidth.value;
        // one control for how strong every line is (area borders, district / municipality / country borders)
        const lineAlpha = hc ? 1 : Math.max(0.05, Math.min(1, s.areaCard.lineIntensity.value / 100));
        const ctxColor = s.mapCard.contextColor.value.value;
        const ctxBorder = s.mapCard.contextBorderColor.value.value;
        let ctxData: { id: string; f: any; fill: string; stroke: string }[] = [];
        const bs = this.baseStyle;
        const involvedSet = new Set((isPointish(level) ? model.involvedCountries : []).map(c => c.iso3));
        if (bs) {
            // vector basemap: every country is land, the ones in focus slightly brighter
            ctxData = geo.countries.map(c => ({ id: c.iso3, f: c.feature, fill: involvedSet.has(c.iso3) ? bs.landFocus : bs.land, stroke: bs.border }));
        } else if (level === "continent") {
            const withData = new Set(model.points.map(p => p.continent!.name));
            ctxData = geo.continents.filter(c => !drawAreas || !withData.has(c.name))
                .map(c => ({ id: c.name, f: c.feature, fill: hc ? "none" : (drawAreas ? noData : ctxColor), stroke: hc ? fg : ctxBorder }));
        } else if (s.mapCard.showContext.value) {
            const withData = new Set(drawAreas ? model.points.map(p => p.country!.iso3) : []);
            ctxData = geo.countries.filter(c => !withData.has(c.iso3)).map(c => ({
                id: c.iso3, f: c.feature,
                fill: hc ? "none" : (involvedSet.has(c.iso3) ? "#FFFFFF" : ctxColor),
                stroke: hc ? fg : (involvedSet.has(c.iso3) ? "#9AA4AF" : ctxBorder)
            }));
        } else if (isPointish(level)) {
            ctxData = model.involvedCountries.map(c => ({ id: c.iso3, f: c.feature, fill: hc ? "none" : "#FFFFFF", stroke: hc ? fg : "#9AA4AF" }));
        }
        // district / municipality views: countries around the areas take their outline from their own areas,
        // so country borders and area borders are the same line (no doubled border along PT/ES etc.)
        const outlineSet = new Set<string>();
        if (model.muniCountries.length && (level === "district" || (level === "city" && model.view !== "country"))) {
            let bx0 = 180, by0 = 90, bx1 = -180, by1 = -90;
            for (const cc of model.muniCountries) {
                const c = geo.countryByIso2Code(cc); if (!c) continue;
                const b = geo.countryBounds(c);
                bx0 = Math.min(bx0, b[0][0]); by0 = Math.min(by0, b[0][1]); bx1 = Math.max(bx1, b[1][0]); by1 = Math.max(by1, b[1][1]);
            }
            const span = Math.max(bx1 - bx0, by1 - by0);
            if (span < 60) {
                const m = 3;
                for (const c of geo.countries) {
                    if (!c.iso2 || !geo.hasDistricts(c.iso2)) continue;
                    const b = geo.countryBounds(c);
                    if (b[1][0] >= bx0 - m && b[0][0] <= bx1 + m && b[1][1] >= by0 - m && b[0][1] <= by1 + m) outlineSet.add(c.iso3);
                }
            }
        }
        this.gContext.selectAll<SVGPathElement, any>("path").data(ctxData, d => d.id).join("path")
            .attr("d", d => path(d.f) || "")
            .attr("fill", d => d.fill).attr("stroke", d => outlineSet.has(d.id) ? "none" : d.stroke)
            .attr("stroke-width", 0.6).attr("vector-effect", "non-scaling-stroke")
            .attr("stroke-opacity", lineAlpha);

        // ---- municipal borders of the countries shown (whole country covered: municipalities without data stay visible) ----
        const muniStroke = hc ? fg : bs ? bs.border : "#B8BEC6";
        const ctxStroke = hc ? fg : bs ? bs.border : ctxBorder;
        const meshes: { cc: string; g: any; w: number; color: string }[] = [
            ...(showMuniBorders ? model.muniCountries.map(cc => ({ cc: "m" + cc, g: geo.municipalityMesh(cc), w: 0.35, color: muniStroke })) : []),
            ...(showDistrictBorders ? model.muniCountries.map(cc => ({ cc: "d" + cc, g: geo.districtMesh(cc), w: 0.7, color: muniStroke })) : []),
            ...[...outlineSet].map(iso3 => geo.countries.find(c => c.iso3 === iso3)!).filter(c => c && !model.muniCountries.includes(c.iso2))
                .map(c => ({ cc: "o" + c.iso2, g: geo.countryOutline(c.iso2), w: 0.6, color: ctxStroke }))
        ].filter(x => !!x.g);
        this.gMuni.selectAll<SVGPathElement, any>("path").data(meshes, (d: any) => d.cc).join("path")
            .attr("d", d => {
                // the mesh is large: reuse its path string while the projection is unchanged
                const k = `${this.projection.scale().toFixed(3)}|${this.projection.translate().map(v => v.toFixed(2)).join(",")}`;
                const c = this.meshPathCache.get(d.cc);
                if (c && c.k === k) return c.d;
                const dd = path(d.g as any) || "";
                this.meshPathCache.set(d.cc, { k, d: dd });
                return dd;
            })
            .attr("fill", "none").attr("stroke", d => d.color)
            .attr("stroke-width", d => d.w).attr("vector-effect", "non-scaling-stroke")
            .attr("stroke-opacity", lineAlpha);
        this.updateMuniVisibility();

        // ---- areas ----
        const areaData = drawAreas ? model.points.filter(p => p.continent || p.country || p.district)
            : drawMuni && (aggMode === "area" || aggMode === "both") ? model.points.filter(p => p.muni || p.district || p.countryAgg) : [];
        areaData.forEach(dp => dp.fill = colorFor(dp));
        const featureOf = (d: DataPoint) => d.muni ? d.muni.feature : d.district ? d.district.feature : d.continent ? d.continent.feature : d.country!.feature;
        const areas = this.gAreas.selectAll<SVGPathElement, DataPoint>("path.gdm-area").data(areaData, d => d.uid || d.label).join("path")
            .classed("gdm-area gdm-mark", true)
            .attr("d", d => path(featureOf(d) as any) || "")
            .attr("fill", d => d.fill!)
            .attr("fill-opacity", s.areaCard.areaOpacity.value / 100)
            .attr("stroke", borderColor).attr("stroke-width", borderW).attr("vector-effect", "non-scaling-stroke")
            .attr("stroke-opacity", lineAlpha)
            .attr("tabindex", 0).attr("role", "button").attr("aria-label", d => d.label);
        this.bindInteractions(areas as any);

        // ---- roads (vector basemap) ----
        this.renderRoads(path);

        // ---- bubbles / donuts ----
        const minR = s.bubbleCard.minRadius.value, maxR = Math.max(minR, s.bubbleCard.maxRadius.value);
        const sizeVals = model.points.map(p => Math.abs((model.hasSize ? p.sizeValue : p.colorValue) ?? 0));
        const sizeMax = sizeVals.length ? safeMax(sizeVals) : 0;
        const rScale = d3.scaleSqrt().domain([0, sizeMax || 1]).range([minR, maxR]).clamp(true);
        const sizeMeasured = model.hasSize || model.hasColor;
        const useDonuts = this.donutsOn(model);
        const areaDonuts = drawAreas && !drawBubbles && useDonuts && s.donutCard.areaDonut.value;
        const muniDonuts = drawMuni && aggMode === "area" && useDonuts && s.donutCard.areaDonut.value;
        const aggregated = (p: DataPoint) => !!(p.muni || (p.district && p.members) || p.countryAgg);
        const isDonutOnly = (p: DataPoint) => areaDonuts || (muniDonuts && aggregated(p));
        let bubbleData = (drawBubbles || areaDonuts) ? model.points.filter(p => p.point &&
            (!drawMuni || !aggregated(p) || aggMode === "both" || muniDonuts)) : [];
        bubbleData.forEach(dp => {
            const v = model.hasSize ? dp.sizeValue : dp.colorValue;
            dp.radius = isDonutOnly(dp) ? s.donutCard.areaDonutSize.value : (sizeMeasured && v !== null ? rScale(Math.abs(v)) : (minR + maxR) / 2);
            dp.fill = bubbleColorFor(dp);
        });
        // only the largest locations get a donut (readability at district / municipality level)
        const donutSet = new Set<DataPoint>();
        if (useDonuts) {
            const maxD = s.donutCard.maxDonuts.value;
            const val = (p: DataPoint) => Math.abs((model.hasSize ? p.sizeValue : p.colorValue) ?? 0);
            const cands = bubbleData.filter(p => p.slices.length).sort((a, b) => val(b) - val(a));
            (maxD > 0 ? cands.slice(0, maxD) : cands).forEach(p => donutSet.add(p));
        }
        // a donut-only mark (area donut) that is not among the largest is not drawn at all; its area keeps the color
        bubbleData = bubbleData.filter(p => !isDonutOnly(p) || donutSet.has(p));
        bubbleData.sort((a, b) => (b.radius || 0) - (a.radius || 0)); // small on top
        this.bubbleSet = new Set(bubbleData);

        const opacity = s.bubbleCard.bubbleOpacity.value / 100;
        const bStroke = hc ? fg : s.bubbleCard.bubbleBorderColor.value.value;
        const bStrokeW = s.bubbleCard.bubbleBorderWidth.value;
        const hole = Math.min(0.95, Math.max(0, s.donutCard.donutHole.value / 100));
        const sliceStroke = hc ? bg : s.donutCard.sliceBorderColor.value.value;
        const sliceStrokeW = s.donutCard.sliceBorderWidth.value;
        const pie = d3.pie<SliceDatum>().value(d => d.value).sort(null);

        const marks = this.gMarks.selectAll<SVGGElement, DataPoint>("g.gdm-bubble").data(bubbleData, d => d.uid || d.label).join("g")
            .classed("gdm-bubble", true);
        marks.each((dp, idx, nodes) => {
            const g = d3.select(nodes[idx]);
            g.selectAll("*").remove();
            if (donutSet.has(dp)) {
                const arc = d3.arc<d3.PieArcDatum<SliceDatum>>().innerRadius(dp.radius! * hole).outerRadius(dp.radius!);
                const sl = g.selectAll<SVGPathElement, d3.PieArcDatum<SliceDatum>>("path").data(pie(dp.slices)).join("path")
                    .classed("gdm-slice gdm-mark", true)
                    .attr("d", arc as any)
                    .attr("fill", d => hc ? fg : d.data.color)
                    .attr("fill-opacity", opacity)
                    .attr("stroke", sliceStroke).attr("stroke-width", sliceStrokeW)
                    .attr("tabindex", 0).attr("role", "button").attr("aria-label", d => `${dp.label} ${d.data.name}`);
                this.bindSliceInteractions(sl);
                // the bubble outline (Bubbles › Outline) also surrounds donuts; slice separators keep their own setting
                if (bStrokeW > 0) {
                    g.append("circle").datum(dp).classed("gdm-donut-outline", true).attr("r", dp.radius!)
                        .attr("fill", "none").attr("stroke", bStroke).attr("stroke-width", bStrokeW).attr("pointer-events", "none");
                    if (hole > 0) g.append("circle").datum(dp).classed("gdm-donut-outline gdm-donut-inner", true).attr("r", dp.radius! * hole)
                        .attr("fill", "none").attr("stroke", bStroke).attr("stroke-width", bStrokeW).attr("pointer-events", "none");
                }
            } else {
                const c = g.append("circle").datum(dp)
                    .classed("gdm-circle gdm-mark", true)
                    .attr("r", dp.radius!)
                    .attr("fill", dp.fill!)
                    .attr("fill-opacity", opacity)
                    .attr("stroke", bStroke).attr("stroke-width", bStrokeW)
                    .attr("tabindex", 0).attr("role", "button").attr("aria-label", dp.label);
                this.bindInteractions(c as any);
            }
        });

        this.positionMarks();
        this.updateRoadVisibility();
        this.renderLabels();
        this.renderZones();
        this.updateResetButton();
        this.applySelectionStyles();


        // ---- unmatched warning ----
        this.renderUnmatched(model);
    }

    /** Warning chip + panel listing the locations that could not be placed, with their values. */
    private renderUnmatched(model: Model): void {
        const items = model.unmatched;
        if (!items.length) {
            this.warning.style("display", "none");
            this.unmatchedPanel.style("display", "none").selectAll("*").remove();
            return;
        }
        const fmt = items.find(u => u.format)?.format || model.colorFormat;
        let total = 0, totalAll = 0;
        for (const u of items) if (u.value !== null) total += u.value;
        for (const p of model.points) { const v = p.colorValue !== null ? p.colorValue : p.sizeValue; if (v !== null) totalAll += v; }
        totalAll += total;
        const share = totalAll ? " · " + this.tr("Rt_ShareOfTotal", "{0}% of total", (total / totalAll * 100).toLocaleString(this.locale, { maximumFractionDigits: 1 })) : "";
        const hasVals = items.some(u => u.value !== null);
        this.warning.style("display", null)
            .attr("title", this.tr("Rt_ClickForList", "Click to see the list"))
            .text("⚠ " + (items.length === 1 ? this.tr("Rt_NotFound1", "1 location not found") : this.tr("Rt_NotFoundN", "{0} locations not found", items.length)) +
                (hasVals ? ` (${formatValue(total, fmt, "auto", 1, this.locale)}${share})` : ""));

        const sorted = items.slice().sort((a, b) => Math.abs(b.value ?? 0) - Math.abs(a.value ?? 0));
        const panel = this.unmatchedPanel;
        panel.selectAll("*").remove();
        const head = panel.append("div").classed("gdm-unmatched-head", true);
        head.append("span").text((items.length === 1 ? this.tr("Rt_NotFound1", "1 location not found") : this.tr("Rt_NotFoundN", "{0} locations not found", items.length)) + (hasVals ? " — " + formatExact(total, fmt, this.locale) : ""));
        head.append("button").attr("aria-label", this.tr("Rt_Close", "Close")).text("✕").on("click", (e: MouseEvent) => { e.stopPropagation(); panel.style("display", "none"); });
        panel.append("div").classed("gdm-unmatched-tip", true)
            .text(this.tr("Rt_NotFoundTip", "Tip: click a location to see it in the other visuals; add the Country column and a Postal code measure, or set the Default country in Map."));
        const table = panel.append("div").classed("gdm-unmatched-list", true);
        const rows = table.selectAll("div.gdm-unmatched-row").data(sorted.slice(0, 500)).join("div").classed("gdm-unmatched-row", true);
        // the country value of the row helps to spot a misspelled country ("Roma · Itly")
        const umName = (d: UnmatchedItem) => {
            const g = d.row?.groupRaw;
            return g !== undefined && g !== null && String(g) && !d.label.includes(String(g)) ? `${d.label} · ${g}` : d.label;
        };
        rows.append("span").classed("gdm-um-name", true).text(umName).attr("title", umName);
        rows.append("span").classed("gdm-um-val", true).text(d => d.value === null ? "" : formatExact(d.value, d.format || fmt, this.locale));
        // click = select / filter that row on the page (Ctrl/Shift adds): the other visuals show what is behind it
        if (this.interactive) {
            const selectable = sorted.filter(u => !!u.row);
            rows.filter(d => !!d.row).classed("gdm-um-click", true).attr("tabindex", 0).attr("role", "button")
                .attr("title", this.tr("Rt_NotFoundClick", "Click to select it in the other visuals (Ctrl+click adds)"))
                .on("click", (e: MouseEvent, d) => { e.stopPropagation(); this.selectUnmatched([d.row!], e.ctrlKey || e.metaKey || e.shiftKey); })
                .on("keydown", (e: KeyboardEvent, d) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); this.selectUnmatched([d.row!], e.ctrlKey || e.shiftKey); } });
            if (selectable.length > 1) head.insert("button", "button").classed("gdm-um-all", true)
                .attr("title", this.tr("Rt_NotFoundSelectAll", "Select all")).text(this.tr("Rt_NotFoundSelectAll", "Select all"))
                .on("click", (e: MouseEvent) => { e.stopPropagation(); this.selectUnmatched(selectable.map(u => u.row!), false); });
            this.markUnmatchedSelection();
        }
        if (sorted.length > 500) table.append("div").classed("gdm-unmatched-row", true).text(this.tr("Rt_AndMore", "… and {0} more", sorted.length - 500));
    }

    /** Selects (filter mode: filters) rows from the "not found" list. */
    private selectUnmatched(rows: DataPoint[], multi: boolean): void {
        if (!this.interactive || !rows.length) return;
        if (this.filterMode) this.toggleFilter(rows.map(r => r.label), multi);
        else this.selectIds(rows.map(r => r.selectionId), multi);
    }

    private markUnmatchedSelection(): void {
        const sel = new Set(this.currentSelection());
        this.unmatchedPanel.selectAll<HTMLDivElement, UnmatchedItem>("div.gdm-um-click").classed("gdm-um-sel", d => !!d.row && sel.has(d.row));
    }

    /**
     * Colour scale over the colour measure.
     *  linear / log : value-based (log uses a symlog so zeros/negatives still work)
     *  clip         : linear between two percentiles; values outside saturate
     *  rank         : continuous percentile rank -> every location gets a distinct shade regardless of skew
     *  quantile     : N classes with the same number of locations each
     */
    /** Colour scale with the negative-value treatment: own colour (default), part of the scale, or diverging (red ← 0 → scale). */
    private buildColorScale(model: Model): ColorScaleInfo {
        const a = this.formattingSettings.areaCard;
        const all: number[] = [];
        for (const p of model.points) if (p.colorValue !== null) all.push(p.colorValue);
        const mode = a.negativeMode.value.value as string;
        const negs = all.filter(v => v < 0);
        if (!negs.length || mode === "scale") return this.baseColorScale(all, false);
        const negColor = a.negativeColor.value.value;
        const pos = all.filter(v => v >= 0);
        const base = this.baseColorScale(pos.length ? pos : [0, 1], mode === "diverging");
        if (mode === "diverging") {
            const lo = Math.min(...negs);
            const light = "#F3F2F1";
            const ns = (v: number) => d3.interpolateLab(negColor, light)(lo === 0 ? 1 : Math.max(0, Math.min(1, (v - lo) / (0 - lo))));
            return Object.assign({}, base, { color: (v: number) => v < 0 ? ns(v) : base.color(v), negative: { color: negColor, from: lo, stops: [negColor, light] } });
        }
        return Object.assign({}, base, { color: (v: number) => v < 0 ? negColor : base.color(v), negative: { color: negColor, from: Math.min(...negs) } });
    }

    private baseColorScale(input: number[], fromZero: boolean): ColorScaleInfo {
        const a = this.formattingSettings.areaCard;
        const n = a.gradientType.value.value;
        const stops = n === "two" ? [a.minColor.value.value, a.maxColor.value.value]
            : n === "four" ? [a.minColor.value.value, a.midColor.value.value, a.mid2Color.value.value, a.maxColor.value.value]
                : [a.minColor.value.value, a.midColor.value.value, a.maxColor.value.value];
        const vals = input.slice().sort((x, y) => x - y);
        const type = a.scaleType.value.value as string;
        const ramp = (t: number) => {
            const tt = Math.max(0, Math.min(1, t)) * (stops.length - 1);
            const i = Math.min(stops.length - 2, Math.floor(tt));
            return d3.interpolateLab(stops[i], stops[i + 1])(tt - i);
        };
        const q = (p: number) => vals.length ? d3.quantileSorted(vals, p)! : 0;
        let lo = vals.length ? vals[0] : 0, hi = vals.length ? vals[vals.length - 1] : 1;
        if (fromZero) lo = 0;

        if (type === "rank" && vals.length) {
            const color = (v: number) => {
                const r = d3.bisectLeft(vals, v), rr = d3.bisectRight(vals, v);
                return ramp(vals.length === 1 ? 1 : ((r + rr - 1) / 2) / (vals.length - 1));
            };
            return { color, kind: "continuous", stops, ticks: [{ t: 0, v: lo }, { t: 0.5, v: q(0.5) }, { t: 1, v: hi }], note: "percentil" };
        }
        if (type === "quantile" && vals.length) {
            const k = Math.max(2, Math.min(9, a.classes.value));
            const breaks: number[] = [];
            for (let i = 1; i < k; i++) breaks.push(q(i / k));
            const colors = d3.range(k).map(i => ramp(i / (k - 1)));
            const sc = d3.scaleThreshold<number, string>().domain(breaks).range(colors);
            const classes = colors.map((c, i) => ({ color: c, from: i === 0 ? lo : breaks[i - 1], to: i === k - 1 ? hi : breaks[i] }));
            return { color: (v: number) => sc(v), kind: "classes", stops, classes, ticks: [] };
        }
        if (type === "clip" && vals.length) {
            lo = q(Math.max(0, a.pLow.value) / 100);
            hi = q(Math.min(100, a.pHigh.value) / 100);
        } else if (!a.autoRange.value) {
            lo = a.rangeMin.value; hi = a.rangeMax.value;
        }
        if (lo === hi) { lo -= 1; hi += 1; }
        if (type === "log") {
            const tr = (v: number) => Math.sign(v) * Math.log10(1 + Math.abs(v));
            const tlo = tr(lo), thi = tr(hi);
            const color = (v: number) => ramp((tr(v) - tlo) / (thi - tlo));
            const mid = Math.sign(lo + hi) * (Math.pow(10, (tlo + thi) / 2) - 1);
            return { color, kind: "continuous", stops, ticks: [{ t: 0, v: lo }, { t: 0.5, v: mid }, { t: 1, v: hi }], note: "log" };
        }
        // linear (and clip); 3 colours may use a custom midpoint (diverging)
        if (stops.length === 3 && !a.autoMid.value && type === "linear") {
            const mid = a.midValue.value;
            const sc = d3.scaleLinear<string>().domain([lo, mid, hi]).range(stops).interpolate(d3.interpolateLab).clamp(true);
            return { color: (v: number) => sc(v), kind: "continuous", stops, ticks: [{ t: 0, v: lo }, { t: (mid - lo) / (hi - lo), v: mid }, { t: 1, v: hi }] };
        }
        const color = (v: number) => ramp((v - lo) / (hi - lo));
        return { color, kind: "continuous", stops, ticks: [{ t: 0, v: lo }, { t: 1, v: hi }], note: type === "clip" ? `P${a.pLow.value}–P${a.pHigh.value}` : undefined };
    }

    /** Fixed Equal Earth projection: true area proportions, good for choropleths at every zoom level. */
    private makeProjection(): d3.GeoProjection {
        return d3.geoEqualEarth();
    }

    /** Bubbles live in screen space so they keep their pixel size when zooming. */
    private positionMarks(): void {
        if (!this.projection) return;
        const t = this.transform;
        this.gMarks.selectAll<SVGGElement, DataPoint>("g.gdm-bubble").attr("transform", d => {
            const p = this.projection(d.point!);
            if (!p) { d.xy = undefined; return "translate(-9999,-9999)"; }
            d.xy = t.apply(p) as [number, number];
            return `translate(${d.xy[0]},${d.xy[1]})`;
        });
    }

    private renderLabels(): void {
        const s = this.formattingSettings;
        const model = this.model;
        this.gLabels.selectAll("*").remove();
        if (!model || !this.projection) { this.gPlaces.selectAll("*").remove(); return; }
        if (!s.labelsCard.show.value) { this.renderPlaces([]); return; }
        const fontSize = s.labelsCard.fontSize.value;
        const content = s.labelsCard.content.value.value;
        const units = s.labelsCard.displayUnits.value.value as Units;
        const decimals = s.labelsCard.decimals.value;
        const t = this.transform;

        const items = model.points.map(dp => {
            let anchor: [number, number] | null = null;
            let dy = 0;
            if (this.bubbleSet.has(dp) && dp.xy) { anchor = dp.xy; dy = (dp.radius || 0) + fontSize; }
            else if (dp.point) { const p = this.projection(dp.point); if (p) anchor = t.apply(p) as [number, number]; dy = fontSize * 0.35; }
            if (!anchor) return null;
            const valueText = model.hasColor ? formatValue(dp.colorValue, dp.colorFormat, units, decimals, this.locale)
                : model.hasSize ? formatValue(dp.sizeValue, dp.sizeFormat, units, decimals, this.locale) : "";
            const lines: string[] = [];
            if (content === "name" || content === "both") lines.push(dp.label);
            if ((content === "value" || content === "both") && valueText) lines.push(valueText);
            if (!lines.length) return null;
            const w = Math.max(...lines.map(l => l.length)) * fontSize * 0.58;
            const h = lines.length * fontSize * 1.15;
            const weight = Math.abs((model.hasSize ? dp.sizeValue : dp.colorValue) ?? 0);
            return { dp, x: anchor[0], y: anchor[1] + dy, lines, w, h, weight };
        }).filter(x => !!x) as { dp: DataPoint; x: number; y: number; lines: string[]; w: number; h: number; weight: number }[];

        items.sort((a, b) => b.weight - a.weight);
        const placed: { x0: number; y0: number; x1: number; y1: number }[] = [];
        const keep = items.filter(it => {
            const box = { x0: it.x - it.w / 2, y0: it.y - fontSize, x1: it.x + it.w / 2, y1: it.y - fontSize + it.h };
            if (box.x1 < 0 || box.x0 > this.mapW || box.y1 < 0 || box.y0 > this.mapH) return false;
            if (s.labelsCard.autoHide.value && placed.some(p => !(box.x1 < p.x0 || box.x0 > p.x1 || box.y1 < p.y0 || box.y0 > p.y1))) return false;
            placed.push(box);
            return true;
        });

        this.renderPlaces(placed);
        const color = this.host.colorPalette.isHighContrast ? this.host.colorPalette.foreground.value : s.labelsCard.fontColor.value.value;
        const text = this.gLabels.selectAll("text").data(keep).join("text")
            .classed("gdm-label", true)
            .classed("gdm-halo", s.labelsCard.halo.value)
            .attr("x", d => d.x).attr("y", d => d.y)
            .attr("text-anchor", "middle")
            .attr("font-size", fontSize)
            .attr("fill", color);
        text.each((d, i, nodes) => {
            const el = d3.select(nodes[i]);
            d.lines.forEach((l, li) => el.append("tspan").attr("x", d.x).attr("dy", li === 0 ? 0 : fontSize * 1.15).attr("font-weight", li === 0 && d.lines.length > 1 ? 600 : null).text(l));
        });
    }

    /** Effective web-mercator zoom level of the current view (projection scale × zoom transform). */
    private zoomLevel(): number {
        if (!this.projection) return 0;
        return Math.log2(this.projection.scale() * this.transform.k * 2 * Math.PI / 256);
    }

    private renderRoads(path: d3.GeoPath): void {
        const s = this.formattingSettings;
        const bs = this.baseStyle;
        if (!bs || !s.basemapCard.showRoads.value) { this.gRoads.selectAll("*").remove(); return; }
        const layers = this.geo!.roadLayers();
        const casings = layers.filter(l => l.kind === "M");
        this.gRoads.selectAll<SVGPathElement, any>("path.gdm-road-case").data(casings, (d: any) => d.key).join("path")
            .classed("gdm-road-case", true)
            .attr("d", d => path(d.geometry as any) || "")
            .attr("fill", "none").attr("stroke", bs.roadMCase).attr("stroke-width", 2.6)
            .attr("stroke-linecap", "round").attr("stroke-linejoin", "round").attr("vector-effect", "non-scaling-stroke");
        this.gRoads.selectAll<SVGPathElement, any>("path.gdm-road").data(layers, (d: any) => d.key).join("path")
            .classed("gdm-road", true)
            .attr("d", d => path(d.geometry as any) || "")
            .attr("fill", "none")
            .attr("stroke", d => d.kind === "M" ? bs.roadM : bs.roadS)
            .attr("stroke-width", d => d.kind === "M" ? 1.6 : 1.1)
            .attr("stroke-linecap", "round").attr("stroke-linejoin", "round").attr("vector-effect", "non-scaling-stroke");
        // make sure casings sit under all road fills
        this.gRoads.selectAll("path.gdm-road").raise();
    }

    /** Municipal borders fade in as the user zooms (thousands of borders would be noise on a whole-country view). */
    private updateMuniVisibility(): void {
        const z = this.zoomLevel();
        this.gMuni.attr("opacity", z < 5.5 ? 0.25 : z < 6.5 ? 0.5 : z < 7.5 ? 0.75 : 1);
    }

    /** Road width/visibility follow the zoom level like a real web map: hairlines when zoomed out, wider when zoomed in. */
    private updateRoadVisibility(): void {
        const z = this.zoomLevel();
        const intensity = (this.formattingSettings?.basemapCard.roadIntensity.value ?? 60) / 100;
        const wMajor = Math.max(0.3, Math.min(3, 0.3 * Math.pow(1.45, z - 3.5)));
        const wMinor = wMajor * 0.7;
        const casing = z >= 6.5;
        const op = intensity * (z < 5 ? 0.55 : z < 6.5 ? 0.8 : 1);
        this.gRoads.attr("opacity", op);
        this.gRoads.selectAll<SVGPathElement, any>("path.gdm-road")
            .style("display", d => (z + 0.3 >= d.minZoom + (d.kind === "S" ? 1 : 0)) ? null : "none")
            .attr("stroke-width", d => d.kind === "M" ? wMajor : wMinor);
        this.gRoads.selectAll<SVGPathElement, any>("path.gdm-road-case")
            .style("display", d => casing && (z + 0.3 >= d.minZoom) ? null : "none")
            .attr("stroke-width", wMajor + 1);
    }

    private scheduleLabels(): void {
        if (this.labelFrame) return;
        const raf = (window as any).requestAnimationFrame || ((cb: () => void) => setTimeout(cb, 16));
        this.labelFrame = raf(() => { this.labelFrame = 0; this.renderLabels(); });
    }

    /** Basemap names (countries + places) drawn under the data marks, avoiding each other and the data labels. */
    private renderPlaces(obstacles: { x0: number; y0: number; x1: number; y1: number }[]): void {
        const s = this.formattingSettings;
        const bs = this.baseStyle;
        this.gPlaces.selectAll("*").remove();
        if (!bs || !this.projection) return;
        const t = this.transform;
        const z = this.zoomLevel();
        const W = this.mapW, H = this.mapH;
        const placed = obstacles.slice();
        const fits = (b: { x0: number; y0: number; x1: number; y1: number }) =>
            b.x0 >= 0 && b.x1 <= W && b.y0 >= 0 && b.y1 <= H && !placed.some(p => !(b.x1 < p.x0 || b.x0 > p.x1 || b.y1 < p.y0 || b.y0 > p.y1));
        const items: { x: number; y: number; text: string; size: number; weight: number; kind: "country" | "place" }[] = [];

        // countries
        if (s.basemapCard.showCountryNames.value) {
            const pt = (this.locale || "").toLowerCase().startsWith("pt");
            const byRank = this.geo!.countries.slice().sort((a, b) => a.minLabelZoom - b.minLabelZoom);
            const pxPerDeg = 256 * Math.pow(2, z) / 360;
            for (const c of byRank) {
                if (z + 0.5 < c.minLabelZoom) continue;
                if (c.lonSpan * pxPerDeg < 30) continue; // too small on screen to deserve a name
                const p = this.projection(c.label);
                if (!p) continue;
                const [x, y] = t.apply(p);
                const text = (pt ? c.namePT : c.nameEN).toUpperCase();
                const size = Math.max(8, s.basemapCard.placeFontSize.value - 1);
                const w = text.length * size * 0.7, h = size;
                const b = { x0: x - w / 2, y0: y - h, x1: x + w / 2, y1: y + 2 };
                if (!fits(b)) continue;
                placed.push(b);
                items.push({ x, y, text, size, weight: 500, kind: "country" });
            }
        }

        // places (cities by population, limited to the visible area)
        if (s.basemapCard.showPlaces.value) {
            const thr = placeThresholdK(z, s.basemapCard.placeDensity.value.value as string);
            let lonMin = 180, lonMax = -180, latMin = 90, latMax = -90, valid = 0;
            for (let i = 0; i <= 4; i++) for (let j = 0; j <= 4; j++) {
                const sp = t.invert([W * i / 4, H * j / 4]);
                const ll = this.projection.invert ? this.projection.invert(sp) : null;
                if (!ll || !isFinite(ll[0]) || !isFinite(ll[1])) continue;
                valid++;
                lonMin = Math.min(lonMin, ll[0]); lonMax = Math.max(lonMax, ll[0]);
                latMin = Math.min(latMin, ll[1]); latMax = Math.max(latMax, ll[1]);
            }
            if (valid < 6) { lonMin = -180; lonMax = 180; latMin = -90; latMax = 90; }
            else { lonMin -= 1; lonMax += 1; latMin -= 1; latMax += 1; }
            const base = s.basemapCard.placeFontSize.value;
            let count = 0;
            // countries / districts views: only the largest places of each area (keeps the map readable)
            const model = this.model;
            const geo = this.geo!;
            const view = !model ? null : model.level === "country" ? "country" : model.level === "district" ? "district"
                : model.level === "city" && (model.view === "country" || model.view === "district") ? model.view : null;
            const cap = view && geo.hasDistricts() ? s.basemapCard.placesPerArea.value : -1;
            const perArea = new Map<string, number>();
            const areaKey = (c: CityInfo): string => {
                if (view !== "district" || !model!.muniCountries.includes(c.iso2)) return c.iso2;
                let k = this.placeAreaCache.get(c);
                if (k === undefined) { const a = geo.findArea(c.iso2, [c.lon, c.lat], true); k = a ? a.cc + ":" + a.district : c.iso2; this.placeAreaCache.set(c, k); }
                return k;
            };
            for (const c of geo.citiesByPopulation()) {
                if (cap === 0) break;
                if (c.popK < thr || count >= 220) break;
                if (c.lon < lonMin || c.lon > lonMax || c.lat < latMin || c.lat > latMax) continue;
                let ak = "";
                if (cap > 0) { ak = areaKey(c); if ((perArea.get(ak) || 0) >= cap) continue; }
                const p = this.projection([c.lon, c.lat]);
                if (!p) continue;
                const [x, y] = t.apply(p);
                const big = c.popK >= thr * 8;
                const size = big ? base + 1 : base;
                const w = c.name.length * size * 0.58, h = size;
                const b = { x0: x - w / 2 - 2, y0: y - h / 2 - 2, x1: x + w / 2 + 2, y1: y + h / 2 + 2 };
                if (!fits(b)) continue;
                placed.push(b);
                items.push({ x, y: y + size * 0.35, text: c.name, size, weight: big ? 600 : 400, kind: "place" });
                count++;
                if (cap > 0) perArea.set(ak, (perArea.get(ak) || 0) + 1);
            }
        }

        this.gPlaces.selectAll("text").data(items).join("text")
            .attr("class", d => `gdm-place gdm-place-${d.kind}`)
            .attr("x", d => d.x).attr("y", d => d.y)
            .attr("text-anchor", "middle")
            .attr("font-size", d => d.size)
            .attr("font-weight", d => d.weight)
            .attr("letter-spacing", d => d.kind === "country" ? "0.08em" : null)
            .attr("fill", d => d.kind === "country" ? bs.country : bs.place)
            .attr("stroke", bs.placeHalo)
            .text(d => d.text);
    }

    private updateResetButton(): void {
        const s = this.formattingSettings;
        const show = !!s && s.mapCard.enableZoom.value && s.mapCard.showReset.value &&
            (this.transform.k !== 1 || this.transform.x !== 0 || this.transform.y !== 0);
        this.resetBtn.style("display", show ? null : "none");
        const zoomOn = !!s && s.mapCard.enableZoom.value && this.interactive;
        this.zoomInBtn.style("display", zoomOn ? null : "none").property("disabled", this.transform.k >= 59.9);
        this.zoomOutBtn.style("display", zoomOn ? null : "none").property("disabled", this.transform.k <= 1.001);
    }

    private zoomBy(f: number): void {
        if (!this.formattingSettings?.mapCard.enableZoom.value) return;
        const cur = this.transform;
        const k = Math.max(1, Math.min(60, cur.k * f));
        const c = cur.invert([this.mapW / 2, this.mapH / 2]);
        this.animateZoom(d3.zoomIdentity.translate(this.mapW / 2 - k * c[0], this.mapH / 2 - k * c[1]).scale(k), 250);
    }

    /** Animated zoom to t (in the current projection), remembered so an interrupting re-render can finish it. */
    private animateZoom(t: d3.ZoomTransform, duration: number): void {
        if (t.k <= 1.0001 && Math.abs(t.x) < 0.5 && Math.abs(t.y) < 0.5) this.zoomTarget = "reset";
        else {
            const c = this.projection.invert ? this.projection.invert(t.invert([this.mapW / 2, this.mapH / 2])) : null;
            this.zoomTarget = c ? { c: c as [number, number], s: this.projection.scale() * t.k } : null;
        }
        this.svg.transition().duration(duration).call(this.zoom.transform as any, t)
            .on("end", () => { this.zoomTarget = null; });
    }

    /** Zooms the map onto the marks that hold the given data rows (search results). */
    private zoomToRows(rows: DataPoint[]): void {
        const model = this.model;
        if (!model || !this.projection || !this.formattingSettings?.mapCard.enableZoom.value) return;
        const want = new Set(rows);
        const feats: any[] = [];
        for (const p of model.points) {
            if (!rowsOf(p).some(r => want.has(r))) continue;
            const f = p.muni ? p.muni.feature : p.district ? p.district.feature : p.continent ? p.continent.feature
                : p.countryAgg && p.country ? p.country.fitFeature : null;
            if (f) feats.push(f);
            else if (p.point) feats.push(d3.geoCircle().center(p.point).radius(0.05)());
            else if (p.country) feats.push(p.country.fitFeature);
        }
        if (!feats.length) return;
        const path = d3.geoPath(this.projection);
        const [[x0, y0], [x1, y1]] = path.bounds({ type: "FeatureCollection", features: feats } as any);
        if (![x0, y0, x1, y1].every(isFinite)) return;
        // the found area fills about two thirds of the map, so its surroundings stay visible
        const w = Math.max(1, x1 - x0), h = Math.max(1, y1 - y0);
        const k = Math.max(1, Math.min(40, 0.66 * this.mapW / w, 0.66 * this.mapH / h));
        const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
        this.animateZoom(d3.zoomIdentity.translate(this.mapW / 2 - k * cx, this.mapH / 2 - k * cy).scale(k), 450);
    }

    // -----------------------------------------------------------------------------------------
    // Legend
    // -----------------------------------------------------------------------------------------

    private renderLegend(model: Model, viewport: powerbi.IViewport): void {
        const s = this.formattingSettings.legendCard;
        const top = s.position.value.value === "top";
        const target = top ? this.legendTop : this.legendBottom;
        const other = top ? this.legendBottom : this.legendTop;
        other.style("display", "none").selectAll("*").remove();
        target.selectAll("*").remove();
        const legendOn = this.donutsOn(model);
        const showGradient = !legendOn && model.hasColor && !this.host.colorPalette.isHighContrast;
        if (!s.show.value || (!legendOn && !showGradient)) { target.style("display", "none"); return; }
        target.style("display", null)
            .style("font-size", `${s.fontSize.value}px`)
            .style("color", s.fontColor.value.value)
            .style("max-width", `${viewport.width}px`);

        if (s.showTitle.value) target.append("span").classed("gdm-legend-title", true).text(legendOn ? model.legendTitle : model.colorName);

        if (legendOn) {
            model.legendItems.forEach(li => {
                const item = target.append("span").classed("gdm-legend-item", true).attr("tabindex", 0).attr("role", "button");
                item.append("span").classed("gdm-swatch", true).style("background", li.color);
                item.append("span").text(li.name);
                const select = (e: MouseEvent | KeyboardEvent) => {
                    e.stopPropagation();
                    if (!this.interactive) return;
                    this.selectionManager.select(li.selectionId, (e as MouseEvent).ctrlKey || (e as MouseEvent).metaKey || (e as MouseEvent).shiftKey)
                        .then(() => this.applySelectionStyles());
                };
                item.on("click", select);
                item.on("keydown", (e: KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); select(e); } });
            });
        } else {
            const cs = this.colorScale!;
            const fmt = (v: number) => formatValue(v, model.colorFormat, "auto", 1, this.locale);
            if (cs.negative) {
                const ng = target.append("span").classed("gdm-legend-class gdm-legend-neg", true);
                if (cs.negative.stops) {
                    ng.append("span").classed("gdm-grad-label", true).text(fmt(cs.negative.from));
                    ng.append("span").classed("gdm-grad-bar gdm-grad-bar-neg", true).style("background", `linear-gradient(to right, ${cs.negative.stops.join(", ")})`);
                } else {
                    ng.append("span").classed("gdm-swatch gdm-swatch-sq", true).style("background", cs.negative.color);
                    ng.append("span").text(this.tr("Rt_Negative", "< 0 (negative)"));
                }
            }
            if (cs.kind === "classes" && cs.classes) {
                cs.classes.forEach(c => {
                    const item = target.append("span").classed("gdm-legend-class", true);
                    item.append("span").classed("gdm-swatch gdm-swatch-sq", true).style("background", c.color);
                    item.append("span").text(`${fmt(c.from)}–${fmt(c.to)}`);
                });
            } else {
                const ticks = cs.ticks;
                target.append("span").classed("gdm-grad-label", true).text(fmt(ticks[0].v));
                const bar = target.append("span").classed("gdm-grad-bar", true).style("background", `linear-gradient(to right, ${cs.stops.join(", ")})`);
                ticks.slice(1, -1).forEach(t => bar.append("span").classed("gdm-grad-tick", true).style("left", `${(t.t * 100).toFixed(1)}%`).attr("title", fmt(t.v)));
                target.append("span").classed("gdm-grad-label", true).text(fmt(ticks[ticks.length - 1].v));
                if (cs.note === "percentil") target.append("span").classed("gdm-grad-note", true).text(this.tr("Rt_LegendRank", "(by rank · median {0})", fmt(ticks[1].v)));
                else if (cs.note === "log") target.append("span").classed("gdm-grad-note", true).text(this.tr("Rt_LegendLog", "(logarithmic)"));
                else if (cs.note) target.append("span").classed("gdm-grad-note", true).text(this.tr("Rt_LegendClip", "(clipped {0}, values outside saturate)", cs.note));
            }
        }
    }

    // -----------------------------------------------------------------------------------------
    // Interactions
    // -----------------------------------------------------------------------------------------

    private bindInteractions(sel: d3.Selection<SVGElement, DataPoint, any, any>): void {
        sel.on("click", (e: MouseEvent, d) => this.onMarkClick(e, d, d.selectionId))
            .on("keydown", (e: KeyboardEvent, d) => {
                if (e.key === "Enter" || e.key === " ") { e.preventDefault(); this.onMarkClick(e, d, d.selectionId); }
            })
            .on("contextmenu", (e: MouseEvent, d) => {
                e.preventDefault(); e.stopPropagation();
                this.selectionManager.showContextMenu(d.selectionId, { x: e.clientX, y: e.clientY });
            })
            .on("mouseover", (e: MouseEvent, d) => this.showTooltip(e, this.tooltipFor(d), rowsOf(d).slice(0, 100).map(r => r.selectionId)))
            .on("mousemove", (e: MouseEvent, d) => this.moveTooltip(e, this.tooltipFor(d), rowsOf(d).slice(0, 100).map(r => r.selectionId)))
            .on("mouseout", () => { this.noDataKey = null; this.host.tooltipService.hide({ immediately: true, isTouchEvent: false }); });
    }

    private bindSliceInteractions(sel: d3.Selection<SVGPathElement, d3.PieArcDatum<SliceDatum>, any, any>): void {
        sel.on("click", (e: MouseEvent, d) => { if (d.data.parent) this.onMarkClick(e, d.data.parent, d.data.selectionId); })
            .on("keydown", (e: KeyboardEvent, d) => {
                if ((e.key === "Enter" || e.key === " ") && d.data.parent) { e.preventDefault(); this.onMarkClick(e, d.data.parent, d.data.selectionId); }
            })
            .on("contextmenu", (e: MouseEvent, d) => {
                e.preventDefault(); e.stopPropagation();
                this.selectionManager.showContextMenu(d.data.selectionId, { x: e.clientX, y: e.clientY });
            })
            .on("mouseover", (e: MouseEvent, d) => this.showTooltip(e, this.tooltipForSlice(d.data), [d.data.selectionId]))
            .on("mousemove", (e: MouseEvent, d) => this.moveTooltip(e, this.tooltipForSlice(d.data), [d.data.selectionId]))
            .on("mouseout", () => { this.noDataKey = null; this.host.tooltipService.hide({ immediately: true, isTouchEvent: false }); });
    }

    // -----------------------------------------------------------------------------------------
    // Drill into selection
    // -----------------------------------------------------------------------------------------

    private readDrillState(dataView: DataView | undefined): void {
        this.categoryDepth = dataView?.categorical?.categories?.length || 0;
        const raw = (dataView?.metadata?.objects as any)?.drillState?.focus as string | undefined;
        let list: DrillFocus[] = [];
        if (raw) {
            try {
                const parsed = JSON.parse(raw);
                list = (Array.isArray(parsed) ? parsed : [parsed])
                    .filter((f: any) => f && (f.level === "continent" || f.level === "country" || f.level === "district" || f.level === "city") && Array.isArray(f.keys) && f.keys.length);
            } catch { list = []; }
        }
        // a focus we persisted is still on its way back from the host: keep the in-memory one until it arrives
        if (this.pendingFocusJson !== null && Date.now() - this.pendingFocusT > 5000) this.pendingFocusJson = null;
        if (this.pendingFocusJson !== null) {
            if ((raw || "") === this.pendingFocusJson) this.pendingFocusJson = null;
        } else this.focus = list;
        // persisted filter selection of the current level (filter mode)
        const sel = (dataView?.metadata?.objects as any)?.drillState?.sel as string | undefined;
        // our own selection change is still on its way back: an older persisted selection must not be restored
        if (this.pendingSelEcho) {
            if ((sel || "") === this.pendingSelEcho.json || Date.now() - this.pendingSelEcho.t > 5000) this.pendingSelEcho = null;
            else return;
        }
        if ((sel || "") !== this.persistedSelJson) {
            this.persistedSelJson = sel || "";
            try {
                const o = sel ? JSON.parse(sel) : null;
                this.pendingRestore = o && Array.isArray(o.labels) ? { level: o.level, labels: o.labels } : null;
            } catch { this.pendingRestore = null; }
        }
    }

    /** Called once the level of the incoming data is known: drop focus entries that no longer apply (drill up)
     *  and turn the last in-visual selection into a focus when the data just went one level deeper. */
    private reconcileFocus(level: Level): void {
        const before = JSON.stringify(this.focus);
        let list = this.focus.filter(f => LEVEL_ORDER[f.level] < LEVEL_ORDER[level]);
        const prev = this.lastLevel;
        if (prev && LEVEL_ORDER[level] > LEVEL_ORDER[prev] && this.pendingSel && this.pendingSel.level === prev) {
            list = list.filter(f => LEVEL_ORDER[f.level] < LEVEL_ORDER[prev]).concat([this.pendingSel]);
        }
        if (prev && level !== prev) {
            this.cityView = null;
            this.pendingSel = null;
            this.zones = [];
            this.filterLabels = new Set();
            this.levelChanged = true;
        }
        if (this.pendingRestore && this.pendingRestore.level === level && !this.levelChanged) {
            this.filterLabels = new Set(this.pendingRestore.labels);
        }
        this.pendingRestore = null;
        this.lastLevel = level;
        this.focus = list;
        this.focusDirty = JSON.stringify(list) !== before;
    }

    /** Active focus entries (only those above the current level). */
    private activeFocus(): DrillFocus[] {
        const lvl = this.model?.level || this.lastLevel;
        return lvl ? this.focus.filter(f => LEVEL_ORDER[f.level] < LEVEL_ORDER[lvl]) : [];
    }

    private persistFocus(list: DrillFocus[]): void {
        this.focus = list;
        this.pendingFocusJson = list.length ? JSON.stringify(list) : "";
        this.pendingFocusT = Date.now();
        this.host.persistProperties({ merge: [{ objectName: "drillState", selector: undefined as any, properties: { focus: list.length ? JSON.stringify(list) : "" } }] });
    }

    /** Remember the current selection as a candidate focus for the next drill down. */
    private get filterMode(): boolean {
        return this.formattingSettings?.selectionCard.interaction.value.value !== "highlight";
    }

    /** Points currently "selected" by the user: filter labels (filter mode) or Power BI selection (highlight mode). */
    private currentSelection(): DataPoint[] {
        const model = this.model;
        if (!model) return [];
        if (this.filterMode) return model.allRows.filter(p => this.filterLabels.has(p.label));
        return this.selectedPoints();
    }

    /** Remember the current selection as the focus for the next drill down. */
    private recordSelection(): void {
        const model = this.model;
        if (!model || model.level === "point") { this.pendingSel = null; return; }
        const pts = this.currentSelection();
        if (!pts.length) { this.pendingSel = null; return; }
        const level = model.level as "continent" | "country" | "district" | "city";
        const keys = [...new Set(pts.map(p => level === "continent" ? p.continent!.name : level === "country" ? p.country!.iso3
            : level === "district" ? p.district!.cc + ":" + p.district!.index : normalize(p.label)))];
        this.pendingSel = {
            level, keys,
            labels: [...new Set(pts.map(p => p.label))],
            pts: level === "city" ? pts.map(p => p.point!).filter(Boolean) : undefined,
            target: this.leafTarget || undefined,
            values: [...new Set(pts.map(p => (p.raw ?? p.label) as any))],
            cvalues: this.groupValues(pts),
            tuples: this.tuplesOf(pts)
        };
    }

    /** Filter target (table/column or hierarchy level) of a category column, for page filters. */
    private targetOf(col: DataViewCategoryColumn): any {
        const src: any = col.source;
        const expr: any = src.expr;
        try {
            if (expr && expr.level !== undefined && expr.arg && expr.arg.hierarchy) {
                const ent = expr.arg.arg?.source?.entity ?? expr.arg.arg?.entity;
                if (ent) return { table: ent, hierarchy: expr.arg.hierarchy, hierarchyLevel: expr.level };
            }
            if (expr && expr.ref !== undefined && expr.source?.entity) return { table: expr.source.entity, column: expr.ref };
        } catch { /* fall through */ }
        const q: string = src.queryName || "";
        const i = q.indexOf(".");
        return i > 0 ? { table: q.slice(0, i), column: q.slice(i + 1) } : null;
    }

    /** Filter mode: focus levels + current-level selection become page filters (like a slicer). */
    private buildPageFilters(): any[] {
        const filters: any[] = [];
        if (!this.model) return filters;
        if (this.filterMode) {
            // one filter set for the location: the selection (always inside the focus) replaces the focus of the same columns
            const sel = this.filterLabels.size ? this.model.allRows.filter(p => this.filterLabels.has(p.label)) : [];
            const leafKey = this.leafTarget ? JSON.stringify(this.leafTarget) : "";
            let locFilters: any[] = [];
            for (const f of this.activeFocus()) {
                if (!f.target || !f.values || !f.values.length) continue;
                if (JSON.stringify(f.target) === leafKey) locFilters = this.locationFilters(f.values, f.cvalues || [], f.tuples || [], !!f.countryOnly);
                else filters.push(new BasicFilter(f.target, "In", f.values).toJSON());
            }
            if (sel.length) {
                // whole countries only when every selected row is placed in one (rows from the "not found" list filter exactly)
                const countryLevel = this.model.level === "city" && this.model.view === "country" && sel.every(p => !!p.country && !p.countryOnly);
                locFilters = this.locationFilters([...new Set(sel.map(p => (p.raw ?? p.label) as any))], this.groupValues(sel), this.tuplesOf(sel), countryLevel);
            }
            filters.push(...locFilters);
        }
        return filters;
    }

    /** (country, location) pairs of rows, for an exact multi-column filter. */
    private tuplesOf(rows: DataPoint[]): [any, any][] {
        const seen = new Set<string>(), out: [any, any][] = [];
        for (const r of rows) {
            if (r.groupRaw === undefined) continue;
            const k = String(r.groupRaw) + "\u0001" + String(r.raw ?? r.label);
            if (!seen.has(k)) { seen.add(k); out.push([r.groupRaw, r.raw ?? r.label]); }
        }
        return out;
    }

    /** Page filters for a set of locations. With the Country column, the filter is exact: whole countries filter the
     *  country column only; locations of one country filter country + location; several countries use (country, location) pairs,
     *  so "OLEIROS" of Spain never brings Oleiros of Portugal along. */
    private locationFilters(values: any[], cvalues: any[], tuples: [any, any][], countryLevel: boolean): any[] {
        const g = this.groupTarget, l = this.leafTarget;
        if (g && cvalues.length && countryLevel) return [new BasicFilter(g, "In", cvalues).toJSON()];
        if (g && cvalues.length === 1 && l) return [new BasicFilter(g, "In", cvalues).toJSON(), new BasicFilter(l, "In", values).toJSON()];
        if (g && tuples.length && l && g.column !== undefined && l.column !== undefined) {
            return [new TupleFilter([g, l], "In", tuples.map(([a, b]) => [{ value: a }, { value: b }]) as any).toJSON()];
        }
        if (g && cvalues.length && l) return [new BasicFilter(g, "In", cvalues).toJSON(), new BasicFilter(l, "In", values).toJSON()];
        return l && values.length ? [new BasicFilter(l, "In", values).toJSON()] : [];
    }

    /** Comparable signature of the location filters in a filter list (own change vs. Power BI echo). */
    private locationSig(list: any[]): string {
        const keys = [this.leafTarget, this.groupTarget].filter(Boolean).map(t => JSON.stringify([t.table, t.column ?? t.hierarchyLevel]));
        const tk = (t: any) => JSON.stringify([t.table, t.column ?? t.hierarchyLevel]);
        const parts: string[] = [];
        for (const f of list || []) {
            if (!f || !f.target) continue;
            const targets = Array.isArray(f.target) ? f.target : [f.target];
            if (!targets.some((t: any) => keys.includes(tk(t)))) continue;
            const vals = (f.values || []).map((v: any) => Array.isArray(v) ? v.map((x: any) => String(x && typeof x === "object" ? x.value : x)).join("\u0002") : String(v)).sort();
            parts.push(targets.map(tk).join("+") + "=" + vals.join("\u0001"));
        }
        return parts.sort().join("|");
    }

    /** Country grouping values of some rows (raw values of that column). */
    private groupValues(rows: DataPoint[]): (string | number | boolean)[] {
        return [...new Set(rows.map(r => r.groupRaw).filter(v => v !== undefined && v !== null) as (string | number | boolean)[])];
    }

    private applyPageFilter(): void {
        if (!this.interactive || !this.model) return;
        const filters = this.buildPageFilters();
        const json = JSON.stringify(filters);
        if (json === this.lastFilterJson) return;
        this.lastFilterJson = json;
        this.ownFilter = { key: this.locationSig(filters), t: Date.now() };
        if (filters.length) this.host.applyJsonFilter(filters.length === 1 ? filters[0] : filters, "general", "filter", 0 /* merge */);
        else this.host.applyJsonFilter(null as any, "general", "filter", 1 /* remove */);
    }

    /** Sync slicers / restored report state: adopt the filter Power BI hands back for the current level column. */
    private syncFromJsonFilters(jsonFilters: any[] | undefined): void {
        const model = this.model;
        if (!model || !this.filterMode || !this.leafTarget || !Array.isArray(jsonFilters)) return;
        const incomingSig = this.locationSig(jsonFilters);
        // our own change is still on its way: an older filter state arriving now must not come back
        if (this.ownFilter) {
            if (incomingSig === this.ownFilter.key || Date.now() - this.ownFilter.t > 4000) this.ownFilter = null;
            return;
        }
        const tk = (t: any) => t ? JSON.stringify([t.table, t.column ?? t.hierarchyLevel]) : "";
        const lk = tk(this.leafTarget), gk = tk(this.groupTarget);
        const leafF = jsonFilters.filter(f => f && f.target && !Array.isArray(f.target) && tk(f.target) === lk).pop();
        const groupF = gk ? jsonFilters.filter(f => f && f.target && !Array.isArray(f.target) && tk(f.target) === gk).pop() : null;
        const tupleF = jsonFilters.filter(f => f && Array.isArray(f.target) && f.target.some((t: any) => tk(t) === lk)).pop();
        const str = (v: any) => String(v && typeof v === "object" ? v.value : v);
        let labels: string[];
        // the location filter of the drill focus alone (no selection inside it)
        const focus = this.activeFocus().filter(f => f.target && tk(f.target) === lk && f.values && f.values.length).pop();
        const focusSig = focus ? this.locationSig(this.locationFilters(focus.values!, focus.cvalues || [], focus.tuples || [], !!focus.countryOnly)) : null;
        if (focusSig !== null && incomingSig === focusSig) labels = [];
        else if (tupleF) {
            const order = (tupleF.target as any[]).map(t => tk(t));
            const gi = order.indexOf(gk), li = order.indexOf(lk);
            const set = new Set((tupleF.values || []).map((tp: any[]) => str(tp[gi]) + "\u0001" + str(tp[li])));
            labels = model.allRows.filter(p => set.has(String(p.groupRaw) + "\u0001" + String(p.raw ?? p.label))).map(p => p.label);
        } else if (leafF || groupF) {
            const vals = leafF ? new Set((leafF.values || []).map((v: any) => String(v))) : null;
            const gvals = groupF ? new Set((groupF.values || []).map((v: any) => String(v))) : null;
            labels = model.allRows.filter(p => (!vals || vals.has(String(p.raw ?? p.label))) && (!gvals || gvals.has(String(p.groupRaw)))).map(p => p.label);
        } else if (this.lastFilterJson && this.lastFilterJson !== "[]" && jsonFilters.length === 0) {
            labels = []; // cleared from a synced slicer
        } else return;
        const cur = this.filterLabels;
        if (labels.length === cur.size && labels.every(l => cur.has(l))) return;
        this.filterLabels = new Set(labels);
        this.lastFilterJson = JSON.stringify(this.buildPageFilters()); // adopted, not re-applied
        this.recordSelection();
        this.persistSel();
    }

    private persistSel(): void {
        const json = this.filterLabels.size && this.model ? JSON.stringify({ level: this.model.level, labels: [...this.filterLabels] }) : "";
        if (json === this.persistedSelJson) return;
        this.persistedSelJson = json;
        this.pendingSelEcho = { json, t: Date.now() };
        this.host.persistProperties({ merge: [{ objectName: "drillState", selector: undefined as any, properties: { sel: json } }] });
    }

    /** Filter mode selection change (click / Shift+click / zones / clear). */
    private setFilterLabels(next: Set<string>): void {
        this.filterLabels = next;
        this.recordSelection();
        this.persistSel();
        this.applyPageFilter();
        this.applySelectionStyles();
        this.updateDrillUi();
    }

    private toggleFilter(labels: string[], multi: boolean): void {
        if (!this.interactive) return;
        const cur = this.filterLabels;
        let next: Set<string>;
        if (multi) {
            next = new Set(cur);
            // a municipality toggles as a whole: all its rows on, or all off when already fully selected
            const allOn = labels.every(l => next.has(l));
            labels.forEach(l => { if (allOn) next.delete(l); else next.add(l); });
        } else {
            const same = cur.size === labels.length && labels.every(l => cur.has(l));
            next = same ? new Set() : new Set(labels);
        }
        this.setFilterLabels(next);
    }

    /** Click on a mark: filter (default) or Power BI highlight. */
    private onMarkClick(e: MouseEvent | KeyboardEvent, d: DataPoint, id: ISelectionId): void {
        e.stopPropagation();
        if (this.drawing) return;
        const multi = e.ctrlKey || e.metaKey || e.shiftKey;
        const rs = rowsOf(d);
        if (this.filterMode) this.toggleFilter(rs.map(r => r.label), multi);
        else this.selectIds(d.members ? rs.map(r => r.selectionId) : [id], multi);
    }

    /** Clear everything the user picked inside the visual (selection, filter, zones). */
    private clearAll(): void {
        if (this.searchApplied && this.searchInput && String(this.searchInput.property("value") || "")) { this.searchInput.property("value", ""); this.searchCount.text(""); }
        this.searchApplied = false;
        this.zones = [];
        this.renderZones();
        if (this.filterMode) this.setFilterLabels(new Set());
        else this.selectionManager.clear().then(() => { this.recordSelection(); this.applySelectionStyles(); this.updateDrillUi(); });
    }

    private selectedPoints(): DataPoint[] {
        const model = this.model;
        if (!model) return [];
        const selected = (this.selectionManager.getSelectionIds() as ISelectionId[]) || [];
        if (!selected.length) return [];
        return model.allRows.filter(d => selected.some(s => s.equals(d.selectionId)) || d.slices.some(sl => selected.some(s => s.equals(sl.selectionId))));
    }

    // ---- zone (lasso) selection ---------------------------------------------------------------

    private setDrawing(on: boolean): void {
        if (!this.interactive) on = false;
        this.drawing = on;
        this.drawPts = [];
        this.svg.classed("gdm-drawing", on);
        if (on) this.svg.on(".zoom", null);
        else if (this.formattingSettings?.mapCard.enableZoom.value) this.svg.call(this.zoom).on("dblclick.zoom", null);
        this.renderZones();
        this.updateDrillUi();
    }

    private pointerXY(e: MouseEvent): [number, number] {
        const r = (this.svg.node() as SVGSVGElement).getBoundingClientRect();
        return [e.clientX - r.left, e.clientY - r.top];
    }

    private drawStart(e: PointerEvent): void {
        if (!this.drawing || e.button !== 0) return;
        e.preventDefault(); e.stopPropagation();
        this.drawPts = [this.pointerXY(e)];
        try { (this.svg.node() as SVGSVGElement).setPointerCapture(e.pointerId); } catch { /* not supported */ }
        this.renderZones();
    }

    private drawMove(e: PointerEvent): void {
        if (!this.drawing || !this.drawPts.length) return;
        const p = this.pointerXY(e);
        const last = this.drawPts[this.drawPts.length - 1];
        if (Math.hypot(p[0] - last[0], p[1] - last[1]) < 3) return;
        this.drawPts.push(p);
        this.renderZones();
    }

    private drawEnd(e: PointerEvent): void {
        if (!this.drawing || !this.drawPts.length) return;
        e.stopPropagation();
        const pts = this.drawPts;
        this.drawPts = [];
        this.lastDrawEnd = Date.now();
        if (pts.length >= 3 && this.projection?.invert) {
            const ll = pts.map(p => this.projection.invert!(this.transform.invert(p))).filter(x => !!x && isFinite(x[0]) && isFinite(x[1])) as [number, number][];
            if (ll.length >= 3) { this.zones.push(ll); this.zoneLevel = this.model?.level || null; }
        }
        this.setDrawing(false);
        this.selectZones();
    }

    private zoneScreenPolys(): [number, number][][] {
        if (!this.projection) return [];
        return this.zones.map(z => z.map(ll => {
            const p = this.projection(ll);
            return p ? this.transform.apply(p) as [number, number] : [NaN, NaN] as [number, number];
        }).filter(p => isFinite(p[0])));
    }

    private renderZones(): void {
        if (!this.gZones) return;
        const polys = this.zoneScreenPolys().filter(p => p.length >= 3).map(p => ({ pts: p, live: false }));
        if (this.drawPts.length > 1) polys.push({ pts: this.drawPts, live: true });
        this.gZones.selectAll<SVGPolygonElement, any>("polygon").data(polys).join("polygon")
            .attr("points", d => d.pts.map(p => `${p[0]},${p[1]}`).join(" "))
            .classed("gdm-zone", true)
            .classed("gdm-zone-live", d => d.live);
        this.clearZoneBtn?.style("display", this.zones.length ? null : "none");
    }

    /** Select every data point whose anchor lies inside any drawn zone (union of zones). */
    private selectZones(): void {
        const model = this.model;
        if (!model) return;
        const polys = this.zoneScreenPolys().filter(p => p.length >= 3);
        const ids: ISelectionId[] = [];
        for (const d of model.points) {
            const anchor = d.point ? this.projection(d.point) : null;
            if (!anchor) continue;
            const xy = this.transform.apply(anchor) as [number, number];
            if (polys.some(poly => d3.polygonContains(poly, xy))) for (const r of rowsOf(d)) ids.push(r.selectionId);
        }
        if (this.filterMode) {
            const labels = model.allRows.filter(d => ids.includes(d.selectionId)).map(d => d.label);
            this.setFilterLabels(new Set(labels));
        } else {
            const p = ids.length ? this.selectionManager.select(ids, false) : this.selectionManager.clear();
            p.then(() => { this.recordSelection(); this.applySelectionStyles(); this.updateDrillUi(); });
        }
        this.renderZones();
    }

    private updateDrillUi(): void {
        this.updateSearchUi();
        this.updateDrillUiInner();
        this.layoutTopBar();
    }

    private updateDrillUiInner(): void {
        this.renderViewToggle();
        const active = this.activeFocus();
        this.clearZoneBtn?.style("display", this.zones.length ? null : "none");
        this.drawBtn?.classed("gdm-active", this.drawing);
        const chip = this.focusChip;
        chip.selectAll("*").remove();
        const sel = this.selectedDisplayLabels();
        const parts = (active.length ? 1 : 0) + (sel.length || this.zones.length ? 1 : 0);
        this.chipList?.style("display", "none");
        if (!parts) { chip.style("display", "none"); return; }
        chip.style("display", null);
        const short = (l: string[]) => l.slice(0, 3).join(", ");
        // "+N" opens the full list of what is filtered
        const more = (g: d3.Selection<HTMLSpanElement, unknown, null, undefined>, all: string[], title: string) => {
            g.attr("title", all.join(", "));
            if (all.length <= 3) return;
            g.append("button").classed("gdm-chip-more", true).text(`+${all.length - 3}`)
                .attr("aria-label", this.tr("Rt_ShowAll", "Show all"))
                .on("click", (e: MouseEvent) => { e.stopPropagation(); this.toggleChipList(title, all); });
        };
        if (active.length) {
            const g = chip.append("span").classed("gdm-chip-part", true);
            const labels = active.map(f => f.labels).reduce((a, b) => a.concat(b), [] as string[]);
            g.append("span").text(this.tr("Rt_Level", "Level: {0}", active.map(f => short(f.labels)).join(" › ")));
            more(g, labels, this.tr("Rt_Level", "Level: {0}", ""));
            if (this.interactive) g.append("button").attr("title", this.tr("Rt_ShowAllLevel", "Show all at this level")).attr("aria-label", this.tr("Rt_ShowAllLevel", "Show all at this level")).text("✕")
                .on("click", (e: MouseEvent) => {
                    e.stopPropagation();
                    this.pendingSel = null;
                    const removed = active[active.length - 1];
                    this.persistFocus(this.focus.filter(f => f !== removed));
                    this.rerender();
                    this.lastFilterJson = "?";
                    this.applyPageFilter();
                });
        }
        if (sel.length || this.zones.length) {
            const g = chip.append("span").classed("gdm-chip-part gdm-chip-filter", true);
            const what = this.filterMode ? this.tr("Rt_Filter", "Filter") : this.tr("Rt_Selection", "Selection");
            const z = this.zones.length ? " · ✎ " + (this.zones.length === 1 ? this.tr("Rt_Zone1", "1 zone") : this.tr("Rt_ZoneN", "{0} zones", this.zones.length)) : "";
            g.append("span").text(`${what}: ${sel.length ? short(sel) : "—"}${z}`);
            more(g, sel, what);
            if (this.interactive) g.append("button").attr("title", this.tr("Rt_ClearAll", "Clear selection, filter and zones")).attr("aria-label", this.tr("Rt_ClearAll", "Clear selection, filter and zones")).text("✕")
                .on("click", (e: MouseEvent) => { e.stopPropagation(); this.clearAll(); });
        }
    }

    private placeAreaCache = new WeakMap<CityInfo, string>();
    private chipListKey = "";
    /** Panel under the chip with every filtered / focused name. */
    private toggleChipList(title: string, all: string[]): void {
        const key = title + "|" + all.join("|");
        let panel = this.chipList;
        if (panel && this.chipListKey === key && panel.style("display") !== "none") { panel.style("display", "none"); return; }
        if (!panel) {
            panel = this.chipList = d3.select(this.focusChip.node()!.parentElement as HTMLDivElement).append("div").classed("gdm-chiplist", true)
                .on("click", (e: MouseEvent) => e.stopPropagation()).on("wheel", (e: WheelEvent) => e.stopPropagation());
        }
        this.chipListKey = key;
        panel.selectAll("*").remove();
        panel.append("div").classed("gdm-chiplist-head", true).text(`${title.replace(/:\s*$/, "")} (${all.length})`);
        panel.append("div").classed("gdm-chiplist-body", true).selectAll("div").data(all.slice().sort((a, b) => a.localeCompare(b))).join("div").text(d => d);
        const cr = this.focusChip.node()!.getBoundingClientRect(), wr = (this.focusChip.node()!.parentElement as HTMLElement).getBoundingClientRect();
        panel.style("display", null).style("left", `${cr.left - wr.left}px`).style("top", `${cr.bottom - wr.top + 4}px`);
    }

    /** Chip and view buttons share the top edge: on a narrow visual the chip moves below the buttons. */
    private layoutTopBar(): void {
        const chip = this.focusChip.node(), tg = this.viewToggle.node(), sb = this.searchBox?.node();
        if (!chip || !tg) return;
        const wr = (chip.parentElement as HTMLElement).getBoundingClientRect();
        const shown = (el: HTMLElement | null | undefined) => !!el && el.style.display !== "none";
        const overlaps = (a: DOMRect, b: DOMRect) => a.right + 6 > b.left && a.left < b.right + 6 && a.bottom + 4 > b.top && a.top < b.bottom + 4;
        // search box first (top-left), the chip below it; both move below the view buttons when they would overlap them
        let top = 6;
        if (shown(sb)) {
            sb!.style.top = "6px";
            if (shown(tg) && overlaps(sb!.getBoundingClientRect(), tg.getBoundingClientRect())) sb!.style.top = `${tg.getBoundingClientRect().bottom - wr.top + 6}px`;
            top = sb!.getBoundingClientRect().bottom - wr.top + 6;
        }
        chip.style.top = `${top}px`;
        if (!shown(chip) || !shown(tg)) return;
        if (overlaps(chip.getBoundingClientRect(), tg.getBoundingClientRect())) chip.style.top = `${tg.getBoundingClientRect().bottom - wr.top + 6}px`;
    }

    // ---- search box ---------------------------------------------------------------------------

    private buildSearch(parent: d3.Selection<HTMLDivElement, unknown, null, undefined>): void {
        const box = this.searchBox = parent.append("div").classed("gdm-search", true).style("display", "none");
        box.on("click", (e: MouseEvent) => e.stopPropagation()).on("dblclick", (e: MouseEvent) => e.stopPropagation())
            .on("wheel", (e: WheelEvent) => e.stopPropagation()).on("pointerdown", (e: PointerEvent) => e.stopPropagation());
        const scopes: [string, string, string][] = [
            ["all", "Opt_Scope_All", "All"], ["country", "Opt_Scope_Country", "Country"],
            ["district", "Opt_Scope_District", "District / region"], ["municipality", "Opt_Scope_Municipality", "Municipality"]
        ];
        this.searchScope = box.append("select").classed("gdm-search-scope", true).attr("aria-label", this.tr("Rt_Search_Scope", "Search in"))
            .attr("title", this.tr("Rt_Search_Scope", "Search in"));
        this.searchScope.selectAll("option").data(scopes).join("option").attr("value", d => d[0]).text(d => this.tr(d[1], d[2]));
        const ops: [string, string, string][] = [
            ["contains", "Rt_Search_Contains", "Contains"], ["notContains", "Rt_Search_NotContains", "Does not contain"],
            ["startsWith", "Rt_Search_StartsWith", "Starts with"], ["endsWith", "Rt_Search_EndsWith", "Ends with"], ["equals", "Rt_Search_Equals", "Is"]
        ];
        this.searchOp = box.append("select").classed("gdm-search-op", true).attr("aria-label", this.tr("Rt_Search_Op", "Search operator"));
        this.searchOp.selectAll("option").data(ops).join("option").attr("value", d => d[0]).text(d => this.tr(d[1], d[2]));
        this.searchInput = box.append("input").classed("gdm-search-input", true).attr("type", "search")
            .attr("placeholder", this.tr("Rt_Search_Placeholder", "Search… (Enter)")).attr("aria-label", this.tr("Rt_Search_Placeholder", "Search… (Enter)"));
        this.searchCount = box.append("span").classed("gdm-search-count", true);
        // typing only previews how many locations match; Enter applies the filter / selection
        const preview = () => {
            if (this.searchTimer !== null) window.clearTimeout(this.searchTimer);
            this.searchTimer = window.setTimeout(() => { this.searchTimer = null; this.runSearch(false); }, 200);
        };
        this.searchInput.on("input", preview)
            .on("search", () => { if (!String(this.searchInput.property("value") || "")) this.runSearch(true); }) // the ✕ of the search field
            .on("keydown", (e: KeyboardEvent) => {
                e.stopPropagation();
                if (e.key === "Enter") { if (this.searchTimer !== null) window.clearTimeout(this.searchTimer); this.searchTimer = null; this.runSearch(true); }
                if (e.key === "Escape") { (e.target as HTMLInputElement).value = ""; this.runSearch(true); }
            });
        this.searchOp.on("change", () => this.runSearch(false)).on("keydown", (e: KeyboardEvent) => { e.stopPropagation(); if (e.key === "Enter") this.runSearch(true); });
        this.searchScope.on("change", () => { this.searchScopeTouched = true; this.runSearch(false); })
            .on("keydown", (e: KeyboardEvent) => { e.stopPropagation(); if (e.key === "Enter") this.runSearch(true); });
    }

    private updateSearchUi(): void {
        const sc = this.formattingSettings.selectionCard;
        const on = !!this.model && this.interactive && sc.showSearch.value;
        this.searchBox.style("display", on ? null : "none");
        // the default scope comes from the format pane until the user picks one on the map
        if (!this.searchScopeTouched) this.searchScope.property("value", String(sc.searchScope.value.value || "all"));
    }

    /** Names a data row can be found by, per search scope. */
    private searchNames(r: DataPoint, scope: string): string[] {
        const out: string[] = [];
        const geo = this.geo;
        if (scope === "all" || scope === "country") {
            if (r.country) out.push(r.country.nameEN, r.country.namePT, r.country.iso2, r.country.iso3);
            if (r.groupRaw !== undefined && r.groupRaw !== null) out.push(String(r.groupRaw));
        }
        if (scope === "all" || scope === "district") {
            const m = r.muniRef;
            const d = r.district || (m && geo ? geo.districtsOf(m.cc)[m.district] : undefined);
            if (d) out.push(d.name, ...d.names);
        }
        if (scope === "all" || scope === "municipality") {
            const m = r.muniRef;
            if (m && m.kind === "m") out.push(m.name, ...m.aliases);
        }
        if (scope === "all") out.push(r.label);
        return out.filter(n => !!n);
    }

    /** Finds the data locations whose country / district / municipality / name matches the search.
     *  apply = false only previews the number of matches; apply = true (Enter) filters or selects them. */
    private runSearch(apply: boolean): void {
        const model = this.model;
        if (!model || !this.interactive) return;
        const term = this.searchKey(String(this.searchInput.property("value") || ""));
        const op = String(this.searchOp.property("value") || "contains");
        const scope = String(this.searchScope.property("value") || "all");
        if (!term) {
            this.searchCount.text("");
            if (apply && this.searchApplied) {
                this.searchApplied = false; this.clearAll();
                if (this.formattingSettings?.mapCard.enableZoom.value) this.animateZoom(d3.zoomIdentity, 350);
            }
            return;
        }
        const hit = (k: string): boolean => {
            switch (op) {
                case "startsWith": return k.startsWith(term);
                case "endsWith": return k.endsWith(term);
                case "equals": return k === term;
                default: return k.includes(term);
            }
        };
        const rows = model.rows.filter(r => {
            const keys = this.searchNames(r, scope).map(n => this.searchKey(n));
            const any = keys.some(hit);
            return op === "notContains" ? !any : any;
        });
        this.searchCount.text(String(rows.length)).classed("gdm-search-pending", !apply)
            .attr("title", apply ? null : this.tr("Rt_Search_PressEnter", "Press Enter to filter"));
        if (!apply) return;
        this.searchApplied = true;
        if (this.filterMode) this.setFilterLabels(new Set(rows.map(r => r.label)));
        else {
            const ids = rows.map(r => r.selectionId);
            const p = ids.length ? this.selectionManager.select(ids, false) : this.selectionManager.clear();
            p.then(() => { this.recordSelection(); this.applySelectionStyles(); this.updateDrillUi(); });
        }
        // the map follows the search: zoom onto what was found
        this.zoomToRows(rows);
    }

    /** accent- and case-insensitive text for searching */
    private searchKey(s: string): string {
        return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
    }

    /** Countries ⇄ districts ⇄ municipalities at the city level.
     *  Going to municipalities with districts selected drills into them (the selection becomes the level focus). */
    private switchView(v: "country" | "district" | "municipality"): void {
        const model = this.model;
        if (!model || model.level !== "city" || model.view === v || !this.interactive) return;
        let focus = this.focus.slice();
        // Europe map: a country focus made by the view buttons (the selected countries)
        const viewCountry = (f: DrillFocus) => f.level === "country" && !!f.view;
        if (v === "country") {
            focus = focus.filter(f => f.level !== "district" && !viewCountry(f));
        } else if (model.view === "country") {
            const sel = this.currentSelection().filter(r => r.country);
            const cs = [...new Map(sel.map(r => [r.country!.iso3, r.country!])).values()];
            if (cs.length) {
                const keys = new Set(cs.map(c => c.iso3));
                const rows = model.rows.filter(r => r.country && keys.has(r.country.iso3));
                focus = focus.filter(f => f.level !== "district" && !viewCountry(f)).concat([{
                    level: "country", view: true, keys: [...keys], labels: cs.map(c => this.countryName(c)), countryOnly: true,
                    // with the Country column the focus is just the countries (keeps the stored state small)
                    target: this.leafTarget || undefined, values: this.groupTarget ? ["*"] : [...new Set(rows.map(r => (r.raw ?? r.label) as any))], cvalues: this.groupValues(rows)
                }]);
            }
        } else if (v === "municipality") {
            const sel = this.currentSelection();
            const keys = [...new Set(sel.filter(r => r.muniRef).map(r => r.muniRef!.cc + ":" + r.muniRef!.district))];
            if (keys.length) {
                const ds = keys.map(k => { const [cc, ix] = k.split(":"); return this.geo!.districtsOf(cc)[+ix]; }).filter(Boolean);
                const inSel = new Set(keys);
                const rows = model.rows.filter(r => r.muniRef && inSel.has(r.muniRef.cc + ":" + r.muniRef.district));
                focus = focus.filter(f => f.level !== "district").concat([{
                    level: "district", keys, labels: ds.map(d => d.name),
                    target: this.leafTarget || undefined, values: [...new Set(rows.map(r => (r.raw ?? r.label) as any))], cvalues: this.groupValues(rows),
                    tuples: this.groupValues(rows).length > 1 ? this.tuplesOf(rows) : undefined
                }]);
            }
        } else {
            focus = focus.filter(f => f.level !== "district");
        }
        this.cityView = v;
        this.zones = [];
        this.filterLabels = new Set();
        this.pendingSel = null;
        this.persistSel();
        if (JSON.stringify(focus) !== JSON.stringify(this.focus)) this.persistFocus(focus);
        this.host.tooltipService.hide({ immediately: true, isTouchEvent: false });
        this.rerender();
        this.lastFilterJson = "?";
        this.applyPageFilter();
    }

    /** Europe map: municipalities are offered for one selected country, selected districts, or a data set of one country. */
    private canShowMunicipalities(): boolean {
        const model = this.model, geo = this.geo;
        if (!model || !geo) return false;
        if (model.view === "municipality") return true;
        const sel = this.currentSelection();
        if (sel.length) {
            if (model.view === "country") {
                const ccs = new Set(sel.map(r => r.country?.iso2).filter(Boolean) as string[]);
                return ccs.size === 1 && geo.hasMunicipalities([...ccs][0]);
            }
            return sel.every(r => r.muniRef && geo.hasMunicipalities(r.muniRef.cc));
        }
        return !!this.municipalityScope(model.rows, model.districtFocus);
    }

    private renderViewToggle(): void {
        const model = this.model;
        const show = !!model && model.level === "city" && !!model.view && this.interactive;
        this.viewToggle.style("display", show ? null : "none");
        if (!show) return;
        const btns: { v: "country" | "district" | "municipality"; t: string }[] = [
            { v: "country", t: this.tr("Rt_ViewCountries", "Countries") },
            { v: "district", t: this.tr("Rt_ViewDistrictsW", "Districts / regions") },
            ...(this.canShowMunicipalities() ? [{ v: "municipality" as const, t: this.tr("Rt_ViewMunicipalities", "Municipalities") }] : [])
        ];
        this.viewToggle.selectAll<HTMLButtonElement, any>("button").data(btns, (d: any) => d.v).join("button")
            .classed("gdm-viewbtn", true)
            .classed("gdm-active", d => model!.view === d.v)
            .attr("aria-pressed", d => String(model!.view === d.v))
            .attr("title", d => d.v === "municipality" ? this.tr("Rt_ViewMunicipalities_Tip", "Show municipalities (of the selected districts, if any)") : d.t)
            .text(d => d.t)
            .on("click", (e: MouseEvent, d) => { e.stopPropagation(); this.switchView(d.v); });
    }

    /** Names shown in the filter chip: the rendered items (municipality names) that hold selected rows. */
    private selectedDisplayLabels(): string[] {
        const model = this.model;
        if (!model) return [];
        const rows = new Set(this.currentSelection());
        if (!rows.size) return this.filterMode ? [...this.filterLabels] : [];
        const out: string[] = [];
        for (const p of model.points) if (rowsOf(p).some(r => rows.has(r))) out.push(p.label);
        return out.length ? [...new Set(out)] : [...rows].map(r => r.label);
    }

    private get interactive(): boolean {
        return this.host.hostCapabilities?.allowInteractions !== false;
    }

    private selectIds(ids: ISelectionId[], multi: boolean): void {
        if (!this.interactive) return;
        const current = this.selectionManager.getSelectionIds() as ISelectionId[];
        const same = !multi && current.length === ids.length && ids.every(id => current.some(c => c.equals(id)));
        const p = same ? this.selectionManager.clear() : this.selectionManager.select(ids, multi);
        p.then(() => { this.recordSelection(); this.applySelectionStyles(); this.updateDrillUi(); });
    }

    private applySelectionStyles(): void {
        const model = this.model;
        if (!model) return;
        this.markUnmatchedSelection();
        const fm = this.filterMode;
        const fset = this.filterLabels;
        const selected = fm ? [] : ((this.selectionManager.getSelectionIds() as ISelectionId[]) || []);
        const hasSel = fm ? fset.size > 0 : selected.length > 0;
        const isSel = (id: ISelectionId) => selected.some(s => s.equals(id));
        const rowSel = (r: DataPoint) => isSel(r.selectionId) || r.slices.some(sl => isSel(sl.selectionId));
        const dpActive = (d: DataPoint) => (fm
            ? (!hasSel || rowsOf(d).some(r => fset.has(r.label)))
            : (!hasSel || rowsOf(d).some(rowSel) || model.legendItems.some(li => isSel(li.selectionId) && d.slices.some(sl => sl.name === li.name))))
            && (!model.hasHighlights || d.highlighted);
        const sliceActive = (sl: SliceDatum) => (fm
            ? (!hasSel || (!!sl.parent && rowsOf(sl.parent).some(r => fset.has(r.label))))
            : (!hasSel || isSel(sl.selectionId) || (sl.parent && isSel(sl.parent.selectionId)) || model.legendItems.some(li => li.name === sl.name && isSel(li.selectionId))))
            && (!model.hasHighlights || (sl.parent ? sl.parent.highlighted : true));
        const st = this.formattingSettings;
        const DIM_OPACITY = st.selectionCard.dimOpacity.value / 100;
        const hc = this.host.colorPalette.isHighContrast;
        const selColor = hc ? this.host.colorPalette.foregroundSelected.value : st.selectionCard.selBorderColor.value.value;
        const selW = st.selectionCard.selBorderWidth.value;
        const borderColor = hc ? this.host.colorPalette.foreground.value : st.areaCard.borderColor.value.value;
        const borderW = st.areaCard.borderWidth.value;
        const bStroke = hc ? this.host.colorPalette.foreground.value : st.bubbleCard.bubbleBorderColor.value.value;
        const bStrokeW = st.bubbleCard.bubbleBorderWidth.value;
        const explicitlySel = (d: DataPoint) => hasSel && (fm ? rowsOf(d).some(r => fset.has(r.label)) : rowsOf(d).some(rowSel));
        const opacity = st.bubbleCard.bubbleOpacity.value / 100;
        const areas = this.gAreas.selectAll<SVGPathElement, DataPoint>("path.gdm-area")
            .attr("opacity", d => dpActive(d) ? 1 : DIM_OPACITY)
            .attr("stroke", d => explicitlySel(d) && selW > 0 ? selColor : borderColor)
            .attr("stroke-width", d => explicitlySel(d) && selW > 0 ? selW : borderW)
            .attr("stroke-opacity", d => explicitlySel(d) && selW > 0 ? 1 : (hc ? 1 : Math.max(0.05, Math.min(1, st.areaCard.lineIntensity.value / 100))));
        areas.filter(d => explicitlySel(d)).raise();
        this.gMarks.selectAll<SVGCircleElement, DataPoint>("circle.gdm-circle").attr("fill-opacity", d => dpActive(d) ? opacity : opacity * DIM_OPACITY)
            .attr("stroke-opacity", d => dpActive(d) ? 1 : DIM_OPACITY)
            .attr("stroke", d => explicitlySel(d) && selW > 0 ? selColor : bStroke)
            .attr("stroke-width", d => explicitlySel(d) && selW > 0 ? selW : bStrokeW);
        this.gMarks.selectAll<SVGPathElement, d3.PieArcDatum<SliceDatum>>("path.gdm-slice").attr("fill-opacity", d => sliceActive(d.data) ? opacity : opacity * DIM_OPACITY);
        this.gMarks.selectAll<SVGCircleElement, DataPoint>("circle.gdm-donut-outline")
            .attr("stroke", d => explicitlySel(d) && selW > 0 ? selColor : bStroke)
            .attr("stroke-width", d => explicitlySel(d) && selW > 0 ? selW : bStrokeW)
            .attr("stroke-opacity", d => dpActive(d) ? 1 : DIM_OPACITY);
        const legendSel = model.legendItems.map(li => !hasSel || isSel(li.selectionId) || model.rows.some(p => p.slices.some(sl => sl.name === li.name && isSel(sl.selectionId))));
        const legendActive = hasSel && legendSel.some(x => x) ? legendSel : model.legendItems.map(() => true);
        [this.legendTop, this.legendBottom].forEach(l => l.selectAll<HTMLSpanElement, unknown>(".gdm-legend-item").style("opacity", (_d, i) => legendActive[i] ? 1 : DIM_OPACITY));
    }

    // -----------------------------------------------------------------------------------------
    // Tooltips
    // -----------------------------------------------------------------------------------------

    private tooltipFor(d: DataPoint): VisualTooltipDataItem[] {
        const m = this.model!;
        if (d.muni || (d.district && d.members) || d.countryAgg) return this.tooltipForMunicipality(d);
        if (d.district) {
            const items: VisualTooltipDataItem[] = [{ displayName: m.locationName, value: d.label },
                { displayName: this.tr("Rt_District", "District / province"), value: `${d.district.name} (${d.district.cc})` }];
            if (m.hasColor) items.push({ displayName: m.colorName, value: formatExact(d.colorValue, d.colorFormat, this.locale) });
            if (m.hasSize && m.sizeName !== m.colorName) items.push({ displayName: m.sizeName, value: formatExact(d.sizeValue, d.sizeFormat, this.locale) });
            if (m.hasLegend) d.slices.slice(0, 12).forEach(sl => items.push({ displayName: sl.name, value: sl.displayValue, color: sl.color }));
            items.push(...d.tooltipExtras);
            return items;
        }
        const items: VisualTooltipDataItem[] = [{ displayName: m.locationName, value: d.label }];
        if (d.postalUsed && isPointish(d.level)) items.push({ displayName: this.tr("Rt_LocatedByPostal", "Located by postal code"), value: `${d.postalUsed}${d.country ? " (" + d.country.iso2 + ")" : ""}` });
        else if (d.city && isPointish(d.level)) items.push({ displayName: this.tr("Rt_Location", "Location"), value: `${d.city.name}, ${d.city.iso2}` });
        if (m.hasColor) items.push({ displayName: m.colorName, value: formatExact(d.colorValue, d.colorFormat, this.locale) });
        if (m.hasSize && m.sizeName !== m.colorName) items.push({ displayName: m.sizeName, value: formatExact(d.sizeValue, d.sizeFormat, this.locale) });
        if (m.hasLegend) d.slices.slice(0, 12).forEach(sl => items.push({ displayName: sl.name, value: sl.displayValue, color: sl.color }));
        items.push(...d.tooltipExtras);
        return items;
    }

    private hideNoData(): void {
        if (this.noDataKey === null) return;
        this.noDataKey = null;
        this.host.tooltipService.hide({ immediately: true, isTouchEvent: false });
    }

    /** Hover over a district / municipality without data: tooltip with its name (to know where there are no sales). */
    private noDataHover(e: MouseEvent): void {
        const m = this.model, geo = this.geo;
        const target = e.target as Element;
        if (!m || !geo || this.drawing || !geo.hasDistricts()) return;
        if (target && target.closest && target.closest(".gdm-mark")) { this.noDataKey = null; return; }
        const level = m.level;
        if (level !== "country" && level !== "district" && level !== "city") return this.hideNoData();
        const ll = this.projection && this.projection.invert ? this.projection.invert(this.transform.invert(this.pointerXY(e))) : null;
        if (!ll || !isFinite(ll[0]) || !isFinite(ll[1])) return this.hideNoData();
        let mu: MuniInfo | undefined;
        {
            const c = geo.countryAtFast(ll[0], ll[1]);
            if (!c) return this.hideNoData();
            if (level === "country" || m.view === "country") {
                if (m.points.some(p => p.country && p.country.iso3 === c.iso3)) return this.hideNoData();
                const key = "c:" + c.iso3;
                const args = { coordinates: this.coords(e), isTouchEvent: false, dataItems: [{ displayName: this.tr("Rt_Country", "Country"), value: this.countryName(c) }, { displayName: "", value: this.tr("Rt_NoData", "No data") }], identities: [] as ISelectionId[] };
                if (key !== this.noDataKey) { this.noDataKey = key; this.host.tooltipService.show(args); } else this.host.tooltipService.move(args);
                return;
            }
            // only countries shown with their areas
            if (m.muniCountries.indexOf(c.iso2) < 0 && level === "city") return this.hideNoData();
            mu = geo.findArea(c.iso2, ll as [number, number], true);
        }
        if (!mu) return this.hideNoData();
        const dist = geo.districtsOf(mu.cc)[mu.district];
        const noSales = { displayName: "", value: this.tr("Rt_NoData", "No data") };
        let key: string, items: VisualTooltipDataItem[];
        {
            if (m.districtFocus.length && dist && m.districtFocus.indexOf(dist) < 0) return this.hideNoData();
            const byDistrict = level === "district" || m.view === "district";
            if (byDistrict) {
                if (!dist || m.points.some(p => p.district === dist)) return this.hideNoData();
                key = `d:${mu.cc}:${mu.district}`;
                items = [{ displayName: this.tr("Rt_District", "District / province"), value: `${dist.name} (${dist.cc})` }, noSales];
            } else {
                if (m.points.some(p => p.muni === mu)) return this.hideNoData();
                key = `m:${mu.cc}:${mu.id}`;
                items = [{ displayName: this.tr("Rt_Municipality", "Municipality"), value: mu.parent ? `${mu.name} (${mu.parent})` : mu.name }];
                if (dist && dist.name !== mu.parent) items.push({ displayName: this.tr("Rt_District", "District / province"), value: `${dist.name} (${dist.cc})` });
                items.push(noSales);
            }
        }
        const args = { coordinates: this.coords(e), isTouchEvent: false, dataItems: items, identities: [] as ISelectionId[] };
        if (key !== this.noDataKey) { this.noDataKey = key; this.host.tooltipService.show(args); }
        else this.host.tooltipService.move(args);
    }

    private tooltipForMunicipality(d: DataPoint): VisualTooltipDataItem[] {
        const m = this.model!;
        const rs = d.members || [];
        const items: VisualTooltipDataItem[] = d.muni
            ? [{ displayName: this.tr("Rt_Municipality", "Municipality"), value: d.muni.parent ? `${d.muni.name} (${d.muni.parent})` : d.muni.name }]
            : d.countryAgg ? [{ displayName: this.tr("Rt_Country", "Country"), value: d.label }]
                : [{ displayName: this.tr("Rt_District", "District / province"), value: `${d.district!.name} (${d.district!.cc})` }];
        if (d.muni && d.muni.n > 1) items.push({ displayName: this.tr("Rt_Agglomerates", "Municipalities in this area"), value: String(d.muni.n) });
        if (m.hasColor) items.push({ displayName: m.colorName, value: formatExact(d.colorValue, d.colorFormat, this.locale) });
        if (m.hasSize && m.sizeName !== m.colorName) items.push({ displayName: m.sizeName, value: formatExact(d.sizeValue, d.sizeFormat, this.locale) });
        if (m.hasLegend) d.slices.slice(0, 12).forEach(sl => items.push({ displayName: sl.name, value: sl.displayValue, color: sl.color }));
        items.push({ displayName: this.tr("Rt_Localities", "Locations in the data"), value: String(rs.length) });
        const val = (r: DataPoint) => (m.hasColor ? r.colorValue : r.sizeValue) ?? 0;
        const TOP = 12;
        rs.slice().sort((a, b) => Math.abs(val(b)) - Math.abs(val(a))).slice(0, TOP).forEach(r =>
            items.push({ displayName: "· " + r.label, value: formatExact(m.hasColor ? r.colorValue : r.sizeValue, m.hasColor ? r.colorFormat : r.sizeFormat, this.locale) }));
        if (rs.length > TOP) items.push({ displayName: "·", value: this.tr("Rt_AndMore", "… and {0} more", rs.length - TOP) });
        items.push(...d.tooltipExtras);
        return items;
    }

    private tooltipForSlice(sl: SliceDatum): VisualTooltipDataItem[] {
        const m = this.model!;
        const d = sl.parent!;
        const total = d.slices.reduce((a, b) => a + b.value, 0);
        const share = total ? ` (${(sl.value / total * 100).toLocaleString(this.locale, { maximumFractionDigits: 1 })}%)` : "";
        const items: VisualTooltipDataItem[] = [
            { displayName: m.locationName, value: d.label },
            { displayName: m.legendTitle || this.tr("Rt_Detail", "Detail"), value: sl.name, color: sl.color },
            { displayName: m.hasSize ? m.sizeName : m.colorName, value: sl.displayValue + share }
        ];
        if (m.hasColor && m.hasSize) items.push({ displayName: `${m.colorName} (total)`, value: formatExact(d.colorValue, d.colorFormat, this.locale) });
        items.push(...d.tooltipExtras);
        return items;
    }

    private coords(e: MouseEvent): number[] {
        const r = this.root.getBoundingClientRect();
        return [e.clientX - r.left, e.clientY - r.top];
    }

    private showTooltip(e: MouseEvent, items: VisualTooltipDataItem[], ids: ISelectionId[]): void {
        this.host.tooltipService.show({ coordinates: this.coords(e), isTouchEvent: false, dataItems: items, identities: ids });
    }

    private moveTooltip(e: MouseEvent, items: VisualTooltipDataItem[], ids: ISelectionId[]): void {
        this.host.tooltipService.move({ coordinates: this.coords(e), isTouchEvent: false, dataItems: items, identities: ids });
    }

    // -----------------------------------------------------------------------------------------
    private showError(err: Error): void {
        this.landing.style("display", null);
        this.landing.selectAll("*").remove();
        this.landing.append("div").classed("gdm-error", true).text(this.tr("Rt_Error", "Error: {0}", err.message));
        if (err.stack) this.landing.append("pre").classed("gdm-error-stack", true).text(err.stack.split("\n").slice(0, 6).join("\n"));
    }
}
