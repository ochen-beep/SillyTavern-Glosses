// @ts-check
/**
 * Deterministic OpenAI-compatible mock endpoint for manual QA of footnote
 * generation — no real LLM needed. Run: `node scripts/mock-llm.mjs`, then in
 * Glosses settings pick Source = Custom, endpoint `http://127.0.0.1:8777/v1`,
 * model as below, any API key.
 *
 * Model names steer behavior:
 *   gls-mock    — anchors footnotes on long words from the prompt; echoes
 *                 [Submitted targets] verbatim for targeted runs
 *   gls-badjson — unparseable response (exercises the parse-failure toast)
 *   gls-empty   — empty response
 *   gls-error   — HTTP 500 (exercises the transport-error toast)
 *
 * GET /__journal dumps every received request (prompt inspection).
 */
import http from 'node:http';

const journal = [];

const server = http.createServer((req, res) => {
    const cors = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
    if (req.method === 'GET' && req.url === '/__journal') {
        res.writeHead(200, { 'content-type': 'application/json', ...cors });
        res.end(JSON.stringify(journal, null, 1));
        return;
    }
    if (req.method === 'GET' && req.url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json', ...cors });
        res.end(JSON.stringify({ data: [{ id: 'gls-mock' }, { id: 'gls-badjson' }, { id: 'gls-empty' }, { id: 'gls-error' }] }));
        return;
    }
    if (req.method !== 'POST' || !(req.url === '/v1/chat/completions' || req.url === '/chat/completions')) {
        res.writeHead(404, cors); res.end(); return;
    }
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
        let parsed = {};
        try { parsed = JSON.parse(body); } catch { /* empty */ }
        const model = parsed.model || 'gls-mock';
        const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
        journal.push({ t: Date.now(), url: req.url, model, messages });
        if (model === 'gls-error') {
            res.writeHead(500, { 'content-type': 'application/json', ...cors });
            res.end(JSON.stringify({ error: { message: 'mock server error' } }));
            return;
        }
        if (model === 'gls-badjson') {
            respond('это вообще не json {{{');
            return;
        }
        if (model === 'gls-empty') {
            respond('');
            return;
        }
        // gls-mock: anchor footnotes on up to 6 long words from the prompt
        // (post text first, but user-typed targeted goals later in the prompt
        // must also make the cut).
        const usr = messages.filter((m) => m.role === 'user').map((m) => m.content).join('\n');
        // Targeted contract: echo the submitted targets verbatim, same order.
        const targetsMark = usr.indexOf('[Submitted targets]');
        if (targetsMark >= 0) {
            const listPart = usr.slice(targetsMark);
            const targets = [...listPart.matchAll(/^\s*\d+\.\s+(.+)$/gm)].map((m) => m[1].trim());
            const fns = targets.map((t, i) => ({ anchor: t, text: `${t} — targeted mock note ${i + 1}.` }));
            respond(JSON.stringify({ footnotes: fns }));
            return;
        }
        const words = [...new Set(
            String(usr).replace(/[^\p{L}\p{N} ]/gu, ' ').split(/\s+/)
                .filter((w) => w.length > 6),
        )].slice(0, 6);
        const sups = ['¹', '²', '³'];
        const fns = words.map((w, i) => ({ index: i + 1, anchor: w, text: `${sups[i]} ${w} — mock footnote ${i + 1}.` }));
        respond(JSON.stringify({ footnotes: fns }));

        function respond(content) {
            res.writeHead(200, { 'content-type': 'application/json', ...cors });
            res.end(JSON.stringify({
                id: 'mock-completion', object: 'chat.completion', model,
                choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
            }));
        }
    });
});

server.listen(8777, () => console.log('gls mock LLM on http://127.0.0.1:8777/v1'));
