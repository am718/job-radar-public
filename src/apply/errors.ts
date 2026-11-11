/** Thrown by every guard that refuses to click/press/submit. */
export class SubmitGuardError extends Error {}
/** Thrown when anything tries to act on a page after handoff. It IS a SubmitGuardError, so one catch covers both. */
export class HandoffError extends SubmitGuardError {}
