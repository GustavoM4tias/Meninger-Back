// controllers/cv/adimplenciaDb.js
//
// ADIMPLÊNCIA PREMIADA por unidade (o "Desconto Construtora"). O CV guarda
// isso na unidade e não expõe por API; aqui é o cadastro do Office, com
// vigência, e as funções que o resto do sistema usa para descontar do preço
// de tabela (priceTablesDb, mirrorDb, sync das tabelas, tool da Eme).
//
//   GET /cv/empreendimento/:id/adimplencia            → unidades com o valor vigente + histórico
//   PUT /cv/empreendimento/:id/adimplencia            → grava (encerra a vigente e abre outra)
//   POST /cv/empreendimento/:id/adimplencia/importar  → lê a exportação de unidades do
//        painel Gestor do CV (CSV com a coluna "Adimplência Premiada") e grava o
//        que mudou. É o único caminho que o CV dá para esse campo: a API (v1,
//        CVDW, v2, v3) não o devolve, e o login do Gestor tem token na tela de
//        entrada, então a exportação precisa de uma pessoa logada.
//
// Regras:
//   - uma linha por unidade por período; `vigencia_ate` nula = vigente;
//   - gravar valor 0/nulo para uma unidade = encerra a vigente sem abrir outra;
//   - a vigência nova começa em `vigencia_de` (padrão hoje); a anterior é
//     encerrada no dia anterior. Mudança retroativa não reescreve a história:
//     só a linha vigente é encerrada.
import db from '../../models/sequelize/index.js';
import { visibleCvIds } from '../../services/permissions/accessScopeService.js';

const { CvEnterprise, CvEnterpriseStage, CvEnterpriseBlock, CvEnterpriseUnit, EnterpriseUnitAdimplencia } = db;

