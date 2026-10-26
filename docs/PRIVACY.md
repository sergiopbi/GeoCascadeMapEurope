# Privacy Policy — World District Shape Map

**Last updated: October 2026**

World District Shape Map ("the visual") is a Power BI custom visual developed by Sergio
Borges.

## Data collection

The visual does **not** collect, store, transmit, or share any data, personal or
otherwise. Specifically:

- It makes no network requests of any kind (no calls to any server, map tile service,
  geocoding API, analytics, or telemetry endpoint). It declares no privileges in
  `capabilities.json` (`"privileges": []`).
- All maps, boundaries, city names and postal-code centroids are bundled inside the
  visual package; nothing is downloaded at runtime.
- It does not use cookies, local storage, or any browser storage mechanism outside of
  what Power BI's own visual framework provides for persisting report/visual settings
  (selected view, drill level, labels and donuts on/off, format-pane choices), which
  stays inside the report file itself and is never transmitted anywhere by this visual.
- It does not load any external scripts, fonts, images, or other resources at runtime.
- All computation (matching cities to countries, districts and municipalities, map
  rendering, filter construction) happens locally in the browser/report sandbox, using
  only the data already present in the Power BI report the visual is placed in.

## Data the visual reads

The visual reads only the fields explicitly bound to it by the report author (a city
column, optionally a country column, a detail column, and measures for value, size,
postal code, latitude/longitude and tooltips), exactly as with any other Power BI
visual. This data never leaves the report/Power BI session.

## Third parties

No third-party services, SDKs, or libraries that transmit data are used. The visual's
own code depends only on the standard Power BI Visuals API/tooling, `powerbi-models`
(used locally to construct the visual's own filters) and `d3` (used locally to draw the
map) — nothing that sends data anywhere.

## Contact

Questions about this privacy policy can be raised via the support channel listed in
the AppSource listing, or as an issue on the source repository:
https://github.com/sergiopbi/WorldDistrictShapeMap
