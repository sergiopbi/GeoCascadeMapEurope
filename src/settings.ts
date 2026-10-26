"use strict";

import powerbi from "powerbi-visuals-api";
import { formattingSettings } from "powerbi-visuals-utils-formattingmodel";
import { dataViewWildcard } from "powerbi-visuals-utils-dataviewutils";

import Card = formattingSettings.SimpleCard;
import Model = formattingSettings.Model;
import Slice = formattingSettings.Slice;

// ---- localisation helpers --------------------------------------------------------------------
// displayName/description are the en-US fallback; the *Key fields are resolved through stringResources.
const t = (key: string, en: string) => ({ displayName: en, displayNameKey: key });
const d = (key: string, en: string) => ({ description: en, descriptionKey: key });
/** Dropdown options are plain strings (the format pane does not call display-name functions);
 *  they are translated once at start-up by localizeDropdownItems(). */
const ITEM_KEYS = new Map<powerbi.IEnumMember, { key: string; en: string }>();
const item = (value: string, key: string, en: string): powerbi.IEnumMember => {
    const it: powerbi.IEnumMember = { value, displayName: en };
    ITEM_KEYS.set(it, { key, en });
    return it;
};

/** Replace every dropdown option text with its localised string (en-US fallback). */
export function localizeDropdownItems(getText: (key: string, en: string) => string): void {
    ITEM_KEYS.forEach((k, it) => { (it as any).displayName = getText(k.key, k.en); });
}

const range = (a: number, b: number): powerbi.visuals.NumUpDownFormat => ({
    minValue: { type: 0 as powerbi.visuals.ValidatorType.Min, value: a } as powerbi.visuals.MinValidator<number>,
    maxValue: { type: 1 as powerbi.visuals.ValidatorType.Max, value: b } as powerbi.visuals.MaxValidator<number>
});

export const SEARCH_SCOPE_ITEMS: powerbi.IEnumMember[] = [
    item("all", "Opt_Scope_All", "All"),
    item("country", "Opt_Scope_Country", "Country"),
    item("district", "Opt_Scope_District", "District / region"),
    item("municipality", "Opt_Scope_Municipality", "Municipality")
];

const MODE_ITEMS: powerbi.IEnumMember[] = [
    item("area", "Opt_Mode_Area", "Area"),
    item("bubble", "Opt_Mode_Bubble", "Bubble"),
    item("both", "Opt_Mode_Both", "Area + bubble")
];

const NEGATIVE_ITEMS: powerbi.IEnumMember[] = [
    item("own", "Opt_Neg_Own", "Own color"),
    item("diverging", "Opt_Neg_Diverging", "Diverging (negative ← 0 → scale)"),
    item("scale", "Opt_Neg_Scale", "Part of the scale")
];

// the map opens on countries or districts (municipalities need a selected country / districts)
const CITY_START_ITEMS: powerbi.IEnumMember[] = [
    item("country", "Opt_CityStart_Country", "Countries"),
    item("district", "Opt_CityStart_District", "Districts / regions")
];

const SCALE_ITEMS: powerbi.IEnumMember[] = [
    item("linear", "Opt_Scale_Linear", "Linear (value)"),
    item("log", "Opt_Scale_Log", "Logarithmic"),
    item("rank", "Opt_Scale_Rank", "By rank (continuous percentile)"),
    item("quantile", "Opt_Scale_Quantile", "Classes with equal counts (quantiles)"),
    item("clip", "Opt_Scale_Clip", "Linear with percentile clipping")
];

const COLORS_ITEMS: powerbi.IEnumMember[] = [
    item("two", "Opt_Colors_2", "2 colors"),
    item("three", "Opt_Colors_3", "3 colors"),
    item("four", "Opt_Colors_4", "4 colors")
];

const BUBBLE_COLOR_ITEMS: powerbi.IEnumMember[] = [
    item("gradient", "Opt_BubbleColor_Gradient", "Gradient (value)"),
    item("fixed", "Opt_BubbleColor_Fixed", "Fixed color")
];

const BASEMAP_ITEMS: powerbi.IEnumMember[] = [
    item("none", "Opt_Basemap_None", "None (shapes only)"),
    item("light", "Opt_Basemap_Light", "Light (road style)"),
    item("grey", "Opt_Basemap_Grey", "Grey"),
    item("dark", "Opt_Basemap_Dark", "Dark")
];

