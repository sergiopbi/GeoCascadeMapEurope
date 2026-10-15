# GeoCascade Map – Europe

Power BI custom visual: an offline vector map that turns a list of **cities** into **countries › districts / regions › municipalities**.

- **Three views**, switched with the buttons on the map: *Countries*, *Districts / regions* (first-level divisions of every country)
  and *Municipalities* (Europe). Municipalities are offered for one selected country, for selected districts, or when the data has a single country.
- Every city row is placed **inside its own country** (Country column): official municipality name first, then postal code, then city name,
  then latitude/longitude. Cities with the same name in different countries (Madrid ES / Madrid CO) stay separate.
- Small European municipalities are grouped around their main town into areas of comparable size (see *Data*); the tooltip lists the
  locations in the data and how many municipalities an area groups.
- Selection **filters the page** like a slicer (or highlights): click, Shift/Ctrl+click or **drawn zones**. With the Country column the
  filter is exact (country column, or country + city pairs).
- Areas without data show their name on hover. Unmatched locations are listed with their values.
- Choropleth areas, bubbles and donuts; 2–4 colour gradients; linear, logarithmic, rank, quantile-class or percentile-clipped scales;
  negative values with their own colour or a diverging ramp.
- Built-in basemap (ocean, land, main roads, place names per area). **No external services, no web access.**
- Tooltips, context menu, keyboard navigation, high contrast, landing page, sync slicers, localized (en-US, pt-PT).

## Data roles

| Role | Kind | Purpose |
|---|---|---|
| City | Grouping | City of each row; optionally a second level below it (postal code, or customer/store with Latitude/Longitude) |
| Country | Grouping | Country column of the same table (name / ISO2 / ISO3). Strongly recommended: without it Power BI sums same-named cities of different countries |
| Value (color) | Measure | Colour scale |
| Size | Measure | Bubble size |
| Detail (legend) | Grouping | Donut slices |
| Postal code | Measure | Placement of each city (e.g. `SELECTEDVALUE(Dim[PostalCode])` or the most frequent one) |
| Latitude / Longitude | Measure | Placement for the level below the city; fallback for cities |
| Tooltips | Measure | Extra tooltip values |

## Build

```bash
npm install
npm run eslint
npx pbiviz package
```

The geographic modules in `src/` are generated:

| Module | Script | Content |
|---|---|---|
| `geodata.ts`, `roads.ts`, `cities.ts` | `scripts_buildgeo.js` | countries, roads, places, cities |
| `postal.ts` | `scripts_fixpostal.js` + `scripts_buildpostal.py` | postal-code centroids (coordinates outside their own municipality are moved into it) |
| `municipalities.ts` | `scripts_buildeuro.js` (`TOL_M=5e-6 Q_M=1e4 TOL_D=1e-4 Q_D=5e3`) | districts of every country, municipality areas of Europe (compact arc encoding) |

## Data

* Country shapes, roads and populated places: **Natural Earth** 1:10m — public domain.
* Districts / regions of every country: **Natural Earth admin-1** — public domain (LV, MK, SI, MT dissolved to their regions).
* Cities and town populations: **GeoNames** cities1000 — CC BY 4.0.
* Postal codes: **GeoNames** postal code data (via `zauberware/postal-codes-json-xml-csv`) — CC BY 4.0, aggregated per country.
* European municipalities: official units listed below, cleaned with mapshaper (snap + clean). Where tiny, they are agglomerated
  inside their district around the most populated neighbour (a unit under 150 km² **and** 20 000 inhabitants joins a neighbour;
  an area never grows past 1 500 km²). Portuguese concelhos are kept as they are.
* **Licences must be confirmed before AppSource**: ODbL and CC BY-SA sources carry share-alike obligations for the derived geometry;
  CAOP (PT) terms to be confirmed with DGT.

Positions are centroids for visualisation, not for routing or legal boundaries. Boundaries do not imply any opinion on disputed territories.

