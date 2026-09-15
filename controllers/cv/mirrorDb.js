// controllers/cv/mirrorDb.js
//
// ESPELHO de vendas do empreendimento: torres x andares x finais, com status,
// preço, área, dormitórios e lado do sol em cada célula. É a leitura de
// "quadra e corte" que a diretoria pede para saber o que sobrou e onde.
//
//   GET /cv/empreendimento/:id/espelho          → torres montadas + configuração
//   PUT /cv/empreendimento/:id/espelho/config   → grava a configuração (admin)
//
// De onde vem cada coisa:
//   - unidade, status, área, vagas   → cv_enterprise_units (espelho do CV)
//   - andar / final                  → CV quando ele manda; senão derivados do
//                                      NÚMERO da unidade (digitos_andar/final)
//   - torre                          → o bloco do CV quando há mais de um;
//                                      senão o prefixo do número (Mond: 1xx/2xx)
//   - preço                          → valor da unidade no CV quando > 0; senão
//                                      a tabela de preço mais recente que tem
//                                      a unidade (cv_enterprise_price_tables);
//                                      senão R$/m² do andar configurado x área
//                                      (estimativa, marcada como tal)
//   - face / sol / dormitórios / tipologia → enterprise_mirror_settings
import db from '../../models/sequelize/index.js';
import { visibleCvIds } from '../../services/permissions/accessScopeService.js';

const {
  CvEnterprise, CvEnterpriseStage, CvEnterpriseBlock, CvEnterpriseUnit,
  CvEnterprisePriceTable, EnterpriseMirrorSettings,
} = db;

// Fallback quando nada foi configurado pela tela. Regra de negócio de verdade
// mora no banco (enterprise_mirror_settings), editada na aba Espelho.
export const DEFAULTS = Object.freeze({
  digitos_final: 1,
  digitos_andar: 1,
  andar_zero_nome: 'Térreo',
  imagem_url: null,
  finais: {},
  valor_m2_andar: {},   // { '<andar>': 9603.93 } - estimativa quando CV e tabela não têm preço
  observacao: '',
});

const FACES = {
  L: { face: 'Leste',  sol: 'manhã',    sol_label: 'Sol da manhã' },
  O: { face: 'Oeste',  sol: 'tarde',    sol_label: 'Sol da tarde' },
  N: { face: 'Norte',  sol: 'dia',      sol_label: 'Sol o dia todo' },
  S: { face: 'Sul',    sol: 'pouco',    sol_label: 'Pouco sol' },
};

const STATUS = {
  1: 'disponivel', 2: 'reserva_inicio', 3: 'vendida', 4: 'bloqueada', 5: 'reserva_ativa',
};

const num = (v) => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// Sanitiza o que chega da tela: só as chaves conhecidas, nos tipos certos.
export function normalizeSettings(input = {}) {
  const s = { ...DEFAULTS, ...(input || {}) };
  const clampInt = (v, min, max, fb) => {
    const n = parseInt(v, 10);
    return Number.isFinite(n) && n >= min && n <= max ? n : fb;
  };
  const out = {
    digitos_final: clampInt(s.digitos_final, 1, 3, DEFAULTS.digitos_final),
    digitos_andar: clampInt(s.digitos_andar, 1, 2, DEFAULTS.digitos_andar),
    andar_zero_nome: String(s.andar_zero_nome || DEFAULTS.andar_zero_nome).slice(0, 40),
    imagem_url: s.imagem_url ? String(s.imagem_url).slice(0, 1000) : null,
    observacao: String(s.observacao || '').slice(0, 2000),
    finais: {},
    valor_m2_andar: {},
  };
  for (const [andar, v] of Object.entries(s.valor_m2_andar || {})) {
    const n = Number(String(v).replace(',', '.'));
    if (/^-?\d+$/.test(andar) && Number.isFinite(n) && n > 0) out.valor_m2_andar[andar] = Math.round(n * 100) / 100;
  }
  for (const [torre, finais] of Object.entries(s.finais || {})) {
    if (!finais || typeof finais !== 'object') continue;
    const t = {};
    for (const [final, cfg] of Object.entries(finais)) {
      if (!cfg || typeof cfg !== 'object') continue;
      const face = FACES[cfg.face] ? cfg.face : null;
      const dorm = clampInt(cfg.dorm, 0, 9, null);
      const tipologia = cfg.tipologia ? String(cfg.tipologia).slice(0, 60) : null;
      if (face || dorm != null || tipologia) t[String(final)] = { face, dorm, tipologia };
    }
    if (Object.keys(t).length) out.finais[String(torre)] = t;
  }
  return out;
}

