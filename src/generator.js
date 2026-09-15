// @ts-check
/**
 * Glosses — Generator module
 * System/user prompt assembly, API calls, generation orchestration.
 *
 * Direct single-call generation: one API request returns up to N footnotes.
 * The model produces a {"footnotes":[...]} response; no candidate pool,
 * no reserve, no second request, no fill-loop. Prior anchors are supplied
 * as a soft advisory only; forced exclusions are strictly enforced.
 *
 * The PROMPT_EXAMPLES, BASE_SYSTEM_PROMPT blocks and the loadPromptStyle/
 * interpolateLangPrompt logic are unchanged from the original.
 */

import {
    state, S, getCtx, getExtBase, warn, error, extractPlainText, t,
    DEFAULT_SETTINGS,
} from './core.js';
import { FOOTNOTE_CONTRACT } from './prompt-contract.js';
import {
    digestFor, variantIsViable, saveFootnotes, listFootnoteSets,
    getForcedIgnore, getPoolExcluded,
} from './cache.js';
import { isTranslatedView } from './domain/message-identity.js';
import { collectExplainedAnchors, combineForbiddenAnchors } from './anchor-policy.js';
import { findAnchorInText } from './anchor-utils.js';
import { getChatLoreConfig, collectAutomaticLore, LORE_MODE, LORE_SCOPE } from './lorebooks.js';
import { buildTextIndex, computeContextSelectors, findFuzzySpan } from './text-index.js';
import { parseResponse, validateFootnotes, validateFootnotesAgainstText, normalizeFootnotes, indexToSuperscript } from './parser.js';
import { injectHighlights, setSpinner } from './renderer.js';
import { updatePanel, panelInvalidate } from './ui/window.js';
import { playSound } from './sound.js';
import { generationCoordinator } from './application/generation-coordinator.js';

// ══════════════════════════════════════════════════════════════════════════════
// BASE SYSTEM PROMPTS
// ══════════════════════════════════════════════════════════════════════════════

const BASE_SYSTEM_PROMPT = `You are ABfootnote, a deterministic footnote extraction utility for SillyTavern.
Your task is NOT roleplay, NOT chat continuation, NOT creative writing.
Read the provided [Annotate this post] block and create footnotes for that exact post.
Never continue the scene. Never write narrative prose. Never imitate the character.

## SCENE FOCUS
The [Annotate this post] block is the post you annotate — your ONLY target. All other blocks ([Earlier in the scene], character, world info) are background that helps you understand the target. Use the background to understand the target; annotate the target only.

Follow the [ANNOTATOR CONTRACT] in the user message exactly for the JSON schema, count, anchor format, and footnote structure.`;

const BASE_SYSTEM_PROMPT_LANG = `You are ABfootnote — a language-learning footnote generator for SillyTavern.
For every interesting word or phrase in [Annotate this post], output a footnote that teaches its translation to the target language.
Never continue the scene. Never write narrative prose. Never imitate the character.

## SCENE FOCUS
The [Annotate this post] block is the post you annotate — your ONLY target. All other blocks are background that helps you understand the target. Use the background to understand the target; annotate the target only.

Follow the [ANNOTATOR CONTRACT] in the user message exactly for the JSON schema, count, anchor format, and footnote structure.`;

// Constructed / fictional target languages. When the target is in this set,
// {{CONLANG_NOTE}} is expanded into an attestation-honesty nudge in language.md.
// Esperanto (`eo`) and Toki Pona (`tok`) are real but constructed — the note
// still applies (it asks for canonically attested forms, not invented ones).
const CONLANG_CODES = new Set(['hvl', 'tlh', 'sin', 'quen', 'eo', 'tok']);

// Body of the {{CONLANG_NOTE}} block, embedded into language.md. Contains a
// {{TARGET_LANG_NAME}} token so it must be substituted BEFORE that placeholder
// is expanded in interpolateLangPrompt.
const CONLANG_NOTE_BODY = `### Attestation note (constructed / fictional target)
The target language {{TARGET_LANG_NAME}} is a constructed or fictional
language. Use only canonically attested words and IPA transcriptions — do not
invent vocabulary. If a translation must be reconstructed from attested roots,
explicitly mark it with "(reconstructed)". If the phonology of a word is
unattested, state that plainly instead of inventing IPA.`;

// Hybrid footnote mode: several lenses are active at once. The model picks the
// ONE best-fitting lens per anchor and produces exactly one footnote for it;
// the category label reveals which lens won. See spec
// 2026-07-02-glosses-hybrid-mode-design.md.
const BASE_SYSTEM_PROMPT_HYBRID = `You are ABfootnote — a hybrid footnote generator for SillyTavern.
For each interesting word, phrase, or situation in [Annotate this post], select the ONE lens that best fits it and apply ONLY that lens's format to produce exactly one footnote for that anchor. The category label in parentheses reveals which lens you chose. Never produce two footnotes for the same anchor.
Never continue the scene. Never write narrative prose. Never imitate the character.

## SCENE FOCUS
The [Annotate this post] block is the post you annotate — your ONLY target. All other blocks are background that helps you understand the target. Use the background to understand the target; annotate the target only.

Follow the [ANNOTATOR CONTRACT] in the user message exactly for the JSON schema, count, anchor format, and footnote structure.`;

