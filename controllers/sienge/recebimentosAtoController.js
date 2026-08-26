// controllers/sienge/recebimentosAtoController.js
//
// Recebimentos do Ato (Financeiro > Contas a Receber). Serve o relatório do
// Sienge "Contas Recebidas (por Data de Recebimento)" recortado no documento
// AVC. Toda a regra de negócio vive no service; aqui só resolvemos a alçada,
// lemos os filtros e formatamos a resposta (JSON / CSV).
//
// Alçada: admin vê tudo; não-admin vê apenas os empreendimentos do seu escopo
// (accessScopeService), pelo centro de custo — mesmo gate da Consulta de nº CEF
// e do Faturamento. Escopo vazio devolve relatório vazio, nunca o total geral.

import svc from '../../services/sienge/recebimentosAtoService.js';
import conciliacao from '../../services/sienge/conciliacaoAtoService.js';
import { getScope } from '../../services/permissions/accessScopeService.js';

const ligado = (v) => v === '1' || v === 'true' || v === true;

/**
 * Roda o relatório e, quando pedido, a conciliação com o Ato. A conciliação é
 * opcional porque custa duas consultas a mais (atos do Office + AVC da folga) e
 * nem toda leitura da tela precisa dela.
 */
async function montarRelatorio(req, scope, filtros) {
  const data = await svc.getReport(filtros, scope, { sort: req.query.sort, dir: req.query.dir });
  if (!ligado(req.query.mesclarAto)) return data;

  const c = await conciliacao.conciliar(data.linhas, filtros, scope, { folgaDias: req.query.folgaDias });
  return {
    ...data,
    // A marcação viaja junto da linha para a tela não ter que cruzar de novo.
    linhas: data.linhas.map(l => ({ ...l, conciliacao: c.porLinha.get(l.id) || null })),
    conciliacao: {
      ativo: true,
      resumo: c.resumo,
      atosSemAvc: c.atosSemAvc,
      folgaDias: c.folgaDias,
      folgaIndisponivel: c.folgaIndisponivel,
    },
  };
}

/** Resolve a alçada do usuário (fail-closed). */
async function resolveScope(req) {
  const scope = await getScope(req.user);
  if (scope.all) return { all: true, erpIds: null };
  return { all: false, erpIds: scope.erpIds || [] };
}

const EMPTY_TOTALS = {
  linhas: 0, parcelas: 0, titulos: 0, clientes: 0,
  valor_baixa: 0, acrescimo: 0, seguro: 0, taxa_adm: 0,
  desconto: 0, liquido: 0, valor_medio: 0,
};

/** GET /api/sienge/recebimentos-ato/filters — empresas e empreendimentos com AVC. */
export async function getFilters(req, res) {
  try {
    const scope = await resolveScope(req);
    if (!scope.all && !scope.erpIds.length) {
      return res.json({ empresas: [], empreendimentos: [], isAdmin: false });
    }
    const data = await svc.getFilterOptions(scope);
    return res.json({ ...data, isAdmin: scope.all });
  } catch (e) {
    console.error('[recebimentos-ato] getFilters:', e.message);
    return res.status(500).json({ error: 'Falha ao carregar os filtros.' });
  }
}

/** GET /api/sienge/recebimentos-ato — totais, quebra por dia e linhas do recorte. */
export async function getReport(req, res) {
  try {
    const scope = await resolveScope(req);
    const filtros = svc.normalizeFilters(req.query);

    if (!scope.all && !scope.erpIds.length) {
      return res.json({ totais: EMPTY_TOTALS, porDia: [], linhas: [], filtros, isAdmin: false });
    }

    const data = await montarRelatorio(req, scope, filtros);
    return res.json({ ...data, isAdmin: scope.all });
  } catch (e) {
    console.error('[recebimentos-ato] getReport:', e.message);
    return res.status(500).json({ error: 'Falha ao carregar os recebimentos do ato.' });
  }
}

// ─── CSV ─────────────────────────────────────────────────────────────────────
// Mesma ordem de colunas do relatório do Sienge, para conferir lado a lado.
const CSV_COLUMNS = [
  ['data_baixa', 'Dt. baixa'],
  ['cliente', 'Cliente'],
  ['cod_cliente', 'Cód. cliente'],
  ['data_emissao', 'Dt. Emissão'],
  ['documento', 'Documento'],
  ['nutitulo', 'Título'],
  ['parcela', 'Parc'],
  ['tipo_condicao', 'TC'],
  ['unidade', 'Unid. princ'],
  ['portador', 'Port'],
  // A coluna "Oper" do relatório do Sienge (operação de cobrança) não é
  // exposta pelo /bulk-data/v1/income. Era 0 em todas as baixas AVC medidas,
  // então sai da exportação em vez de virar um zero inventado.
  ['data_vencimento', 'Data vecto'],
  ['valor_baixa', 'Vl. baixa'],
  ['acrescimo', 'Acréscimo'],
  ['seguro', 'Seguro'],
  ['taxa_adm', 'Taxa adm'],
  ['desconto', 'Desconto'],
  ['liquido', 'Líquido'],
  ['empresa', 'Empresa'],
  ['empreendimento', 'Empreendimento'],
];

const MONEY_KEYS = new Set(['valor_baixa', 'acrescimo', 'seguro', 'taxa_adm', 'desconto', 'liquido']);
const DATE_KEYS = new Set(['data_baixa', 'data_emissao', 'data_vencimento']);

