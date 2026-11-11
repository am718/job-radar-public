// Test-only behavior for the inert mock forms. NOT part of the product.
// Emulates react-select style comboboxes (role=combobox input + role=listbox/option), records file choices, and COUNTS submit attempts so tests can assert zero.
window.__submitClicks = 0; window.__submitEvents = 0; window.__files = {}; window.__selected = {};
document.addEventListener('click', (e) => { const b = e.target.closest('button,input[type=submit]'); if (b && (b.getAttribute('type') === 'submit' || /submit/i.test(b.textContent || '') || b.id === 'btn-submit')) window.__submitClicks++; }, true);   // (an untyped Yes/No answer button is not a submit)
document.addEventListener('submit', () => { window.__submitEvents++; }, true);
document.addEventListener('change', (e) => { const t = e.target; if (t.type === 'file') window.__files[t.id || t.name] = [...t.files].map((f) => f.name); }, true);
const OPTS = {
  country: ['United States', 'Canada', 'Mexico', 'United Kingdom'],
  school: ['State University', 'Fairfield University', 'New York University', 'Columbia University'],
  degree: ["Bachelor's Degree", "Master's Degree", 'PhD', 'High School'],
  discipline: ['Computer Science', 'Mathematics', 'Physics'],
  yesno: ['Yes', 'No'],
  hear: ['LinkedIn', 'Company website', 'Referral', 'Job board', 'Other'],
  orient: ['Straight', 'Gay or Lesbian', 'Bisexual', 'Decline to answer'],
  gender: ['Male', 'Female', 'Non-binary', 'Decline To Self Identify'],
  race: ['Asian', 'Black or African American', 'White', 'Two or More Races', 'Decline To Self Identify'],
  veteran: ['I am not a protected veteran', 'I identify as one or more of the classifications of protected veteran', 'I don\'t wish to answer'],
  state: ['New York', 'New Jersey', 'California', 'Texas', 'Illinois'],
  month: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
  locations: ['Springfield, Missouri, United States', 'Springfield, Ohio, United States', 'Springfield, Oregon, United States', 'Springfield, Massachusetts, United States', 'Springfield, Illinois, United States', 'Evanston, Illinois, United States', 'New York, New York, United States'],
  year: ['2023', '2024', '2025', '2026', '2027', '2028'],
};
function optionsFor(input) {
  const rec = input.getAttribute('data-jr-options'); if (rec) { try { return JSON.parse(rec); } catch (e) {} }   // options recorded from the REAL form by src/apply/harness.ts
  const id = input.id || '';
  const lb = (input.getAttribute('aria-labelledby') || '').split(/\s+/).map((i) => (document.getElementById(i) || {}).textContent || '').join(' ').trim();
  const label = lb || (document.querySelector(`label[for="${id}"]`) || {}).textContent || id;
  const l = (id + ' ' + label).toLowerCase();
  if (/location \(city\)|^location/.test(l)) return OPTS.locations;
  if (/sponsor|authori|previously been employed|do you require|based in any of these|transgender|disability|chronic condition/.test(l)) return OPTS.yesno;
  if (/hear about/.test(l)) return OPTS.hear;
  if (/country/.test(l)) return OPTS.country; if (/school/.test(l)) return OPTS.school; if (/degree/.test(l)) return OPTS.degree; if (/discipline/.test(l)) return OPTS.discipline;
  if (/month/.test(l)) return OPTS.month; if (/year/.test(l)) return OPTS.year; if (/hear|learn/.test(l)) return OPTS.hear;
  if (/hispanic/.test(l)) return OPTS.yesno; if (/gender/.test(l) || /how do you identify \(gender/.test(l)) return OPTS.gender; if (/race|ethnic/.test(l)) return OPTS.race; if (/veteran/.test(l)) return OPTS.veteran;
  if (/which u\.s\. state|province/.test(l)) return OPTS.state;
  return OPTS.yesno;
}
function wire(input) {
  let list = null;
  const close = () => { if (list) { list.remove(); list = null; } input.setAttribute('aria-expanded', 'false'); };
  const open = () => {
    close(); const q = input.value.toLowerCase(); list = document.createElement('div'); list.setAttribute('role', 'listbox');
    optionsFor(input).filter((o) => o.toLowerCase().includes(q)).forEach((o) => { const d = document.createElement('div'); d.setAttribute('role', 'option'); d.textContent = o;
      d.addEventListener('click', () => { window.__selected[input.id] = o; input.value = ''; let sv = input.closest('.select__control, div').querySelector('.mock-single-value'); if (!sv) { sv = document.createElement('span'); sv.className = 'mock-single-value'; input.parentElement.appendChild(sv); } sv.textContent = o; close();
        // REAL Greenhouse behaviour (found live): choosing the phone Country resets the form and clears everything typed so far. Reproduced here so tests catch fills that do not survive it.
        if (input.id === 'country' && document.getElementById('first_name')) { document.querySelectorAll('input:not([role=combobox]):not([type=hidden]):not([type=checkbox]):not([type=radio]), textarea').forEach((i) => { i.value = ''; }); window.__resets = (window.__resets || 0) + 1; }
      });
      list.appendChild(d); });
    input.parentElement.appendChild(list); input.setAttribute('aria-expanded', 'true');
  };
  input.addEventListener('focus', open); input.addEventListener('click', open); input.addEventListener('input', open);
}
document.querySelectorAll('input[role=combobox]').forEach(wire);
// Ashby-style yes/no buttons: toggle a pressed state (type=button, never submits)
document.querySelectorAll('[data-mock-yesno] button').forEach((b) => b.addEventListener('click', () => { const g = b.parentElement; g.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', 'false')); b.setAttribute('aria-pressed', 'true'); window.__selected[g.dataset.q] = b.textContent.trim(); }));