const DENSITY_ITEMS: powerbi.IEnumMember[] = [
    item("low", "Opt_Density_Low", "Low"),
    item("medium", "Opt_Density_Medium", "Medium"),
    item("high", "Opt_Density_High", "High")
];

const INTERACTION_ITEMS: powerbi.IEnumMember[] = [
    item("filter", "Opt_Interaction_Filter", "Filter the page"),
    item("highlight", "Opt_Interaction_Highlight", "Highlight (Power BI default)")
];

const POSITION_ITEMS: powerbi.IEnumMember[] = [
    item("top", "Opt_Position_Top", "Top"),
    item("bottom", "Opt_Position_Bottom", "Bottom")
];

const CONTENT_ITEMS: powerbi.IEnumMember[] = [
    item("name", "Opt_Content_Name", "Name"),
    item("value", "Opt_Content_Value", "Value"),
    item("both", "Opt_Content_Both", "Name and value")
];

const UNITS_ITEMS: powerbi.IEnumMember[] = [
    item("auto", "Opt_Units_Auto", "Auto"),
    item("none", "Opt_Units_None", "None"),
    item("thousands", "Opt_Units_Thousands", "Thousands (K)"),
    item("millions", "Opt_Units_Millions", "Millions (M)"),
    item("billions", "Opt_Units_Billions", "Billions (B)")
];

// ---- cards -----------------------------------------------------------------------------------

export class MapCard extends Card {
    countryMode = new formattingSettings.ItemDropdown({ name: "countryMode", ...t("Map_CountryMode", "Countries view"), items: MODE_ITEMS, value: MODE_ITEMS[0] });
    districtMode = new formattingSettings.ItemDropdown({ name: "districtMode", ...t("Map_DistrictMode", "Districts view"), items: MODE_ITEMS, value: MODE_ITEMS[0] });
    cityStart = new formattingSettings.ItemDropdown({
        name: "cityStart", ...t("Map_CityStart", "Opens on"),
        ...d("Map_CityStart_Desc", "View shown first. The buttons on the map switch between countries, districts and (for one selected country or selected districts) municipalities."),
        items: CITY_START_ITEMS, value: CITY_START_ITEMS[0]
    });
    cityMode = new formattingSettings.ItemDropdown({
        name: "cityMode", ...t("Map_CityMode", "Municipalities view"),
        ...d("Map_CityMode_Desc", "Area: each city is placed in its municipality, values are summed and the whole municipality is colored. Bubble: one bubble per city."),
        items: MODE_ITEMS, value: MODE_ITEMS[0]
    });
    defaultCountry = new formattingSettings.TextInput({
        name: "defaultCountry", ...t("Map_DefaultCountry", "Default country (cities / postal codes)"),
        ...d("Map_DefaultCountry_Desc", "ISO2 code (e.g. PT) used for every city when the Country column is not used (single-country data). Empty = automatic."),
        placeholder: "auto", value: ""
    });
    showContext = new formattingSettings.ToggleSwitch({ name: "showContext", ...t("Map_ShowContext", "Show neighbours (context)"), value: true });
    contextColor = new formattingSettings.ColorPicker({ name: "contextColor", ...t("Map_ContextColor", "Neighbour color"), value: { value: "#E9ECEF" } });
    contextBorderColor = new formattingSettings.ColorPicker({ name: "contextBorderColor", ...t("Map_ContextBorder", "Neighbour border"), value: { value: "#FFFFFF" } });
    enableZoom = new formattingSettings.ToggleSwitch({ name: "enableZoom", ...t("Map_EnableZoom", "Mouse zoom and pan"), value: true });
    showReset = new formattingSettings.ToggleSwitch({ name: "showReset", ...t("Map_ShowReset", "Reset zoom button"), value: true });

    name = "mapCard";
    displayName = "Map";
    displayNameKey = "Card_Map";
    slices: Slice[] = [this.cityStart, this.countryMode, this.districtMode, this.cityMode, this.defaultCountry, this.showContext, this.contextColor, this.contextBorderColor, this.enableZoom, this.showReset];

    onPreProcess(): void {
        this.contextColor.visible = this.showContext.value;
        this.contextBorderColor.visible = this.showContext.value;
        this.showReset.visible = this.enableZoom.value;
    }
}

