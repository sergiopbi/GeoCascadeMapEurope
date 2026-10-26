# AppSource submission checklist

Two separate things, don't conflate them:

- **Publishing to AppSource** — required to distribute the visual at all. Moderate bar:
  general guidelines, working package, required listing metadata.
- **Certification** (optional, separate request, can be done later) — adds the "PBI
  Certified" badge, export to PowerPoint/PDF and emailed subscriptions. Microsoft reviews
  the source code, requires a public repo with a `certification` branch matching the
  submitted package, and re-reviews every update.

## Files in this repository for the submission

| File | Use in Partner Center |
|---|---|
| `WorldDistrictShapeMap.pbiviz` | Technical configuration › package |
| `WorldDistrictShapeMap.pbix` | Technical configuration › sample report (visual + "How to use" page) |
| `WorldDistrictShapeMap_Logo_300x300.png` | Offer listing › logo |
| `WorldDistrictShapeMap1..5_1366x768.png` | Offer listing › screenshots |
| `PRIVACY.md` | Properties › privacy policy URL |

## Before you can submit

- [x] API version 5.11.1 (latest), `npm run package` with zero lint errors.
- [x] Real support URL (`/issues`) and gitHubUrl in `pbiviz.json`.
- [x] Privacy policy at a public URL: https://github.com/sergiopbi/WorldDistrictShapeMap/blob/main/PRIVACY.md
- [x] 300×300 logo, 5 screenshots 1366×768 (≤ 1 MB each).
- [ ] Sample .pbix saved in the repo root with the final package imported.
- [ ] Data licences reviewed (docs/KNOWN_LIMITATIONS.md § 1).
- [ ] Partner Center account (work / Entra ID account; personal accounts are refused):
      Account settings › Programs › Other programs › **Commercial Marketplace** › Get started.

## Partner Center — what to fill

**New offer**: Home › Marketplace offers › + New offer › **Power BI visual**.
Offer ID: `world-district-shape-map` · Alias: World District Shape Map.

**Offer setup**: "My offer does not require purchase of a service and does not offer
in-app purchases". Leave **Request Power BI certification unchecked** for the first
submission (it cannot be unchecked later and slows validation).

**Properties**: category *Maps*; legal: **Use the Standard Contract**; privacy policy link
above.

**Offer listing**

- Name: World District Shape Map
- Search results summary (≤100): Turn City + Country rows into shaded countries, districts and municipalities. Offline, no API key.
- Short description: Shape map that places every city inside its own country and aggregates it into countries, districts / regions and municipalities — with search, drawn selection zones, donuts by category and a list of rows it could not place.
- Description (HTML):

```html
<p><b>World District Shape Map</b> turns a plain list of cities into a filled map of countries, districts / regions and municipalities. No geocoding service, no Bing, no API key: all shapes and lookups are inside the visual, so it works offline and in restricted tenants.</p>
<p><b>Correct by design.</b> Each city is read inside its own country (Country column: name or ISO code), so Madrid, Spain and Madrid, Colombia never mix. A postal code measure resolves duplicate names inside a country. Rows that cannot be placed are never guessed — they are listed with their values, and a click selects them in the other visuals so the data can be fixed.</p>
<ul>
<li>Three views: Countries › Districts / regions › Municipalities (municipalities in 54 countries, first-level regions worldwide)</li>
<li>Areas, bubbles or both, with value labels that follow the measure format</li>
<li>Detail field shown as donuts, limited to the largest areas for readability</li>
<li>Search by country, district, municipality or all, with contains / starts with / ends with / is — Enter filters the page and zooms the map</li>
<li>Draw free-hand selection zones; filter or highlight the rest of the report</li>
<li>Zoom with wheel, pinch or + / − buttons; the view is kept when data changes</li>
<li>Keyboard navigation, high contrast, tooltips, context menu, 7 languages (EN, PT-PT, PT-BR, ES, FR, DE, IT)</li>
</ul>
<p>Boundary data: geoBoundaries, Natural Earth, GeoNames, CAOP (Portugal) — sources and licences are listed on GitHub.</p>
```

- Search keywords: shape map · choropleth · municipalities
- Getting started: (1) City column in **City**, the country column of the same table in
  **Country**; (2) a measure in **Value (color)** — optional Detail, Size, Postal code,
  Tooltips; (3) switch views, click to filter, search with Enter, check the ⚠ list. The
  sample report has a "How to use" page.
- Support: https://github.com/sergiopbi/WorldDistrictShapeMap/issues

**Technical configuration**: upload `WorldDistrictShapeMap.pbiviz` and `WorldDistrictShapeMap.pbix`.

**Review and publish › Notes for certification** (required even without certification):

> Free visual: no purchase, no in-app purchase, no licence key, no sign-in. The visual
> declares no privileges and makes no network calls; all geographic data is bundled.
> To test: open the sample report, or bind any city column to "City", the matching
> country column (name or ISO2/ISO3) to "Country" and a numeric measure to
> "Value (color)". The sample also has a Detail field (donuts), a Postal code measure and
> three rows with a misspelled country that show the "locations not found" list.
> Source code: https://github.com/sergiopbi/WorldDistrictShapeMap

Partner Center breaks silently behind ad/tracker blockers (Brave Shields) and private
windows — use a normal window with blockers off.

## Before requesting certification (later, optional)

- [ ] Public GitHub repo containing only this visual's code (this repository).
- [ ] A branch literally named `certification` whose code matches exactly the submitted
      `.pbiviz`.
- [ ] `npm run eslint` and `npm run package` with zero errors.

## Versioning reminder

If you resubmit an update later: **never change the visual's GUID**
(`worldDistrictShapeMap7D702F8ACA1D8422B7FCA006130E5099` in `pbiviz.json`) — that's how Partner Center
recognizes it as an update to the same visual rather than a new submission.
