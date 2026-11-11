import http from 'node:http';
import type { Page } from 'playwright';

/** A local fake ATS: GET / serves a Lever-shaped application form, POST /apply is RECORDED (never forwarded anywhere). */
export interface MockAts { url: string; posts: { url: string; body: string }[]; close(): Promise<void> }
export const FORM_HTML = `<!DOCTYPE html><html><body><form id="application-form" method="POST" action="/apply">
<input name="name" type="text"><input name="email" type="email"><input name="phone" type="text">
<button type="submit" id="go">Submit application</button>
<button type="button" id="go-fetch" onclick="fetch('/apply',{method:'POST',body:'via=fetch'}).then((r)=>{document.title='ok '+r.status}).catch(()=>{document.title='connection failed'})">Send</button></form></body></html>`;
export async function startMockAts(o: { postStatus?: number; postHeaders?: Record<string, string> } = {}): Promise<MockAts> {
  const posts: MockAts['posts'] = [];
  const server = http.createServer((req, res) => {
    if (req.method === 'POST') { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => { posts.push({ url: req.url ?? '', body: b }); res.statusCode = o.postStatus ?? 200; for (const [k, v] of Object.entries(o.postHeaders ?? {})) res.setHeader(k, v); res.setHeader('content-type', 'text/html'); res.end('<html><body><h1>Application received</h1></body></html>'); }); return; }
    res.setHeader('content-type', 'text/html'); res.end(req.url === '/login' ? FORM_HTML.replace('<input name="name" type="text">', '<input name="name" type="text"><input type="password" name="pw">') : FORM_HTML);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as any).port;
  return { url: `http://127.0.0.1:${port}/`, posts, close: () => new Promise<void>((r) => { server.close(() => r()); server.closeAllConnections?.(); }) };
}

/** A HUMAN click: raw mouse events sent through a CDP session at the element's position. This is deliberately NOT Playwright's click(), i.e. outside the tool's automation wrapper. */
export async function humanClick(page: Page, selector: string): Promise<void> {
  const box = await page.locator(selector).boundingBox();
  if (!box) throw new Error(`no box for ${selector}`);
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  await cdp.detach();
}
