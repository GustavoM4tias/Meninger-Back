// services/sienge/conciliacaoAtoService.js
//
// Conciliação entre o ATO cobrado pelo Office (boleto Caixa + link de cartão
// Userede) e o RECEBIMENTO lançado no Sienge (documento AVC).
//
// Para que serve: o ato é cobrado e baixado automaticamente pelo Office, mas o
// lançamento no Sienge é manual — o administrativo digita depois. Então o
// recebimento do Sienge está sempre atrás da cobrança, e o buraco entre os dois
// é justamente o trabalho pendente. Esta conciliação mostra esse buraco.
//
// ── A CHAVE ─────────────────────────────────────────────────────────────────
// Casamos por NOME DO CLIENTE normalizado (sem acento, sem pontuação, caixa
// alta). Medido no Jardim dos Anjos (agosto/2026): 90 de 90 recebimentos AVC
// acharam o ato pelo nome — 100%.
// As alternativas foram testadas e são piores:
//   • documentNumber do AVC -> idpessoa_cv do ato: casou 3% (o Sienge grava ali
//     o código do próprio cliente na maioria das vezes, não o id do CV);
//   • nome + valor exato: 93% — os 7% que sobram não são erro de chave, são
//     divergência de VALOR, que é um achado do relatório e não um obstáculo.
// Nome não é chave forte: dois homônimos no mesmo empreendimento se confundem.
// Por isso o casamento é feito DENTRO do escopo (empreendimento/empresa) e,
// havendo mais de um ato para o mesmo nome, escolhemos o de valor igual e, na
// falta dele, o pago mais próximo da data do recebimento. Casos com mais de um
// candidato saem marcados como `ambiguo` para conferência humana.
//
// ── O EMPREENDIMENTO ────────────────────────────────────────────────────────
// O ato guarda o empreendimento como TEXTO do CV ("RESIDENCIAL DOS ANJOS"); o
// AVC vem com centro de custo e empresa do ERP (10401 / 104). A ponte é a
// tabela `enterprises`, que pareia os dois mundos. O `erp_cost_center_id` do
// pareamento às vezes é o centro de custo cheio (23001) e às vezes o código da
// empresa (104) — daí aceitarmos as duas formas.
// Ato cujo empreendimento não resolve NÃO é descartado em silêncio: ele é
// contado em `naoMapeados` e aparece na tela.
//
// ── A JANELA ────────────────────────────────────────────────────────────────
// Os dois lados são buscados com FOLGA de 90 dias para trás do período pedido,
// só para efeito de CASAMENTO. Sem isso, um ato pago em julho e lançado em
// julho apareceria como "falta lançar" ao consultar agosto — acusação falsa.
// Já a CONTAGEM dos grupos respeita o período que o usuário escolheu.

import db from '../../models/sequelize/index.js';
import { siengeQuery } from '../../lib/siengeReadDb.js';

const Q = { type: db.Sequelize.QueryTypes.SELECT };

// Folga (em dias) para trás, só para casar — ver o cabeçalho. É apenas o
// FALLBACK: quem manda é o campo "Olhar para trás" da tela, porque o atraso do
// administrativo varia por empreendimento e por época do ano.
const FOLGA_DIAS_PADRAO = 90;
const FOLGA_MIN = 0;
const FOLGA_MAX = 365;

/** Folga efetiva: o que veio da tela, preso na faixa segura. */
export function resolverFolga(valor) {
  const n = parseInt(valor, 10);
  if (!Number.isFinite(n)) return FOLGA_DIAS_PADRAO;
  return Math.min(FOLGA_MAX, Math.max(FOLGA_MIN, n));
}

