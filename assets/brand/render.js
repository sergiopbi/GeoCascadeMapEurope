const { chromium } = require('/opt/npm-tools/node_modules/playwright');
const fs = require('fs');
(async () => {
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  for (const [svg, size, out] of [['icon20.svg', 20, '../icon.png'], ['logo.svg', 300, 'logo_300.png'], ['logo.svg', 512, 'logo_512.png'], ['logo.svg', 96, 'logo_96.png']]) {
    const p = await b.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
    const s = fs.readFileSync(__dirname + '/' + svg, 'utf8').replace('<svg ', `<svg width="${size}" height="${size}" `);
    await p.setContent(`<html><body style="margin:0;background:transparent">${s}</body></html>`);
    await p.screenshot({ path: __dirname + '/' + out, omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
    await p.close();
  }
  // preview sheet
  const p = await b.newPage({ viewport: { width: 520, height: 140 } });
  await p.setContent(`<html><body style="margin:10px;font:12px sans-serif;display:flex;gap:20px;align-items:end">
   <div><img src="file://${__dirname}/../icon.png" width="20"><br>20px</div><div><img src="file://${__dirname}/../icon.png" width="60" style="image-rendering:pixelated"><br>20px ×3</div>
   <div><img src="file://${__dirname}/logo_96.png"><br>96px</div><div style="background:#252423;padding:6px"><img src="file://${__dirname}/../icon.png" width="20"></div></body></html>`);
  await p.screenshot({ path: __dirname + '/preview.png' });
  await b.close();
})();
