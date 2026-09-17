# Glosses

Literary footnotes for [SillyTavern](https://github.com/SillyTavern/SillyTavern). Gloss a chat post with footnotes in the style you choose — Pratchett, language-learning, academic, meta-narrative, hybrid, or your own — generated for each AI message after it streams.

Подробный гайд (на русском): **[USER_GUIDE.md](USER_GUIDE.md)** — установка по шагам, все настройки, режимы отображения, плавающая панель, свой CSS для попапа.

## What it does

- Five built-in prompt styles plus **hybrid** (several lenses on one post — Language, Pratchett, Canon, Academic, Meta, plus the opt-in Canon Expansion lens that invents lore the canon leaves undefined) plus a fully **custom** prompt style. Presets are one-click shortcuts; manual mode is first-class — any manual edit of a downstream field auto-reverts to manual.
- Footnotes are anchored to the post text and survive edits and swipes: an edit triggers a rebind (surviving anchors re-resolve and re-number), each swipe keeps its own set.
- Display modes: markers in the text, popup on click, numbered block under the post — any mix (`inline` / `popup` / `both`).
- Floating panel (the QR-bar `Tⁿ` button and/or a draggable floating button) with three tabs: **Footnotes** (navigate, copy, edit, delete, regenerate), **Targeted** (gloss a list of up to 20 words/phrases on demand), **Exclusions** (soft repeat-avoidance + exact per-chat forced-ignore).
- Two generation sources: a **Connection Profile** (Connection Manager extension) or a **custom OpenAI-compatible endpoint** called straight from the browser. Optional persona / character card / lorebook context, so the model can disambiguate explanations.
- The Language style accepts constructed/fictional targets (High Valyrian, Klingon, Sindarin, Quenya, Esperanto, Toki Pona) — with attestation honesty; do not expect invented vocabulary.
- Popup styling: skins + knobs + a live custom-CSS layer. Sounds, ru/en UI, mobile layouts.

## Setup

1. Drop this folder under `data/default-user/extensions/third-party/`, restart SillyTavern.
2. Extensions panel → **Glosses** → tick **Enable Footnotes**.
3. Pick a preset in the **Prompt** accordion (or configure manually), then choose a source in **Generation Engine**. A custom `http:` endpoint outside localhost asks a one-time **Confirm insecure endpoint**.

Slash commands: `/glosses_toggle` (on/off), `/glosses_regen` (regenerate footnotes for the last AI message), `/glosses_clear` (clear the current chat's footnote cache).

## Compatibility

- SillyTavern client `1.12.10` or newer. Connection Manager is needed only for the Connection Profile source — the custom endpoint works standalone.
- Footnote calls go through a separate, isolated generation path with presets/instruct explicitly disabled, so the strict JSON footnote contract is preserved — your main chat generation is untouched.
- The built-in Translate extension is detected: footnotes stay anchored to the original text and restore automatically when you un-translate (details below).

## Technical details (for the curious)

- Vanilla ESM JS, jQuery global, **no build step**. Entry: `index.js` → `src/`.
- **Tests**: `npm test` — Node unit tests for the pure modules (matching, text index + fuzzy anchoring, policies, parser, direct and targeted generation, tab controller, per-variant payload storage, metadata writer/chat writer, generation coordinator, endpoint policy, settings binding, rebind engine); CI runs them in `.github/workflows/`. Manual acceptance against a live ST sandbox is still required for DOM/ST-API behaviour — panel mobile layout, editing, regeneration failure preservation, chat/swipe lifecycle.
- **Storage (v3.2+)**: footnote payloads live inside the message itself — `swipe_info[i].extra.gls` (with a live `msg.extra.gls` mirror), keyed by full-text content digest — data moves with the variant and dies with it. No migration from the legacy fingerprint-keyed `chatMetadata.gls_data.entries`; old entries are never read and are wiped by Clear/Clean.
- **Edit resilience**: editing a post triggers a rebind instead of invalidation — surviving anchors are re-resolved against the new text and re-numbered; lost anchors become `payload.orphans`, surfaced as a "lost anchors" banner with an explicit Regenerate CTA in the Footnotes panel. Continue is handled the same way.
- **Foreign-payload rule**: a digest-mismatched payload whose digest matches ANOTHER variant of the same message was planted there by SillyTavern's own extra cloning (the live `extra` is snapshotted into a new swipe slot when a swipe is created), not by an edit — re-binding it would transplant the other swipe's footnotes onto coincidentally matching words. Such payloads are cleared and the variant falls through to fresh generation; the legitimate edit/continue rebind is unaffected.
- **Persistence**: chat-scoped lists (forcedIgnore/poolExcluded) live in `chatMetadata` through the serialized metadata writer; per-variant payloads persist through a coalesced chat writer calling `ctx.saveChat()` (the st-context alias of `saveChatConditional`) with graceful fallback. Save failures surface as a visible toast. Both writers capture `chatId` at schedule time and drop pending writes when the chat switched — the old chat is never persisted through the new context.
- **Custom endpoint hardening (v3.2+)**: the endpoint URL is validated **before** the API key is read or any request is sent — only `http:`/`https:` are accepted, and URLs that embed credentials (`user:pass@host`) are rejected; the key is always sent separately via the `Authorization` header. `https:` endpoints are used as-is; `http:` on loopback hosts (`localhost`, `127.0.0.1`, `::1`) is allowed with a one-time warning; any other plain-`http` origin requires the one-time **Confirm insecure endpoint** confirmation, which adds the origin to a persisted allow-list. The key itself lives in browser `localforage` (not server-side) — that's a browser store, not a vault; for sensitive keys prefer a Connection Profile.
- **Translate guard details**: whenever the Translate extension shows a translated view (AI messages: `mes` stays the original with the translation in `extra.display_text`; your own messages: the translation replaces `mes` and the original is kept in `extra.display_text`), Glosses detects it and skips marker injection, rebind, and generation for that message — including the edit/cancel path, so cancelling the editor of a translated message cannot destroy its footnotes. When you revert to the original, the cached footnotes restore automatically.

## License

MIT.