function fmtDateBR(v) {
  if (!v) return '';
  const d = new Date(v);
  if (isNaN(d)) return '';
  return `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${d.getUTCFullYear()}`;
}
// pt-BR: vírgula decimal (Excel local).
function fmtMoneyBR(v) {
  if (v === null || v === undefined || v === '') return '';
  return Number(v).toFixed(2).replace('.', ',');
}
function csvCell(val) {
  const s = String(val ?? '');
  // separador é ';'; protege ; " e quebras de linha
  return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** GET /api/sienge/recebimentos-ato/export — CSV (;) do recorte filtrado. */
export async function exportCsv(req, res) {
  try {
    const scope = await resolveScope(req);
    const filtros = svc.normalizeFilters(req.query);

    const data = (!scope.all && !scope.erpIds.length)
      ? { linhas: [], totais: EMPTY_TOTALS }
      : await montarRelatorio(req, scope, filtros);

    // Com a mesclagem ligada o CSV ganha o resultado do confronto — é ele que o
    // administrativo usa para saber o que ainda tem que digitar no Sienge.
    const comAto = !!data.conciliacao?.ativo;
    const colunas = comAto
      ? [...CSV_COLUMNS, ['_ato_status', 'Ato'], ['_ato_valor', 'Valor do ato'], ['_ato_pago_em', 'Ato pago em']]
      : CSV_COLUMNS;

    const ROTULO = { conciliado: 'Conciliado', divergente: 'Valor divergente', sem_ato: 'Sem ato' };

    const lines = [colunas.map(([, label]) => csvCell(label)).join(';')];
    for (const r of data.linhas) {
      lines.push(colunas.map(([key]) => {
        if (key === '_ato_status') return csvCell(ROTULO[r.conciliacao?.status] || '');
        if (key === '_ato_valor') return csvCell(fmtMoneyBR(r.conciliacao?.ato?.valor));
        if (key === '_ato_pago_em') return csvCell(fmtDateBR(r.conciliacao?.ato?.pago_em));
        const v = r[key];
        if (MONEY_KEYS.has(key)) return csvCell(fmtMoneyBR(v));
        if (DATE_KEYS.has(key)) return csvCell(fmtDateBR(v));
        return csvCell(v);
      }).join(';'));
    }
    // Rodapé igual ao do Sienge: quem confere procura estes quatro números.
    const t = data.totais;
    lines.push('');
    // O rótulo ocupa a 1ª coluna e os totais precisam cair EXATAMENTE embaixo
    // das suas colunas — daí o preenchimento ser derivado de CSV_COLUMNS em vez
    // de um punhado de vírgulas contadas à mão (que desalinha a cada coluna
    // que entra ou sai).
    const iValor = colunas.findIndex(([k]) => k === 'valor_baixa');
    const totalRow = new Array(colunas.length).fill('');
    totalRow[0] = 'Total geral';
    ['valor_baixa', 'acrescimo', 'seguro', 'taxa_adm', 'desconto', 'liquido']
      .forEach((k, i) => { totalRow[iValor + i] = fmtMoneyBR(t[k]); });
    lines.push(totalRow.map(csvCell).join(';'));
    lines.push(`Total de parcelas;${t.parcelas}`);
    lines.push(`Valor médio;${fmtMoneyBR(t.valor_medio)}`);
    lines.push(`Total de títulos;${t.titulos}`);
    lines.push(`Total de clientes;${t.clientes}`);

    if (comAto) {
      const c = data.conciliacao;
      lines.push('');
      lines.push('CONFRONTO COM O ATO');
      lines.push(`Recebimentos conciliados;${c.resumo.conciliados}`);
      lines.push(`  destes, com valor divergente;${c.resumo.divergentes}`);
      lines.push(`Recebimento sem ato (abatido que não é ato);${c.resumo.avcSemAto};${fmtMoneyBR(c.resumo.valorAvcSemAto)}`);
      lines.push(`Ato pago sem recebimento (falta lançar);${c.resumo.atoSemAvc};${fmtMoneyBR(c.resumo.valorAtoSemAvc)}`);
      if (c.resumo.naoMapeados) {
        lines.push(`Atos ignorados por empreendimento não identificado;${c.resumo.naoMapeados}`);
      }

      // A lista acionável: é o que ainda precisa ser digitado no Sienge.
      lines.push('');
      lines.push('ATOS PAGOS SEM RECEBIMENTO LANÇADO');
      lines.push(['Pago em', 'Cliente', 'Empreendimento', 'Unidade', 'Valor', 'Tipo', 'Reserva'].map(csvCell).join(';'));
      for (const a of c.atosSemAvc) {
        lines.push([fmtDateBR(a.pago_em), a.titular, a.empreendimento, a.unidade || '',
          fmtMoneyBR(a.valor), a.tipo === 'cartao' ? 'Cartão' : 'Boleto', a.idreserva].map(csvCell).join(';'));
      }
    }

    const csv = '﻿' + lines.join('\r\n'); // BOM p/ acentos no Excel
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition',
      `attachment; filename="recebimentos_ato_${filtros.startDate}_a_${filtros.endDate}.csv"`);
    return res.send(csv);
  } catch (e) {
    console.error('[recebimentos-ato] exportCsv:', e.message);
    return res.status(500).json({ error: 'Falha ao exportar os recebimentos do ato.' });
  }
}

export default { getFilters, getReport, exportCsv };