// Few-shot examples keyed by [style][locale]. These live in code (not in the
// .md files) because they need to vary by output language and embed the exact
// superscript format the parser expects.
const PROMPT_EXAMPLES = {
    pratchett: {
        en: `### Examples (exact output format — copy this structure)

¹ Madonna (It.) — An exclamation of shock, literally "the Virgin Mary." Although, given what's happening in the room, the Virgin would most likely prefer to pretend she was never here and quietly slip out the back door.

² Baisse le son, tu vas réveiller les morts (Fr.) — "Turn it down, you'll wake the dead." A fundamentally incorrect claim: as any practicing necromancer knows, the dead sleep remarkably soundly, and raising them requires at minimum a sacrificial goat, not merely loud music.

³ Cruciatus (Lat.) — An unforgivable curse causing unbearable pain. Considered poor etiquette in polite society, though unfortunately polite society usually ends right where dark wizards with bad childhoods begin.

Example with non-nominative anchor (source text: "rubbed with kohl"):
⁴ Kohl (hist.) — Traditional ancient Egyptian eye cosmetic made from ground galena. Served both a sacred-aesthetic and practical function, shielding the optic nerve from harsh sun and infection.
Anchor in JSON: "rubbed with kohl"

Example with phrase anchor (source text: "son of Horus"):
⁵ Son of Horus (myth.) — Horus was the falcon-headed sky god, known for his vindictiveness and his talent for losing important body parts in family squabbles. Direct descent from him automatically guaranteed perfect posture, innate pomposity, and an acute need to look down on everyone else as something stuck to the sole of a sandal.
Anchor in JSON: "son of Horus"`,
        ru: `### Examples (exact output format — copy this structure)

¹ Madonna (ит.) — Выражение шока, буквально «Богоматерь». Хотя, учитывая происходящее в комнате, Богоматерь, скорее всего, предпочла бы сделать вид, что её здесь нет, и тихо уйти через чёрный ход.

² Baisse le son, tu vas réveiller les morts (фр.) — «Убавь звук, ты мертвых разбудишь». Утверждение в корне неверное: как известно любому практикующему некроманту, мёртвые спят на удивление крепко, и чтобы их разбудить, требуется как минимум жертвенный козёл, а не просто громкая музыка.

³ Cruciatus (лат.) — Непростительное проклятие, причиняющее невыносимую боль. В приличном обществе считается дурным тоном, но, к сожалению, приличное общество обычно заканчивается там, где начинаются тёмные маги с плохим детством.

Example with non-nominative anchor (source text: "натёрла сурьмой"):
⁴ Сурьма (историч.) — Традиционная древнеегипетская подводка для глаз, изготавливавшаяся из растёртого галенита. Выполняла как сакрально-эстетическую функцию, так и практическую, защищая зрительный нерв от палящего солнца и инфекций.
Anchor in JSON: "натёрла сурьмой"

Example with phrase anchor (source text: "сына Гора"):
⁵ Сын Гора (мифол.) — Гор был богом неба с головой сокола, известным своей мстительностью и талантом терять важные части тела в семейных ссорах. Прямое родство с ним автоматически гарантировало идеальную осанку, врождённый пафос и острую потребность смотреть на всех остальных как на нечто, прилипшее к подошве сандалии.
Anchor in JSON: "сына Гора"`,
    },
    pratchett50: {
        en: `### Examples (exact output format — copy this structure)

**Foreign phrase — translation first, Pratchett remark earns its place:**
¹ Baisse le son, tu vas réveiller les morts (Fr.) — "Turn it down, you'll wake the dead." A stock hyperbolic complaint. As any practicing necromancer knows, the dead actually sleep remarkably soundly, and their awakening requires at minimum a sacrificial goat, not merely loud music.

**Technical term — precise definition, dry remark at the end:**
² Nanobots (Tech.) — Hypothetical molecular-scale devices designed to perform tasks inside the body: drug delivery, diagnostics, tissue repair. Hypothetical — because real engineers are currently occupied with making regular printers work at least half the time.

**Real geographical location — factual note, remark only if genuinely apt:**
³ Café de Flore (Geo.) — Café at 172 Boulevard Saint-Germain, Paris, founded in 1887. Regular haunt of Jean-Paul Sartre and Simone de Beauvoir in the 1940s; still considered an intellectual landmark of the Left Bank. Eight euros for an espresso — that's not for the coffee, it's for the right to sit next to the ghost of existentialism.

**Historical event — what and when, Pratchett iff warranted:**
⁴ Battle of Waterloo (Hist.) — Fought on 18 June 1815 near the eponymous village in Belgium, where the Seventh Coalition under the Duke of Wellington and Marshal Blücher delivered the final defeat to Napoleon's army. For Napoleon, this was Europe's definitive "no" — politely worded enough not to explain the reasons, yet convincing enough that seventy thousand bayonets did the job.

**Fictional-universe canon — factual first, irony welcome:**
⁵ Avada Kedavra (Canon) — One of the three Unforgivable Curses in J. K. Rowling's legendarium; causes instant death without visible bodily damage. First appears in "Goblet of Fire" (2000). The only documented way to survive is to be the main character and have enough books left in the series.

**Cultural reference / jargon — full Pratchett:**
⁶ Cruciatus (Lat.) — An unforgivable curse causing unbearable pain. Considered poor form in polite society, but polite society usually ends precisely where dark wizards with troubled childhoods and grudge lists longer than "War and Peace" begin.

Example with non-nominative anchor (source text: "rubbed with kohl"):
⁷ Kohl (Hist.) — A cosmetic compound based on ground galena (lead sulfide), used in ancient Egypt as eye lining; applied with a sharpened stick, simultaneously protecting against sun and infection. That galena contained lead did not deter the Egyptians — they were realists.

Example with phrase anchor (source text: "son of Horus"):
⁸ Son of Horus (Myth.) — Descendant of Horus, the ancient Egyptian falcon-headed sky god and patron of pharaohs. Direct lineage automatically guaranteed impeccable posture, innate pomposity, and the habit of looking at everyone as something stuck to the sole of a sandal.`,
        ru: `### Examples (exact output format — copy this structure)

**Foreign phrase — translation first, Pratchett remark earns its place:**
¹ Baisse le son, tu vas réveiller les morts (фр.) — «Убавь звук, ты мертвецов разбудишь». Устойчивое разговорное преувеличение. Как известно любому практикующему некроманту, мёртвые на самом деле спят на удивление крепко, и для их пробуждения требуется как минимум жертвенный козёл, а не просто громкая музыка.

**Technical term — precise definition, dry remark at the end:**
² Наноботы (техн.) — Гипотетические устройства молекулярного масштаба, спроектированные для выполнения задач внутри организма: доставки лекарств, диагностики, восстановления тканей. Гипотетические — потому что реальные инженеры пока заняты тем, чтобы обычные принтеры работали хотя бы через раз.

**Real geographical location — factual note, remark only if genuinely apt:**
³ Café de Flore (геогр.) — Кафе на бульваре Сен-Жермен, 172, Париж, основано в 1887 году. Постоянное место Жан-Поля Сартра и Симоны де Бовуар в 1940-х; по сей день считается интеллектуальным символом Левого берега. Восемь евро за эспрессо — это не за кофе, это за право занять стул рядом с призраком экзистенциализма.

**Historical event — what and when, Pratchett iff warranted:**
⁴ Битва при Ватерлоо (историч.) — Сражение 18 июня 1815 года близ одноимённой деревни в Бельгии, в котором силы Седьмой коалиции под командованием герцога Веллингтона и фельдмаршала Блюхера нанесли окончательное поражение армии Наполеона. Для Наполеона это стало окончательным «нет» со стороны Европы — достаточно вежливым, чтобы не объяснять причин, и достаточно убедительным, чтобы хватило семидесяти тысяч штыков.

**Fictional-universe canon — factual first, irony welcome:**
⁵ Авада Кедавра (канон.) — Одно из трёх Непростительных заклятий в легендариуме Дж. К. Роулинг; вызывает мгновенную смерть без видимых повреждений тела. Впервые появляется в «Кубке огня» (2000). Единственный задокументированный способ выжить — быть главным героем и иметь достаточно книг в серии.

**Cultural reference / jargon — full Pratchett:**
⁶ Cruciatus (лат.) — Непростительное проклятие, причиняющее невыносимую боль. В приличном обществе считается дурным тоном, но приличное общество обычно заканчивается именно там, где начинаются тёмные маги с плохим детством и списком обид длиннее, чем «Война и мир».

Example with non-nominative anchor (source text: "натёрла сурьмой"):
⁷ Сурьма (историч.) — Косметическая смесь на основе растёртого галенита (сульфида свинца), применявшаяся в Древнем Египте как подводка для глаз; наносилась заострённой палочкой, одновременно защищая от солнца и инфекций. То, что галенит содержит свинец, египтян не останавливало — они были реалистами.

Example with phrase anchor (source text: "сына Гора"):
⁸ Сын Гора (мифол.) — Потомок Гора, египетского бога неба с головой сокола, покровителя фараонов. Прямое родство автоматически гарантировало безупречную осанку, врождённый пафос и привычку смотреть на окружающих как на нечто, прилипшее к подошве сандалии.`,
    },
    meta_plus: {
        en: `### Examples (exact output format — copy this structure)

¹ Dark Cave (litcrit.) — The author spent three paragraphs describing the darkness in a cave that, as it turns out, had torches standing in it. The writer apparently believed "dark" was synonymous with "atmospheric." He was wrong.

² Hero Charges Into Battle (narrative.) — In Chapter 12, this same character broke his ribs falling down a three-step staircase. Now he's charging twenty armed goblins with a single poker. Apparently the ribs healed extraordinarily fast — or the author simply forgot.

³ "Forewarned Is Forearmed" (fourthwall.) — Does the reader genuinely believe this character will ever be both forewarned and forearmed simultaneously? The author has promised three times that "next time will be worse." So far, only the prose is getting worse.

⁴ Dungeon Civil Code (archive.) — §7.3.2 of the Dungeon Civil Code: "Any party discovering a treasure chest is required to first check for mimics, and then for more dangerous mimics. In the event of a mimic of a mimic, legal counsel is recommended — provided the mimic hasn't eaten counsel first."

⁵ On the Dark Lord's Sword (gossip.) — In the taverns they whisper that the Dark Lord's sword was actually bought at a clearance sale in an arms shop for three copper pennies and sharpened by a driver who quit after the first swing. The Lord, of course, maintains it is "a ritual blade of ancient times." The driver disagrees.

⁶ Knocking at the Door (folklore.) — If someone knocks three times at midnight — it's spirits. Four times — it's the postman. Five times — it's spirits who have learned to count and decided to frighten you even more.

⁷ "I Am Unstoppable" (irony.) — The character announces this with the confidence of someone who has clearly never been stopped before, which statistically means his first time is about three paragraphs away.

⁸ The Final Stand (bathos.) — A three-page monologue about honor, destiny, and the weight of centuries of dragon blood — interrupted by a sneeze that sends him stumbling off the edge of the parapet. The narrative budget has been spent.

⁹ "Just a Scratch" (litotes.) — The character lost an arm. The text calls it "a minor inconvenience." The remaining four paragraphs describe, in forensic detail, how the arm is currently on the other side of the courtyard.

¹⁰ Hero Before a Mirror (intertext.) — Hamlet held a skull. Our hero holds a hairbrush and delivers the same soliloquy to his own reflection, minus the philosophical depth but plus surprisingly specific hair care advice.

¹¹ "An Army of Thousands" (hyperbol.) — The text claims the army stretched "from horizon to horizon." At standard marching density, that is roughly 4.7 soldiers and one very confused goat.`,
        ru: `### Examples (exact output format — copy this structure)

¹ Тёмная пещера (литкрит.) — Автор потратил три абзаца на описание темноты в пещере, где, как выясняется, стояли факелы. Писатель, видимо, полагал, что «тёмный» — это синоним «атмосферного». Он ошибался.

² Герой врывается в бой (нарратив.) — В главе 12 этот же персонаж сломал себе рёбра после падения с лестницы из трёх ступенек. Теперь он бросается на двадцать вооружённых гоблинов с одной кочергой. Видимо, рёбра срослись экстремально быстро — или автор просто забыл.

³ «Предупреждён — значит вооружён» (четв.стена) — Интересно, читатель действительно верит, что этот персонаж когда-нибудь будет предупреждён и вооружён одновременно? Автор уже три раза обещал, что «в следующий раз будет хуже». Пока что хуже становится только прозе.

⁴ Гражданский кодекс Подземелья (архив.) — Статья 7.3.2 Гражданского Кодекса Подземелья: «Любая партия, обнаружившая сундук с сокровищами, обязана сначала проверить его на наличие мимиков, а затем — на наличие более опасных мимиков. В случае обнаружения мимика мимика рекомендуется обратиться к юристу, если мимик не съел юриста первым.»

⁵ О мече Тёмного Лорда (сплетня) — В тавернах шепчут, что меч Тёмного Лорда на самом деле был куплен на распродаже в оружейной лавке за три медяка и подточен шофёром, который уволился после первого же замаха. Лорд, впрочем, утверждает, что это «ритуальный клинок древних времён». Шофёр утверждает иначе.

⁶ Стук в дверь (примета) — Если в полночь в дверь стучат трижды — это духи. Если четыре раза — это почтальон. Если пять раз — это духи, которые научились считать и решили вас напугать ещё сильнее.

⁷ «Меня не остановить» (ирония) — Персонаж произносит это с уверенностью человека, которого, судя по статистике, ещё никогда не останавливали. Что математически означает: первый раз — через абзац.

⁸ Последний бой (батос) — Трёхстраничный монолог о чести, предназначении и весе веков драконьей крови — прерванный чихом, от которого он спотыкается и падает с парапета. Нарративный бюджет исчерпан.

⁹ «Царапинка» (лифтез) — Персонаж потерял руку. Текст называет это «незначительным неудобством». Остальные четыре абзаца описывают в судебно-медицинских подробностях, как рука в данный момент находится на другом конце двора.

¹⁰ Герой перед зеркалом (интекст.) — Гамлет держал череп. Наш герой держит расчёску и произносит тот же монолог перед собственным отражением — без философской глубины, но с неожиданно подробными рекомендациями по уходу за волосами.

¹¹ «Армия в тысячи воинов» (гиперб.) — Текст утверждает, что армия тянулась «от горизонта до горизонта». При стандартной плотности марша это примерно 4,7 солдата и один растерянный козёл.`,
    },
    academic: {
        en: `### Examples (exact output format — copy this structure)

¹ Cruciatus (Lat., from crucio — "to torture") — In J. K. Rowling's legendarium, one of the three Unforgivable Curses; inflicts intense pain without physical damage. First mentioned in "Harry Potter and the Goblet of Fire" (2000).

² Baisse le son, tu vas réveiller les morts (Fr.) — "Turn it down, you'll wake the dead." Colloquial French expression used as a hyperbolic complaint about excessive noise.

³ Shendyt (Arch., anc. Egyp.) — Traditional ancient Egyptian linen loincloth; a basic element of male attire across all social strata, secured by a belt of varying complexity depending on the wearer's status.

Example with non-nominative anchor (source text: "rubbed with kohl"):
⁴ Kohl (Hist.) — Traditional cosmetic compound based on galena (lead sulfide), used in ancient Egypt as eye lining; applied with a sharpened stick.

Example with phrase anchor (source text: "son of Horus"):
⁵ Son of Horus (Myth.) — Designation for a descendant of Horus, the falcon-headed sky god; inheritor of his cult and the mythological status of protector of royal authority.`,
        ru: `### Examples (exact output format — copy this structure)

¹ Cruciatus (лат., от crucio — «мучить») — В легендариуме Дж. К. Роулинг одно из трёх Непростительных заклятий; вызывает интенсивную боль без физических повреждений. Впервые упоминается в «Гарри Поттере и Кубке огня» (2000).

² Baisse le son, tu vas réveiller les morts (фр.) — «Убавь звук, ты мертвых разбудишь». Разговорное французское выражение, употребляется как гиперболическое указание на чрезмерный шум.

³ Shendyt (архаич., др.-егип.) — Традиционная древнеегипетская набедренная повязка из льна; базовый элемент мужского костюма всех социальных слоёв, фиксировавшийся поясом различной степени сложности в зависимости от статуса владельца.

Example with non-nominative anchor (source text: "натёрла сурьмой"):
⁴ Сурьма (историч.) — Традиционная косметическая смесь на основе галенита (сульфида свинца), использовавшаяся в Древнем Египте в качестве подводки для глаз; наносилась заострённой палочкой.

Example with phrase anchor (source text: "сына Гора"):
⁵ Сын Гора (мифол.) — Обозначение потомка Гора, бога неба с головой сокола; наследник его культа и мифологического статуса защитника царской власти.`,
    },
    language: {
        en: `### Examples

**Single word with instructive translation (source: "He felt a strange tension"):**
\`\`\`json
{
  "footnotes": [
    {
      "anchor": "напряжение",
      "text": "¹ напряжение (Eng.) — tension · /ˈtɛnʃən/ · «téhn-shn» · mnemonic: from tense ( напряжённый) · collocation: under tension — под напряжением"
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
      "text": "¹ чувство (Eng.) — feeling · /ˈfiːlɪŋ/ · «féeling» · also: sense (чувство/смысл), emotion (эмоция) · collocation: a sense of — чувство чего-либо"
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
      "text": "¹ абсолютный (Eng.) — absolute · /ˈæbsəluːt/ · «ábsolút» · from Lat. absolutus — unlimited · mnemonic: ab(olute)ly = абсолютно"
    }
  ]
}
\`\`\`

**Text-only fallback example:**
¹ напряжение (Eng.) — tension · /ˈtɛnʃən/ · «téhn-shn» · from tense · collocation: under tension`,
        ru: `### Examples

**Single word with instructive translation (source: "Он ощущал странное напряжение"):**
\`\`\`json
{
  "footnotes": [
    {
      "anchor": "напряжение",
      "text": "¹ напряжение (англ.) — tension · /ˈtɛnʃən/ · «те́ншн» · мнемоника: от tense (напряжённый) · коллокация: under tension — под напряжением"
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
      "text": "¹ чувство (англ.) — feeling · /ˈfiːlɪŋ/ · «фи́линг» · also: sense (чувство/смысл), emotion (эмоция) · коллокация: a sense of — чувство чего-либо"
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
      "text": "¹ абсолютный (англ.) — absolute · /ˈæbsəluːt/ · «а́бсолю́т» · от лат. absolutus — неограниченный · мнемоника: ab(olute)ly = абсолютно"
    }
  ]
}
\`\`\`

**Text-only fallback example:**
¹ напряжение (англ.) — tension · /ˈtɛnʃən/ · «те́ншн» · от tense · коллокация: under tension`,
    },
    // Hybrid mixed-lens examples. Intentionally mix lenses on the SAME Post
    // text so the model learns to switch lenses per anchor — including a
    // situation-level (multi-word clause) anchor winning the Pratchett lens.
    hybrid: {
        en: `### Examples (mixed lenses — copy this switching behaviour)

Post (context only; footnote its words/phrases/situations, not wholesale).
"She whispered 'valar morghulis' and sat on the Iron Throne, the blade edges biting through her gown."

¹ valar morghulis ({{TARGET_LANG_LABEL}}) — valar morghulis · /ˈvalar ˈmorɡulis/ · «váh-lar mor-gúh-liss» · mnemonic: valar (all men) + morghulis (must die) · collocation: valar dohaeris — "all men must serve" (the traditional response).

² Iron Throne (canon.) — Seat of the House of the Dragon in King's Landing, forged by Aegon the Conqueror from the swords of defeated enemies. Per canon, its blades cut whoever sits on it — a deliberate reminder that power should never be comfortable.

³ sat on the Iron Throne, the blade edges biting through her gown (Pratchett.) — A coronation: traditionally the moment a monarch settles into power. Here, power settles into her — with some interest. The throne, famously made of swords, takes the job of "ruling uncomfortably" rather literally; one might suggest it is overachieving.
⁴ whispered 'valar morghulis' (narrative.) — A character mutters a ominous foreign phrase and then immediately does the most predictable thing possible. The author believes untranslated menace substitutes for character motivation. It does not. Somewhere, a footnote generator is being underpaid to point this out.`,
        ru: `### Examples (mixed lenses — copy this switching behaviour)

Post (context only; footnote its words/phrases/situations, not wholesale).
«Она прошептала „valar morghulis" и села на Железный трон, лезвия врезаясь в её платье.»

¹ valar morghulis ({{TARGET_LANG_LABEL}}) — valar morghulis · /ˈvalar ˈmorɡulis/ · «ва́лар мор-гу́лис» · мнемоника: valar (все люди) + morghulis (должны умереть) · коллокация: valar dohaeris — «все люди должны служить» (традиционный ответ).

² Железный трон (канон.) — Резной трон Дома Дракона в Королевской Гавани, выкован Эйгоном Завоевателем из мечей поверженных врагов. По канону, его лезвия режут всякого сидящего — намеренное напоминание о том, что власть не должна быть удобной.

³ села на Железный трон, лезвия врезаясь в её платье (пратчетт.) — Коронация: традиционно момент, когда монарх входит во власть. Здесь власть входит в неё — причём с интересом. Трон, как известно, сделан из мечей, и работу «править неудобно» понимает весьма буквально; можно сказать, перевыполняет план.
⁴ прошептала «valar morghulis» (нарратив.) — Персонаж бормочет зловещую иностранную фразу, а затем немедленно делает самое предсказуемое, что можно придумать. Автор полагает, что непереведённая угроза заменяет мотивацию персонажа. Это не так. Где-то генератор сносок недополучает за то, что указывает на это.`,
    },
};

