// _design/imports-orfaos.mjs
//
// Confere se algum arquivo DO COMMIT importa arquivo que ficou de fora dele.
//
// Espelha o `_design/imports-pendurados.mjs` do Meninger-Front, para o backend.
// A diferença é o gatilho: no front o import quebra a build; aqui, em ESM, ele
// derruba o BOOT — e como `models/sequelize/index.js` é importado por quase
// tudo, um import órfão ali mata a API inteira.
//
// Já aconteceu quatro vezes, sempre igual: o commit leva o arquivo que importa
// e deixa para trás o importado.
//   - 2026-08-06: server.js + models/index.js levaram import de feature em
//     andamento; ERR_MODULE_NOT_FOUND em produção, front todo "Sem Permissão"
//   - 2026-08-23: duas vezes no front
//   - 2026-08-24: models/sequelize/index.js commitado importando
//     ./microsoft/microsoftSettings.js, que nunca foi versionado
//
// `node --check` não pega: ele valida sintaxe, não resolve import.
//
// Uso, com os arquivos JÁ no stage e antes do push:
//   node _design/imports-orfaos.mjs
//
// Saída: lista o que está órfão, ou confirma que não há nenhum. Código de saída
// 1 quando acha algo, para dar para encadear com o commit.

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const staged = execSync('git diff --cached --name-only', { encoding: 'utf8' })
    .trim().split('\n').filter(f => f.endsWith('.js') || f.endsWith('.mjs'));

if (!staged.length) {
    console.log('Nada no stage para conferir.');
    process.exit(0);
}

const tracked = new Set(execSync('git ls-files', { encoding: 'utf8' }).trim().split('\n'));
const stagedSet = new Set(staged);

let orfaos = 0;

for (const arquivo of staged) {
    if (!fs.existsSync(arquivo)) continue; // arquivo deletado no commit

    // Tira comentário antes de varrer: import citado em comentário (exemplo de
    // uso, nota de histórico) não é import. Sem isto o verificador acusa o
    // próprio arquivo que explica como ele funciona.
    const src = fs.readFileSync(arquivo, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');

    // Pega `from './x.js'` e `import('./x.js')` — só caminho relativo, porque
    // pacote do node_modules não é problema nosso.
    const alvos = [
        ...src.matchAll(/from\s+['"](\.[^'"]+)['"]/g),
        ...src.matchAll(/import\(\s*['"](\.[^'"]+)['"]\s*\)/g),
    ];

    for (const m of alvos) {
        const dir = path.posix.dirname(arquivo.split(path.sep).join('/'));
        const rel = path.posix.normalize(path.posix.join(dir, m[1]));

        // Versionado, no mesmo commit, ou existente no disco e já rastreado:
        // qualquer um serve. O que não pode é só existir na sua pasta.
        if (tracked.has(rel) || stagedSet.has(rel)) continue;

        console.log(`IMPORT ORFAO  ${arquivo}`);
        console.log(`              -> ${m[1]}  (${rel} nao esta versionado nem no commit)`);
        orfaos++;
    }
}

if (orfaos) {
    console.log();
    console.log(`${orfaos} import(s) apontando para fora do commit.`);
    console.log('Acrescente o arquivo importado ao commit antes de dar push.');
    process.exit(1);
}

console.log(`${staged.length} arquivo(s) conferido(s): nenhum import aponta para fora do commit.`);
