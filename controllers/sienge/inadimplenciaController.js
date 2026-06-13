// controllers/sienge/inadimplenciaController.js
//
// Tela de Inadimplência — ADMIN ONLY. Lê do backup diário do Sienge via
// services/sienge/inadimplenciaService.js. Toda a regra de negócio (query fiel
// ao BI + clamp de negativos) vive no service; aqui só fazemos o gate de
// administrador, parsing dos filtros e formatação da resposta (JSON / CSV).

import svc from '../../services/sienge/inadimplenciaService.js';

function ensureAdmin(req, res) {
  if (req.user?.role !== 'admin') {
    res.status(403).json({ error: 'Apenas administradores.' });
    return false;
  }
  return true;
}

// Lê os filtros da query string num formato estável para o service.
function parseFilters(q = {}) {
  return {
    startDate: q.startDate,
    endDate: q.endDate,
    empresas: q.empresas,             // "18,33" ou ausente
    empreendimentos: q.empreendimentos,
    situacoes: q.situacoes,           // "Normal,Cobrança"
    search: q.search,
  };
}

/** GET /api/sienge/inadimplencia/filters — opções dos seletores. */
export async function getFilters(req, res) {
  if (!ensureAdmin(req, res)) return;
  try {
    const data = await svc.getFilterOptions();
    res.json(data);
  } catch (e) {
    console.error('[inadimplencia] getFilters:', e.message);
    res.status(500).json({ error: 'Falha ao carregar filtros de inadimplência.' });
  }
}

/** GET /api/sienge/inadimplencia — resumo + aging + quebras. */
export async function getDashboard(req, res) {
  if (!ensureAdmin(req, res)) return;
  try {
    const refresh = req.query.refresh === '1' || req.query.refresh === 'true';
    const data = await svc.getDashboard(parseFilters(req.query), { refresh });
    res.json(data);
  } catch (e) {
    console.error('[inadimplencia] getDashboard:', e.message);
    res.status(500).json({ error: 'Falha ao carregar a inadimplência.' });
  }
}

/** GET /api/sienge/inadimplencia/detail — linhas paginadas. */
export async function getDetail(req, res) {
  if (!ensureAdmin(req, res)) return;
  try {
    const { page, pageSize, sort, dir } = req.query;
    const data = await svc.getDetail(parseFilters(req.query), { page, pageSize, sort, dir });
    res.json(data);
  } catch (e) {
    console.error('[inadimplencia] getDetail:', e.message);
    res.status(500).json({ error: 'Falha ao carregar o detalhamento.' });
  }
}

// ─── CSV ──────────────────────────────────────────────────────────────────────
const CSV_COLUMNS = [
  ['nutitulo',        'Nº Título'],
  ['nuparcela',       'Parcela'],
  ['unidade',         'Unidade'],
  ['data_emissao',    'Data Emissão'],
  ['data_vencimento', 'Data Vencimento'],
  ['data_pagamento',  'Data Pagamento'],
  ['tipo_baixa',      'Tipo Baixa'],
  ['conta',           'Conta'],
  ['situacao',        'Situação'],
  ['cod_cliente',     'Cód Cliente'],
  ['tipo_documento',  'Tipo Documento'],
  ['tipo_condicao',   'Tipo Condição'],
  ['centro_de_custo', 'Centro de Custo'],
  ['cod_portador',    'Cód Portador'],
  ['dias_em_atraso',  'Dias em Atraso'],
  ['empresa',         'Empresa'],
  ['valor_original',  'Valor Original'],
  ['valor_baixado',   'Valor Baixado'],
  ['valor_atual',     'Valor Atual'],
  ['valor_multa',     'Valor Multa'],
  ['valor_juros',     'Valor Juros'],
];

const MONEY_KEYS = new Set(['valor_original', 'valor_baixado', 'valor_atual', 'valor_multa', 'valor_juros']);
const DATE_KEYS  = new Set(['data_emissao', 'data_vencimento', 'data_pagamento']);

function fmtDateBR(v) {
  if (!v) return '';
  const d = new Date(v);
  if (isNaN(d)) return '';
  return `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${d.getUTCFullYear()}`;
}
// pt-BR: vírgula decimal (Excel local). Mantém sinal e 2 casas.
function fmtMoneyBR(v) {
  if (v === null || v === undefined || v === '') return '';
  return Number(v).toFixed(2).replace('.', ',');
}
function csvCell(val) {
  const s = String(val ?? '');
  // separador é ';'; protege ; " e quebras de linha
  return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** GET /api/sienge/inadimplencia/export — CSV (;) do conjunto filtrado. */
export async function exportCsv(req, res) {
  if (!ensureAdmin(req, res)) return;
  try {
    const rows = await svc.getAllRows(parseFilters(req.query));

    const lines = [CSV_COLUMNS.map(([, label]) => csvCell(label)).join(';')];
    for (const r of rows) {
      lines.push(CSV_COLUMNS.map(([key]) => {
        const v = r[key];
        if (MONEY_KEYS.has(key)) return csvCell(fmtMoneyBR(v));
        if (DATE_KEYS.has(key)) return csvCell(fmtDateBR(v));
        return csvCell(v);
      }).join(';'));
    }

    const csv = '﻿' + lines.join('\r\n'); // BOM p/ acentos no Excel
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="inadimplencia_${stamp}.csv"`);
    res.send(csv);
  } catch (e) {
    console.error('[inadimplencia] exportCsv:', e.message);
    res.status(500).json({ error: 'Falha ao exportar inadimplência.' });
  }
}

export default { getFilters, getDashboard, getDetail, exportCsv };