// ══════════════════════════════════════════════════════════════════════════════
// PROMPT STYLE LOADING
// ══════════════════════════════════════════════════════════════════════════════

// The output language of footnote TEXT (not the UI language, not the study
// target). Set via the "Output language" dropdown; default 'ru'. This replaces
// the old heuristic (document.documentElement.lang) which inferred it from the
// ST UI language — see anchor-count-language spec §3.
function getOutputLanguage() {
    return S().outputLanguage === 'en' ? 'English' : 'Russian';
}

// Boolean convenience mirroring getOutputLanguage, used by label tables.
function isOutputRu() {
    return S().outputLanguage !== 'en';
}

function langCacheKey() {
    const s = S();
    return `${s.targetLanguage || 'en'}:${s.cefrLevel || 'auto'}:${getOutputLanguage()}`;
}

/**
 * Assemble the STYLE half of the prompt (style rules + few-shot examples) for
 * the current promptStyle + output language, WITHOUT the base system prompt.
 * Cached per key. The targeted flow («Точечно») uses this alone — the regular
 * BASE_SYSTEM_PROMPT contradicts the targeted contract (authoritative targets
 * need not occur in the post).
 */
export async function assembleStyle() {
    const s = S();
    const outputLang = getOutputLanguage();
    const examplesLocale = outputLang === 'Russian' ? 'ru' : 'en';
    let stylePrompt = '';

    if (s.promptStyle === 'custom') {
        stylePrompt = s.customPrompt || '';
    } else if (s.promptStyle === 'language') {
        const key = `language:${langCacheKey()}`;
        if (state.promptCache[key]) {
            stylePrompt = state.promptCache[key];
        } else {
            // Invalidate any stale language caches (settings changed).
            for (const k of Object.keys(state.promptCache)) {
                if (k.startsWith('language:')) delete state.promptCache[k];
            }
            try {
                const resp = await fetch(`${getExtBase()}/prompts/language.md`);
                if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                let raw = await resp.text();
                raw = interpolateLangPrompt(raw);
                const examples = PROMPT_EXAMPLES.language?.[examplesLocale] || '';
                raw = raw.replace(/\{\{EXAMPLES\}\}/g, examples);
                stylePrompt = raw;
                state.promptCache[key] = stylePrompt;
            } catch (e) { warn('Failed to load language prompt:', e); }
        }
    } else if (s.promptStyle === 'hybrid') {
        // Hybrid mode: one footnote per anchor, the model picks the single
        // best-fitting ACTIVE LENS. The envelope (prompts/hybrid.md) carries the
        // COMMON rules (output language, translation boundary, format) ONCE; each
        // active lens contributes only its own role (voice + when + label).
        // Custom lenses (user-authored) travel alongside the 5 built-ins, so the
        // constructor accepts any mix.
        //
        // Cache key is built from (a) the active built-in lens names + (b) the
        // active custom lens ids + (c) lang/cefr/outputLang signature, so any
        // flip / add / edit / delete of a custom lens invalidates it.
        stylePrompt = await _buildHybridPrompt(examplesLocale, outputLang);
    } else {
        const style = s.promptStyle || 'pratchett';
        const key = `${style}:${outputLang}`;
        if (state.promptCache[key]) {
            stylePrompt = state.promptCache[key];
        } else {
            for (const k of Object.keys(state.promptCache)) {
                if (k.startsWith(`${style}:`)) delete state.promptCache[k];
            }
            try {
                const resp = await fetch(`${getExtBase()}/prompts/${style}.md`);
                if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                let raw = await resp.text();
                raw = raw.replace(/\{\{OUTPUT_LANGUAGE\}\}/g, outputLang);
                // Contract/vibe split: the shared format rules were moved OUT of
                // the style files into src/prompt-contract.js (they were
                // duplicated verbatim in every style). The {{CONTRACT}} marker
                // sits where the per-style "### Format requirements" section
                // used to be, so the assembled prompt is unchanged.
                raw = raw.replace(/\{\{CONTRACT\}\}/g, FOOTNOTE_CONTRACT);
                const examples = PROMPT_EXAMPLES[style]?.[examplesLocale] || '';
                raw = raw.replace(/\{\{EXAMPLES\}\}/g, examples);
                stylePrompt = raw;
                state.promptCache[key] = stylePrompt;
            } catch (e) { warn('Failed to load prompt style:', e); }
        }
    }

    // The style half is complete; the base system prompt is appended by
    // loadPromptStyle for the regular flow only.
    return (stylePrompt || '').trim();
}