// Primeiro grupo de dígitos do nome: "BL A - AP 101" → 101, "846 - Vaga 183" → 846
const numeroDe = (nome) => {
  const m = String(nome || '').match(/\d+/);
  return m ? m[0] : null;
};

// Deriva torre/andar/final do número quando o CV não manda.
// "278" com 1+1 → { torre: '2', andar: 7, final: '8' }
function decompor(numero, { digitos_final, digitos_andar }) {
  if (!numero) return { torre: null, andar: null, final: null };
  const s = String(numero);
  const final = s.slice(-digitos_final);
  const resto = s.slice(0, -digitos_final);
  const andarStr = resto.slice(-digitos_andar);
  const torre = resto.slice(0, -digitos_andar) || null;
  return {
    torre,
    andar: andarStr ? parseInt(andarStr, 10) : null,
    final: final ? String(parseInt(final, 10)) : null,
  };
}

// Tabela de preço que serve de referência: vigente mais recente com unidades;
// sem vigente, a mais recente que tenha unidades.
async function tabelaReferencia(idempreendimento) {
  const rows = await CvEnterprisePriceTable.findAll({
    where: { idempreendimento },
    order: [['data_vigencia_de', 'DESC NULLS LAST'], ['idtabela', 'DESC']],
  });
  const hoje = new Date().toISOString().slice(0, 10);
  const ymd = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);
  const comUnidades = rows.filter((t) => {
    const u = t.raw?.unidades?.length ? t.raw.unidades : (t.raw?.metadados?.unidades || []);
    return u.length > 0;
  });
  const vigente = comUnidades.find((t) => (!t.data_vigencia_de || ymd(t.data_vigencia_de) <= hoje)
    && (!t.data_vigencia_ate || ymd(t.data_vigencia_ate) >= hoje));
  const t = vigente || comUnidades[0];
  if (!t) return null;
  const unidades = t.raw?.unidades?.length ? t.raw.unidades : t.raw.metadados.unidades;
  const porId = new Map();
  for (const u of unidades) if (u.idunidade != null) porId.set(Number(u.idunidade), num(u.valor_total));
  return {
    idtabela: t.idtabela,
    nome: t.nome,
    vigente: Boolean(vigente),
    data_vigencia_de: ymd(t.data_vigencia_de),
    data_vigencia_ate: ymd(t.data_vigencia_ate),
    porId,
  };
}

async function loadSettings(idempreendimento) {
  const row = await EnterpriseMirrorSettings.findByPk(idempreendimento);
  return { row, settings: normalizeSettings(row?.settings || {}) };
}