export class BasemapCard extends Card {
    style = new formattingSettings.ItemDropdown({ name: "style", ...t("Base_Style", "Style"), items: BASEMAP_ITEMS, value: BASEMAP_ITEMS[1] });
    showRoads = new formattingSettings.ToggleSwitch({ name: "showRoads", ...t("Base_ShowRoads", "Main roads"), value: true });
    roadIntensity = new formattingSettings.NumUpDown({ name: "roadIntensity", ...t("Base_RoadIntensity", "Road intensity (%)"), value: 60, options: range(0, 100) });
    showPlaces = new formattingSettings.ToggleSwitch({ name: "showPlaces", ...t("Base_ShowPlaces", "Place names"), value: true });
    placeDensity = new formattingSettings.ItemDropdown({ name: "placeDensity", ...t("Base_PlaceDensity", "Name density"), items: DENSITY_ITEMS, value: DENSITY_ITEMS[1] });
    placesPerArea = new formattingSettings.NumUpDown({
        name: "placesPerArea", ...t("Base_PlacesPerArea", "Cities per area (countries / districts views)"),
        ...d("Base_PlacesPerArea_Desc", "Most populated place names shown in each country (country view) or district (district view). 0 hides them; the municipality view uses the name density."),
        value: 2, options: range(0, 10)
    });
    placeFontSize = new formattingSettings.NumUpDown({ name: "placeFontSize", ...t("Base_PlaceFontSize", "Name size"), value: 10, options: range(6, 20) });
    showCountryNames = new formattingSettings.ToggleSwitch({ name: "showCountryNames", ...t("Base_ShowCountryNames", "Country names"), value: true });

    name = "basemapCard";
    displayName = "Basemap";
    displayNameKey = "Card_Basemap";
    slices: Slice[] = [this.style, this.showRoads, this.roadIntensity, this.showPlaces, this.placeDensity, this.placesPerArea, this.placeFontSize, this.showCountryNames];

    onPreProcess(): void {
        const vector = this.style.value?.value !== "none";
        this.showRoads.visible = vector;
        this.roadIntensity.visible = vector && this.showRoads.value;
        this.showPlaces.visible = vector;
        this.placeDensity.visible = vector && this.showPlaces.value;
        this.placesPerArea.visible = vector && this.showPlaces.value;
        this.placeFontSize.visible = vector && (this.showPlaces.value || this.showCountryNames.value);
        this.showCountryNames.visible = vector;
    }
}

