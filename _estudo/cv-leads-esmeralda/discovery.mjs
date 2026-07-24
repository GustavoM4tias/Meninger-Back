// Discovery (SOMENTE LEITURA) — não altera nada.
// 1) Descobre idempreendimento de Esmeralda e Tres Marias / Ibitinga
// 2) Lê um lead de teste e mostra empreendimentos + corretor atuais
import axios from 'axios';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const api = axios.create({
  baseURL: process.env.CV_API_BASE_URL,
  headers: {
    Accept: 'application/json',
    email: process.env.CV_API_EMAIL,
    token: process.env.CV_API_TOKEN,
  },
  timeout: 120000,
});

const TEST_LEAD = process.argv[2] || '33171';

function mask(s) { return s ? s.slice(0, 4) + '…' + s.slice(-3) : '(vazio)'; }

async function main() {
  console.log('Base URL :', process.env.CV_API_BASE_URL);
  console.log('Email    :', process.env.CV_API_EMAIL);
  console.log('Token    :', mask(process.env.CV_API_TOKEN));
  console.log('------------------------------------------------------------');

  // 1) Empreendimentos
  console.log('\n== Empreendimentos (filtro ESMERALDA / MARIAS / IBITINGA) ==');
  try {
    const resp = await api.get('/v1/cadastros/empreendimentos');
    const raw = resp.data;
    // resposta costuma ser objeto keyed por id ou array; normaliza
    let list = [];
    if (Array.isArray(raw)) list = raw;
    else if (raw && typeof raw === 'object') {
      list = Object.entries(raw).map(([k, v]) => ({ _key: k, ...v }));
    }
    const hit = list.filter(e => {
      const nome = (e.nome || e.empreendimento || e.descricao || '').toString().toUpperCase();
      return /ESMERALDA|MARIAS|IBITINGA/.test(nome);
    });
    if (!hit.length) {
      console.log('Nenhum match direto. Amostra de 5 registros para inspecionar formato:');
      console.log(JSON.stringify(list.slice(0, 5), null, 2));
    } else {
      hit.forEach(e => {
        console.log(`  id=${e.idempreendimento ?? e._key}  nome="${e.nome ?? e.empreendimento ?? e.descricao}"`);
      });
    }
  } catch (e) {
    console.log('ERRO ao listar empreendimentos:', e.response?.status, e.response?.data || e.message);
  }

  // 2) Lead de teste
  console.log(`\n== Lead de teste idlead=${TEST_LEAD} ==`);
  try {
    const resp = await api.get(`/cvio/lead?idlead=${TEST_LEAD}&limit=1&offset=0`);
    const leads = resp.data?.leads || [];
    if (!leads.length) { console.log('Nenhum lead retornado.'); return; }
    const l = leads[0];
    console.log('  idlead    :', l.idlead);
    console.log('  nome      :', l.nome);
    console.log('  situacao  :', l.situacao_nome ?? l.situacao);
    console.log('  corretor  :', JSON.stringify(l.corretor ?? l.corretor_nome ?? l.idcorretor));
    console.log('  empreendimentos:');
    const emps = l.empreendimentos || l.empreendimento || [];
    console.log(JSON.stringify(emps, null, 2));
    // dump de chaves para achar onde está o empreendimento, se não veio acima
    if (!emps || (Array.isArray(emps) && !emps.length)) {
      console.log('  [!] campo empreendimentos vazio/ausente. Chaves do lead:');
      console.log('     ', Object.keys(l).join(', '));
    }
  } catch (e) {
    console.log('ERRO ao ler lead:', e.response?.status, e.response?.data || e.message);
  }
}

main();
