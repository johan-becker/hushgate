/**
 * Which extractor gets to try, and in what order.
 *
 * Operator-provided extractors come first. That ordering is the whole point of
 * having them: an operator who has installed a better tool for a format than
 * the one built in here has said, by configuring it, that theirs should win.
 * The built-in tier is the floor, not the preference.
 *
 * PDF is absent from the built-in tier on purpose. A from-scratch PDF text
 * extractor was written and measured while this feature was designed, and its
 * failure mode was the one hushgate cannot tolerate: on ordinary real-world
 * documents it produced fluent-looking output with the names, addresses and
 * reference numbers missing, or with words split so finely that no detector
 * could match an identifier in them. Refusing PDFs until an operator points at
 * a real extractor is the honest position, and `doctor` says so out loud.
 */
import { emlExtractor } from './eml.js';
import { externalExtractor } from './external.js';
import { htmlExtractor } from './html.js';
import { ooxmlExtractor } from './ooxml.js';
import { plaintextExtractor } from './plaintext.js';
import { rtfExtractor } from './rtf.js';
import type { ExternalExtractorSpec, Extractor } from './types.js';

/** The tier that is always present, in the order it is tried. */
export const BUILTIN_EXTRACTORS: readonly Extractor[] = [
  ooxmlExtractor,
  emlExtractor,
  htmlExtractor,
  rtfExtractor,
  // Last: it accepts almost anything that decodes as text, so an earlier
  // extractor that understands the container must get first refusal.
  plaintextExtractor,
];

/** Everything that may run, operator-configured first. */
export function buildExtractors(specs: readonly ExternalExtractorSpec[]): readonly Extractor[] {
  return [...specs.map(externalExtractor), ...BUILTIN_EXTRACTORS];
}