/**
 * Full system prompt for the REGULAR flow: base SCENE-FOCUS prompt (what to
 * annotate) + the style half. The count target + VERBATIM contract live in
 * buildUserPrompt's user message. The system prompt carries no count pressure
 * here, so the model is never forced to fabricate anchors; the user-message
 * contract tells it to broaden anchor granularity (names/phrases/clauses) to
 * reach N honestly in one request.
 */
export async function loadPromptStyle() {
    const s = S();
    const stylePrompt = await assembleStyle();
    const basePrompt = s.promptStyle === 'language' ? BASE_SYSTEM_PROMPT_LANG
        : s.promptStyle === 'hybrid'    ? BASE_SYSTEM_PROMPT_HYBRID
        : BASE_SYSTEM_PROMPT;
    return `${basePrompt}\n\n${stylePrompt || ''}`.trim();
}

function interpolateLangPrompt(template) {
    const LANG_NAMES = {
        en: 'English', fr: 'Français', de: 'Deutsch', es: 'Español',
        it: 'Italiano', pt: 'Português', ja: 'Japanese', ko: 'Korean',
        zh: 'Chinese', tr: 'Türkçe', pl: 'Polski', nl: 'Nederlands',
        // Constructed / fictional (see CONLANG_CODES)
        hvl: 'High Valyrian', tlh: 'Klingon', sin: 'Sindarin',
        quen: 'Quenya', eo: 'Esperanto', tok: 'Toki Pona',
    };
    const isRu = isOutputRu();
    const LANG_LABELS = isRu ? {
        en: 'англ.', fr: 'фр.', de: 'нем.', es: 'исп.',
        it: 'ит.', pt: 'порт.', ja: 'яп.', ko: 'кор.',
        zh: 'кит.', tr: 'тур.', pl: 'польск.', nl: 'нид.',
        // Constructed / fictional
        hvl: 'вал.', tlh: 'клн.', sin: 'синд.',
        quen: 'квэн.', eo: 'эсп.', tok: 'токи',
    } : {
        en: 'Eng.', fr: 'Fr.', de: 'Ger.', es: 'Sp.',
        it: 'It.', pt: 'Port.', ja: 'Jap.', ko: 'Kor.',
        zh: 'Chi.', tr: 'Tur.', pl: 'Pol.', nl: 'Dut.',
        // Constructed / fictional
        hvl: 'Val.', tlh: 'Kli.', sin: 'Sind.',
        quen: 'Quen.', eo: 'Esp.', tok: 'Tok.',
    };
    const CEFR_DESC = {
        auto: 'Adapt to the text\'s complexity automatically. Select words appropriate for the reader\'s likely level. Focus on instructive, non-obvious translations.',
        a1a2: 'Focus on A1–B1 vocabulary. Simple, everyday words. Use short, clear explanations. Prioritize survival words and basic phrases.',
        b1b2: 'Focus on B1–C1 vocabulary. Explain idioms, phrasal verbs, collocations, nuanced usage. Highlight differences between literal and figurative meaning.',
        c1c2: 'Focus on C1–C2 vocabulary. Literary terms, etymology, stylistic nuances, rare constructions. Include word origins and register information.',
    };
    const lang = S().targetLanguage || 'en';
    const level = S().cefrLevel || 'auto';
    const outputLang = isRu ? 'Russian' : 'English';
    // Conlang attestation note — substituted first so its own
    // {{TARGET_LANG_NAME}} token is expanded by the next replace.
    const conlangNote = CONLANG_CODES.has(lang) ? CONLANG_NOTE_BODY : '';
    return template
        .replace(/\{\{CONLANG_NOTE\}\}/g, conlangNote)
        .replace(/\{\{TARGET_LANG_NAME\}\}/g, LANG_NAMES[lang] || lang)
        .replace(/\{\{TARGET_LANG_CODE\}\}/g, lang)
        .replace(/\{\{TARGET_LANG_LABEL\}\}/g, LANG_LABELS[lang] || `${lang}.`)
        .replace(/\{\{CEFR_LEVEL\}\}/g, level)
        .replace(/\{\{CEFR_LEVEL_DESC\}\}/g, CEFR_DESC[level] || CEFR_DESC.auto)
        .replace(/\{\{OUTPUT_LANGUAGE\}\}/g, outputLang);
}

