# Glosses

Literary footnotes for [SillyTavern](https://github.com/SillyTavern/SillyTavern). Gloss a chat post with footnotes in the style you choose — Pratchett, language-learning, academic, meta-narrative, hybrid, or your own — generated for each AI message after it streams.

## Setup

1. **Install**: drop this folder under `data/default-user/extensions/third-party/`, restart SillyTavern.
2. Extensions panel → find **Glosses** → tick **Enable Footnotes**.
3. Open the **Prompt** accordion, pick a **Preset** (or configure manually — see below):

   | Preset | What it sets |
   |---|---|
   | **Pratchett 50 (RU)** | `promptStyle=pratchett50`, `outputLanguage=ru` |
   | **Lang EN → RU · A2** | `promptStyle=language`, `outputLanguage=ru`, `targetLanguage=en`, `cefrLevel=a1a2` |
   | **Academic Lore (RU)** | `promptStyle=academic`, `outputLanguage=ru` |
   | **Meta (RU)** | `promptStyle=meta_plus`, `outputLanguage=ru` |
   | **(no preset / manual)** | clears `selectedPreset`; edit each field yourself |

   Any manual edit of a downstream field (style, output language, target language, CEFR, hybrid lens toggle) auto-reverts to "(no preset / manual)" — manual mode is first-class, presets are just shortcuts.

4. Open **Generation Engine**, pick a source:
   - **Connection Profile** (recommended): use a profile from the Connection Manager extension.
   - **Custom (OpenAI-compatible)**: paste an endpoint URL and API key. The request goes directly from the browser; the endpoint must send CORS headers or it'll be blocked. The key is stored in browser `localforage` (not server-side) — for server-side secret storage use a Connection Profile instead.

### Custom endpoint security (v3.2+)

The custom endpoint URL is validated **before** the API key is read or any request is sent:

- Only `http:` / `https:` URLs are accepted. `javascript:`, `file:`, `data:` and other protocols are rejected, as are URLs that embed credentials (`user:pass@host`) — the key is always sent separately via the `Authorization` header.
- `https:` endpoints are used as-is.
- `http:` endpoints on loopback hosts (`localhost`, `127.0.0.1`, `::1`) are allowed with a one-time warning.
- `http:` endpoints on any other (non-loopback) host require a one-time origin confirmation: a **Confirm insecure endpoint** button appears in the Custom panel and adds the origin to a persisted allow-list; the request is refused until then. This prevents silently sending your API key in cleartext over the network.

Remember: `localforage` is browser storage, not a secure vault — any script running on the page can read it. For sensitive keys prefer a Connection Profile.

## Reading footnotes

A footnote indicator appears in the message text next to the anchor. Reading modes (Display accordion):

| Mode | Markers in text | Popup on click | Inline block under post |
|---|---|---|---|
| `inline` | YES (no superscript) | NO | YES — numbered list of footnotes |
| `popup` | YES (numbered superscript) | YES | NO |
| `both` | YES (numbered superscript) | YES | YES |

A floating panel (toggle via the QR-bar `Tⁿ` button — the footnote launcher icon) follows the focused message. It has three tabs:

- **Footnotes** lists the current message's footnotes with previous/next navigation, copy, edit, delete, regenerate, and clear controls. Editing changes only the display text; anchors remain read-only.
- **Targeted** accepts one word or phrase per line (up to 20), then produces footnotes in the active style anchored to the focused message. Results are committed through the normal per-variant payload store (markers appear on the post, entries persist with the chat and can be edited/deleted from the Footnotes tab); the per-chat draft text persists in chat metadata.
- **Exclusions** controls the soft preference to avoid previously glossed anchors and stores exact, per-chat forced-ignore phrases. Apply changes affect future generations and regenerations only; existing footnotes are not removed.

- **✕ on the panel** hides it and remembers that choice in the extension settings (it stays hidden across page reloads). Click the launcher to bring it back; click the launcher once more while the panel is visible to turn the floating panel off permanently.
- **Source not configured?** The panel shows a persistent "Source not configured" badge with an **Open settings** button — instead of silently idling after a single vanishing toast.

## Slash commands

| Command | Action |
|---|---|
| `/glosses_toggle` | Toggle footnotes on/off; the QR-bar launcher syncs immediately. |
| `/glosses_regen` | Regenerate footnotes for the last AI message. |
| `/glosses_clear` | Clear all footnotes cache for the current chat. |

## Advanced

- **Clean data** (Extensions panel → Glosses → Clean): removes the current chat's footnote cache and any custom-uploaded sound. It does **not** remove the API key (`localforage`) or the floating-panel position — those are per-browser layout/credentials, not chat data, and are only removed by clearing the whole browser storage.
- **Custom prompt style**: write your own voice in the Custom prompt textarea (Prompt accordion, when `Prompt style = Custom`).
- **Hybrid lenses (Advanced)**: when `Prompt style = Hybrid`, an **Advanced lenses** sub-accordion (collapsed by default) exposes the 5 built-in lens toggles (Language, Pratchett, Canon, Academic, Meta) plus your own custom-lens editor. Each custom lens specifies voice + when-to-footnote + label + format quirk; only the `{{OUTPUT_LANGUAGE}}` token is interpolated.
- **Constructed target languages**: the Language prompt style accepts constructed/fictional targets (High Valyrian, Klingon, Sindarin, Quenya, Esperanto, Toki Pona) — grouped under "Constructed / fictional (advanced)" at the bottom of the target-language dropdown. Attestation honesty is requested by the prompt; do not expect invented vocabulary.
- **Persona / character card / lorebook**: optional context blocks (Generation Engine accordion) — included as reference context so the model can disambiguate explanations; anchors still come only from the current post during ordinary generation.
- **Repeat advisory and exclusions**: the Exclusions tab provides a soft, bounded advisory of recent anchors. Reuse remains allowed when needed to reach the requested count. Forced-ignore entries match the complete normalized anchor exactly and apply only to future generation.

## Compatibility

- SillyTavern client `1.12.10` or newer.
- Requires the Connection Manager extension **only when** you choose the Connection Profile source. Custom (OpenAI-compatible) works standalone.
- Glosses' footnote calls go through a separate, isolated generation path with presets/instruct explicitly disabled, so the strict JSON footnote contract is preserved — your main chat generation is untouched.
- **Translate extension**: whenever the built-in Translate extension shows a translated view (AI messages: `mes` stays the original with the translation in `extra.display_text`; your own messages: the translation replaces `mes` and the original is kept in `extra.display_text`), Glosses detects it and skips marker injection, rebind, and generation for that message — including the edit/cancel path, so cancelling the editor of a translated message cannot destroy its footnotes. When you revert to the original (un-translate), the cached footnotes restore automatically. Footnotes stay anchored to the original text — never to the translation.

## Development

- Vanilla ESM JS, jQuery global, no build step. Entry: `index.js` → `src/`.
- Node unit tests for pure modules: `npm test` (matching, text index + fuzzy anchoring, policies, parser, direct and targeted generation, tab controller, per-variant payload storage, metadata writer/chat writer, generation coordinator, endpoint policy, settings binding, rebind engine).
- Manual acceptance against a live ST sandbox is still required for DOM/ST-API behaviour, including panel mobile layout, editing, regeneration failure preservation, and chat/swipe lifecycle.
- **v3.2 per-variant storage**: footnote payloads live inside `swipe_info[i].extra.gls` (with a live `msg.extra.gls` mirror), keyed by full-text content digest — data moves with the variant and dies with it. No migration from legacy fingerprint-keyed `chatMetadata.gls_data.entries`; old entries are never read and are wiped by Clear/Clean.
- **Edit resilience**: editing a post triggers a rebind instead of invalidation — surviving anchors are re-resolved against the new text and re-numbered; lost anchors become `payload.orphans` surfaced as a "lost anchors" banner with an explicit Regenerate CTA in the Footnotes panel. Continue is handled the same way.
- **Foreign-payload rule**: a digest-mismatched payload whose digest matches ANOTHER variant of the same message was planted there by SillyTavern's own extra cloning (the live `extra` is snapshotted into a new swipe slot when a swipe is created), not by an edit — re-binding it would transplant the other swipe's footnotes onto coincidentally matching words. Such payloads are cleared and the variant falls through to fresh generation; the legitimate edit/continue rebind is unaffected.
- Persistence: chat-scoped lists (forcedIgnore/poolExcluded) live in `chatMetadata` through the serialized metadata writer; per-variant payloads persist through a coalesced chat writer calling `ctx.saveChat()` (the st-context alias of `saveChatConditional`) with graceful fallback. Save failures surface as a visible toast.
- Cross-chat safety: both writers capture `chatId` at schedule time and drop pending writes when the chat switched — the old chat is never persisted through the new context.

## License

MIT.