const TIPOS = ['valor', 'percentual'];
const hojeYmd = () => new Date().toISOString().slice(0, 10);
const ymd = (d) => (d ? String(d).slice(0, 10) : null);
const num = (v) => {
  if (v == null || v === '') return null;
  const n = Number(typeof v === 'string' && v.includes(',') ? v.replace(/\./g, '').replace(',', '.') : v);
  return Number.isFinite(n) ? n : null;
};
const diaAnterior = (ymdStr) => {
  const d = new Date(`${ymdStr}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
};

// ── Leitura para o resto do sistema ──────────────────────────────────────────

/** Todas as linhas do empreendimento (histórico inteiro), mais antigas primeiro. */
export async function carregarRegistro(idempreendimento) {
  return EnterpriseUnitAdimplencia.findAll({
    where: { idempreendimento },
    order: [['vigencia_de', 'ASC'], ['id', 'ASC']],
  });
}

/**
 * Mapa idunidade → { tipo, valor } vigente numa data (YYYY-MM-DD; padrão hoje),
 * a partir das linhas de `carregarRegistro`. Uma consulta ao banco por
 * empreendimento, e a data resolve em memória - a lista de tabelas precisa
 * de uma data por tabela.
 */
export function mapaEm(linhas, data = hojeYmd()) {
  const out = new Map();
  for (const l of linhas) {
    const de = ymd(l.vigencia_de), ate = ymd(l.vigencia_ate);
    if (de && de > data) continue;
    if (ate && ate < data) continue;
    const valor = num(l.valor);
    if (valor == null || valor <= 0) continue;
    out.set(Number(l.idunidade), { tipo: TIPOS.includes(l.tipo) ? l.tipo : 'valor', valor });
  }
  return out;
}

/** Atalho: mapa vigente hoje, direto do banco. */
export async function mapaVigente(idempreendimento) {
  return mapaEm(await carregarRegistro(idempreendimento));
}

/** Quanto sai do preço de tabela para esta unidade (R$), ou null sem cadastro. */
export function descontoDe(valorTabela, reg) {
  if (!reg || valorTabela == null) return null;
  const v = num(reg.valor);
  if (v == null || v <= 0) return null;
  const desconto = reg.tipo === 'percentual' ? valorTabela * (v / 100) : v;
  return Math.round(Math.min(desconto, valorTabela) * 100) / 100;
}

/**
 * Cópia congelada para gravar junto da tabela de preço no sync:
 * { referencia, unidades: { '<idunidade>': { tipo, valor } } }, ou null quando
 * nenhuma unidade da tabela tem adimplência cadastrada.
 */
export async function snapshotPara(idempreendimento, idsUnidade = []) {
  const mapa = await mapaVigente(idempreendimento);
  const unidades = {};
  for (const id of idsUnidade) {
    const reg = mapa.get(Number(id));
    if (reg) unidades[String(id)] = reg;
  }
  return Object.keys(unidades).length ? { referencia: hojeYmd(), unidades } : null;
}

/** O snapshot gravado na tabela, no mesmo formato de `mapaEm`. */
export function mapaDoSnapshot(snapshot) {
  const out = new Map();
  for (const [id, reg] of Object.entries(snapshot?.unidades || {})) {
    const valor = num(reg?.valor);
    if (valor != null && valor > 0) out.set(Number(id), { tipo: TIPOS.includes(reg.tipo) ? reg.tipo : 'valor', valor });
  }
  return out;
}

// ── HTTP ─────────────────────────────────────────────────────────────────────
const podeVer = async (user, id) => {
  const allowed = await visibleCvIds(user);
  return allowed === null || allowed.includes(Number(id));
};

async function unidadesDo(idempreendimento) {
  const etapas = await CvEnterpriseStage.findAll({ where: { idempreendimento }, attributes: ['idetapa', 'nome'] });
  if (!etapas.length) return [];
  const blocos = await CvEnterpriseBlock.findAll({ where: { idetapa: etapas.map((e) => e.idetapa) }, attributes: ['idbloco', 'idetapa', 'nome'] });
  if (!blocos.length) return [];
  const etapaPorId = new Map(etapas.map((e) => [e.idetapa, e]));
  const blocoPorId = new Map(blocos.map((b) => [b.idbloco, b]));
  const unidades = await CvEnterpriseUnit.findAll({
    where: { idbloco: blocos.map((b) => b.idbloco) },
    attributes: ['idunidade', 'idbloco', 'nome', 'area_privativa', 'tipologia', 'situacao_mapa_disponibilidade'],
    order: [['nome', 'ASC']],
  });
  return unidades.map((u) => {
    const b = blocoPorId.get(u.idbloco);
    return {
      idunidade: u.idunidade,
      nome: u.nome,
      bloco: b?.nome || null,
      etapa: b ? etapaPorId.get(b.idetapa)?.nome || null : null,
      area_privativa: num(u.area_privativa),
      tipologia: u.tipologia || null,
      situacao: u.situacao_mapa_disponibilidade,
    };
  });
}

async function montarResposta(idempreendimento) {
  const [unidades, linhas] = await Promise.all([unidadesDo(idempreendimento), carregarRegistro(idempreendimento)]);
  const vigentes = new Map();
  for (const l of linhas) if (!l.vigencia_ate) vigentes.set(Number(l.idunidade), l);
  const nomePorId = new Map(unidades.map((u) => [u.idunidade, u.nome]));
  return {
    idempreendimento,
    unidades: unidades.map((u) => {
      const v = vigentes.get(u.idunidade);
      return { ...u, tipo: v?.tipo || null, valor: v ? num(v.valor) : null, vigencia_de: v ? ymd(v.vigencia_de) : null, observacao: v?.observacao || null };
    }),
    // histórico inteiro, mais recente primeiro, com o nome da unidade
    historico: [...linhas].reverse().map((l) => ({
      id: l.id, idunidade: l.idunidade, unidade: nomePorId.get(Number(l.idunidade)) || String(l.idunidade),
      tipo: l.tipo, valor: num(l.valor), vigencia_de: ymd(l.vigencia_de), vigencia_ate: ymd(l.vigencia_ate), observacao: l.observacao || null,
      created_at: l.createdAt ?? l.created_at ?? null,
    })),
    resumo: {
      unidades: unidades.length,
      com_adimplencia: [...vigentes.keys()].filter((id) => nomePorId.has(id)).length,
    },
  };
}

export const getAdimplencia = async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Usuário não autenticado.' });
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: "O parâmetro 'id' é obrigatório." });
  try {
    if (!(await podeVer(req.user, id))) return res.status(403).json({ error: 'Empreendimento fora do seu escopo.' });
    const ent = await CvEnterprise.findByPk(id, { attributes: ['idempreendimento'] });
    if (!ent) return res.status(404).json({ error: 'Empreendimento não encontrado.' });
    return res.json(await montarResposta(id));
  } catch (err) {
    console.error('Erro ao listar adimplência premiada:', err);
    return res.status(500).json({ error: 'Erro ao listar a adimplência premiada.' });
  }
};

// Aplica uma lista de itens { idunidade, tipo, valor }: encerra a vigente que
// mudou e abre a nova; valor nulo/0 só encerra. Devolve o que de fato mudou.
async function aplicarItens(id, itens, { vigenciaDe, observacao, userId }) {
  const validas = new Set((await unidadesDo(id)).map((u) => u.idunidade));
  const ids = [...new Set(itens.map((i) => Number(i.idunidade)).filter((n) => validas.has(n)))];
  if (!ids.length) return null;
  let alteradas = 0, encerradas = 0;
  await db.sequelize.transaction(async (transaction) => {
    const vigentes = await EnterpriseUnitAdimplencia.findAll({ where: { idempreendimento: id, idunidade: ids, vigencia_ate: null }, transaction });
    const vigentePor = new Map(vigentes.map((l) => [Number(l.idunidade), l]));
    for (const item of itens) {
      const idunidade = Number(item.idunidade);
      if (!validas.has(idunidade)) continue;
      const tipo = TIPOS.includes(item.tipo) ? item.tipo : 'valor';
      const valor = num(item.valor);
      const atual = vigentePor.get(idunidade);
      const igual = atual && atual.tipo === tipo && Math.abs(num(atual.valor) - (valor ?? 0)) < 0.005;
      if (igual) continue;
      if (!atual && !(valor > 0)) continue;
      if (atual) {
        // encerra no dia anterior ao início da nova; se a nova começa no
        // mesmo dia em que a vigente nasceu, a vigente simplesmente some
        const fim = diaAnterior(vigenciaDe);
        if (fim < ymd(atual.vigencia_de)) await atual.destroy({ transaction });
        else await atual.update({ vigencia_ate: fim }, { transaction });
        encerradas++;
      }
      if (valor != null && valor > 0) {
        await EnterpriseUnitAdimplencia.create({ idempreendimento: id, idunidade, tipo, valor, vigencia_de: vigenciaDe, observacao, created_by: userId ?? null }, { transaction });
        alteradas++;
      }
    }
  });
  return { gravadas: alteradas, encerradas };
}

const vigenciaDoBody = (body) => (/^\d{4}-\d{2}-\d{2}$/.test(String(body?.vigencia_de || '')) ? String(body.vigencia_de) : hojeYmd());

/**
 * Body: { vigencia_de?: 'YYYY-MM-DD', observacao?: string,
 *         unidades: [{ idunidade, tipo: 'valor'|'percentual', valor }] }
 * valor nulo/0 encerra a vigente da unidade. Só mexe nas unidades enviadas.
 */
export const saveAdimplencia = async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Usuário não autenticado.' });
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: "O parâmetro 'id' é obrigatório." });
  const body = req.body || {};
  const itens = Array.isArray(body.unidades) ? body.unidades : [];
  if (!itens.length) return res.status(400).json({ error: 'Envie ao menos uma unidade.' });
  try {
    const ent = await CvEnterprise.findByPk(id, { attributes: ['idempreendimento'] });
    if (!ent) return res.status(404).json({ error: 'Empreendimento não encontrado.' });
    const r = await aplicarItens(id, itens, { vigenciaDe: vigenciaDoBody(body), observacao: body.observacao ? String(body.observacao).slice(0, 255) : null, userId: req.user.id });
    if (!r) return res.status(400).json({ error: 'Nenhuma das unidades enviadas pertence a este empreendimento.' });
    return res.json({ ...(await montarResposta(id)), ...r });
  } catch (err) {
    console.error('Erro ao gravar adimplência premiada:', err);
    return res.status(500).json({ error: 'Erro ao gravar a adimplência premiada.' });
  }
};

// ── Importação da exportação de unidades do Gestor ───────────────────────────
// Formato do arquivo (Cadastros > Empreendimentos > Unidades > Exportar
// Unidades): UTF-8 com BOM, 1ª linha é o título, 2ª o cabeçalho, separador
// ";", campos entre aspas. "Adimplência Premiada" vem "26000" ou "40000.00";
// "Valor" vem "235,000.00" (vírgula de milhar), por isso o número é lido
// pela posição do último separador.
const numeroCsv = (s) => {
  const t = String(s ?? '').replace(/[R$\s]/g, '');
  if (!t) return null;
  const v = t.lastIndexOf(','), d = t.lastIndexOf('.');
  let limpo;
  if (v > d) limpo = t.replace(/\./g, '').replace(',', '.');
  else limpo = t.replace(/,/g, '');
  const n = Number(limpo);
  return Number.isFinite(n) ? n : null;
};
const linhaCsv = (l) => {
  const out = []; let cur = '', q = false;
  for (let i = 0; i < l.length; i++) {
    const ch = l[i];
    if (ch === '"') { if (q && l[i + 1] === '"') { cur += '"'; i++; } else q = !q; continue; }
    if (ch === ';' && !q) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out;
};
const semAcento = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

/** [{ idunidade, unidade, valor }] a partir do texto do CSV; null quando não é a exportação do CV. */
export function parseExportacaoCv(texto) {
  const linhas = String(texto || '').replace(/^\uFEFF/, '').split(/\r?\n/).filter((l) => l.trim());
  const iHdr = linhas.findIndex((l) => /id\s*unidade/i.test(l) && /adimpl/i.test(semAcento(l)));
  if (iHdr < 0) return null;
  const hdr = linhaCsv(linhas[iHdr]).map(semAcento);
  const cId = hdr.findIndex((h) => h === 'id unidade');
  const cNome = hdr.findIndex((h) => h === 'unidade');
  const cAd = hdr.findIndex((h) => h.includes('adimpl'));
  if (cId < 0 || cAd < 0) return null;
  const out = [];
  for (const l of linhas.slice(iHdr + 1)) {
    const c = linhaCsv(l);
    const idunidade = Number(c[cId]);
    if (!Number.isFinite(idunidade) || idunidade <= 0) continue;
    out.push({ idunidade, unidade: (c[cNome] || '').trim(), valor: numeroCsv(c[cAd]) });
  }
  return out;
}

/**
 * Body: { csv: string, vigencia_de?, observacao? }. Unidade com valor > 0 no
 * arquivo recebe esse valor (tipo 'valor'); unidade do arquivo sem valor que
 * tinha adimplência vigente é encerrada. Unidade fora do arquivo não muda.
 */
export const importAdimplencia = async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Usuário não autenticado.' });
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: "O parâmetro 'id' é obrigatório." });
  const body = req.body || {};
  const linhas = parseExportacaoCv(body.csv);
  if (!linhas) return res.status(400).json({ error: 'Este arquivo não é a exportação de unidades do CV (precisa das colunas "ID Unidade" e "Adimplência Premiada").' });
  if (!linhas.length) return res.status(400).json({ error: 'A exportação veio sem unidades.' });
  try {
    const ent = await CvEnterprise.findByPk(id, { attributes: ['idempreendimento'] });
    if (!ent) return res.status(404).json({ error: 'Empreendimento não encontrado.' });
    const validas = new Set((await unidadesDo(id)).map((u) => u.idunidade));
    const doEmp = linhas.filter((l) => validas.has(l.idunidade));
    if (!doEmp.length) return res.status(400).json({ error: 'Nenhuma unidade do arquivo pertence a este empreendimento: confira se exportou o empreendimento certo.' });
    const itens = doEmp.map((l) => ({ idunidade: l.idunidade, tipo: 'valor', valor: l.valor > 0 ? l.valor : 0 }));
    const r = await aplicarItens(id, itens, {
      vigenciaDe: vigenciaDoBody(body),
      observacao: body.observacao ? String(body.observacao).slice(0, 255) : `Importado da exportação do CV em ${hojeYmd()}`,
      userId: req.user.id,
    });
    return res.json({
      ...(await montarResposta(id)),
      ...(r || { gravadas: 0, encerradas: 0 }),
      importacao: { lidas: linhas.length, do_empreendimento: doEmp.length, com_valor: doEmp.filter((l) => l.valor > 0).length, fora: linhas.length - doEmp.length },
    });
  } catch (err) {
    console.error('Erro ao importar adimplência premiada:', err);
    return res.status(500).json({ error: 'Erro ao importar a adimplência premiada.' });
  }
};