export class AreaCard extends Card {
    scaleType = new formattingSettings.ItemDropdown({
        name: "scaleType", ...t("Area_ScaleType", "Color scale"),
        ...d("Area_ScaleType_Desc", "For very uneven values (e.g. one country with 80% of the total) use Logarithmic, By rank or Classes."),
        items: SCALE_ITEMS, value: SCALE_ITEMS[0]
    });
    classes = new formattingSettings.NumUpDown({ name: "classes", ...t("Area_Classes", "Number of classes"), value: 5, options: range(2, 9) });
    pLow = new formattingSettings.NumUpDown({ name: "pLow", ...t("Area_PLow", "Lower clip (percentile)"), value: 5, options: range(0, 49) });
    pHigh = new formattingSettings.NumUpDown({ name: "pHigh", ...t("Area_PHigh", "Upper clip (percentile)"), value: 90, options: range(51, 100) });
    gradientType = new formattingSettings.ItemDropdown({ name: "gradientType", ...t("Area_Colors", "Number of colors"), items: COLORS_ITEMS, value: COLORS_ITEMS[1] });
    minColor = new formattingSettings.ColorPicker({ name: "minColor", ...t("Area_MinColor", "Minimum color"), value: { value: "#DCE9F5" } });
    midColor = new formattingSettings.ColorPicker({ name: "midColor", ...t("Area_MidColor", "Middle color"), value: { value: "#6FA8DC" } });
    mid2Color = new formattingSettings.ColorPicker({ name: "mid2Color", ...t("Area_Mid2Color", "Middle color 2"), value: { value: "#3D7CC4" } });
    maxColor = new formattingSettings.ColorPicker({ name: "maxColor", ...t("Area_MaxColor", "Maximum color"), value: { value: "#1F5E9C" } });
    autoRange = new formattingSettings.ToggleSwitch({ name: "autoRange", ...t("Area_AutoRange", "Automatic min/max"), value: true });
    rangeMin = new formattingSettings.NumUpDown({ name: "rangeMin", ...t("Area_RangeMin", "Minimum"), value: 0 });
    rangeMax = new formattingSettings.NumUpDown({ name: "rangeMax", ...t("Area_RangeMax", "Maximum"), value: 100 });
    autoMid = new formattingSettings.ToggleSwitch({ name: "autoMid", ...t("Area_AutoMid", "Automatic midpoint"), value: true });
    midValue = new formattingSettings.NumUpDown({ name: "midValue", ...t("Area_MidValue", "Midpoint"), value: 0 });
    fxFill = new formattingSettings.ColorPicker({
        name: "fxFill",
        ...t("Area_FxFill", "Color by rule (fx)"),
        ...d("Area_FxFill_Desc", "Use the fx button for rule- or field-based colors. Overrides the gradient."),
        value: { value: "" },
        instanceKind: 3 as powerbi.VisualEnumerationInstanceKinds, // ConstantOrRule (const enum, inlined by hand)
        selector: dataViewWildcard.createDataViewWildcardSelector(0 /* InstancesAndTotals */),
        altConstantSelector: undefined
    });
    negativeMode = new formattingSettings.ItemDropdown({
        name: "negativeMode", ...t("Area_NegativeMode", "Negative values"),
        ...d("Area_NegativeMode_Desc", "Own color: negatives (returns, credits) get one color and the scale covers 0 to max. Diverging: shades of that color down to the most negative value. Part of the scale: negatives are the low end of the scale."),
        items: NEGATIVE_ITEMS, value: NEGATIVE_ITEMS[0]
    });
    negativeColor = new formattingSettings.ColorPicker({ name: "negativeColor", ...t("Area_NegativeColor", "Negative color"), value: { value: "#D64550" } });
    noDataColor = new formattingSettings.ColorPicker({ name: "noDataColor", ...t("Area_NoDataColor", "No-data color"), value: { value: "#C8CED6" } });
    borderColor = new formattingSettings.ColorPicker({ name: "borderColor", ...t("Area_BorderColor", "Border color"), value: { value: "#FFFFFF" } });
    borderWidth = new formattingSettings.NumUpDown({ name: "borderWidth", ...t("Area_BorderWidth", "Border width"), value: 0.6, options: range(0, 5) });
    lineIntensity = new formattingSettings.NumUpDown({
        name: "lineIntensity", ...t("Area_LineIntensity", "Line intensity (%)"),
        ...d("Area_LineIntensity_Desc", "Opacity of every border line: area borders and district, municipality and country borders."),
        value: 65, options: range(5, 100)
    });
    areaOpacity = new formattingSettings.NumUpDown({ name: "areaOpacity", ...t("Area_Opacity", "Area opacity (%)"), value: 100, options: range(5, 100) });

    name = "areaCard";
    displayName = "Areas and colors";
    displayNameKey = "Card_Area";
    slices: Slice[] = [this.scaleType, this.classes, this.pLow, this.pHigh, this.gradientType, this.minColor, this.midColor, this.mid2Color, this.maxColor, this.autoRange, this.rangeMin, this.rangeMax,
        this.autoMid, this.midValue, this.fxFill, this.negativeMode, this.negativeColor, this.noDataColor, this.borderColor, this.borderWidth, this.lineIntensity, this.areaOpacity];

    onPreProcess(): void {
        const n = this.gradientType.value?.value;
        const st = this.scaleType.value?.value;
        const valueBased = st === "linear" || st === "log";
        this.midColor.visible = n !== "two";
        this.mid2Color.visible = n === "four";
        this.autoMid.visible = n === "three" && valueBased;
        this.midValue.visible = n === "three" && valueBased && !this.autoMid.value;
        this.autoRange.visible = valueBased;
        this.rangeMin.visible = valueBased && !this.autoRange.value;
        this.rangeMax.visible = valueBased && !this.autoRange.value;
        this.classes.visible = st === "quantile";
        this.pLow.visible = st === "clip";
        this.pHigh.visible = st === "clip";
    }
}

