const { chromium } = require('/opt/npm-tools/node_modules/playwright');
(async () => {
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const p = await b.newPage({ viewport: { width: 820, height: 560 } });
  const errs = []; p.on('pageerror', e => errs.push(String(e)));
  await p.goto('file://' + __dirname + '/out/pkg.html');
  const r = await p.evaluate(() => {
    const plug = Object.values(window.powerbi.visuals.plugins)[0];
    const log = []; const host = window.__harness.makeHost(log);
    const el = document.getElementById('v');
    const v = plug.create({ element: el, host });
    const cities = ['LISBOA', 'CACEM', 'QUELUZ', 'PORTO', 'MADRID', 'CASTELLON', 'TORRENTE'];
    const dv = window.__harness.buildDataView({ levels: [{ name: 'COUNTRY_PAY', role: 'countryGroup', values: ['PT', 'PT', 'PT', 'PT', 'ES', 'ES', 'ES'] }, { name: 'CITY_PAY', values: cities }], measures: [{ role: 'color', name: 'GSV', format: '€ #,0', values: [9, 2, 1, 6, 7, 1, 1] }, { role: 'postalCode', name: 'CP', values: ['1950-421', '2735-000', '2745-000', '4000-000', '28001', '12006', '46900'] }] });
    v.update({ viewport: { width: 800, height: 520 }, dataViews: [dv], type: 2 });
    const fm = v.getFormattingModel();
    const items = []; const walk = o => { if (!o || typeof o !== 'object') return; if (o.items && o.value && o.value.displayName !== undefined) items.push(o.items.map(i => i.displayName).join('/')); for (const k in o) walk(o[k]); }; walk(fm);
    return { log, areas: [...el.querySelectorAll('path.gdm-area')].map(x => x.getAttribute('aria-label')), cards: fm.cards.map(c => c.displayName).join(', '), dropdowns: items.slice(0, 3) };
  });
  console.log(JSON.stringify(r, null, 1), errs);
  await (await p.$('#v')).screenshot({ path: __dirname + '/out/pkg.png' });
  await b.close();
})();
