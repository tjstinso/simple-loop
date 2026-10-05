import { BREAKER_CLASSES, type Breakers } from './breaker.js';

/** The hidden marker of an ask's comment (one comment per ask id). */
export const askMarker = (chainId: number, askId: string): string => `<!-- factory:chain=${chainId} event=ask id=${askId} -->`;

/** What was tried: the failure classes with their counts, for the ask's comment. */
export function triedText(breakers: Breakers | undefined): string {
  const lines = BREAKER_CLASSES.flatMap((c) => {
    const b = breakers?.[c];
    return b !== undefined && (b.consecutiveFailures > 0 || b.opens > 0)
      ? [`- \`${c}\`: ${b.consecutiveFailures} consecutive failure(s), the breaker opened ${b.opens} time(s)`]
      : [];
  });
  return lines.length > 0 ? lines.join('\n') : '- nothing failed; the work stopped for the reason above';
}

/** The comment body (without the marker): the question, what was tried and the expected answer. */
export function buildAskComment(question: string, context: string, tried: string, options?: readonly string[]): string {
  const opts = options !== undefined && options.length > 0 ? `\n\nOptions:\n${options.map((o, i) => `${i + 1}. ${o}`).join('\n')}` : '';
  return [
    '**The factory needs a decision from a person.**',
    '',
    `Question: ${question}${opts}`,
    '',
    `Context: ${context}`,
    '',
    'What was tried:',
    tried,
    '',
    'Expected answer: reply with a comment or review on this pull request (or push a fix). The factory then resumes automatically with your answer, and its failure counts start again.',
  ].join('\n');
}