// ── Hybrid prompt assembly ──────────────────────────────────────────────────
// The envelope (prompts/hybrid.md) carries the COMMON rules ONCE; each active
// lens contributes only its role. Custom lenses (user-authored) travel inline.
// One footnote per anchor: the model picks the single best-fitting ACTIVE LENS.
const HYBRID_BUILTIN_LENSES = ['language', 'pratchett', 'canon', 'academic', 'meta'];

/**
 * Resolve the active lens flags using DEFAULT_SETTINGS as the single source
 * of truth for missing/non-boolean values (spec §5.3). Replaces the old
 * mixed `!== false` / `=== true` ad-hoc guards in `_buildHybridPrompt`
 * that were fragile to future lens additions.
 *
 * @param {object} lenses  - S().hybridLenses (may be missing or partial)
 * @param {object} defaults - DEFAULT_SETTINGS.hybridLenses
 * @returns {Object<string, boolean>}
 */
export function resolveActiveLenses(lenses, defaults) {
    const src = (lenses && typeof lenses === 'object') ? lenses : {};
    const out = {};
    for (const k of HYBRID_BUILTIN_LENSES) {
        const v = src[k];
        out[k] = (typeof v === 'boolean') ? v : defaults[k];
    }
    return out;
}

async function _buildHybridPrompt(examplesLocale, outputLang) {
    const s = S();
    const lenses = s.hybridLenses || {};
    const active = resolveActiveLenses(lenses, DEFAULT_SETTINGS.hybridLenses);
    // Custom lenses: active, with a name AND a non-empty prompt body.
    const customActive = (Array.isArray(s.customLenses) ? s.customLenses : [])
        .filter(c => c && c.active && c.name && c.prompt);

    // Defensive: if EVERYTHING is off (only possible via hand-edit), force
    // Language on so the model always has at least one lens.
    const anyBuiltin = HYBRID_BUILTIN_LENSES.some(k => active[k]);
    if (!anyBuiltin && !customActive.length) active.language = true;

    const sig = [
        ...HYBRID_BUILTIN_LENSES.filter(k => active[k]),
        ...customActive.map(c => c.id || c.name),
    ].join(',');
    const key = `hybrid:${sig}:${langCacheKey()}`;
    if (state.promptCache[key]) return state.promptCache[key];

    // Invalidate stale hybrid prompts (active lens set / lang changed).
    for (const k of Object.keys(state.promptCache)) {
        if (k.startsWith('hybrid:')) delete state.promptCache[k];
    }

    let raw = '';
    try {
        const resp = await fetch(`${getExtBase()}/prompts/hybrid.md`);
        if (!resp.ok) throw new Error(`HTTP ${resp.status} (hybrid.md)`);
        raw = await resp.text();
    } catch (e) {
        warn('Failed to load hybrid envelope:', e);
        return '';
    }

    // Build the {{LENSES}} body: one block per active lens, built-ins first
    // (fixed order), then custom (stored order). One footnote per anchor means
    // the model SEES all active lenses and picks one per anchor — no overlap.
    const blocks = [];
    for (const lens of HYBRID_BUILTIN_LENSES) {
        if (!active[lens]) continue;
        try {
            const snipResp = await fetch(`${getExtBase()}/prompts/lenses/${lens}.md`);
            if (!snipResp.ok) throw new Error(`HTTP ${snipResp.status} (lenses/${lens}.md)`);
            let snip = await snipResp.text();
            // Language lens needs {{TARGET_LANG_*}} + {{CEFR_*}} + {{CONLANG_NOTE}}
            // interpolated BEFORE {{OUTPUT_LANGUAGE}} is applied. interpolateLangPrompt
            // handles OUTPUT_LANGUAGE too, so it's a single pass for that lens.
            snip = lens === 'language' ? interpolateLangPrompt(snip)
                                       : snip.replace(/\{\{OUTPUT_LANGUAGE\}\}/g, outputLang);
            blocks.push(snip.trim());
        } catch (e) {
            warn(`Failed to load hybrid lens "${lens}":`, e);
            // Skip the missing lens rather than nuking the whole prompt — a
            // packaging bug on ONE lens shouldn't blank the other four.
        }
    }
    for (const c of customActive) {
        // Custom lenses only get {{OUTPUT_LANGUAGE}} (no lang/CEFR tokens).
        const body = String(c.prompt).replace(/\{\{OUTPUT_LANGUAGE\}\}/g, outputLang);
        blocks.push(`### Lens: ${String(c.name).trim()}\n${body.trim()}`);
    }

    raw = raw.replace(/\{\{LENSES\}\}/g, blocks.join('\n\n'));

    // Few-shot examples: {{TARGET_LANG_LABEL}} only makes sense if the Language
    // lens is on (the first example footnote is a language-lens example).
    // interpolateLangPrompt handles the label cleanly; otherwise strip it.
    let examples = PROMPT_EXAMPLES.hybrid?.[examplesLocale] || '';
    if (active.language) examples = interpolateLangPrompt(examples);
    else                 examples = examples.replace(/\{\{TARGET_LANG_LABEL\}\}/g, '');
    raw = raw.replace(/\{\{EXAMPLES\}\}/g, examples);

    // Final envelope pass: hybrid.md's own {{OUTPUT_LANGUAGE}} (the lens
    // snippets above did their own replace, so this is a no-op for them).
    raw = raw.replace(/\{\{OUTPUT_LANGUAGE\}\}/g, outputLang);

    state.promptCache[key] = raw;
    return raw;
}

