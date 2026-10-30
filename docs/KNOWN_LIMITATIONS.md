# Known limitations & open items

Written honestly for whoever maintains this next — including future-you.

## 1. Data licences of the bundled boundaries

Each boundary set keeps the licence of its source (README › Data sources and licences).
Several European sets (AL, CZ, EE, FI, HU, LI, LT, MC, ME, RS, SI, SK, SM — ODbL;
AT, CY, HR, PL — CC BY-SA) carry **share-alike** obligations. The derived
geometry is published openly in `src/municipalities.ts` under the same licences and the
attribution is in the README and the AppSource listing. If that is ever judged not
enough, those countries can be rebuilt from public-domain / CC BY sources (Natural Earth
admin-1 districts are public domain) with `tools/buildeuro.js`.

**Portugal (CAOP, DGT)**: the CAOP metadata does not state reuse terms; confirm them on
dados.gov.pt / with DGT before relying on the CAOP geometry commercially.

## 2. Package size (~1.8 MB) — light data set

Power BI Service refuses to import visual packages above about 2 MB ("An error occurred
while attempting to import visual into this report"; the first submission, at 8.2 MB,
was rejected for this). This build therefore bundles a light data set: municipalities
for 43 European countries only (districts / regions elsewhere), simplified outlines,
small municipalities grouped into areas of 300 km² / 30 000 inhabitants, cities with
30 000+ inhabitants, postal codes one digit coarser, and no basemap roads.
Effect: small localities outside the municipality names and the city list end up in the
"not found" list more often — never in a wrong place.

## 3. Matching limits

- Matching is by official municipality name, postal code (GeoNames), GeoNames place name
  and latitude/longitude, inside the row's own country. Very small localities missing
  from GeoNames and without a postal code end up in the "not found" list (by design:
  never in a wrong place).
- Small European municipalities are agglomerated around their main town (< 300 km² and
  < 30 000 inhabitants joins a neighbour; never above 2 500 km²); the tooltip lists how
  many official municipalities an area groups. Portuguese concelhos are kept as they are.

## 4. Tooltips are text only

Power BI's native tooltip service only accepts text. A country flag would need an emoji,
which Windows renders as two letters ("PT"), or a custom HTML tooltip that would replace
the native one — so no flags.

## 5. Not implemented (optional pbiviz features)

Analytics pane, fetch more data, file download, launch URL, local storage, modal dialog:
not needed by this visual.