// ── Montagem ─────────────────────────────────────────────────────────────────
export async function montarEspelho(idempreendimento) {
  const [{ settings, row }, etapas, tabela] = await Promise.all([
    loadSettings(idempreendimento),
    CvEnterpriseStage.findAll({ where: { idempreendimento }, order: [['idetapa', 'ASC']] }),
    tabelaReferencia(idempreendimento),
  ]);
  const etapaIds = etapas.map((e) => e.idetapa);
  const blocos = etapaIds.length
    ? await CvEnterpriseBlock.findAll({ where: { idetapa: etapaIds }, order: [['nome', 'ASC'], ['idbloco', 'ASC']] })
    : [];
  const blocoIds = blocos.map((b) => b.idbloco);
  const unidades = blocoIds.length
    ? await CvEnterpriseUnit.findAll({ where: { idbloco: blocoIds }, order: [['idunidade', 'ASC']] })
    : [];

  const blocoPorId = new Map(blocos.map((b) => [b.idbloco, b]));
  const etapaPorId = new Map(etapas.map((e) => [e.idetapa, e]));
  const multiBloco = blocos.length > 1;

  // 1) cada unidade vira uma célula com torre/andar/final resolvidos
  const cells = [];
  let fonteCv = 0, fonteTabela = 0, fonteEstimado = 0, semPreco = 0;
  for (const u of unidades) {
    const bloco = blocoPorId.get(u.idbloco);
    const etapa = bloco ? etapaPorId.get(bloco.idetapa) : null;
    const numero = numeroDe(u.nome);
    const d = decompor(numero, settings);

    // Torre: bloco do CV quando há mais de um; senão o prefixo do número.
    const torreKey = multiBloco ? `b${u.idbloco}` : (d.torre != null ? `n${d.torre}` : `b${u.idbloco}`);
    const torreNome = multiBloco ? (bloco?.nome || `Bloco ${u.idbloco}`) : (d.torre != null ? `Torre ${d.torre}` : (bloco?.nome || 'Torre única'));

    const andar = u.andar != null ? Number(u.andar) : d.andar;
    const final = u.coluna != null ? String(u.coluna) : d.final;

    const area = num(u.area_privativa);
    const valorCv = num(u.valor);
    const m2Andar = andar != null ? settings.valor_m2_andar?.[String(andar)] : null;
    let valor = null, fonte = null;
    if (valorCv && valorCv > 0) { valor = valorCv; fonte = 'cv'; fonteCv++; }
    else if (tabela?.porId.has(u.idunidade) && tabela.porId.get(u.idunidade) > 0) { valor = tabela.porId.get(u.idunidade); fonte = 'tabela'; fonteTabela++; }
    else if (m2Andar && area) { valor = Math.round(m2Andar * area * 100) / 100; fonte = 'estimado'; fonteEstimado++; }
    else semPreco++;

    const cfg = settings.finais?.[torreKey]?.[final] || settings.finais?.['*']?.[final] || {};
    const face = cfg.face ? FACES[cfg.face] : null;

    cells.push({
      idunidade: u.idunidade,
      idunidade_int: u.idunidade_int,
      nome: u.nome,
      numero,
      etapa: etapa?.nome || null,
      bloco: bloco?.nome || null,
      torre: torreKey,
      torre_nome: torreNome,
      andar,
      final,
      status: STATUS[u.situacao_mapa_disponibilidade] || 'sem_status',
      data_bloqueio: u.data_bloqueio || null,
      area,
      vagas: u.vagas_garagem_qtde ?? (typeof u.vagas_garagem === 'string' && /^\d+$/.test(u.vagas_garagem) ? Number(u.vagas_garagem) : null),
      vagas_texto: u.vagas_garagem || null,
      tipologia: cfg.tipologia || u.tipologia || null,
      dorm: cfg.dorm ?? null,
      face_sigla: cfg.face || null,
      face: face?.face || null,
      sol: face?.sol || null,
      sol_label: face?.sol_label || null,
      valor,
      valor_fonte: fonte,
      valor_m2: valor != null && area ? valor / area : null,
    });
  }

  // 2) agrupa por torre → andar (de cima para baixo) → finais (crescente)
  const torres = new Map();
  for (const c of cells) {
    if (!torres.has(c.torre)) torres.set(c.torre, { key: c.torre, nome: c.torre_nome, andares: new Map(), finais: new Set(), cells: [] });
    const t = torres.get(c.torre);
    t.cells.push(c);
    const a = c.andar ?? -1;
    if (!t.andares.has(a)) t.andares.set(a, []);
    t.andares.get(a).push(c);
    if (c.final != null) t.finais.add(c.final);
  }

  const sortFinais = (arr) => [...arr].sort((x, y) => Number(x) - Number(y) || String(x).localeCompare(String(y)));
  const resumoDe = (arr) => {
    const r = { unidades: arr.length, disponiveis: 0, vendidas: 0, reservadas: 0, bloqueadas: 0, vgv_disponivel: 0, area_disponivel: 0 };
    for (const c of arr) {
      if (c.status === 'disponivel') { r.disponiveis++; if (c.valor) { r.vgv_disponivel += c.valor; r.area_disponivel += c.area || 0; } }
      else if (c.status === 'vendida') r.vendidas++;
      else if (c.status === 'bloqueada') r.bloqueadas++;
      else if (c.status === 'reserva_inicio' || c.status === 'reserva_ativa') r.reservadas++;
    }
    r.valor_m2_disponivel = r.area_disponivel > 0 ? r.vgv_disponivel / r.area_disponivel : null;
    return r;
  };

  const torresOut = [...torres.values()]
    .sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR', { numeric: true }))
    .map((t) => {
      const finais = sortFinais(t.finais);
      const andares = [...t.andares.entries()]
        .sort((a, b) => b[0] - a[0])
        .map(([andar, arr]) => ({
          andar: andar === -1 ? null : andar,
          nome: andar === -1 ? 'Sem andar' : (andar === 0 ? settings.andar_zero_nome : `${andar}º`),
          unidades: [...arr].sort((x, y) => Number(x.final) - Number(y.final)),
          resumo: resumoDe(arr),
        }));
      const colunas = finais.map((f) => {
        const arr = t.cells.filter((c) => c.final === f);
        const cfg = settings.finais?.[t.key]?.[f] || {};
        const face = cfg.face ? FACES[cfg.face] : null;
        // tipologia/área mais comum da prumada (para o rodapé)
        const freq = new Map();
        for (const c of arr) if (c.area) freq.set(c.area, (freq.get(c.area) || 0) + 1);
        const areaModa = freq.size ? [...freq.entries()].sort((a, b) => b[1] - a[1])[0][0] : null;
        return {
          final: f, ...cfg, face_nome: face?.face || null, sol: face?.sol || null, sol_label: face?.sol_label || null,
          area: areaModa, resumo: resumoDe(arr),
        };
      });
      return { key: t.key, nome: t.nome, finais, colunas, andares, resumo: resumoDe(t.cells) };
    });

  return {
    idempreendimento,
    settings,
    configurado: Boolean(row),
    multi_bloco: multiBloco,
    fonte_preco: {
      cv: fonteCv, tabela: fonteTabela, estimado: fonteEstimado, sem_preco: semPreco,
      tabela_ref: tabela ? { idtabela: tabela.idtabela, nome: tabela.nome, vigente: tabela.vigente, data_vigencia_de: tabela.data_vigencia_de, data_vigencia_ate: tabela.data_vigencia_ate } : null,
    },
    torres: torresOut,
    resumo: resumoDe(cells),
    faces: Object.fromEntries(Object.entries(FACES).map(([k, v]) => [k, v.face])),
  };
}