// ══════════════════════════════════════════════════════════════════════════════
// USER PROMPT BUILDING
// ══════════════════════════════════════════════════════════════════════════════

/** Coerce arbitrary WI/persona return shapes into a plain string. */
function coercePromptText(value) {
    if (!value) return '';
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return value.map(coercePromptText).filter(Boolean).join('\n');
    if (typeof value === 'object') {
        if (typeof value.worldInfoString === 'string') return value.worldInfoString;
        if (typeof value.worldInfoBefore === 'string' || typeof value.worldInfoAfter === 'string') {
            return [value.worldInfoBefore, value.worldInfoAfter].filter(Boolean).join('\n');
        }
        if (typeof value.prompt === 'string') return value.prompt;
        if (typeof value.content === 'string') return value.content;
        if (typeof value.text === 'string') return value.text;
        if (typeof value.toString === 'function' && value.toString !== Object.prototype.toString) {
            const str = value.toString();
            if (str && str !== '[object Object]') return str;
        }
        try { const json = JSON.stringify(value); return json && json !== '{}' ? json : ''; } catch { return ''; }
    }
    const str = String(value);
    return str === '[object Object]' ? '' : str;
}

function getTargetFootnoteCount() {
    const n = parseInt(S().maxFootnotes, 10);
    return Number.isFinite(n) ? Math.min(20, Math.max(1, n)) : 5;
}

/**
 * Build the input consumed by SillyTavern's automatic lore activation
 * (getWorldInfoPrompt). Ported from DS Comments (src/generator.js).
 *   - Messages newest-first (ST's scan expects reverse-chronological order)
 *     with raw m.mes — the same surface ST itself scans.
 *   - globalScanData carries the 'quiet' trigger plus the persona/character
 *     fields whose TEXT can activate keyword entries: without them, entries
 *     keyed on words that appear only in the character description, scenario,
 *     or persona never activate for the footnote prompt.
 */
export function buildLoreScanInput(ctx) {
    const chatMessages = (ctx.chat || [])
        .filter(m => m && !m.is_system && !m.is_hidden)
        .map(m => {
            const name = m.is_user ? (ctx.name1 || 'User') : (m.name || ctx.name2 || 'Character');
            return `${name}: ${String(m.mes || '')}`;
        })
        .reverse();

    const globalScanData = { trigger: 'quiet' };
    try {
        if (ctx.characterId !== undefined && ctx.characters?.[ctx.characterId]) {
            const ch = ctx.characters[ctx.characterId];
            if (ch.description) globalScanData.characterDescription = ch.description;
            if (ch.personality) globalScanData.characterPersonality = ch.personality;
            if (ch.scenario) globalScanData.scenario = ch.scenario;
        }
        const pd = ctx.powerUserSettings?.persona_description;
        if (pd) globalScanData.personaDescription = pd;
    } catch { /* skip */ }

    return { chatMessages, globalScanData };
}

function buildCharBlock(messageId) {
    const ctx = getCtx();
    let ch = null;
    if (ctx.characterId !== undefined && ctx.characters?.[ctx.characterId]) {
        ch = ctx.characters[ctx.characterId];
    } else {
        const msg = ctx.chat?.[parseInt(messageId)];
        if (msg?.name) ch = ctx.characters?.find(c => c.name === msg.name) ?? null;
    }
    if (!ch?.description) return '';
    return `[Character: ${ch.name}\n${ch.description}]`;
}

function buildChatHistory(anchorMsgId) {
    const ctx = getCtx();
    const depth = Math.max(0, parseInt(S().contextDepth, 10) || 0);
    const chat = ctx.chat;
    if (!chat || depth <= 0) return '';
    // Context is STRICTLY prior messages. The anchor post is annotated via
    // [Annotate this post] and must NOT also appear here — otherwise the model
    // starts generating footnotes for older posts' words instead of the
    // current one.
    const endIdx = parseInt(anchorMsgId, 10); // exclusive of the anchor
    return chat
        .slice(0, endIdx)
        .slice(-depth)
        .filter(m => !m.is_system && !m.is_hidden)
        .map(m => `${m.is_user ? (ctx.name1 || 'User') : (m.name || 'AI')}: ${extractPlainText(m.mes || '')}`)
        .join('\n');
}

/**
 * Build the context blocks for the single generation turn: the annotation
 * target ([Annotate this post], the ONLY block validateFootnotes resolves
 * anchors against — see extractPostTextFromPrompt in parser.js) + background
 * blocks the model may use to enrich explanations ([Earlier in the scene],
 * Character, User persona, World info). Background is reference context, never
 * an anchor source. The first element is always [Annotate this post: ...], so
 * extractPostTextFromPrompt can resolve anchors against the target alone.
 */

/**
 * Read the current persona description, preferring ctx.getPersonaDescription
 * (older ST) and falling back to ctx.powerUserSettings + personas.js's
 * `user_avatar` named export (newer ST where ctx.getPersonaDescription is
 * no longer exposed via getContext). Never throws — returns '' on any
 * failure (the persona block is opt-in enrichment; a missing description
 * is not an error, just a degraded footnote).
 *
 * Verified against release (paths from third-party/<ext>/src/generator.js):
 *   - ctx.powerUserSettings: exposed in getContext() (st-context.js:228)
 *   - user_avatar: named export of public/scripts/personas.js:108
 *   - persona_descriptions: power_user field (power-user.js), keyed by avatar
 */
let _userAvatarImport = null; // memoize the dynamic personas.js import
async function getPersonaDescription() {
    const ctx = getCtx();
    // Preferred path (older ST versions that still expose it).
    if (typeof ctx.getPersonaDescription === 'function') {
        try { return ctx.getPersonaDescription() || ''; } catch { /* fall through */ }
    }
    // Fallback: read manually via ctx.powerUserSettings + personas.js's user_avatar.
    // From src/generator.js the relative path to public/scripts/personas.js is
    //   ../../../../personas.js  (4 ../ hops: src → Glosses → third-party → extensions → scripts)
    try {
        if (!_userAvatarImport) {
            _userAvatarImport = import('../../../../personas.js').catch(() => null);
        }
        const mod = await _userAvatarImport;
        const user_avatar = mod?.user_avatar;
        const pu = ctx.powerUserSettings;
        if (user_avatar && pu?.persona_descriptions) {
            const desc = pu.persona_descriptions?.[user_avatar]?.description;
            if (typeof desc === 'string') return desc;
        }
    } catch { /* non-critical */ }
    return '';
}

/**
 * @param {string} messageId
 * @param {number} swipeIdx
 * @param {{ skipForbidden?: boolean }} [opts] — skipForbidden drops the
 *        [Forbidden anchors] block. Used by the targeted flow, whose targets
 *        are explicit user choices that must not be second-guessed by the
 *        stop-words / forced-ignore lists.
 */
