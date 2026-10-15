const { chromium } = require('/opt/npm-tools/node_modules/playwright');
(async () => {
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const p = await b.newPage({ viewport: { width: 900, height: 700 } });
  const errs = []; p.on('pageerror', e => errs.push(String(e))); p.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
  await p.goto('file://' + __dirname + '/out/index.html');
  const rows = [
    ['LISBOA','PT','1950-421',900],['PORTO','PT','4000-000',650],['BRAGA','PT','4700-000',420],['FUNCHAL','PT','9000-000',110],
    ['MADRID','ES','28001',700],['GETAFE','ES','28901',90],['SEVILLA','ES','41001',300],['VALENCIA','ES','46001',280],['MEDINA DEL CAMPO','ES','47400',40],['TORDESILLAS','ES','47100',12],['LAS PALMAS','ES','35001',209],
    ['PARIS','FR','75001',500],['LYON','FR','69001',200],['VERSAILLES','FR','78000',60],['ETAMPES','FR','91150',15],
    ['MILANO','IT','20100',300],['ROMA','IT','00100',250],['BERLIN','DE','10115',220],['MUENCHEN','DE','80331',180],
    ['NEW YORK','US','10001',400],['SAO PAULO','BR','01000-000',150],['XYZXYZ','ES','',5]
  ];
  await p.evaluate(rows => {
    window.runScenario({ title: 'Europa', height: 640, levels: [{ name: 'COUNTRY_PAY', role: 'countryGroup', values: rows.map(r => r[1]) }, { name: 'CITY_PAY', values: rows.map(r => r[0]) }],
      measures: [{ role: 'color', name: 'Gross Sales Value', format: '€ #,0', values: rows.map(r => r[3] * 1000) }, { role: 'postalCode', name: 'MAP CP', values: rows.map(r => r[2]) }] });
  }, rows);
  const h = (await p.$$('.visual-host'))[0];
  const st = () => h.evaluate(el => { const m = el.__visual.model; return { ms: el.__ms, level: m.level, view: m.view, n: m.points.length, pts: m.points.slice(0, 12).map(x => x.label + (x.members ? '(' + x.members.length + ')' : '')), focus: m.districtFocus.map(d => d.name), um: m.unmatched.map(u => u.label), toggle: [...el.querySelectorAll('.gdm-viewbtn')].map(b => b.textContent + (b.classList.contains('gdm-active') ? '*' : '')).join(' | '), chip: (el.querySelector('.gdm-focuschip') || {}).textContent, filter: el.__log.filter(l => l.startsWith('filter')).slice(-1)[0], failed: el.__log.filter(l => l.startsWith('FAILED')) }; });
  const clickArea = async (lab, shift) => { const ok = await h.evaluate((el, [lab, shift]) => { const a = [...el.querySelectorAll('path.gdm-area')].find(x => x.getAttribute('aria-label') === lab); if (!a) return [...el.querySelectorAll('path.gdm-area')].map(x => x.getAttribute('aria-label')).join(','); a.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: shift })); return true; }, [lab, !!shift]); if (ok !== true) throw new Error('no area ' + lab + ' in ' + ok); };
  const view = async name => { await h.evaluate((el, name) => [...el.querySelectorAll('.gdm-viewbtn')].find(b => b.textContent.startsWith(name)).click(), name); await p.waitForTimeout(150); };
  console.log('1 países:', JSON.stringify(await st()));
  await h.screenshot({ path: __dirname + '/out/e1.png' });
  await clickArea('Espanha');
  console.log('2 sel ES:', JSON.stringify(await st()));
  await view('Concelhos');
  console.log('3 concelhos ES:', JSON.stringify(await st()));
  await h.screenshot({ path: __dirname + '/out/e2.png' });
  await view('Países');
  console.log('4 países:', JSON.stringify(await st()));
  await view('Distritos');
  console.log('5 distritos:', JSON.stringify(await st()));
  await h.screenshot({ path: __dirname + '/out/e3.png' });
  const dl = await h.evaluate(el => el.__visual.model.points.filter(p => p.district && p.district.cc === 'FR').map(p => p.label));
  console.log('FR districts', dl);
  await clickArea(dl[0]); if (dl[1]) await clickArea(dl[1], true);
  console.log('6 sel FR districts:', JSON.stringify(await st()));
  await view('Concelhos');
  console.log('7 concelhos FR:', JSON.stringify(await st()));
  await h.screenshot({ path: __dirname + '/out/e4.png' });
  // tooltip of an agglomerated area
  const tip = await h.evaluate(el => { const v = el.__visual; const d = v.model.points.find(p => p.muni && p.muni.n > 1) || v.model.points[0]; return v.tooltipFor(d); });
  console.log('tooltip', JSON.stringify(tip));
  console.log('errors', errs);
  await b.close();
})();
