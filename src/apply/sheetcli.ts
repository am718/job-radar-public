import 'dotenv/config';
import { openDb } from '../store.js';
import { loadAnswers } from './answers.js';
import { buildSheet } from './sheet.js';
const key = process.argv[2];
if (!key) { console.error('usage: npm run sheet -- <source:id>'); process.exit(1); }
try { console.log(buildSheet(openDb(), key, loadAnswers(process.env.JOB_RADAR_ANSWERS ?? 'answers.json'))); } catch (e) { console.error((e as Error).message); process.exit(1); }