export class BubbleCard extends Card {
    bubbleColorMode = new formattingSettings.ItemDropdown({ name: "bubbleColorMode", ...t("Bubble_ColorMode", "Bubble color"), items: BUBBLE_COLOR_ITEMS, value: BUBBLE_COLOR_ITEMS[0] });
    bubbleColor = new formattingSettings.ColorPicker({ name: "bubbleColor", ...t("Bubble_Color", "Fixed color"), value: { value: "#1F5E9C" } });
    minRadius = new formattingSettings.NumUpDown({ name: "minRadius", ...t("Bubble_MinRadius", "Minimum radius (px)"), value: 4, options: range(1, 100) });
    maxRadius = new formattingSettings.NumUpDown({ name: "maxRadius", ...t("Bubble_MaxRadius", "Maximum radius (px)"), value: 26, options: range(2, 200) });
    bubbleOpacity = new formattingSettings.NumUpDown({ name: "bubbleOpacity", ...t("Bubble_Opacity", "Opacity (%)"), value: 85, options: range(5, 100) });
    bubbleBorderColor = new formattingSettings.ColorPicker({ name: "bubbleBorderColor", ...t("Bubble_BorderColor", "Outline"), value: { value: "#FFFFFF" } });
    bubbleBorderWidth = new formattingSettings.NumUpDown({ name: "bubbleBorderWidth", ...t("Bubble_BorderWidth", "Outline width"), value: 1, options: range(0, 6) });

    name = "bubbleCard";
    displayName = "Bubbles";
    displayNameKey = "Card_Bubble";
    slices: Slice[] = [this.bubbleColorMode, this.bubbleColor, this.minRadius, this.maxRadius, this.bubbleOpacity, this.bubbleBorderColor, this.bubbleBorderWidth];

    onPreProcess(): void {
        this.bubbleColor.visible = this.bubbleColorMode.value?.value === "fixed";
    }
}

export class DonutCard extends Card {
    donutHole = new formattingSettings.Slider({
        name: "donutHole", ...t("Donut_Hole", "Center hole size (%)"),
        ...d("Donut_Hole_Desc", "0% = full pie; 90% = thin ring."),
        value: 45, options: range(0, 90)
    });
    sliceBorderColor = new formattingSettings.ColorPicker({ name: "sliceBorderColor", ...t("Donut_SliceBorderColor", "Slice separator"), value: { value: "#FFFFFF" } });
    sliceBorderWidth = new formattingSettings.NumUpDown({ name: "sliceBorderWidth", ...t("Donut_SliceBorderWidth", "Separator width"), value: 1, options: range(0, 6) });
    areaDonut = new formattingSettings.ToggleSwitch({ name: "areaDonut", ...t("Donut_AreaDonut", "Donut at area center"), value: true });
    areaDonutSize = new formattingSettings.NumUpDown({ name: "areaDonutSize", ...t("Donut_AreaDonutSize", "Area donut radius (px)"), value: 16, options: range(4, 80) });
    showDonuts = new formattingSettings.ToggleSwitch({ name: "showDonuts", ...t("Donut_Show", "Show donuts"), value: true });
    maxDonuts = new formattingSettings.NumUpDown({
        name: "maxDonuts", ...t("Donut_Max", "Maximum donuts (largest first)"),
        ...d("Donut_Max_Desc", "Only the largest locations get a donut; the others keep a plain bubble (or just the area color). 0 = all."),
        value: 25, options: range(0, 500)
    });

    name = "donutCard";
    displayName = "Donuts (with legend)";
    displayNameKey = "Card_Donut";
    slices: Slice[] = [this.showDonuts, this.maxDonuts, this.donutHole, this.sliceBorderColor, this.sliceBorderWidth, this.areaDonut, this.areaDonutSize];

    onPreProcess(): void {
        this.areaDonutSize.visible = this.areaDonut.value;
    }
}

export class SelectionCard extends Card {
    interaction = new formattingSettings.ItemDropdown({
        name: "interaction", ...t("Sel_Interaction", "On selection"),
        ...d("Sel_Interaction_Desc", "Filter: the selection (click, Shift/Ctrl+click, drawn zones) filters the other visuals on the page, like a slicer. Highlight: standard Power BI behavior."),
        items: INTERACTION_ITEMS, value: INTERACTION_ITEMS[0]
    });
    selBorderColor = new formattingSettings.ColorPicker({ name: "selBorderColor", ...t("Sel_BorderColor", "Selected outline"), value: { value: "#252423" } });
    selBorderWidth = new formattingSettings.NumUpDown({ name: "selBorderWidth", ...t("Sel_BorderWidth", "Outline width (px)"), value: 1.2, options: range(0, 8) });
    dimOpacity = new formattingSettings.NumUpDown({ name: "dimOpacity", ...t("Sel_DimOpacity", "Unselected opacity (%)"), value: 35, options: range(0, 100) });
    showSearch = new formattingSettings.ToggleSwitch({
        name: "showSearch", ...t("Sel_ShowSearch", "Search box"),
        ...d("Sel_ShowSearch_Desc", "Search field on the map: contains, does not contain, starts with, ends with or equals; the matches are selected."),
        value: true
    });
    searchScope = new formattingSettings.ItemDropdown({
        name: "searchScope", ...t("Sel_SearchScope", "Search in"),
        ...d("Sel_SearchScope_Desc", "Default field the search box looks in: everything, the country, the district / region or the municipality. It can be changed on the map."),
        items: SEARCH_SCOPE_ITEMS, value: SEARCH_SCOPE_ITEMS[0]
    });

