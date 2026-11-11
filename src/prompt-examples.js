// @ts-check
/**
 * Glosses — Few-shot prompt examples, keyed by [style][locale].
 *
 * Extracted verbatim from generator.js (pure data, no imports): these live in
 * code (not in the .md files) because they need to vary by output language and
 * embed the exact superscript format the parser expects. generator.js is the
 * only consumer.
 */
export const PROMPT_EXAMPLES = {
    pratchett: {
        en: `### Examples (exact output format — copy this structure)

¹ Madonna (It.) — An exclamation of shock, literally "the Virgin Mary." Although, given what's happening in the room, the Virgin would most likely prefer to pretend she was never here and quietly slip out the back door.

² Baisse le son, tu vas réveiller les morts (Fr.) — "Turn it down, you'll wake the dead." A fundamentally incorrect claim: as any practicing necromancer knows, the dead sleep remarkably soundly, and raising them requires at minimum a sacrificial goat, not merely loud music.

³ Cruciatus (Lat.) — An unforgivable curse causing unbearable pain. Considered poor etiquette in polite society, though unfortunately polite society usually ends right where dark wizards with bad childhoods begin.

Example with non-nominative anchor (source text: "rubbed with kohl"):
⁴ Kohl (Hist.) — Traditional ancient Egyptian eye cosmetic made from ground galena. Served both a sacred-aesthetic and practical function, shielding the optic nerve from harsh sun and infection.
Anchor in JSON: "rubbed with kohl"

Example with phrase anchor (source text: "son of Horus"):
⁵ Son of Horus (Myth.) — Horus was the falcon-headed sky god, known for his vindictiveness and his talent for losing important body parts in family squabbles. Direct descent from him automatically guaranteed perfect posture, innate pomposity, and an acute need to look down on everyone else as something stuck to the sole of a sandal.
Anchor in JSON: "son of Horus"`,
        ru: `### Examples (exact output format — copy this structure)

¹ Madonna (ит.) — Выражение шока, буквально «Богоматерь». Хотя, учитывая происходящее в комнате, Богоматерь, скорее всего, предпочла бы сделать вид, что её здесь нет, и тихо уйти через чёрный ход.

² Baisse le son, tu vas réveiller les morts (фр.) — «Убавь звук, ты мертвых разбудишь». Утверждение в корне неверное: как известно любому практикующему некроманту, мёртвые спят на удивление крепко, и чтобы их разбудить, требуется как минимум жертвенный козёл, а не просто громкая музыка.

³ Cruciatus (лат.) — Непростительное проклятие, причиняющее невыносимую боль. В приличном обществе считается дурным тоном, но, к сожалению, приличное общество обычно заканчивается там, где начинаются тёмные маги с плохим детством.

Example with non-nominative anchor (source text: "натёрла сурьмой"):
⁴ Сурьма (Историч.) — Традиционная древнеегипетская подводка для глаз, изготавливавшаяся из растёртого галенита. Выполняла как сакрально-эстетическую функцию, так и практическую, защищая зрительный нерв от палящего солнца и инфекций.
Anchor in JSON: "натёрла сурьмой"

Example with phrase anchor (source text: "сына Гора"):
⁵ Сын Гора (Мифол.) — Гор был богом неба с головой сокола, известным своей мстительностью и талантом терять важные части тела в семейных ссорах. Прямое родство с ним автоматически гарантировало идеальную осанку, врождённый пафос и острую потребность смотреть на всех остальных как на нечто, прилипшее к подошве сандалии.
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
² Наноботы (Техн.) — Гипотетические устройства молекулярного масштаба, спроектированные для выполнения задач внутри организма: доставки лекарств, диагностики, восстановления тканей. Гипотетические — потому что реальные инженеры пока заняты тем, чтобы обычные принтеры работали хотя бы через раз.

**Real geographical location — factual note, remark only if genuinely apt:**
³ Café de Flore (Геогр.) — Кафе на бульваре Сен-Жермен, 172, Париж, основано в 1887 году. Постоянное место Жан-Поля Сартра и Симоны де Бовуар в 1940-х; по сей день считается интеллектуальным символом Левого берега. Восемь евро за эспрессо — это не за кофе, это за право занять стул рядом с призраком экзистенциализма.

**Historical event — what and when, Pratchett iff warranted:**
⁴ Битва при Ватерлоо (Историч.) — Сражение 18 июня 1815 года близ одноимённой деревни в Бельгии, в котором силы Седьмой коалиции под командованием герцога Веллингтона и фельдмаршала Блюхера нанесли окончательное поражение армии Наполеона. Для Наполеона это стало окончательным «нет» со стороны Европы — достаточно вежливым, чтобы не объяснять причин, и достаточно убедительным, чтобы хватило семидесяти тысяч штыков.

**Fictional-universe canon — factual first, irony welcome:**
⁵ Авада Кедавра (Канон.) — Одно из трёх Непростительных заклятий в легендариуме Дж. К. Роулинг; вызывает мгновенную смерть без видимых повреждений тела. Впервые появляется в «Кубке огня» (2000). Единственный задокументированный способ выжить — быть главным героем и иметь достаточно книг в серии.

**Cultural reference / jargon — full Pratchett:**
⁶ Cruciatus (лат.) — Непростительное проклятие, причиняющее невыносимую боль. В приличном обществе считается дурным тоном, но приличное общество обычно заканчивается именно там, где начинаются тёмные маги с плохим детством и списком обид длиннее, чем «Война и мир».

Example with non-nominative anchor (source text: "натёрла сурьмой"):
⁷ Сурьма (Историч.) — Косметическая смесь на основе растёртого галенита (сульфида свинца), применявшаяся в Древнем Египте как подводка для глаз; наносилась заострённой палочкой, одновременно защищая от солнца и инфекций. То, что галенит содержит свинец, египтян не останавливало — они были реалистами.

Example with phrase anchor (source text: "сына Гора"):
⁸ Сын Гора (Мифол.) — Потомок Гора, египетского бога неба с головой сокола, покровителя фараонов. Прямое родство автоматически гарантировало безупречную осанку, врождённый пафос и привычку смотреть на окружающих как на нечто, прилипшее к подошве сандалии.`,
    },
    meta_plus: {
        en: `### Examples (exact output format — copy this structure)

¹ Dark Cave (Litcrit.) — The author spent three paragraphs describing the darkness in a cave that, as it turns out, had torches standing in it. The writer apparently believed "dark" was synonymous with "atmospheric." He was wrong.

² Hero Charges Into Battle (Narrative.) — In Chapter 12, this same character broke his ribs falling down a three-step staircase. Now he's charging twenty armed goblins with a single poker. Apparently the ribs healed extraordinarily fast — or the author simply forgot.

³ "Forewarned Is Forearmed" (Fourthwall.) — Does the reader genuinely believe this character will ever be both forewarned and forearmed simultaneously? The author has promised three times that "next time will be worse." So far, only the prose is getting worse.

⁴ Dungeon Civil Code (Archive.) — §7.3.2 of the Dungeon Civil Code: "Any party discovering a treasure chest is required to first check for mimics, and then for more dangerous mimics. In the event of a mimic of a mimic, legal counsel is recommended — provided the mimic hasn't eaten counsel first."

⁵ On the Dark Lord's Sword (Gossip.) — In the taverns they whisper that the Dark Lord's sword was actually bought at a clearance sale in an arms shop for three copper pennies and sharpened by a driver who quit after the first swing. The Lord, of course, maintains it is "a ritual blade of ancient times." The driver disagrees.

⁶ Knocking at the Door (Folklore.) — If someone knocks three times at midnight — it's spirits. Four times — it's the postman. Five times — it's spirits who have learned to count and decided to frighten you even more.

⁷ "I Am Unstoppable" (Irony.) — The character announces this with the confidence of someone who has clearly never been stopped before, which statistically means his first time is about three paragraphs away.

⁸ The Final Stand (Bathos.) — A three-page monologue about honor, destiny, and the weight of centuries of dragon blood — interrupted by a sneeze that sends him stumbling off the edge of the parapet. The narrative budget has been spent.

⁹ "Just a Scratch" (Litotes.) — The character lost an arm. The text calls it "a minor inconvenience." The remaining four paragraphs describe, in forensic detail, how the arm is currently on the other side of the courtyard.

¹⁰ Hero Before a Mirror (Intertext.) — Hamlet held a skull. Our hero holds a hairbrush and delivers the same soliloquy to his own reflection, minus the philosophical depth but plus surprisingly specific hair care advice.

¹¹ "An Army of Thousands" (Hyperbol.) — The text claims the army stretched "from horizon to horizon." At standard marching density, that is roughly 4.7 soldiers and one very confused goat.`,
        ru: `### Examples (exact output format — copy this structure)

¹ Тёмная пещера (Литкрит.) — Автор потратил три абзаца на описание темноты в пещере, где, как выясняется, стояли факелы. Писатель, видимо, полагал, что «тёмный» — это синоним «атмосферного». Он ошибался.

² Герой врывается в бой (Нарратив.) — В главе 12 этот же персонаж сломал себе рёбра после падения с лестницы из трёх ступенек. Теперь он бросается на двадцать вооружённых гоблинов с одной кочергой. Видимо, рёбра срослись экстремально быстро — или автор просто забыл.

³ «Предупреждён» (Четв.стена.) — Интересно, читатель действительно верит, что этот персонаж когда-нибудь будет предупреждён и вооружён одновременно? Автор уже три раза обещал, что «в следующий раз будет хуже». Пока что хуже становится только прозе.

⁴ Гражданский кодекс Подземелья (Архив.) — Статья 7.3.2 Гражданского Кодекса Подземелья: «Любая партия, обнаружившая сундук с сокровищами, обязана сначала проверить его на наличие мимиков, а затем — на наличие более опасных мимиков. В случае обнаружения мимика мимика рекомендуется обратиться к юристу, если мимик не съел юриста первым.»

⁵ О мече Тёмного Лорда (Сплетня.) — В тавернах шепчут, что меч Тёмного Лорда на самом деле был куплен на распродаже в оружейной лавке за три медяка и подточен шофёром, который уволился после первого же замаха. Лорд, впрочем, утверждает, что это «ритуальный клинок древних времён». Шофёр утверждает иначе.

⁶ Стук в дверь (Примета.) — Если в полночь в дверь стучат трижды — это духи. Если четыре раза — это почтальон. Если пять раз — это духи, которые научились считать и решили вас напугать ещё сильнее.

⁷ «Меня не остановить» (Ирония.) — Персонаж произносит это с уверенностью человека, которого, судя по статистике, ещё никогда не останавливали. Что математически означает: первый раз — через абзац.

⁸ Последний бой (Батос.) — Трёхстраничный монолог о чести, предназначении и весе веков драконьей крови — прерванный чихом, от которого он спотыкается и падает с парапета. Нарративный бюджет исчерпан.

⁹ «Царапинка» (Литотес.) — Персонаж потерял руку. Текст называет это «незначительным неудобством». Остальные четыре абзаца описывают в судебно-медицинских подробностях, как рука в данный момент находится на другом конце двора.

¹⁰ Герой перед зеркалом (Интекст.) — Гамлет держал череп. Наш герой держит расчёску и произносит тот же монолог перед собственным отражением — без философской глубины, но с неожиданно подробными рекомендациями по уходу за волосами.

¹¹ «Армия в тысячи воинов» (Гиперб.) — Текст утверждает, что армия тянулась «от горизонта до горизонта». При стандартной плотности марша это примерно 4,7 солдата и один растерянный козёл.`,
    },
    academic: {
        en: `### Examples (exact output format — copy this structure)

¹ Cruciatus (Lat.) — From crucio, "to torture". In J. K. Rowling's legendarium, one of the three Unforgivable Curses; inflicts intense pain without physical damage. First mentioned in "Harry Potter and the Goblet of Fire" (2000).

² Baisse le son, tu vas réveiller les morts (Fr.) — "Turn it down, you'll wake the dead." Colloquial French expression used as a hyperbolic complaint about excessive noise.

³ Shendyt (Arch., anc. Egyp.) — Traditional ancient Egyptian linen loincloth; a basic element of male attire across all social strata, secured by a belt of varying complexity depending on the wearer's status.

Example with non-nominative anchor (source text: "rubbed with kohl"):
⁴ Kohl (Hist.) — Traditional cosmetic compound based on galena (lead sulfide), used in ancient Egypt as eye lining; applied with a sharpened stick.

Example with phrase anchor (source text: "son of Horus"):
⁵ Son of Horus (Myth.) — Designation for a descendant of Horus, the falcon-headed sky god; inheritor of his cult and the mythological status of protector of royal authority.`,
        ru: `### Examples (exact output format — copy this structure)

¹ Cruciatus (лат.) — От crucio, «мучить». В легендариуме Дж. К. Роулинг одно из трёх Непростительных заклятий; вызывает интенсивную боль без физических повреждений. Впервые упоминается в «Гарри Поттере и Кубке огня» (2000).

² Baisse le son, tu vas réveiller les morts (фр.) — «Убавь звук, ты мертвых разбудишь». Разговорное французское выражение, употребляется как гиперболическое указание на чрезмерный шум.

³ Shendyt (Архаич., др.-егип.) — Традиционная древнеегипетская набедренная повязка из льна; базовый элемент мужского костюма всех социальных слоёв, фиксировавшийся поясом различной степени сложности в зависимости от статуса владельца.

Example with non-nominative anchor (source text: "натёрла сурьмой"):
⁴ Сурьма (Историч.) — Традиционная косметическая смесь на основе галенита (сульфида свинца), использовавшаяся в Древнем Египте в качестве подводки для глаз; наносилась заострённой палочкой.

Example with phrase anchor (source text: "сына Гора"):
⁵ Сын Гора (Мифол.) — Обозначение потомка Гора, бога неба с головой сокола; наследник его культа и мифологического статуса защитника царской власти.`,
    },
    language: {
        en: `### Examples

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
        ru: `### Examples

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