// ── HTTP ─────────────────────────────────────────────────────────────────────
const podeVer = async (user, id) => {
  const allowed = await visibleCvIds(user);
  return allowed === null || allowed.includes(Number(id));
};

export const getMirror = async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Usuário não autenticado.' });
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: "O parâmetro 'id' é obrigatório." });
  try {
    if (!(await podeVer(req.user, id))) return res.status(403).json({ error: 'Empreendimento fora do seu escopo.' });
    const ent = await CvEnterprise.findByPk(id, { attributes: ['idempreendimento', 'nome'] });
    if (!ent) return res.status(404).json({ error: 'Empreendimento não encontrado.' });
    return res.json(await montarEspelho(id));
  } catch (err) {
    console.error('Erro ao montar espelho (DB):', err);
    return res.status(500).json({ error: 'Erro ao montar o espelho do empreendimento.' });
  }
};

export const saveMirrorSettings = async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Usuário não autenticado.' });
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: "O parâmetro 'id' é obrigatório." });
  try {
    const ent = await CvEnterprise.findByPk(id, { attributes: ['idempreendimento'] });
    if (!ent) return res.status(404).json({ error: 'Empreendimento não encontrado.' });
    const settings = normalizeSettings(req.body?.settings ?? req.body ?? {});
    await EnterpriseMirrorSettings.upsert({ idempreendimento: id, settings, updated_by: req.user.id ?? null });
    return res.json(await montarEspelho(id));
  } catch (err) {
    console.error('Erro ao salvar configuração do espelho:', err);
    return res.status(500).json({ error: 'Erro ao salvar a configuração do espelho.' });
  }
};
