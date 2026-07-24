// Altera empreendimento do lead para SOMENTE Esmeralda (id 42).
// Uso:
//   node alterar.mjs test 33171          -> 1 lead, antes/depois detalhado
//   node alterar.mjs run ids.txt         -> lote (arquivo com 1 id por linha)
//   node alterar.mjs run ids.txt --dry   -> lote em dry-run (só lê, não altera)
import axios from 'axios';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const ESMERALDA = 42;   // manter
const TRES_MARIAS = 39; // remover

const api = axios.create({
  baseURL: process.env.CV_API_BASE_URL,
  headers: {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    email: process.env.CV_API_EMAIL,
    token: process.env.CV_API_TOKEN,
  },
  timeout: 120000,
});

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getLead(idlead) {
  const resp = await api.get(`/cvio/lead?idlead=${idlead}&limit=1&offset=0`);
  return (resp.data?.leads || [])[0] || null;
}

function snap(l) {
  if (!l) return { existe: false };
  const emps = (l.empreendimentos || []).map(e => e.id);
  return {
    existe: true,
    nome: l.nome,
    situacao: l.situacao?.nome ?? l.situacao,
    corretor: l.corretor ? `${l.corretor.id}:${l.corretor.nome}` : null,
    emps,
  };
}

async function alterar(idlead) {
  const resp = await api.put(`/v1/cvbot/lead/${idlead}/alterar_empreendimento`, {
    idempreendimento: ESMERALDA,
  });
  return resp.data;
}

async function testOne(idlead) {
  console.log(`\n=== TESTE lead ${idlead} ===`);
  const before = snap(await getLead(idlead));
  console.log('ANTES :', JSON.stringify(before));
  if (!before.existe) { console.log('Lead não encontrado, abortando.'); return; }
  if (before.emps.length === 1 && before.emps[0] === ESMERALDA) {
    console.log('Já está só com Esmeralda. Nada a fazer.');
    return;
  }
  console.log(`PUT alterar_empreendimento -> idempreendimento=${ESMERALDA} …`);
  try {
    const r = await alterar(idlead);
    console.log('RESPOSTA:', JSON.stringify(r));
  } catch (e) {
    console.log('ERRO no PUT:', e.response?.status, JSON.stringify(e.response?.data || e.message));
    return;
  }
  await sleep(1500);
  const after = snap(await getLead(idlead));
  console.log('DEPOIS:', JSON.stringify(after));
  // Veredito
  const removeuTM = !after.emps.includes(TRES_MARIAS);
  const manteveEsm = after.emps.includes(ESMERALDA);
  const soEsm = after.emps.length === 1 && manteveEsm;
  const corretorMudou = before.corretor !== after.corretor;
  console.log('\n--- VEREDITO ---');
  console.log('Removeu Três Marias?', removeuTM);
  console.log('Manteve Esmeralda? ', manteveEsm);
  console.log('Sobrou SÓ Esmeralda?', soEsm);
  console.log('Corretor mudou?    ', corretorMudou, corretorMudou ? `(${before.corretor} -> ${after.corretor})` : '');
}

async function runBatch(file, dry) {
  const ids = fs.readFileSync(file, 'utf8')
    .split(/\r?\n/).map(s => s.trim()).filter(Boolean).filter(s => /^\d+$/.test(s));
  console.log(`Lote: ${ids.length} ids | dry=${dry}`);
  const log = [];
  let ok = 0, skip = 0, err = 0;
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    const prefix = `[${i + 1}/${ids.length}] ${id}`;
    try {
      const before = snap(await getLead(id));
      if (!before.existe) { console.log(`${prefix} SKIP (não existe)`); log.push({ id, status: 'nao_existe' }); skip++; continue; }
      if (before.emps.length === 1 && before.emps[0] === ESMERALDA) {
        console.log(`${prefix} SKIP (já só Esmeralda)`); log.push({ id, status: 'ja_ok', before }); skip++; continue;
      }
      if (dry) { console.log(`${prefix} DRY antes=${JSON.stringify(before.emps)} corretor=${before.corretor}`); log.push({ id, status: 'dry', before }); continue; }
      await alterar(id);
      await sleep(800);
      const after = snap(await getLead(id));
      const soEsm = after.emps.length === 1 && after.emps.includes(ESMERALDA);
      const corretorMudou = before.corretor !== after.corretor;
      console.log(`${prefix} ${soEsm ? 'OK' : 'CHECAR'} ${JSON.stringify(before.emps)}->${JSON.stringify(after.emps)}${corretorMudou ? ' CORRETOR-MUDOU' : ''}`);
      log.push({ id, status: soEsm ? 'ok' : 'checar', before, after, corretorMudou });
      ok++;
    } catch (e) {
      console.log(`${prefix} ERRO ${e.response?.status || ''} ${JSON.stringify(e.response?.data || e.message)}`);
      log.push({ id, status: 'erro', erro: e.response?.data || e.message }); err++;
    }
    await sleep(300);
  }
  const out = path.resolve(__dirname, `resultado_${dry ? 'dry' : 'run'}.json`);
  fs.writeFileSync(out, JSON.stringify(log, null, 2));
  console.log(`\nFIM. ok=${ok} skip=${skip} erro=${err}. Log: ${out}`);
}

const [mode, arg, flag] = process.argv.slice(2);
if (mode === 'test') testOne(arg || '33171');
else if (mode === 'run') runBatch(path.resolve(__dirname, arg), flag === '--dry');
else console.log('Uso: node alterar.mjs test <idlead> | run <ids.txt> [--dry]');