    name = "selectionCard";
    displayName = "Selection";
    displayNameKey = "Card_Selection";
    slices: Slice[] = [this.interaction, this.showSearch, this.searchScope, this.selBorderColor, this.selBorderWidth, this.dimOpacity];
}

export class CategoryColorsCard extends Card {
    name = "categoryColors";
    displayName = "Legend colors";
    displayNameKey = "Card_CategoryColors";
    slices: Slice[] = [];
}

export class LegendCard extends Card {
    show = new formattingSettings.ToggleSwitch({ name: "show", ...t("Common_Show", "Show"), value: true });
    position = new formattingSettings.ItemDropdown({ name: "position", ...t("Legend_Position", "Position"), items: POSITION_ITEMS, value: POSITION_ITEMS[1] });
    showTitle = new formattingSettings.ToggleSwitch({ name: "showTitle", ...t("Legend_ShowTitle", "Title"), value: true });
    fontSize = new formattingSettings.NumUpDown({ name: "fontSize", ...t("Common_FontSize", "Text size"), value: 10, options: range(6, 30) });
    fontColor = new formattingSettings.ColorPicker({ name: "fontColor", ...t("Common_FontColor", "Text color"), value: { value: "#444444" } });

    topLevelSlice = this.show;
    name = "legendCard";
    displayName = "Legend";
    displayNameKey = "Card_Legend";
    slices: Slice[] = [this.position, this.showTitle, this.fontSize, this.fontColor];
}

export class LabelsCard extends Card {
    show = new formattingSettings.ToggleSwitch({ name: "show", ...t("Common_Show", "Show"), value: false });
    content = new formattingSettings.ItemDropdown({ name: "content", ...t("Labels_Content", "Content"), items: CONTENT_ITEMS, value: CONTENT_ITEMS[2] });
    fontSize = new formattingSettings.NumUpDown({ name: "fontSize", ...t("Common_FontSize", "Text size"), value: 9, options: range(6, 30) });
    fontColor = new formattingSettings.ColorPicker({ name: "fontColor", ...t("Common_FontColor", "Text color"), value: { value: "#252423" } });
    halo = new formattingSettings.ToggleSwitch({ name: "halo", ...t("Labels_Halo", "White text halo"), value: true });
    autoHide = new formattingSettings.ToggleSwitch({ name: "autoHide", ...t("Labels_AutoHide", "Hide when overlapping"), value: true });
    displayUnits = new formattingSettings.ItemDropdown({ name: "displayUnits", ...t("Labels_Units", "Display units"), items: UNITS_ITEMS, value: UNITS_ITEMS[0] });
    decimals = new formattingSettings.NumUpDown({ name: "decimals", ...t("Labels_Decimals", "Decimal places"), value: 1, options: range(0, 6) });

    topLevelSlice = this.show;
    name = "labelsCard";
    displayName = "Data labels";
    displayNameKey = "Card_Labels";
    slices: Slice[] = [this.content, this.fontSize, this.fontColor, this.halo, this.autoHide, this.displayUnits, this.decimals];
}

export class VisualFormattingSettingsModel extends Model {
    mapCard = new MapCard();
    basemapCard = new BasemapCard();
    areaCard = new AreaCard();
    bubbleCard = new BubbleCard();
    donutCard = new DonutCard();
    selectionCard = new SelectionCard();
    categoryColors = new CategoryColorsCard();
    legendCard = new LegendCard();
    labelsCard = new LabelsCard();
    cards = [this.mapCard, this.basemapCard, this.areaCard, this.bubbleCard, this.donutCard, this.selectionCard, this.categoryColors, this.legendCard, this.labelsCard];
}
