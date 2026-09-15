// controllers/cv/priceTablesDb.js
//
// Leitura das tabelas de preço espelhadas do CV (cv_enterprise_price_tables).
// A tabela nunca é apagada pelo sync (PriceTableSyncService só insere/atualiza),
// então o que está no banco É o histórico: toda tabela que já passou pelo CV
// desde a primeira sincronização, vigente ou não.
//
//   GET /cv/empreendimento/:id/tabelas   → lista leve (sem unidades)
//   GET /cv/price-tables/:idtabela       → uma tabela com as unidades e séries
//
// ADIMPLÊNCIA PREMIADA (Desconto Construtora): por padrão o preço devolvido
// já vem com ela descontada (`?descontar=0` devolve o preço cheio). De onde
// vem o valor de cada unidade:
//   - tabela encerrada → a cópia congelada quando a tabela foi gravada
//     (coluna `adimplencia`), para o passado não mudar se o cadastro mudar;
//   - tabela vigente/futura → o cadastro vigente hoje (enterprise_unit_adimplencia);
//   - sem cópia congelada numa encerrada → o cadastro vigente na data em que a
//     tabela encerrou.
import db from '../../models/sequelize/index.js';
import { visibleCvIds } from '../../services/permissions/accessScopeService.js';
import { carregarRegistro, mapaEm, mapaDoSnapshot, descontoDe } from './adimplenciaDb.js';

const { CvEnterprisePriceTable } = db;

// As unidades vêm do endpoint /detalhada (raw.unidades). Quando ele falha o
// sync ainda grava os metadados, e o endpoint de metadados também traz as
// unidades (raw.metadados.unidades) - vale como fallback.
const unitsOf = (raw) => {
  const a = Array.isArray(raw?.unidades) ? raw.unidades : [];
  if (a.length) return a;
  return Array.isArray(raw?.metadados?.unidades) ? raw.metadados.unidades : [];
};

const ymd = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);

// vigente | encerrada | futura | sem_vigencia, olhando só a data (Brasília
// não importa aqui: vigência é dia inteiro).
const situacaoOf = (de, ate) => {
  if (!de && !ate) return 'sem_vigencia';
  const hoje = new Date().toISOString().slice(0, 10);
  if (de && ymd(de) > hoje) return 'futura';
  if (ate && ymd(ate) < hoje) return 'encerrada';
  return 'vigente';
};

const num = (v) => (v == null || v === '' ? null : Number(v));

// Área: os syncs anteriores a 14/09/2026 gravaram "67.930000" como 67930000
// (ver parseArea no PriceTableSyncService). Para essas linhas o texto original
// ainda está em raw.metadados.unidades, e é ele que vale; sem ele, um número
// acima de 100.000 só pode ser esse erro (nenhuma unidade tem 100 mil m²).
const areaOf = (u, original) => {
  const src = original?.area_privativa ?? u.area_privativa;
  if (src == null || src === '') return null;
  const str = String(src).trim();
  const n = str.includes(',') ? Number(str.replace(/\./g, '').replace(',', '.')) : Number(str);
  if (!Number.isFinite(n)) return null;
  return n >= 100000 ? n / 1e6 : n;
};

// Adimplência premiada que vale para ESTA tabela (ver cabeçalho do arquivo).
// `registro` = linhas de carregarRegistro(idempreendimento); sem ele, só a
// cópia congelada conta.
const adimplenciaDaTabela = (t, registro) => {
  const situacao = situacaoOf(t.data_vigencia_de, t.data_vigencia_ate);
  const congelada = t.adimplencia?.unidades ? mapaDoSnapshot(t.adimplencia) : null;
  if (situacao === 'encerrada') {
    if (congelada?.size) return { mapa: congelada, fonte: 'congelada', referencia: t.adimplencia.referencia || null };
    const mapa = registro ? mapaEm(registro, ymd(t.data_vigencia_ate)) : new Map();
    return { mapa, fonte: mapa.size ? 'cadastro' : 'nenhuma', referencia: ymd(t.data_vigencia_ate) };
  }
  const hoje = new Date().toISOString().slice(0, 10);
  const mapa = registro ? mapaEm(registro, hoje) : new Map();
  if (mapa.size) return { mapa, fonte: 'cadastro', referencia: hoje };
  if (congelada?.size) return { mapa: congelada, fonte: 'congelada', referencia: t.adimplencia.referencia || null };
  return { mapa, fonte: 'nenhuma', referencia: hoje };
};

