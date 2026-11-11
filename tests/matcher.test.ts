import { describe, it, expect } from 'vitest';
import { chromium } from 'playwright';
import { pickOption, noMatchReason } from '../src/apply/fill.js';
import { classify } from '../src/apply/classify.js';
import { isAllowedReadPost, isSubmitLike } from '../src/apply/guard.js';

const VERCEL_RACE = ['Black or of African descent', 'East Asian', 'Hispanic, Latinx or of Spanish Origin', 'Indigenous, American Indian or Alaska Native', 'Middle Eastern or North African', 'Native Hawaiian or Pacific Islander', 'South Asian', 'Southeast Asian', 'White or European', 'I prefer to self-describe', "I don't wish to answer"];
const ASHBY_RACE = ['Hispanic or Latino', 'White (Not Hispanic or Latino)', 'Black or African American (Not Hispanic or Latino)', 'Native Hawaiian or Other Pacific Islander (Not Hispanic or Latino)', 'Asian (Not Hispanic or Latino)', 'American Indian or Alaska Native (Not Hispanic or Latino)', 'Two or More Races (Not Hispanic or Latino)', 'Decline to self-identify'];

describe('fuzzy option matching (real option text from the live forms)', () => {
  it('Male matches Man (and never Woman / Female); Female matches Woman', () => {
    expect(pickOption(['Man', 'Non-binary', 'Woman', 'I prefer to self-describe', "I don't wish to answer"], 'Male', true).option).toBe('Man');
    expect(pickOption(['Male', 'Female', 'Decline to self-identify'], 'Male', true).option).toBe('Male');
    expect(pickOption(['Female', 'Non-binary'], 'Male', true).option).toBeNull();
    expect(pickOption(['Man', 'Woman'], 'Female', true).option).toBe('Woman');
  });
  it('Asian: one fitting option is chosen; several (East / South / Southeast Asian) are NOT guessed and are listed as ambiguous', () => {
    expect(pickOption(ASHBY_RACE, 'Asian', true)).toEqual({ option: 'Asian (Not Hispanic or Latino)', uncertain: true });
    const r = pickOption(VERCEL_RACE, 'Asian', true);
    expect(r.option).toBeNull(); expect(r.ambiguous).toEqual(['East Asian', 'South Asian', 'Southeast Asian']);
    expect(noMatchReason(VERCEL_RACE, 'Asian', r)).toMatch(/needs your answer.*East Asian \/ South Asian \/ Southeast Asian/);
    expect(pickOption(VERCEL_RACE, 'South Asian', true).option).toBe('South Asian');   // exact answer resolves it
  });
  it('Yes / No match "Yes, I am ..." / "No, I am not ..." style options; no false hit on "North" or "Not sure"-like words', () => {
    expect(pickOption(['Yes, I am authorized to work in the US', 'No, I am not'], 'Yes', true).option).toBe('Yes, I am authorized to work in the US');
    expect(pickOption(['Yes, I am a veteran or active member', 'No, I am not a veteran or active member', 'I prefer to self-describe', "I don't wish to answer"], 'No', true).option).toBe('No, I am not a veteran or active member');
    expect(pickOption(['North Dakota', 'Yes', 'No'], 'No', false).option).toBe('No');
    expect(pickOption(['Yes', 'No', "I don't wish to answer"], 'Maybe', true).option).toBeNull();
  });
  it('orientation: Heterosexual exact; Straight -> Heterosexual; decline wording maps to "I don\'t wish to answer"', () => {
    const o = ['Asexual', 'Bisexual and/or pansexual', 'Gay', 'Heterosexual', 'Lesbian', 'Queer', 'I prefer to self-describe', "I don't wish to answer"];
    expect(pickOption(o, 'Heterosexual', true)).toEqual({ option: 'Heterosexual', uncertain: false });
    expect(pickOption(o, 'Straight', true).option).toBe('Heterosexual');
    expect(pickOption(o, 'Decline To Self Identify', true).option).toBe("I don't wish to answer");
  });
  it('legal answers never use loose substring matching ("Yes, I am" does not become "Yes"); non-legal still may, flagged uncertain', () => {
    expect(pickOption(['Yes', 'No'], 'Yes, I am', true).option).toBeNull();
    expect(pickOption(['LinkedIn', 'Company website'], 'linkedin ads', false)).toEqual({ option: 'LinkedIn', uncertain: true });
  });
  it('null / empty answers pick nothing', () => { expect(pickOption(['Yes', 'No'], '', true).option).toBeNull(); });
});

describe('classifier regressions found on live forms', () => {
  it('"How do you pronounce your name?" is NOT a pronouns question; real pronoun questions still are', () => {
    expect(classify('Name Pronunciation | How do you pronounce your name?')).not.toBe('pronouns');
    expect(classify('Name Pronunciation | How do you pronounce your name?')).toBe('unknown');   // not the name either
    expect(classify('Legal First Name')).toBe('first_name'); expect(classify('Legal Last Name')).toBe('last_name'); expect(classify('Full name')).toBe('full_name'); expect(classify('Name')).toBe('full_name');
    expect(classify('What are your pronouns?')).toBe('pronouns');
    expect(classify('Pronouns')).toBe('pronouns');
  });
  it('"years of post college work experience" is NOT a school question; real school questions still are', () => {
    expect(classify('How many years of relevant, post college work experience do you have?')).not.toBe('school');
    expect(classify('Which university are you currently attending or did you last attend?')).toBe('school');
    expect(classify('School')).toBe('school');
  });
});

