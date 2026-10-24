# Glosses

Literary footnotes for [SillyTavern](https://github.com/SillyTavern/SillyTavern). A model of your choice writes footnotes for AI posts — Pratchett-style jokes, language-learning word notes, academic lore, meta-narrator asides, or any mix of these.

Full guide (in Russian): **[USER_GUIDE.md](USER_GUIDE.md)**.

## Features

- Five built-in styles, a custom prompt, or a hybrid mode (several "lenses" on one post); one-click presets.
- Footnotes survive message edits — they re-anchor and renumber; every swipe keeps its own set.
- Display modes: inline highlights, a numbered block under the post, a click popup, or the floating panel only.
- Floating panel: read, edit, delete, regenerate; request footnotes for specific words; per-chat exclusions.
- Two isolated generation sources: a Connection Manager profile or your own OpenAI-compatible endpoint. Neither touches your main chat prompts.
- Popup skins, custom CSS, sounds, highlight styling; English and Russian UI.
- Auto-generation is off by default — enable it in Behavior, or generate manually per message.

## Setup

1. Copy this folder into `data/default-user/extensions/` and restart SillyTavern.
2. Extensions panel → **Glosses** → enable **Enable Footnotes**.
3. Pick a preset or style in **Prompt**, choose a source in **Generation Engine**.
4. For automatic footnotes, tick **Auto-generate on new messages** (Behavior).

## Slash commands

| Command | What it does |
| --- | --- |
| `/glosses_toggle` | Turn footnotes on or off |
| `/glosses_regen` | Regenerate footnotes for the last AI message |
| `/glosses_clear` | Clear this chat's footnote cache |

## Requirements

- SillyTavern 1.12.10 or newer.
- Connection Manager is needed only for the Connection Profile source.

## License

[GNU AGPL-3.0](LICENSE).