// Preço de cada unidade: cheio (CV), desconto e o que vale (líquido quando
// `descontar`). Tudo que resume ou lista parte daqui.
const precoDe = (u, adimpl, descontar) => {
  const cheio = num(u.valor_total);
  const desconto = descontoDe(cheio, adimpl.mapa.get(Number(u.idunidade)));
  const valor = cheio == null ? null : (descontar && desconto ? Math.round((cheio - desconto) * 100) / 100 : cheio);
  return { cheio, desconto, valor };
};

// Resumo das unidades: quantas, faixa de valor, VGV e R$/m² médio ponderado.
const summarizeUnits = (unidades, originais, adimpl, descontar) => {
  let n = 0, vgv = 0, area = 0, min = null, max = null, disponiveis = 0, comAdimpl = 0, totalAdimpl = 0;
  for (const u of unidades) {
    const { desconto, valor: v } = precoDe(u, adimpl, descontar);
    if (v == null) continue;
    n++; vgv += v;
    if (desconto) { comAdimpl++; totalAdimpl += desconto; }
    const a = areaOf(u, originais.get(u.idunidade));
    if (a) area += a;
    if (min == null || v < min) min = v;
    if (max == null || v > max) max = v;
    if (/dispon/i.test(u.situacao || '')) disponiveis++;
  }
  return {
    unidades: unidades.length,
    com_valor: n,
    disponiveis,
    valor_min: min,
    valor_max: max,
    vgv,
    valor_m2_medio: area > 0 ? vgv / area : null,
    unidades_com_adimplencia: comAdimpl,
    adimplencia_total: Math.round(totalAdimpl * 100) / 100,
  };
};

export const toRow = (t, { withUnits = false, descontar = true, registro = null } = {}) => {
  const raw = t.raw || {};
  const unidades = unitsOf(raw);
  const meta = raw.metadados ? { ...raw.metadados } : null;
  // texto original de cada unidade, por idunidade (ver areaOf)
  const originais = new Map((meta?.unidades || []).map((u) => [u.idunidade, u]));
  if (meta) delete meta.unidades;
  const adimpl = adimplenciaDaTabela(t, registro);
  const resumo = summarizeUnits(unidades, originais, adimpl, descontar);
  const row = {
    idtabela: t.idtabela,
    idempreendimento: t.idempreendimento,
    nome: t.nome,
    forma: t.forma,
    aprovado: Boolean(t.aprovado),
    ativo_painel: Boolean(t.ativo_painel),
    data_vigencia_de: ymd(t.data_vigencia_de),
    data_vigencia_ate: ymd(t.data_vigencia_ate),
    situacao: situacaoOf(t.data_vigencia_de, t.data_vigencia_ate),
    maximo_parcelas: t.maximo_parcelas,
    quantidade_parcelas_min: t.quantidade_parcelas_min,
    quantidade_parcelas_max: t.quantidade_parcelas_max,
    juros_mes: num(t.juros_mes),
    tabela_minima: meta?.tabela_minima === 'S',
    referencia: meta?.referencia || null,
    primeira_sincronizacao: t.createdAt ?? t.created_at ?? null,
    ultima_sincronizacao: t.updatedAt ?? t.updated_at ?? null,
    resumo,
    // como a adimplência premiada entrou nesta leitura
    adimplencia: {
      descontada: Boolean(descontar),
      fonte: adimpl.fonte,           // congelada | cadastro | nenhuma
      referencia: adimpl.referencia, // data a que o valor se refere
      unidades: resumo.unidades_com_adimplencia,
      total: resumo.adimplencia_total,
    },
  };
  if (withUnits) {
    row.metadados = meta;
    row.unidades = unidades.map((u) => {
      const { cheio, desconto, valor } = precoDe(u, adimpl, descontar);
      const area = areaOf(u, originais.get(u.idunidade));
      return {
        idunidade: u.idunidade ?? null,
        etapa: u.etapa ?? null,
        bloco: u.bloco ?? null,
        unidade: u.unidade ?? null,
        area_privativa: area,
        situacao: u.situacao ?? null,
        valor_tabela: cheio,               // preço cheio, como está no CV
        adimplencia_premiada: desconto,    // R$ que sai quando descontada
        valor_total: valor,                // o que vale nesta leitura
        valor_m2: valor != null && area ? valor / area : null,
        series: (u.series || []).map((s) => ({
          nome: s.nome ?? null,
          qtd_parcelas: num(s.qtd_parcelas),
          data_vencimento: s.data_vencimento ?? null,
          valor: num(s.valor),
        })),
      };
    });
  }
  return row;
};

