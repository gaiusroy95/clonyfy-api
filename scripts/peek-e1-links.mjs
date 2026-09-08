import { readFileSync } from 'fs';

const html = readFileSync('output/benchmarks/week1-e1/captured-pages/__root__.html', 'utf8');
const hrefs = [...html.matchAll(/\bhref=["']([^"']+)["']/gi)].map((m) => m[1]);
console.log('hrefs', [...new Set(hrefs)].slice(0, 30));

for (const path of ['/sitemap.xml', '/sitemap-0.xml', '/robots.txt']) {
  try {
    const res = await fetch(`https://www.echeloninternational.ge${path}`);
    console.log(path, res.status, (await res.text()).slice(0, 200));
  } catch (e) {
    console.log(path, e.message);
  }
}
