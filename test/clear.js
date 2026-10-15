const { chromium } = require('/opt/npm-tools/node_modules/playwright');
(async () => {
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const p = await b.newPage();
  const errs = []; p.on('pageerror', e => errs.push(String(e)));
  await p.goto('file://' + __dirname + '/out/index.html');
  const r = await p.evaluate(() => {
    const rows = [['PT', 'LISBOA', 900], ['PT', 'PORTO', 650], ['ES', 'MADRID', 700], ['ES', 'SEVILLA', 300]];
    window.runScenario({ title: 'c', levels: [{ name: 'COUNTRY_PAY', role: 'countryGroup', values: rows.map(r => r[0]) }, { name: 'CITY_PAY', values: rows.map(r => r[1]) }], measures: [{ role: 'color', name: 'GSV', values: rows.map(r => r[2]) }] });
    const el = document.querySelector('.visual-host'); const v = el.__visual;
    const out = [];
    const upd = (sel, filters) => { const o = Object.assign({}, v.lastOptions); const dv = Object.assign({}, o.dataViews[0]); dv.metadata = Object.assign({}, dv.metadata, { objects: { drillState: { sel } } }); o.dataViews = [dv]; o.jsonFilters = filters; v.update(o); };
    // select Espanha (country view)
    const a = [...el.querySelectorAll('path.gdm-area')].find(x => x.getAttribute('aria-label') === 'Espanha'); a.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const selJson = v.persistedSelJson; const filt = JSON.parse(v.lastFilterJson);
    upd(selJson, filt); // host echo of the selection
    out.push('selected ' + v.filterLabels.size);
    // clear with the chip ✕
    el.querySelector('.gdm-chip-filter button').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    out.push('after click ' + v.filterLabels.size);
    upd(selJson, filt);   // stale echo: host still carries the old persisted selection + filter
    out.push('after stale echo ' + v.filterLabels.size + ' chip=' + (el.querySelector('.gdm-focuschip').style.display !== 'none'));
    upd('', []);          // the real echo
    out.push('after real echo ' + v.filterLabels.size + ' chip=' + (el.querySelector('.gdm-focuschip').style.display !== 'none'));
    return out;
  });
  console.log(r, errs);
  await b.close();
})();
// focus chip (Nível ✕) with a stale echo
(async () => {
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const p = await b.newPage();
  await p.goto('file://' + __dirname + '/out/index.html');
  const r = await p.evaluate(() => {
    const rows = [['PT', 'LISBOA', 900], ['PT', 'PORTO', 650], ['ES', 'MADRID', 700], ['ES', 'SEVILLA', 300]];
    window.runScenario({ title: 'f', levels: [{ name: 'COUNTRY_PAY', role: 'countryGroup', values: rows.map(r => r[0]) }, { name: 'CITY_PAY', values: rows.map(r => r[1]) }], measures: [{ role: 'color', name: 'GSV', values: rows.map(r => r[2]) }] });
    const el = document.querySelector('.visual-host'); const v = el.__visual; const out = [];
    const upd = (focus, sel, filters) => { const o = Object.assign({}, v.lastOptions); const dv = Object.assign({}, o.dataViews[0]); dv.metadata = Object.assign({}, dv.metadata, { objects: { drillState: { focus, sel } } }); o.dataViews = [dv]; o.jsonFilters = filters; v.update(o); };
    const a = [...el.querySelectorAll('path.gdm-area')].find(x => x.getAttribute('aria-label') === 'Espanha'); a.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    [...el.querySelectorAll('.gdm-viewbtn')].find(b => b.textContent.startsWith('Concelhos')).click();
    const fj = v.pendingFocusJson, filt = JSON.parse(v.lastFilterJson);
    upd(fj, '', filt);
    out.push('view ' + v.model.view + ' focus ' + v.focus.length + ' labels=' + v.filterLabels.size + ' own=' + JSON.stringify(v.ownFilter) + ' filt=' + JSON.stringify(filt).slice(0,120));
    el.querySelector('.gdm-focuschip button').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    out.push('after ✕ focus ' + v.focus.length + ' view ' + v.model.view + ' labels=' + v.filterLabels.size + ' own=' + JSON.stringify(v.ownFilter));
    upd(fj, '', filt);
    out.push('after stale echo focus ' + v.focus.length + ' view ' + v.model.view + ' labels=' + v.filterLabels.size + ' own=' + JSON.stringify(v.ownFilter));
    upd('', '', []);
    out.push('after real echo focus ' + v.focus.length + ' view ' + v.model.view + ' chip=' + el.querySelector('.gdm-focuschip').textContent + ' labels=' + v.filterLabels.size + ' zones=' + v.zones.length);
    return out;
  });
  console.log(r);
  await b.close();
})();
