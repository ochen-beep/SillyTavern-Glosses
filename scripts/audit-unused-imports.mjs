// Audit script: report named imports that are never referenced in the module.
import { readFileSync } from 'node:fs';

const files = process.argv.slice(2);
let issues = 0;

for (const f of files) {
    const src = readFileSync(f, 'utf8');
    const importRe = /import\s*\{([^}]+)\}\s*from/g;
    let m;
    while ((m = importRe.exec(src)) !== null) {
        const names = m[1].split(',').map(s => s.trim().split(/\s+as\s+/).pop()).filter(Boolean);
        for (const name of names) {
            const fileWithoutImport = src.slice(0, m.index) + src.slice(m.index + m[0].length);
            const re = new RegExp('\\b' + name.replace(/[\\$]/g, '\\$&') + '\\b', 'g');
            const count = (fileWithoutImport.match(re) || []).length;
            if (count === 0) { console.log(`UNUSED in ${f}: ${name}`); issues++; }
        }
    }
}
console.log(issues === 0 ? 'no unused imports' : `${issues} unused import(s)`);