| ISO2 | Source level (units) | Licence | Source |
|---|---|---|---|
| AD | geoBoundaries ADM1 (7) | Public Domain | geoBoundaries, Wikimedia Commons |
| AL | geoBoundaries ADM3 (373) | Open Data Commons Open Database License 1.0 | OpenStreetMap, Wambacher |
| AT | geoBoundaries ADM3 (2097) | Creative Commons Attribution-ShareAlike 2.0 | Federal Office for Metrology and Survey, Austria, Derived from ADM4 layer |
| BA | geoBoundaries ADM3 (142) | Public Domain | Wikimedia Commons |
| BE | geoBoundaries ADM4 (589) | Creative Commons Attribution 4.0 International (CC BY 4.0) | Namur Capitale, Statistics Belgium |
| BG | geoBoundaries ADM2 (265) | Public Domain | geoBoundaries, Wikimedia |
| BY | geoBoundaries ADM2 (118) | Creative Commons Attribution 3.0 License | geoBoundaries, CIESIN |
| CH | geoBoundaries ADM3 (2286) | Federal Office of Topography swisstopo License | Federal Office of Topography swisstopo |
| CY | geoBoundaries ADM2 (612) | Creative Commons Attribution-ShareAlike 3.0 Unported | Wikipedia, Cyprus Department of Land Registry and Geometry |
| CZ | geoBoundaries ADM3 (6257) | Open Data Commons Open Database License 1.0 | OpenStreetMap, Wambacher |
| DE | geoBoundaries ADM3 (428) | Data license Germany - Attribution - Version 2.0 | Federal Agency for Cartography and Geodesy |
| DK | geoBoundaries ADM2 (98) | Public Domain | geoBoundaries, Wikimedia Commons |
| EE | geoBoundaries ADM2 (215) | Open Data Commons Open Database License 1.0 | OpenStreetMap, Wambacher |
| ES | geoBoundaries ADM3 (8205) | Creative Commons Attribution 4.0 International (CC BY 4.0) | Open Data ESRI, IGN Central Registry of Cartography Area |
| FI | geoBoundaries ADM3 (313) | Open Data Commons Open Database License 1.0 | OpenStreetMap, Wambacher |
| FR | geoBoundaries ADM5 (35010) | Open Data Commons Attribution License 1.0 | Republic of France, Regulatory Authority for Electronic Communications, Posts and Press Distribution (ARCEP) |
| GB | geoBoundaries ADM3 (216) | Open Government Licence v3.0 | Office for National Statistics |
| GR | geoBoundaries ADM3 (326) | CC0 1.0 Universal (CC0 1.0) Public Domain Dedication | geoBoundaries, Wikimedia Commons |
| HR | geoBoundaries ADM2 (560) | Creative Commons Attribution-ShareAlike 2.0 | Open Street Map, geoBoundaries |
| HU | geoBoundaries ADM3 (3357) | Open Data Commons Open Database License 1.0 | OpenStreetMap, Wambacher |
| IE | geoBoundaries ADM2 (166) | Creative Commons Attribution 4.0 (CC BY 4.0) | Ordnance Survey Ireland |
| IS | geoBoundaries ADM2 (74) | Creative Commons Attribution 4.0 International (CC BY 4.0) | National Land Survey of Iceland |
| IT | geoBoundaries ADM4 (7901) | Creative Commons Attribution 3.0 License | ISTAT, National Institute of Statistics |
| LI | geoBoundaries ADM1 (11) | Open Data Commons Open Database License 1.0 | OpenStreetMap, Wambacher |
| LT | geoBoundaries ADM2 (60) | Open Data Commons Open Database License 1.0 | OpenStreetMap, Wambacher |
| LU | geoBoundaries ADM3 (102) | Public Domain | Le Gouvernement du Grande Duche de Luxembourg |
| LV | geoBoundaries ADM2 (589) | Creative Commons Attribution 4.0 International (CC BY 4.0) | Valsts zemes dienests |
| MC | geoBoundaries ADM1 (1) | Open Data Commons Open Database License 1.0 | OpenStreetMap, Wambacher |
| MD | geoBoundaries ADM1 (37) | Creative Commons Attribution 3.0 Intergovernmental Organisations (CC BY 3.0 IGO) | UNHCR, OCHA FISS |
| ME | geoBoundaries ADM1 (23) | Open Data Commons Open Database License 1.0 | OpenStreetMap, Wambacher |
| MK | geoBoundaries ADM2 (84) | Creative Commons Attribution 4.0 International (CC BY 4.0) | EuroGeographics, Regional IM Working Group - Europe |
| MT | geoBoundaries ADM1 (68) | Public Domain | geoBoundaries, d-maps.com |
| NL | geoBoundaries ADM2 (344) | CC0 1.0 Universal (CC0 1.0) Public Domain Dedication | National Georegister |
| NO | geoBoundaries ADM2 (431) | Creative Commons Attribution 4.0 International (CC BY 4.0) | Geonorge, Mapping Authority of Norway |
| PL | geoBoundaries ADM3 (2480) | Creative Commons Attribution-ShareAlike 2.0 | OpenStreetMap, Wambacher |
| RO | geoBoundaries ADM2 (3235) | Creative Commons Attribution 4.0 International (CC BY 4.0) | Agentia Nationala de Cadastru si Publicitate Imobiliara |
| RS | geoBoundaries ADM2 (145) | Open Data Commons Open Database License 1.0 | OpenStreetMap, Wambacher |
| SE | geoBoundaries ADM2 (290) | CC0 1.0 Universal (CC0 1.0) Public Domain Dedication | geoBoundaries, Wikimedia Commons |
| SI | geoBoundaries ADM2 (213) | Open Data Commons Open Database License 1.0 | OpenStreetMap, Wambacher |
| SK | geoBoundaries ADM3 (2941) | Open Data Commons Open Database License 1.0 | OpenStreetMap, Wambacher |
| SM | geoBoundaries ADM1 (9) | Open Data Commons Open Database License 1.0 | OpenStreetMap, Wambacher |
| UA | geoBoundaries ADM2 (495) | Public Domain | geoBoundaries, Wikimedia Commons |
| PT | CAOP concelhos (308) | DGT — terms to confirm | Direção-Geral do Território via nmota/caop_GeoJSON |
