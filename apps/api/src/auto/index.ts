// The process-wide AUTO gate (ADR-0030). Same Clef endpoint, per-user switch
// and outage notice as the AI check of allow pauses (ADR-0029): the outage
// object IS the pause gate's, so one card / one push covers both.
// AUTO_THRESHOLD (default 0.8; not a number in (0, 1] = the default, logged).
import { clefConfig } from '../clef/index.js';
import { pauseGate } from '../pausecheck/index.js';
import { AutoGate, autoThresholdFromEnv } from './gate.js';

const threshold = autoThresholdFromEnv(process.env.AUTO_THRESHOLD);
if (clefConfig) console.log(`auto: Clef at ${clefConfig.host}, threshold ${threshold}`);

export const autoGate = new AutoGate(clefConfig, threshold, pauseGate.outage);
