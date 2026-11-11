import fs from 'node:fs';
// Dev tool: turns saved HTML of a real application page (plain GET, no browser, nothing submitted) into an inert local fixture:
// keeps only <form id="application-form">, strips scripts/styles/svg/links/images and long hidden values.
// usage: tsx src/apply/captureFixtures.ts <in.html> <out.html> <label>
const [inp, out, label] = process.argv.slice(2);
const html = fs.readFileSync(inp, 'utf8');
const m = html.match(/<form[^>]*id="application-form".*?<\/form>/s);
if (!m) throw new Error('no application form found');
const clean = m[0]
  .replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<svg[\s\S]*?<\/svg>/gi, '').replace(/<img[^>]*>/gi, '').replace(/<link[^>]*>/gi, '')
  .replace(/(<input[^>]*type="hidden"[^>]*value=")([^"]{120,})(")/gi, '$1x$3').replace(/ style="[^"]*"/gi, '')
  .replace(/<form([^>]*)>/i, '<form$1 onsubmit="return false">');
fs.writeFileSync(out, `<!DOCTYPE html><html><head><meta charset="utf-8"><title>mock ${label} application form (captured markup, inert)</title></head><body>\n<!-- Mock built from the server-rendered markup of a real ${label} application page (GET only). Scripts removed. -->\n${clean}\n<script src="mock-widgets.js"></script></body></html>\n`);
console.log(`${label}: ${html.length} -> ${clean.length} chars`);
