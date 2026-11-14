// @ts-check
/**
 * Glosses — Few-shot prompt examples, keyed by [surface][locale] (hybrid +
 * language; the former classic-style keys are retired with the styles).
 *
 * Extracted verbatim from generator.js (pure data, no imports): these live in
 * code (not in the .md files) because they need to vary by output language and
 * embed the exact superscript format the parser expects. generator.js is the
 * only consumer.
 */
export const PROMPT_EXAMPLES = {
    language: {
        en: {
            forward: `### Examples

**Single word with instructive translation (source: "He felt a strange tension"):**
\`\`\`json
{
  "footnotes": [
    {
      "anchor": "напряжение",
      "text": "¹ Напряжение (Eng.) — Tension · /ˈtɛnʃən/ · «téhn-shn» · mnemonic: from tense (напряжённый) · collocation: under tension — под напряжением"
    }
  ]
}
\`\`\`

**Word with multiple meanings (source: "Drago could not explain this strange feeling"):**
\`\`\`json
{
  "footnotes": [
    {
      "anchor": "чувство",
      "text": "¹ Чувство (Eng.) — Feeling · /ˈfiːlɪŋ/ · «féeling» · also: sense (чувство/смысл), emotion (эмоция) · collocation: a sense of — чувство чего-либо"
    }
  ]
}
\`\`\`

**Phrase (source: "She became absolutely devoted"):**
\`\`\`json
{
  "footnotes": [
    {
      "anchor": "абсолютный",
      "text": "¹ Абсолютный (Eng.) — Absolute · /ˈæbsəluːt/ · «ábsolút» · from Lat. absolutus — unlimited · mnemonic: ab(olute)ly = абсолютно"
    }
  ]
}
\`\`\`

**Text-only fallback example:**
¹ Напряжение (Eng.) — Tension · /ˈtɛnʃən/ · «téhn-shn» · from tense · collocation: under tension`,
            reverse: `### Examples

**Word in the study language explained in the reader's language (source: "Его упорство удивило всех"):**
\`\`\`json
{
  "footnotes": [
    {
      "anchor": "упорство",
      "text": "¹ Упорство (Ru.) — Persistence, tenacity · /ʊpɐˈrostvə/ · «oo-porst-va» · mnemonic: упор — he puts up a fight · collocation: с упорством — with persistence"
    }
  ]
}
\`\`\`

**Text-only fallback example:**
¹ Упорство (Ru.) — Persistence, tenacity · /ʊpɐˈrostvə/ · «oo-porst-va» · from упорный`,
        },
        ru: {
            forward: `### Examples

**Single word with instructive translation (source: "Он ощущал странное напряжение"):**
\`\`\`json
{
  "footnotes": [
    {
      "anchor": "напряжение",
      "text": "¹ Напряжение (англ.) — Tension · /ˈtɛnʃən/ · «те́ншн» · мнемоника: от tense (напряжённый) · коллокация: under tension — под напряжением"
    }
  ]
}
\`\`\`

**Word with multiple meanings (source: "Драго не мог объяснить это странное чувство"):**
\`\`\`json
{
  "footnotes": [
    {
      "anchor": "чувство",
      "text": "¹ Чувство (англ.) — Feeling · /ˈfiːlɪŋ/ · «фи́линг» · also: sense (чувство/смысл), emotion (эмоция) · коллокация: a sense of — чувство чего-либо"
    }
  ]
}
\`\`\`

**Phrase (source: "Она превратилась в абсолютный куль"):**
\`\`\`json
{
  "footnotes": [
    {
      "anchor": "абсолютный",
      "text": "¹ Абсолютный (англ.) — Absolute · /ˈæbsəluːt/ · «а́бсолю́т» · от лат. absolutus — неограниченный · мнемоника: ab(olute)ly = абсолютно"
    }
  ]
}
\`\`\`

**Text-only fallback example:**
¹ Напряжение (англ.) — Tension · /ˈtɛnʃən/ · «те́ншн» · от tense · коллокация: under tension`,
            reverse: `### Examples

**Слово на изучаемом языке с объяснением на языке читателя (source: "His tenacity surprised everyone"):**
\`\`\`json
{
  "footnotes": [
    {
      "anchor": "tenacity",
      "text": "¹ Tenacity (англ.) — Упорство, настойчивость · /təˈnæsɪti/ · «тэна́сити» · мнемоника: ten-acity — держится «десятью руками» · коллокация: sheer tenacity — чистое упрямство"
    }
  ]
}
\`\`\`

**Text-only fallback example:**
¹ Tenacity (англ.) — Упорство, настойчивость · /təˈnæsɪti/ · «тэна́сити» · от tenacious`,
        },
    },
    // Hybrid mixed-lens examples. Intentionally mix lenses on the SAME Post
    // text so the model learns to switch lenses per anchor — including a
    // situation-level (multi-word clause) anchor winning the Pratchett lens.
    hybrid: {
        en: `### Examples (mixed lenses — copy this switching behaviour)

Post (context only; footnote its words/phrases/situations, not wholesale).
"She whispered 'valar morghulis' and sat on the Iron Throne, the blade edges biting through her gown. The hall held its breath."

¹ Valar morghulis ({{TARGET_LANG_LABEL}}) — Valar morghulis · /ˈvalar ˈmorɡulis/ · «váh-lar mor-gúh-liss» · mnemonic: valar (all men) + morghulis (must die) · collocation: valar dohaeris — "all men must serve" (the traditional response).

² Iron Throne (Canon.) — Seat of the House of the Dragon in King's Landing, forged by Aegon the Conqueror from the swords of defeated enemies. Per canon, its blades cut whoever sits on it — a deliberate reminder that power should never be comfortable.

³ Coronation (Pratchett.) — Traditionally the moment a monarch settles into power. Here, power settles into her — with some interest. The throne, famously made of swords, takes the job of "ruling uncomfortably" rather literally; one might suggest it is overachieving.
Anchor in JSON: "sat on the Iron Throne, the blade edges biting through her gown"
⁴ Held breath (Narrative.) — The hall holds its breath for a woman who just traded a kill-phrase for a chair made of swords. The author believes untranslated menace substitutes for character motivation. It does not. Somewhere, a footnote generator is being underpaid to point this out.
Anchor in JSON: "The hall held its breath"`,
        ru: `### Examples (mixed lenses — copy this switching behaviour)

Post (context only; footnote its words/phrases/situations, not wholesale).
«Она прошептала „valar morghulis" и села на Железный трон, лезвия врезаясь в её платье. Зал затаил дыхание.»

¹ Valar morghulis ({{TARGET_LANG_LABEL}}) — Valar morghulis · /ˈvalar ˈmorɡulis/ · «ва́лар мор-гу́лис» · мнемоника: valar (все люди) + morghulis (должны умереть) · коллокация: valar dohaeris — «все люди должны служить» (традиционный ответ).

² Железный трон (Канон.) — Резной трон Дома Дракона в Королевской Гавани, выкован Эйгоном Завоевателем из мечей поверженных врагов. По канону, его лезвия режут всякого сидящего — намеренное напоминание о том, что власть не должна быть удобной.

³ Коронация (Пратчетт.) — Традиционно момент, когда монарх входит во власть. Здесь власть входит в неё — причём с интересом. Трон, как известно, сделан из мечей, и работу «править неудобно» понимает весьма буквально; можно сказать, перевыполняет план.
Anchor in JSON: "села на Железный трон, лезвия врезаясь в её платье"
⁴ Затаившееся дыхание (Нарратив.) — Зал затаивает дыхание для женщины, которая только что обменяла убийственную фразу на трон из мечей. Автор полагает, что непереведённая угроза заменяет мотивацию персонажа. Это не так. Где-то генератор сносок недополучает за то, что указывает на это.
Anchor in JSON: "Зал затаил дыхание"`,
    },
};
