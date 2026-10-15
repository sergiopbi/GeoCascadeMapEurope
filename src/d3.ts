"use strict";
// Only the d3 modules the visual uses (keeps the bundle small and avoids d3-dsv / d3-fetch).
import "d3-transition";
export { select } from "d3-selection";
export type { Selection } from "d3-selection";
export { zoom, zoomIdentity } from "d3-zoom";
export type { ZoomBehavior, ZoomTransform, D3ZoomEvent } from "d3-zoom";
export { geoPath, geoEqualEarth, geoCircle, geoContains, geoDistance, geoBounds } from "d3-geo";
export type { GeoPath, GeoProjection } from "d3-geo";
export { scaleLinear, scaleSqrt, scaleThreshold } from "d3-scale";
export { interpolateLab } from "d3-interpolate";
export { pie, arc } from "d3-shape";
export type { PieArcDatum } from "d3-shape";
export { range, quantileSorted, bisectLeft, bisectRight } from "d3-array";
export { polygonContains } from "d3-polygon";