/** Normaliza nome de pessoa/empreendimento para virar chave de comparação. */
export function normalizar(s) {
  return String(s ?? '')
    .normalize('NFD').replace(/\p{Diacritic}/gu, '')
    .toUpperCase().replace(/[^A-Z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

const diasAntes = (iso, dias) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - dias);
  return d.toISOString().slice(0, 10);
};

const soData = (v) => (v ? String(v instanceof Date ? v.toISOString() : v).slice(0, 10) : null);

/**
 * Mapa nome-do-empreendimento -> { erpCc, companyId }, mais o índice
 * centro-de-custo -> empresa usado para ampliar a alçada (ver `expandirEscopo`).
 * Aceita tanto o nome do CV quanto o do ERP porque o ato grava o do CV, mas
 * empreendimento antigo às vezes veio com o nome do ERP.
 */
async function carregarMapaEmpreendimentos() {
  const rows = await db.sequelize.query(
    `SELECT erp_cost_center_id, company_id, cv_id, name, cv_payload->>'nome' AS cv_nome
       FROM enterprises`, Q);

  const mapa = new Map();
  const empresaPorCc = new Map();
  for (const e of rows) {
    const valor = {
      erpCc: e.erp_cost_center_id == null ? null : Number(e.erp_cost_center_id),
      companyId: e.company_id == null ? null : Number(e.company_id),
    };
    if (valor.erpCc != null && valor.companyId != null) empresaPorCc.set(valor.erpCc, valor.companyId);
    for (const nome of [e.cv_nome, e.name]) {
      const k = normalizar(nome);
      // 'NULL' aparece porque cv_payload->>'nome' devolve a string quando o
      // JSON tem null literal.
      if (k && k !== 'NULL' && !mapa.has(k)) mapa.set(k, valor);
    }
  }
  return { mapa, empresaPorCc };
}

/**
 * Amplia a alçada do centro de custo para a EMPRESA dele.
 *
 * Por que é necessário: o ato não guarda centro de custo, só o nome do
 * empreendimento do CV — e no `enterprises` a linha pareada com o CV costuma
 * trazer o código da EMPRESA (Jardim dos Anjos = 104), enquanto o grant do
 * usuário costuma cair na linha do ERP, com o centro de custo cheio (10401).
 * Sem esta ponte, quem tivesse o grant por 10401 via os 90 recebimentos e
 * NENHUM ato — e a tela acusaria os 90 como "sem ato", que é alarme falso.
 *
 * Não é afrouxamento de alçada: o ato só existe no nível do empreendimento do
 * CV, então esta é a granularidade máxima que o dado tem. Um grant em qualquer
 * centro de custo do empreendimento dá acesso aos atos DESSE empreendimento.
 */
function expandirEscopo(erpIds, empresaPorCc) {
  const out = new Set(erpIds || []);
  for (const id of erpIds || []) {
    const empresa = empresaPorCc.get(Number(id));
    if (empresa != null) out.add(empresa);
  }
  return [...out];
}

/** O ato pertence ao recorte? Aceita casar pelo centro de custo OU pela empresa. */
function dentroDoRecorte(destino, { ccs, empresas, scope }) {
  if (!destino) return false;
  const { erpCc, companyId } = destino;

  // Alçada primeiro: fail-closed.
  if (!scope.all) {
    const permitidos = new Set(scope.erpIds || []);
    if (!permitidos.has(erpCc) && !(companyId != null && permitidos.has(companyId))) return false;
  }
  if (ccs && !ccs.has(erpCc) && !(companyId != null && ccs.has(companyId))) return false;
  if (empresas && !empresas.has(erpCc) && !(companyId != null && empresas.has(companyId))) return false;
  return true;
}

/** Busca os atos (boleto + cartão) pagos na janela, já achatados num formato só. */
async function carregarAtos(deISO, ateISO) {
  const params = { replacements: { de: deISO, ate: `${ateISO} 23:59:59` }, ...Q };

  const boletos = await db.sequelize.query(
    `SELECT id, idreserva, idpessoa_cv, titular_nome, empreendimento, valor,
            vencimento, status, payment_status, paid_at, NULL AS unidade
       FROM boleto_history
      WHERE payment_status = 'paid' AND paid_at BETWEEN :de AND :ate
        AND COALESCE(ignorado, false) = false`, params);

  const cartoes = await db.sequelize.query(
    `SELECT id, idreserva, idpessoa_cv, titular_nome, empreendimento, valor,
            NULL AS vencimento, status, payment_status, paid_at, unidade
       FROM userede_link_history
      WHERE payment_status = 'paid' AND paid_at BETWEEN :de AND :ate
        AND COALESCE(ignorado, false) = false`, params);

  return [
    ...boletos.map(r => ({ ...r, tipo: 'boleto' })),
    ...cartoes.map(r => ({ ...r, tipo: 'cartao' })),
  ].map(a => ({
    id: a.id,
    // boleto_history e userede_link_history COMPARTILHAM espaço de id, então
    // `id` sozinho não identifica um ato: dois registros diferentes podem ter
    // o mesmo número. `uid` é o que serve de chave de lista e de deduplicação.
    uid: `${a.tipo}:${a.id}`,
    tipo: a.tipo,
    idreserva: a.idreserva,
    titular: a.titular_nome,
    chave: normalizar(a.titular_nome),
    empreendimento: a.empreendimento,
    unidade: a.unidade,
    valor: Number(a.valor || 0),
    pago_em: soData(a.paid_at),
    vencimento: soData(a.vencimento),
  }));
}

/**
 * Nomes de clientes que JÁ tiveram recebimento de ato no espelho do Sienge
 * dentro da janela de folga. Serve só para NÃO acusar de pendente um ato que já
 * foi lançado antes do período consultado.
 *
 * Vem do BACKUP, e não da API, por uma razão medida: pedir a janela estendida à
 * API sem filtro de empresa devolve 66,8 MB e 20.329 registros (contra 16 MB do
 * período), e isso derrubava a tela em produção com 500 - o processo do Office
 * roda ~25 schedulers e não tem memória sobrando para segurar esse JSON. Aqui a
 * resposta é uma lista de nomes.
 *
 * O atraso do espelho (~24h) é inofensivo NESTE uso: recebimento lançado nas
 * últimas horas cai dentro do próprio período consultado, que é lido ao vivo e
 * entra no conjunto por outro caminho (ver `chavesJaLancadas`).
 */
async function nomesComAvcNoEspelho(deISO, ateISO, { ccs, empresas, scope }) {
  const params = [deISO, ateISO];
  let extra = '';
  const add = (v) => { params.push(v); return '$' + params.length; };

  if (empresas) extra += `
      AND emp.cdempresaview = ANY(${add([...empresas])}::int[])`;
  if (ccs)      extra += `
      AND e.cdempreendview  = ANY(${add([...ccs])}::int[])`;
  if (!scope.all) {
    // Mesma regra dos dois lados: centro de custo OU código da empresa.
    const permitidos = add(scope.erpIds || []);
    extra += `
      AND (e.cdempreendview = ANY(${permitidos}::int[]) OR emp.cdempresaview = ANY(${permitidos}::int[]))`;
  }

  const sql = `
    SELECT DISTINCT c.nmcliente
      FROM ecrcbaixa bx
      INNER JOIN ecrctitulo  t   ON t.nutitulo = bx.nutitulo
      INNER JOIN ecadempresa emp ON emp.cdempresa = t.cdempresa
      LEFT  JOIN ecadcliente c   ON c.cdcliente = t.cdcliente
      LEFT  JOIN LATERAL (
        SELECT un.cdempreend FROM ecrcunidade un
        WHERE un.nutitulo = t.nutitulo
        ORDER BY (un.flprincipal = 'S') DESC, un.nuunidade LIMIT 1
      ) u ON true
      LEFT JOIN ecadempreend e ON e.cdempreend = u.cdempreend
     WHERE TRIM(t.cddocumento) = 'AVC'
       AND bx.dtrecto BETWEEN $1::date AND $2::date${extra}
  `;
  const { rows } = await siengeQuery(sql, params);
  return rows.map(r => normalizar(r.nmcliente)).filter(Boolean);
}

/**
 * Escolhe o melhor ato para um recebimento entre os candidatos de mesmo nome:
 * valor igual ganha; senão, o pago mais perto da data do recebimento.
 */
function melhorCandidato(candidatos, recebimento) {
  if (candidatos.length === 1) return candidatos[0];
  const exato = candidatos.filter(a => Math.abs(a.valor - recebimento.valor_baixa) < 0.01);
  const pool = exato.length ? exato : candidatos;
  const alvo = new Date(`${recebimento.data_baixa}T00:00:00Z`).getTime();
  return pool.reduce((melhor, a) => {
    const d = (t) => Math.abs(new Date(`${t.pago_em || '1970-01-01'}T00:00:00Z`).getTime() - alvo);
    return d(a) < d(melhor) ? a : melhor;
  });
}

const RESUMO_ZERO = {
  conciliados: 0, divergentes: 0, avcSemAto: 0, atoSemAvc: 0,
  valorAtoSemAvc: 0, valorAvcSemAto: 0, naoMapeados: 0, atosPagosNoPeriodo: 0,
};

/**
 * Concilia as linhas de AVC do período com os atos pagos.
 *
 * @param linhas   linhas já filtradas do relatório de recebimentos (período)
 * @param filtros  { startDate, endDate, empresas[], empreendimentos[] }
 * @param scope    { all } ou { erpIds }
 * @returns { resumo, atosSemAvc[], porLinha: Map<idLinha, marcacao> }
 */
export async function conciliar(linhas, filtros, scope, { folgaDias } = {}) {
  const { startDate, endDate } = filtros;
  const folga = resolverFolga(folgaDias);
  const de = diasAntes(startDate, folga);

  const ccs = filtros.empreendimentos.length ? new Set(filtros.empreendimentos) : null;
  const empresas = filtros.empresas.length ? new Set(filtros.empresas) : null;

  const [{ mapa: mapaEmp, empresaPorCc }, atosTodos] = await Promise.all([
    carregarMapaEmpreendimentos(),
    carregarAtos(de, endDate),
  ]);

  // A alçada do lado do ato enxerga o empreendimento inteiro (ver expandirEscopo).
  const escopoAto = scope.all
    ? scope
    : { all: false, erpIds: expandirEscopo(scope.erpIds, empresaPorCc) };

  // Recorta os atos pelo escopo, contando quem não resolveu empreendimento.
  let naoMapeados = 0;
  const atos = [];
  for (const a of atosTodos) {
    const destino = mapaEmp.get(normalizar(a.empreendimento));
    if (!destino) { naoMapeados++; continue; }
    if (dentroDoRecorte(destino, { ccs, empresas, scope: escopoAto })) atos.push(a);
  }

  // Índice de atos por nome.
  const atosPorChave = new Map();
  for (const a of atos) {
    if (!atosPorChave.has(a.chave)) atosPorChave.set(a.chave, []);
    atosPorChave.get(a.chave).push(a);
  }

  // ── Lado AVC: cada linha do período ganha uma marcação ────────────────────
  const porLinha = new Map();
  const usados = new Set();
  const resumo = { ...RESUMO_ZERO, naoMapeados };

  for (const l of linhas) {
    const candidatos = atosPorChave.get(normalizar(l.cliente)) || [];
    if (!candidatos.length) {
      resumo.avcSemAto++;
      resumo.valorAvcSemAto += l.valor_baixa;
      porLinha.set(l.id, { status: 'sem_ato', ato: null });
      continue;
    }
    const ato = melhorCandidato(candidatos, l);
    usados.add(ato.uid);

    const divergente = Math.abs(ato.valor - l.valor_baixa) >= 0.01;
    if (divergente) resumo.divergentes++;
    resumo.conciliados++;

    porLinha.set(l.id, {
      status: divergente ? 'divergente' : 'conciliado',
      ambiguo: candidatos.length > 1,
      ato: {
        id: ato.id, uid: ato.uid, tipo: ato.tipo, titular: ato.titular, valor: ato.valor,
        pago_em: ato.pago_em, unidade: ato.unidade, idreserva: ato.idreserva,
        diferenca: Number((l.valor_baixa - ato.valor).toFixed(2)),
      },
    });
  }

  // ── Lado ato: pagos no PERÍODO que não acharam recebimento ────────────────
  // Procura no AVC da janela estendida — um ato pago em junho e lançado em
  // junho não pode ser acusado de pendente só porque a tela está em agosto.
  const noPeriodo = atos.filter(a => a.pago_em >= startDate && a.pago_em <= endDate);
  resumo.atosPagosNoPeriodo = noPeriodo.length;

  const naoCasados = noPeriodo.filter(a => !usados.has(a.uid));

  // Quem já foi lançado alguma vez na janela de folga. Duas fontes somadas:
  // o espelho (barato, cobre até ~24h atrás) e as próprias linhas do período
  // (ao vivo, cobrem o que o espelho ainda não tem). Sem esse conjunto NÃO
  // acusamos ninguém: a lista sai vazia e a tela avisa.
  let chavesJaLancadas = null;
  if (naoCasados.length) {
    try {
      chavesJaLancadas = new Set([
        ...await nomesComAvcNoEspelho(de, endDate, { ccs, empresas, scope }),
        ...linhas.map(l => normalizar(l.cliente)),
      ]);
    } catch (e) {
      console.error('[conciliacao-ato] folga indisponível (espelho):', e.message);
      chavesJaLancadas = null;
    }
  }
  const chavesAvcFolga = chavesJaLancadas;

  const atosSemAvc = [];
  if (chavesAvcFolga) {
    for (const a of naoCasados) {
      if (chavesAvcFolga.has(a.chave)) continue; // já lançado fora do período
      atosSemAvc.push(a);
      resumo.atoSemAvc++;
      resumo.valorAtoSemAvc += a.valor;
    }
  }

  resumo.valorAtoSemAvc = Math.round(resumo.valorAtoSemAvc * 100) / 100;
  resumo.valorAvcSemAto = Math.round(resumo.valorAvcSemAto * 100) / 100;

  return {
    resumo,
    atosSemAvc: atosSemAvc.sort((a, b) => String(a.pago_em).localeCompare(String(b.pago_em))),
    porLinha,
    folgaIndisponivel: naoCasados.length > 0 && !chavesAvcFolga,
    folgaDias: folga,
  };
}

export default { conciliar, normalizar, resolverFolga };
