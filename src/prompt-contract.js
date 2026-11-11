// @ts-check
/**
 * Glosses — Footnote contract (non-editable prompt header).
 *
 * The contract/vibe split, ported from DS Comments/src/prompt-contract.js:
 *
 *   - The CONTRACT (output format, JSON schema, format rules) lives here in
 *     code and is NON-EDITABLE — breaking it breaks parseResponse/validation.
 *   - The VIBE (voice, tone, what-to-footnote per style) lives in the
 *     editable prompts/*.md files.
 *
 * Before the split, the format rules below were duplicated (with slight
 * wording drift) inside every style file (pratchett.md, pratchett50.md,
 * academic.md, meta_plus.md), so a rules tweak required editing 4+ files.
 * loadPromptStyle injects FOOTNOTE_CONTRACT via the {{CONTRACT}} marker that
 * sits where the per-style "### Format requirements" section used to be —
 * so the assembled prompt is unchanged for the model.
 *
 * Style-specific tails that are NOT common (e.g. academic's "precise
 * explanation + etymology", meta's "2–4 sentences", pratchett50's extended
 * category-code list) stay in their own .md files after the marker.
 *
 * NOTE: language.md keeps its own IPA/CEFR-specific format section. hybrid.md
 * carries only the lens envelope (output language, one-lens-per-anchor, active
 * lenses) — all universal format and translation rules live in the contracts:
 * this file (classic styles via {{CONTRACT}}), generator.js's _CONTRACT_TAIL
 * (regular flow, all styles) and targeted-generation.js's inline contract.
 */

export const FOOTNOTE_CONTRACT = `### Footnote style requirements
- The response schema is defined by the [ANNOTATOR CONTRACT] block in the user message. Output only that JSON object; do not add prose or markdown fences.
- "anchor" MUST be the exact verbatim phrase from the source post. It is used to locate the source phrase; do not paraphrase, normalize, or add punctuation.
- Every "text" value begins with its superscript index using superscript digits for any number (¹, ², ..., ⁹, ¹⁰, ¹¹, ...), followed by the display label, a language/category code in parentheses, a spaced em-dash ( — ), and the footnote body. That em-dash is structural: rendering splits the footnote into a title plus a body at it.
- The display label starts with a capital letter and uses the nominative case, 1–4 words — never the full anchored narration clause (the clause stays in "anchor"; a quoted foreign phrase serves as its own label, and it must contain no spaced em-dash). Standard language tags such as (англ.), (Fr.) or (Jap.) keep their usual form. Capitalize the category code and end it with a dot.
- If the word appears in the source text in a non-nominative form (for example, "благовониями", "сурьмой", or "сына Гора"), use the nominative display label in "text" (for example, "Благовония", "Сурьма", or "Сын Гора") while retaining the exact source phrase in "anchor". Do NOT put bracket notation in the "text" field.
- Translation rule: a phrase the post quotes in a language different from the narration language MUST get a footnote, and its body must open with the translation. Do NOT create a translation footnote for wording already rendered in the narration language, even if the story says a character speaks another language.
- Language/category codes may include (It.), (Fr.), (Lat.), (Ger.), (Eng.), (Jap.), (Sp.), (Archaic.), (Demonic.), (Ironic.), or (Historical.).
- Scan the whole post before choosing anchors. When several honest anchors are available, spread footnotes across the beginning, middle, and end instead of clustering them in the opening.`;