// `?descontar=0|false|nao` = preço cheio; qualquer outra coisa = descontado.
const descontarDe = (req) => !/^(0|false|n|nao|não)$/i.test(String(req.query?.descontar ?? '').trim());

/** Todas as tabelas do empreendimento já lidas (para a tool da Eme). */
export async function lerTabelas(idempreendimento, { withUnits = true, descontar = true } = {}) {
  const [rows, registro] = await Promise.all([
    CvEnterprisePriceTable.findAll({ where: { idempreendimento }, order: [['data_vigencia_de', 'DESC NULLS LAST'], ['idtabela', 'DESC']] }),
    carregarRegistro(idempreendimento),
  ]);
  return rows.map((t) => toRow(t, { withUnits, descontar, registro }));
}

// Não-admin só enxerga tabela de empreendimento do seu escopo (mesma regra
// de /cv/empreendimento/:id). Devolve true quando pode.
const podeVer = async (user, idempreendimento) => {
  const allowed = await visibleCvIds(user);
  return allowed === null || allowed.includes(Number(idempreendimento));
};

export const listPriceTablesByEnterprise = async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Usuário não autenticado.' });
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: "O parâmetro 'id' é obrigatório." });
  try {
    if (!(await podeVer(req.user, id))) {
      return res.status(403).json({ error: 'Empreendimento fora do seu escopo.' });
    }
    return res.json(await lerTabelas(id, { withUnits: false, descontar: descontarDe(req) }));
  } catch (err) {
    console.error('Erro ao listar tabelas de preço (DB):', err);
    return res.status(500).json({ error: 'Erro ao listar tabelas de preço.' });
  }
};

export const getPriceTableById = async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Usuário não autenticado.' });
  const idtabela = Number(req.params.idtabela);
  if (!Number.isFinite(idtabela) || idtabela <= 0) return res.status(400).json({ error: "O parâmetro 'idtabela' é obrigatório." });
  try {
    const t = await CvEnterprisePriceTable.findByPk(idtabela);
    if (!t) return res.status(404).json({ error: 'Tabela de preço não encontrada.' });
    if (!(await podeVer(req.user, t.idempreendimento))) {
      return res.status(403).json({ error: 'Empreendimento fora do seu escopo.' });
    }
    const registro = await carregarRegistro(t.idempreendimento);
    return res.json(toRow(t, { withUnits: true, descontar: descontarDe(req), registro }));
  } catch (err) {
    console.error('Erro ao buscar tabela de preço (DB):', err);
    return res.status(500).json({ error: 'Erro ao buscar tabela de preço.' });
  }
};
