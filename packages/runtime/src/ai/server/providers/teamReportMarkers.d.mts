/** `Verdict: no blockers` / `Verdict: blockers found`, and their pt-BR forms (a RegExp source). */
export const REVIEW_VERDICT_PATTERN: string;
/** The advisor's opinion line, English and pt-BR forms (a RegExp source). */
export const ADVISOR_OPINION_PATTERN: string;
/** Whether a verdict line means "no blockers" (true), "blockers found" (false) or is absent (null). */
export function readReviewVerdict(text: string | null | undefined): boolean | null;
