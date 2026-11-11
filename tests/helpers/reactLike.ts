// A form that behaves like a React controlled form: state is updated only from REAL input events, and React's value tracker ignores an input event when the DOM value
// equals the last value assigned through the element's own value setter. So `el.value = x` (even followed by an input event) leaves the state empty although the
// field LOOKS filled, which is the "every field looked filled but Submit said fields were missing" failure. Validation runs on blur and sets aria-invalid + an error.
// `?stubborn=Email` makes one field ignore all input (a widget that never registers), to prove VERIFY reports it by label.
export const REACT_LIKE_HTML = `<!doctype html><html><body><form id="f" onsubmit="return false">
${[['first_name', 'First Name', 'text'], ['last_name', 'Last Name', 'text'], ['email', 'Email', 'email'], ['phone', 'Phone', 'tel']].map(([n, l, t]) => `<div class="field"><label for="${n}">${l} *</label><input id="${n}" name="${n}" type="${t}" required aria-required="true"><span class="error" role="alert"></span></div>`).join('\n')}
<div class="field"><label for="why">Additional information</label><textarea id="why" name="why"></textarea><span class="error" role="alert"></span></div>
<button type="submit" id="go">Submit Application</button></form>
<script>
const stubborn = new URLSearchParams(location.search).get('stubborn');
window.__state = {};
const proto = { input: HTMLInputElement.prototype, textarea: HTMLTextAreaElement.prototype };
document.querySelectorAll('input,textarea').forEach((el) => {
  const nativeSet = Object.getOwnPropertyDescriptor(el instanceof HTMLTextAreaElement ? proto.textarea : proto.input, 'value').set;
  const nativeGet = Object.getOwnPropertyDescriptor(el instanceof HTMLTextAreaElement ? proto.textarea : proto.input, 'value').get;
  let tracked = '';
  Object.defineProperty(el, 'value', { configurable: true, get() { return nativeGet.call(el); }, set(v) { tracked = String(v); nativeSet.call(el, v); } });   // React's tracker hook
  const props = { value: '' }; el['__reactPropsTest'] = props;
  const err = el.parentElement.querySelector('.error');
  const sync = () => { props.value = window.__state[el.name] ?? ''; };
  el.addEventListener('input', () => {
    if (stubborn && el.name === stubborn.toLowerCase().replace(' ', '_')) return;
    const v = nativeGet.call(el); if (v === tracked) return; tracked = v;       // React: no change detected, state is not updated
    window.__state[el.name] = v; sync();
  });
  el.addEventListener('blur', () => {
    const missing = el.required && !(window.__state[el.name] || '').trim();
    el.setAttribute('aria-invalid', missing ? 'true' : 'false'); err.textContent = missing ? 'This field is required' : '';
  });
});
window.__valid = () => ['first_name', 'last_name', 'email', 'phone'].every((n) => (window.__state[n] || '').trim());
</script></body></html>`;