describe('guard: the only non-GET requests ever allowed', () => {
  const q = (op: string) => `https://jobs.ashbyhq.com/api/non-user-graphql?op=${op}`;
  it('allows Ashby read-only GraphQL queries that render the form', () => {
    for (const op of ['ApiOrganizationFromHostedJobsPageName', 'ApiJobPosting', 'ApiAutocompleteGeoLocation']) expect(isAllowedReadPost('POST', q(op), JSON.stringify({ operationName: op, query: 'query X { a }' }))).toBe(true);
  });
  it('blocks Ashby submissions, mutations, mismatched op names, other ops and other hosts', () => {
    expect(isAllowedReadPost('POST', q('ApiSubmitSingleApplicationFormAction'), JSON.stringify({ operationName: 'ApiSubmitSingleApplicationFormAction', query: 'mutation S { x }' }))).toBe(false);
    expect(isAllowedReadPost('POST', q('ApiJobPosting'), JSON.stringify({ operationName: 'ApiJobPosting', query: 'mutation S { x }' }))).toBe(false);
    expect(isAllowedReadPost('POST', q('ApiJobPosting'), JSON.stringify({ operationName: 'SomethingElse', query: 'query' }))).toBe(false);
    expect(isAllowedReadPost('POST', 'https://evil.example/api/non-user-graphql?op=ApiJobPosting', JSON.stringify({ operationName: 'ApiJobPosting' }))).toBe(false);
    expect(isAllowedReadPost('POST', q('ApiJobPosting'), 'not json')).toBe(false);
    expect(isAllowedReadPost('GET', q('ApiJobPosting'), null)).toBe(false);
  });
  it('allows only the Greenhouse presigned resume-upload bucket; the application POST and any other host stay blocked', () => {
    expect(isAllowedReadPost('POST', 'https://grnhse-prod-jben-us-east-1.s3.amazonaws.com/', null)).toBe(true);
    expect(isAllowedReadPost('POST', 'https://boards-api.greenhouse.io/v1/boards/vercel/jobs/7678262305', '{}')).toBe(false);
    expect(isAllowedReadPost('POST', 'https://job-boards.greenhouse.io/vercel/jobs/7678262305', '{}')).toBe(false);
    expect(isAllowedReadPost('POST', 'https://evilbucket.s3.amazonaws.com/', null)).toBe(false);
    expect(isAllowedReadPost('POST', 'https://grnhse-prod.s3.amazonaws.com.evil.example/', null)).toBe(false);
    expect(isAllowedReadPost('POST', 'http://grnhse-prod-jben-us-east-1.s3.amazonaws.com/', null)).toBe(false);
    expect(isAllowedReadPost('POST', 'https://c.spl.greenhouse.io/com.snowplowanalytics.snowplow/tp2', '{}')).toBe(false);
  });
  it('isSubmitLike: untyped button inside a form is still submit; untyped Yes/No button with no form is not; "Submit Application" is always submit', async () => {
    const b = await chromium.launch({ headless: true }); const p = await b.newPage();
    await p.setContent('<form><button id="a">Next</button></form><div><button id="yes">Yes</button><button id="sub">Submit Application</button><button id="ap">Apply now</button><button type="submit" id="t">Go</button></div>');
    expect(await isSubmitLike(p.locator('#a'))).toBe(true);
    expect(await isSubmitLike(p.locator('#yes'))).toBe(false);
    expect(await isSubmitLike(p.locator('#sub'))).toBe(true); expect(await isSubmitLike(p.locator('#ap'))).toBe(true); expect(await isSubmitLike(p.locator('#t'))).toBe(true);
    await b.close();
  }, 60000);
});

describe('Greenhouse apply URL', () => {
  it('a company-hosted careers page is replaced by the canonical board form; greenhouse.io URLs and unknown boards are left alone', async () => {
    const { canonicalGreenhouseUrl } = await import('../src/apply/ats.js');
    expect(canonicalGreenhouseUrl('https://careers.toasttab.com/jobs?gh_jid=1001284', '1001284', 'toast')).toBe('https://job-boards.greenhouse.io/toast/jobs/1001284');
    expect(canonicalGreenhouseUrl('https://job-boards.greenhouse.io/vercel/jobs/7678262305', '7678262305', 'vercel')).toBe('https://job-boards.greenhouse.io/vercel/jobs/7678262305');
    expect(canonicalGreenhouseUrl('https://boards.greenhouse.io/x/jobs/1?gh_src=a', '1', 'x')).toBe('https://boards.greenhouse.io/x/jobs/1?gh_src=a');
    expect(canonicalGreenhouseUrl('https://careers.example.com/jobs?gh_jid=5', '5', null)).toBe('https://careers.example.com/jobs?gh_jid=5');
    expect(canonicalGreenhouseUrl('https://careers.example.com/jobs?gh_jid=abc', 'abc', 'x')).toBe('https://careers.example.com/jobs?gh_jid=abc');
  });
});
