# Glosses

Literary footnotes for [SillyTavern](https://github.com/SillyTavern/SillyTavern). After each AI reply, a model of your choice writes footnotes for that message — Pratchett-style jokes, word notes for language learners, academic lore, meta-narrator asides, or any mix of these.

Подробный гайд на русском: **[USER_GUIDE.md](USER_GUIDE.md)**.

## Features

- **Footnote styles.** Five built-in styles (Pratchett, Pratchett 50%, Meta Narrative+, Academic, Language), plus **Hybrid** — several styles ("lenses") on one post — plus a fully **custom** prompt of your own. One-click presets for common setups; whatever you configure by hand stays as you set it.
- **Footnotes survive edits.** Each footnote is tied to the exact words it explains. Edit a message and the surviving footnotes re-anchor and renumber; every swipe keeps its own set.
- **Display modes.** Highlights in the text, a numbered block under the post, a popup on click, or the floating panel only.
- **Floating panel.** Opens from a button in the quick-actions bar and/or a draggable floating button. Three tabs: **Footnotes** (jump to, copy, edit, delete, regenerate), **Targeted** (gloss up to 20 words or phrases you pick), **Exclusions** (words to avoid, per chat).
- **Two generation sources.** A Connection Profile from the Connection Manager extension, or your own OpenAI-compatible endpoint called straight from the browser. The model can also see your persona, the character card, and lorebook entries, so it understands what it is explaining.
- **Language learning.** The Language style can target real and fictional languages (High Valyrian, Klingon, …) and honestly marks invented vocabulary as unattested.
- **Looks and sounds.** Popup skins, a custom-CSS editor, notification sounds, English and Russian UI.
- **Plays nice with everything else.** Footnote requests run in a separate, isolated call — your main chat prompts and presets are untouched. When the built-in Translate extension shows a translated message, footnotes step aside and come back when you switch to the original.

## Setup

1. Copy this folder into `data/default-user/extensions/third-party/` and restart SillyTavern.
2. Open the Extensions panel → **Glosses** → tick **Enable Footnotes**.
3. Pick a preset or style in the **Prompt** section, then choose a source in **Generation Engine**.

## Slash commands

| Command | What it does |
| --- | --- |
| `/glosses_toggle` | Turn footnotes on or off |
| `/glosses_regen` | Regenerate footnotes for the last AI message |
| `/glosses_clear` | Clear this chat's footnote cache |

## Requirements

- SillyTavern 1.12.10 or newer.
- Connection Manager is needed only for the Connection Profile source; a custom endpoint works without it.

## License

[GNU AGPL-3.0](LICENSE).