export async function buildContextBlocks(messageId, swipeIdx, opts = {}) {
    const ctx = getCtx();
    const s = S();
    const msg = ctx.chat?.[parseInt(messageId)];
    if (!msg) return [];
    const text = Array.isArray(msg.swipes) ? (msg.swipes[swipeIdx] ?? msg.mes) : msg.mes;
    const cleanText = extractPlainText(text);
    const parts = [`[Annotate this post:\n${cleanText}]`];

    if (s.avoidRepeatedAnchors !== false) {
        // "Already explained" pool: permissive — every anchor Glosses has ever
        // generated for this chat (any message, any variant), except the
        // current message's own anchors, so the block can't leak a hint to
        // re-gloss exactly the target. Those filters deliberately do NOT
        // filter by swipe/position/message-type: in chats with swipes or
        // regenerations those filters silently dropped most of the pool,
        // leaving the advisory block empty. See collectExplainedAnchors.
        const prior = collectExplainedAnchors({
            sets: listFootnoteSets(),
            currentMsgId: messageId,
            limit: 200,
            // Per-chat "hidden from advisory" list, curated from the pool-manager
            // UI in the Exclusions tab. Hides an anchor from THIS block only —
            // the footnote itself is unaffected.
            excludeKeys: getPoolExcluded(),
        });
        if (prior.length) {
            parts.push(`[Previously glossed anchors - prefer different anchors when possible; reuse is allowed to reach the requested count:\n${prior.join('; ')}]`);
        }
    }

    if (s.contextDepth > 0) {
        const history = buildChatHistory(messageId);
        if (history) parts.push(`[Earlier in the scene — reference only; do NOT annotate it, use it only as background:\n${history}]`);
    }
    if (s.includeCharacterCard) {
        const card = buildCharBlock(messageId);
        if (card) parts.push(card);
    }
    if (s.includePersona) {
        const persona = await getPersonaDescription();
        if (persona) parts.push(`[User persona:\n${persona}]`);
    }
    // ── Lorebook context. Effective source, in order:
    //   1. per-chat config (chatMetadata.gls_lorebook, lorebooks.js) when its
    //      enabled flag is on — AUTOMATIC scope ALL (dry-run scan + vectorized
    //      entries from the WORLD_INFO_ACTIVATED cache) or ATTACHED (only the
    //      entries of books bound to this chat). ATTACHED degrades to the full
    //      scan when the activation cache doesn't match the anchor (regen of
    //      an older post) so the prompt keeps its background.
    //   2. otherwise the legacy global includeLorebook toggle → full scan.
    // isDryRun is ALWAYS true in every scan (contract ported from DS
    // Comments): a non-dry-run scan re-emits WORLD_INFO_ACTIVATED and writes
    // sticky/cooldown timed-effects into chat_metadata OUTSIDE ST's
    // generation cycle — the footnote prompt must neither consume nor mutate
    // the main chat's world-info state.
    const loreCfg = getChatLoreConfig(ctx);
    if (loreCfg.enabled || s.includeLorebook) {
        let wi = '';
        try {
            if (loreCfg.enabled && loreCfg.mode !== LORE_MODE.MANUAL) {
                const { chatMessages, globalScanData } = buildLoreScanInput(ctx);
                const scope = loreCfg.autoScope ?? LORE_SCOPE.ALL;
                let lore = await collectAutomaticLore(ctx, { chatMessages, globalScanData, anchorMsgId: messageId, anchorSwipeIdx: swipeIdx, scope });
                if (!lore.text && !lore.cacheMatched && scope === LORE_SCOPE.ATTACHED) {
                    // Activation cache miss (older-post regen) — degrade to
                    // the full scan instead of dropping the background.
                    lore = await collectAutomaticLore(ctx, { chatMessages, globalScanData, anchorMsgId: messageId, anchorSwipeIdx: swipeIdx, scope: LORE_SCOPE.ALL });
                }
                wi = lore.text;
            } else {
                const { chatMessages, globalScanData } = buildLoreScanInput(ctx);
                const wiResult = ctx.getWorldInfoPrompt?.(chatMessages, ctx.maxContext || 4096, true, globalScanData);
                wi = coercePromptText(wiResult instanceof Promise ? await wiResult : wiResult);
            }
        } catch { /* WI unavailable */ }
        if (wi) parts.push(`[World info — background only. Do NOT annotate it:
${wi}]`);
    }

    if (!opts.skipForbidden) {
        const stopList = (s.stopWords || '').split(',').map(x => x.trim()).filter(Boolean);
        const forbidden = combineForbiddenAnchors(stopList, getForcedIgnore());
        if (forbidden.length) parts.push(`[Forbidden anchors — do NOT create footnotes for these exact phrases:\n${forbidden.join('; ')}]`);
    }

    return parts;
}

export const DIRECT_FOOTNOTE_CONTRACT = `[ANNOTATOR CONTRACT — direct footnotes, one response]

Generate exactly {N} distinct footnotes. Return fewer only when the post genuinely cannot support that many. Never invent or borrow anchors from background blocks.

Scan the entire [Annotate this post] block: foreign/archaic terms, specialized vocabulary, proper nouns, place names, titles of works, idioms, metaphors, and verbatim clauses describing a meaningful situation. Each "anchor" MUST be an exact verbatim substring of [Annotate this post] and distinct from every other anchor; quote the visible wording only — never include markdown decoration characters (*, _, \`, ~) in the anchor. Prefer anchors not listed in the advisory previously-glossed block when possible, but reuse is allowed to reach {N}.

Do not create anchors matching the forbidden list. For an oblique source form, keep the exact source phrase in "anchor" and use the nominative only as the display label in "text".

Output ONLY this JSON (no markdown fences, no prose):
{"footnotes":[{"anchor":"verbatim source phrase","text":"¹ Label (cat.) — explanation"}]}`;

/** Build the direct user-turn prompt with target, contract, then reference blocks. */
export async function buildUserPrompt(messageId, swipeIdx) {
    const parts = await buildContextBlocks(messageId, swipeIdx);
    if (!parts.length) return '';
    const targetCount = getTargetFootnoteCount();
    const contract = DIRECT_FOOTNOTE_CONTRACT.replace(/\{N\}/g, String(targetCount));
    return [parts[0], contract, ...parts.slice(1)].join('\n\n');
}

// ══════════════════════════════════════════════════════════════════════════════
// GENERATION
// ══════════════════════════════════════════════════════════════════════════════

/** Copy a footnote with a fresh 1..len index + matching superscript in text. */
function renumberFootnotes(fns) {
    return fns.map((f, i) => {
        const newIndex = i + 1;
        const sup = indexToSuperscript(newIndex);
        const text = String(f.text || '').replace(/^[⁰¹²³⁴⁵⁶⁷⁸⁹\d]+/u, sup);
        return { ...f, index: newIndex, text };
    });
}

/**
 * Build the DOM text model for a message element's rendered .mes_text.
 * Returns null when the element or the DOM API is unavailable (Node tests,
 * detached elements) so the caller can fall back to the prompt text. Safe to
 * call while the PREVIOUS generation's highlights are still on screen: the
 * index excludes superscript digits (sup.gls-sup) and .gls-marker wrappers
 * add no text, so the model equals the one built over the clean DOM.
 */
function buildDomTextModel(mesEl) {
    try {
        if (!mesEl || typeof mesEl.querySelector !== 'function') return null;
        const mesText = mesEl.querySelector('.mes_text');
        if (!mesText) return null;
        return buildTextIndex(mesText);
    } catch {
        return null;
    }
}

/**
 * Generate footnotes for a message+swipe, persist them, and inject highlights.
 * Aborts a previous in-flight generation for the same messageId.
 *
 * Direct generation makes one API request and validates exact target-post
 * anchors before transactional persistence. When the rendered DOM is
 * available, validation runs against the SAME text index the renderer will
 * match on (with a fuzzy second tier for lightly normalized anchors), so a
 * validated footnote is a footnote that can physically receive a marker.
 * Overshoot is capped in document order; an honest undershoot is retained.
 *
 * The variant's identity is its full-text digest, snapshotted at run start:
 * the commit guard discards the result when the variant was switched or its
 * text changed (edit / continue) while the request was in flight.
 */
// Launcher pulse: while any generation is in flight, both launcher controls
// (QR-bar button + floating FAB) pulse via .gls_generating (style.css).
// Generations are per-message and can overlap (a regen on another message), so
// the class is reference-counted; superseded runs decrement too — their finally
// still runs after beginRun() replaced their controller.
let _generatingRuns = 0;

function setLaunchersGenerating(on) {
    for (const id of ['gls_launcher', 'gls_fab']) {
        document.getElementById(id)?.classList.toggle('gls_generating', on);
    }
}

