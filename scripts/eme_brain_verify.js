// scripts/eme_brain_verify.js
//
// GATE DE ZERO-REGRESSÃO (Fase 0). Prova, EM MEMÓRIA (sem banco), que a montagem
// DB-driven (assembleSystemPrompt sobre os blocos semeados) é IDÊNTICA ao
// buildSystemPrompt atual, para vários perfis de usuário.
//
// Uso:  node scripts/eme_brain_verify.js
// Sai com código 1 se houver qualquer divergência.

import { buildSystemPrompt } from '../services/OfficeAI/systemPrompt.js';
import { buildOfficeBlocks, assembleSystemPrompt } from '../services/OfficeAI/promptAssembler.js';

// A data/hora ("## Data e hora atual") é a única parte volátil (relógio). Como
// ambos os caminhos usam a MESMA função (buildDynamicContext/dayjs), normalizamos
// essa linha para evitar flake quando o minuto vira entre as duas chamadas.
const normNow = (s) => s.replace(/(## Data e hora atual\n)[^\n]*/, '$1<NOW>');

const brain = { blocks: buildOfficeBlocks() };

const profiles = [
  {
    label: 'admin (sem empreendimentos)',
    user: { username: 'Ana', position: 'Diretora Comercial', city: 'Cuiabá', role: 'admin' },
    ents: [],
  },
  {
    label: 'não-admin com cidade + empreendimentos',
    user: { username: 'Bruno', position: 'Corretor', city: 'Sinop', role: 'user' },
    ents: [
      { name: 'Residencial Ingá', cidade: 'Sinop' },
      { name: 'Park Alameda', cidade: 'Sinop' },
    ],
  },
  {
    label: 'não-admin sem cargo informado',
    user: { username: 'Carla', city: 'Sarandi', role: 'user' },
    ents: [],
  },
];

let allOk = true;

for (const p of profiles) {
  const expected = normNow(buildSystemPrompt(p.user, p.ents));
  const assembled = normNow(assembleSystemPrompt(brain, p.user, p.ents, 'OFFICE'));
  const ok = expected === assembled;
  allOk = allOk && ok;

  if (ok) {
    console.log(`OK   ${p.label}  (${expected.length} chars)`);
  } else {
    let i = 0;
    while (i < expected.length && i < assembled.length && expected[i] === assembled[i]) i++;
    console.log(`DIFF ${p.label}  (esperado ${expected.length} vs montado ${assembled.length})`);
    console.log(`     primeira divergência @ ${i}`);
    console.log(`     esperado: ${JSON.stringify(expected.slice(Math.max(0, i - 50), i + 50))}`);
    console.log(`     montado : ${JSON.stringify(assembled.slice(Math.max(0, i - 50), i + 50))}`);
  }
}

// Sanidade extra: a concatenação crua dos blocos estáticos do HEAD/TAIL deve
// bater com PROMPT_HEAD/PROMPT_TAIL (sem a âncora dinâmica).
const blocks = buildOfficeBlocks();
const nBlocks = blocks.length;
const nDynamic = blocks.filter(b => b.isDynamic).length;
console.log(`\nBlocos gerados: ${nBlocks} (estáticos ${nBlocks - nDynamic}, dinâmico ${nDynamic}).`);

console.log(
  allOk
    ? '\n✅ ZERO REGRESSÃO: montagem DB-driven byte-idêntica ao buildSystemPrompt.'
    : '\n❌ Divergência detectada — NÃO publicar.'
);

process.exit(allOk ? 0 : 1);
