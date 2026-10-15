// The text markers a team member's report opens with, as one definition for
// everything that reads them (NIB.39 item B): the pilot report script
// (scripts/team-pilot-report.mjs) and the host's tests. The contract in
// prompt.ts asks for the English markers; a member that localizes the marker
// (pt-BR) still counts, so a verdict or an opinion is never lost to wording.
// Plain JavaScript so node can run the script on the source tree.

/** `Verdict: no blockers` / `Verdict: blockers found`, and their pt-BR forms. */
export const REVIEW_VERDICT_PATTERN =
  '(?:Verdict|Veredito|Veredicto):\\s*(?:no blockers|blockers found|sem bloqueantes|sem bloqueios|bloqueantes encontrados|com bloqueantes|bloqueios encontrados)';

/** The advisor's opinion line (buildAdvisorAddendum), English and pt-BR forms. */
export const ADVISOR_OPINION_PATTERN =
  '(?:Independent opinion|Opini[aã]o independente|Parecer independente):\\s*(?:no material objections|approved with reservations|correct before proceeding|reconsider the approach|sem obje[cç][oõ]es materiais|aprovado com ressalvas|corrigir antes de prosseguir|reconsiderar a abordagem)';

/** Whether a verdict line means "no blockers" (true), "blockers found" (false) or is absent (null). */
export function readReviewVerdict(text) {
  const match = new RegExp(REVIEW_VERDICT_PATTERN, 'i').exec(text ?? '');
  if (!match) return null;
  return /no blockers|sem bloqueantes|sem bloqueios/i.test(match[0]);
}