export async function generateFootnotes(messageId, swipeIdx, mesEl) {
    // Translate-guard (manual paths included): regenerating over a translated
    // view would validate anchors against the translation but stamp the
    // payload with the ORIGINAL body's digest — markers land on translation
    // words and misplace after un-translate. Ask the user to un-translate.
    const entryMsg = getCtx().chat?.[parseInt(messageId)];
    if (isTranslatedView(entryMsg)) {
        toastr?.info?.(`[Glosses] ${t('The message is translated — un-translate it to regenerate footnotes.')}`);
        return;
    }
    if (!variantIsViable(messageId, swipeIdx)) {
        // Reject placeholder/short posts at every entry point (Issue 5).
        return;
    }
    const startDigest = digestFor(messageId, swipeIdx);
    // Stage 6: the coordinator owns the per-message run (controller + token +
    // revision + chatEpoch). Starting a new run supersedes any previous one.
    const run = generationCoordinator.beginRun(messageId);
    const ctrl = run.ctrl;
    setSpinner(messageId, true);
    if (_generatingRuns++ === 0) setLaunchersGenerating(true);

    try {
        const signal = ctrl.signal;
        const systemPrompt = await loadPromptStyle();
        if (!generationCoordinator.isCurrent(run)) return;   // chat switched / swiped / superseded
        const target = getTargetFootnoteCount();
        const userPrompt = await buildUserPrompt(messageId, swipeIdx);
        if (!generationCoordinator.isCurrent(run)) return;   // chat switched / swiped / superseded
        const stopList = (S().stopWords || '').split(',').map(x => x.trim()).filter(Boolean);
        const forbidden = combineForbiddenAnchors(stopList, getForcedIgnore());
        // Single source of truth: with a rendered element, validate against
        // the DOM text index (what the renderer matches). The fuzzy resolver
        // is the second tier for anchors the model lightly normalized —
        // inflections, markdown decoration — and every rescue is logged.
        const domModel = buildDomTextModel(mesEl);
        const validationText = domModel?.text ?? null;
        const resolveFallback = validationText === null ? null : (anchor) => {
            const hit = findFuzzySpan(validationText, anchor);
            if (hit) warn(`Fuzzy-resolved anchor "${anchor}" -> "${hit.text}" (distance ${hit.distance})`);
            return hit;
        };
        const parsed = parseResponse(await callAPI(systemPrompt, userPrompt, signal));
        if (!generationCoordinator.isCurrent(run)) return;   // chat switched / swiped / superseded
        const validated = validationText !== null
            ? validateFootnotesAgainstText(parsed, validationText, forbidden, resolveFallback)
            : validateFootnotes(parsed, userPrompt, forbidden);
        if (!generationCoordinator.isCurrent(run)) return;   // chat switched / swiped / superseded
        if (!validated?.length) {
            // Not a silent no-op: the user cannot tell "the model returned
            // garbage" from "nothing in the post was worth glossing".
            const candidates = parsed?.footnotes?.length ?? 0;
            if (!candidates) {
                toastr?.warning?.(`[Glosses] ${t('The model returned no parsable footnotes. Check the connection or try again.')}`);
            } else {
                toastr?.info?.(`[Glosses] ${t('All returned footnote anchors were rejected (not found in the post, duplicates, or forced-ignore).')}`);
            }
            return;
        }

        const ctx2 = getCtx();
        const msg2 = ctx2.chat?.[parseInt(messageId)];
        const rawMes = Array.isArray(msg2?.swipes) ? (msg2.swipes[swipeIdx] ?? msg2.mes) : (msg2?.mes ?? '');
        const plain = extractPlainText(rawMes);
        let footnotes = normalizeFootnotes(validated, validationText ?? plain) ?? validated;
        // If the model overshoots N, keep the first N in document order and
        // renumber 1..N. Undershoot is left as-is (honest maximum).
        if (footnotes.length > target) {
            footnotes = footnotes.slice(0, target);
            footnotes = renumberFootnotes(footnotes);
        }
        if (!footnotes?.length) return;

        // The direct contract has no validation-only fields. Keep persisted
        // entries constrained to the renderer/cache footnote shape, plus the
        // context selectors (prefix/suffix around the resolved span) that let
        // re-injections prefer the occurrence each anchor was originally
        // placed on when the anchor string occurs multiple times.
        footnotes = footnotes.map((f) => {
            const out = { index: f.index, anchor: f.anchor, text: f.text };
            if (validationText !== null) {
                const hit = findAnchorInText(validationText, f.anchor);
                if (hit) Object.assign(out, computeContextSelectors(validationText, hit.start, hit.end));
            }
            return out;
        });

        // Final guard right before the irreversible write: the awaits above for
        // normalization are cheap, but a chat switch could still have landed in
        // the gap. Never persist/render into the wrong chat.
        // Stage 6: isCurrent(run) now also requires that THIS run is still the
        // owner of the message's abort slot — a superseded run whose transport
        // ignored AbortSignal can no longer commit over its replacement. The
        // live digest check is kept: an in-place edit or swipe can otherwise
        // retain ownership while changing the target text.
        const liveMsg = getCtx().chat?.[parseInt(messageId)];
        const liveSwipe = liveMsg?.swipe_id ?? 0;
        const liveDigest = digestFor(messageId, liveSwipe);
        if (!generationCoordinator.isCurrent(run) || liveSwipe !== swipeIdx || liveDigest !== startDigest) return;
        saveFootnotes(messageId, swipeIdx, footnotes, { style: S().promptStyle });
        // §6.4: a successful run (manual paths included) clears the sticky
        // "Source not configured" badge — previously only the auto-generate and
        // targeted paths reset it, so one failure kept the badge up forever and
        // hid the empty-state Generate CTA behind 'unconfigured'.
        state.configuredState = { ok: true, reason: '' };
        injectHighlights(mesEl, footnotes);
        playSound();
        state.panelFocusMsgId = String(messageId);
        panelInvalidate();
        updatePanel();
    } catch (e) {
        if (e.name === 'AbortError') return;
        // A stale run is not an error — it was legitimately superseded by a chat
        // switch, a swipe of this message, or a newer run. Discard silently (no
        // toast, no configuredState flip).
        if (!generationCoordinator.isCurrent(run)) return;
        error(e);
        // §6.4: reflect any non-abort failure onto state.configuredState so the
        // floating panel can show the persistent badge — not just the momentary
        // toast. Manual /glosses_regen flows usually skip checkSourceConfigured,
        // so this catch is the only place they surface a failure into the panel.
        state.configuredState = { ok: false, reason: e.message || String(e) };
        toastr?.error?.(`[Glosses] ${e.message}`);
    } finally {
        if (--_generatingRuns <= 0) { _generatingRuns = 0; setLaunchersGenerating(false); }
        // Only clean up if THIS call is still the active controller for the
        // message. If a later call (B) superseded us, its own finally cleans up;
        // touching state here would abort/hide B mid-flight. endRun guards on
        // ownership (abortControllers[id] === this run's ctrl).
        if (generationCoordinator.endRun(run)) {
            setSpinner(messageId, false);
            // §6.5: refresh the floating panel so the per-message regen button
            // (Task 18) and the persistent source badge (Task 16) un-lock /
            // re-render after a failure or abort, not just on success.
            try { updatePanel(); } catch { /* non-critical */ }
        }
    }
}

async function callAPI(systemPrompt, userPrompt, signal) {
    const s = S();

    // Test-only injection point: tests set _testApiOverride to a function
    // returning a canned raw model response (possibly gated behind a promise
    // they control to simulate mid-flight chat switches). Gated on NODE_TEST
    // so production code never observes the hook.
    //
    // NOTE: read `process` via globalThis. The bare `process?.env` form throws
    // ReferenceError in the browser (process is a Node-only global that is not
    // even declared there — optional chaining guards against undefined VALUES,
    // not against undeclared identifiers). globalThis.process exists in Node
    // and is simply absent in the browser, so this short-circuits safely.
    if (globalThis.process?.env?.NODE_TEST === '1' && typeof _testApiOverride === 'function') {
        return _testApiOverride(systemPrompt, userPrompt, signal);
    }

    if (s.source === 'profile') {
        const { generateWithProfile } = await import('./connection.js');
        return generateWithProfile(s.selectedProfile, systemPrompt, userPrompt, signal);
    }
    if (s.source === 'custom') {
        const { generateWithCustomEndpoint } = await import('./connection.js');
        return generateWithCustomEndpoint(systemPrompt, userPrompt, signal, s.customEndpoint, s.customModel);
    }
    // No 'default' source — the old ST-API passthrough was removed (it routed
    // footnote generation through the main LLM pipeline, picking up presets,
    // instruct formatting and other extensions' injections). Only the two
    // isolated sources above are supported; an unset/stale source is a
    // configuration error the user must resolve in settings.
    throw new Error('Select a generation source (Connection Profile or Custom) in Glosses settings.');
}

// ── Test-only hooks (gated on NODE_TEST) ──
// Set by tests/generation-epoch.test.mjs to intercept callAPI with a
// controllable promise so we can simulate a CHAT_CHANGED mid-flight.
let _testApiOverride = null;
export function _testSetApiOverride(fn) { _testApiOverride = fn; }
export function _testClearApiOverride() { _testApiOverride = null; }

