const { chromium } = require('/opt/npm-tools/node_modules/playwright');
const demo = require('./demo.json');
(async () => {
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const p = await b.newPage({ viewport: { width: 1060, height: 640 } });
  await p.goto('file://' + __dirname + '/out/index.html');
  const rows = [...demo.es.map(n => [n, 'ES']), ...demo.pt.map(n => [n, 'PT'])];
  await p.evaluate(rows => {
    window.runScenario({ title: 'demo', height: 620, levels: [{ name: 'COUNTRY_PAY', role: 'countryGroup', values: rows.map(r => r[1]) }, { name: 'CITY_PAY', values: rows.map(r => r[0]) }],
      measures: [{ role: 'color', name: 'Gross Sales Value', format: '€ #,0.00', values: rows.map((r, i) => Math.round(5000 + 90000 * Math.abs(Math.sin(i * 7.3)))) }] });
  }, rows);
  const h = (await p.$$('.visual-host'))[0];
  await h.evaluate(el => { const v = el.__visual; v.cityView = 'district'; v.rerender(); });
  const zoomTo = async (lon, lat, k) => h.evaluate((el, [lon, lat, k]) => { const v = el.__visual; const [x, y] = v.projection([lon, lat]); v.svg.call(v.zoom.transform, Object.assign(Object.create(Object.getPrototypeOf(v.transform)), { k, x: v.mapW / 2 - k * x, y: v.mapH / 2 - k * y })); }, [lon, lat, k]);
  await p.waitForTimeout(200); await h.screenshot({ path: __dirname + '/out/demo_dist.png' });
  // one country in the data set? no (PT + ES): select Espanha in country view then municipalities
  await h.evaluate(el => { const v = el.__visual; v.cityView = 'country'; v.rerender(); });
  await h.evaluate(el => { const a = [...el.querySelectorAll('path.gdm-area')].find(x => x.getAttribute('aria-label') === 'Espanha'); a.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  await h.evaluate(el => [...el.querySelectorAll('.gdm-viewbtn')].find(b => b.textContent.startsWith('Concelhos')).click());
  await p.waitForTimeout(200);
  await zoomTo(-5.3, 41.4, 3.2); await p.waitForTimeout(400);
  await h.screenshot({ path: __dirname + '/out/demo_muni.png' });
  console.log(await h.evaluate(el => el.__visual.model.points.length));
  await b.close();
})();
