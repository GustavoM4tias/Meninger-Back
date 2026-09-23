// controllers/cv/mirrorDb.js
//
// ESPELHO de vendas do empreendimento: torres x andares x finais, com status,
// preço, área, dormitórios e lado do sol em cada célula. É a leitura de
// "quadra e corte" que a diretoria pede para saber o que sobrou e onde.
//
// Empreendimento HORIZONTAL (casas, loteamento) não tem torre nem andar: o
// espelho vira QUADRAS x LOTES. O modo sai do tipo do empreendimento no CV
// (`modo: auto`) ou da configuração da aba; quadra é o bloco do CV quando há
// mais de um, senão o "QD 3"/"Quadra 3" do nome; lote é o "LT 12"/"Lote 12"
// ou o número da unidade. Ler "CASA 278" como torre 2, 7º andar, final 8 era
// o que fazia o Parque Alameda (Votuporanga) aparecer com andares.
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
//   - adimplência premiada (Desconto Construtora) → enterprise_unit_adimplencia,
//     vigente hoje; o preço da célula já vem com ela descontada e `valor_cheio`
//     guarda o cheio
import db from '../../models/sequelize/index.js';
import { visibleCvIds } from '../../services/permissions/accessScopeService.js';
import { mapaVigente, descontoDe } from './adimplenciaDb.js';
import { mapaMotivos } from '../../services/cv/unitStockService.js';

const {
  CvEnterprise, CvEnterpriseStage, CvEnterpriseBlock, CvEnterpriseUnit,
  CvEnterprisePriceTable, EnterpriseMirrorSettings,
} = db;

// Fallback quando nada foi configurado pela tela. Regra de negócio de verdade
// mora no banco (enterprise_mirror_settings), editada na aba Espelho.
export const DEFAULTS = Object.freeze({
  modo: 'auto',         // auto (pelo tipo do CV) | vertical | horizontal
  valor_m2_padrao: null, // R$/m² de estimativa quando não há andar (horizontal) nem final configurado
  digitos_final: 1,
  digitos_andar: 1,
  andar_zero_nome: 'Térreo',
  imagem_url: null,
  finais: {},
  valor_m2_andar: {},   // { '<andar>': 9603.93 } - estimativa quando CV e tabela não têm preço
  // Dormitórios pela área quando o CV não diz: faixas em ordem, a última sem
  // `ate` é o "acima disso". Regra de negócio: mora no banco, isto é o fallback.
  dorm_por_area: [{ ate: 45, dorm: 1 }, { ate: 65, dorm: 2 }, { dorm: 3 }],
  vagas_padrao: null,   // vagas por unidade quando o CV não informa
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
  const m2Padrao = Number(String(s.valor_m2_padrao ?? '').replace(',', '.'));
  const out = {
    modo: ['auto', 'vertical', 'horizontal'].includes(s.modo) ? s.modo : DEFAULTS.modo,
    valor_m2_padrao: Number.isFinite(m2Padrao) && m2Padrao > 0 ? Math.round(m2Padrao * 100) / 100 : null,
    digitos_final: clampInt(s.digitos_final, 1, 3, DEFAULTS.digitos_final),
    digitos_andar: clampInt(s.digitos_andar, 1, 2, DEFAULTS.digitos_andar),
    andar_zero_nome: String(s.andar_zero_nome || DEFAULTS.andar_zero_nome).slice(0, 40),
    imagem_url: s.imagem_url ? String(s.imagem_url).slice(0, 1000) : null,
    observacao: String(s.observacao || '').slice(0, 2000),
    finais: {},
    valor_m2_andar: {},
    dorm_por_area: [],
    vagas_padrao: clampInt(s.vagas_padrao, 0, 9, null),
  };
  for (const f of Array.isArray(s.dorm_por_area) ? s.dorm_por_area : []) {
    const dorm = clampInt(f?.dorm, 0, 9, null);
    if (dorm == null) continue;
    const ate = f?.ate === '' || f?.ate == null ? null : Number(String(f.ate).replace(',', '.'));
    out.dorm_por_area.push(ate != null && Number.isFinite(ate) && ate > 0 ? { ate, dorm } : { dorm });
  }
  // faixas em ordem de área; a aberta (sem `ate`) vai para o fim
  out.dorm_por_area.sort((a, b) => (a.ate ?? Infinity) - (b.ate ?? Infinity));
  if (!out.dorm_por_area.length) out.dorm_por_area = DEFAULTS.dorm_por_area.map((f) => ({ ...f }));
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
      const m2 = Number(String(cfg.valor_m2 ?? '').replace(',', '.'));
      const valor_m2 = Number.isFinite(m2) && m2 > 0 ? Math.round(m2 * 100) / 100 : null;
      if (face || dorm != null || tipologia || valor_m2) t[String(final)] = { face, dorm, tipologia, valor_m2 };
    }
    if (Object.keys(t).length) out.finais[String(torre)] = t;
  }
  return out;
}

// "2 dorm", "3 quartos", "2D" no texto da tipologia do CV → número
const dormDoTexto = (txt) => {
  const m = String(txt || '').match(/(\d)\s*(?:dorm|quarto|dt|d\b|suite)/i);
  return m ? Number(m[1]) : null;
};
const dormPorArea = (area, faixas) => {
  if (area == null) return null;
  for (const f of faixas) if (f.ate == null || area <= f.ate) return f.dorm;
  return null;
};
// Tipos automáticos: cada área privativa distinta vira uma letra, da menor
// para a maior (60,80 = A, 60,92 = B, 78,20 = C...). É o que a planta diz
// quando ninguém cadastrou tipologia.
const tiposPorArea = (unidades) => {
  const areas = [...new Set(unidades.map((u) => num(u.area_privativa)).filter((a) => a))].sort((a, b) => a - b);
  const letra = (i) => (i < 26 ? String.fromCharCode(65 + i) : `T${i + 1}`);
  return new Map(areas.map((a, i) => [a, letra(i)]));
};
const fmtArea = (a) => `${a.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} m²`;

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

// Horizontal: "QD 03 - LT 12", "Quadra A Lote 7", "CASA 45", "Q3L12".
// A quadra é tudo entre o "QD" e o separador ou o "LT": no Parque Alameda
// ela é "NE 22.05.15" ("QD NE 22.05.15 - LT 01"), não só "NE".
const QUADRA_RE = /\bQ(?:D|DA|UADRA)?\.?\s*[:-]?\s*(.+?)\s*(?:[-–|,;]|\bL(?:T|OTE)?(?![A-Z])|$)/i;
const LOTE_RE = /\bL(?:T|OTE)?\.?\s*[:-]?\s*(\d{1,4})\b/i;
function decomporHorizontal(nome) {
  const s = String(nome || '');
  const q = s.match(QUADRA_RE);
  const l = s.match(LOTE_RE);
  const quadra = q ? String(q[1]).toUpperCase().replace(/^0+(\d)/, '$1').replace(/\s+/g, ' ') : null;
  const lote = l ? String(parseInt(l[1], 10)) : (numeroDe(s) != null ? String(parseInt(numeroDe(s), 10)) : null);
  return { quadra, lote };
}
const ehHorizontal = (tipoNome) => /horizontal|loteamento|\bcasas?\b|\blotes?\b/i.test(String(tipoNome || ''));

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
  const [{ settings, row }, ent, etapas, tabela, adimplencia, motivos] = await Promise.all([
    loadSettings(idempreendimento),
    CvEnterprise.findByPk(idempreendimento, { attributes: ['idempreendimento', 'tipo_empreendimento_nome'] }),
    CvEnterpriseStage.findAll({ where: { idempreendimento }, order: [['idetapa', 'ASC']] }),
    tabelaReferencia(idempreendimento),
    mapaVigente(idempreendimento).catch(() => new Map()),
    // Motivo do bloqueio por unidade (núcleo do estoque comercial). Falhar aqui
    // não pode derrubar o espelho: sem o mapa, toda bloqueada é só bloqueada.
    mapaMotivos(idempreendimento).catch(() => new Map()),
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
  // Só bloco COM unidade conta como torre: o CV tem bloco vazio de sobra
  // (MOOV tem um segundo bloco sem nada, e as 8 torres moram no número).
  const blocosComUnidade = new Set(unidades.map((u) => u.idbloco));
  const multiBloco = blocosComUnidade.size > 1;
  const tipoAuto = tiposPorArea(unidades);
  // andar/coluna do CV só valem quando variam: o Adhara manda 0/0 em todas
  // as unidades, e isso é "não sei", não "térreo, coluna 0".
  const cvAndarVale = new Set(unidades.map((u) => u.andar).filter((v) => v != null)).size > 1;
  const cvColunaVale = new Set(unidades.map((u) => u.coluna).filter((v) => v != null)).size > 1;
  const modo = settings.modo === 'auto' ? (ehHorizontal(ent?.tipo_empreendimento_nome) ? 'horizontal' : 'vertical') : settings.modo;
  const horizontal = modo === 'horizontal';

  // 1) cada unidade vira uma célula com torre/andar/final resolvidos
  const cells = [];
  let fonteCv = 0, fonteTabela = 0, fonteEstimado = 0, semPreco = 0, comAdimplencia = 0;
  for (const u of unidades) {
    const bloco = blocoPorId.get(u.idbloco);
    const etapa = bloco ? etapaPorId.get(bloco.idetapa) : null;
    const numero = numeroDe(u.nome);
    let torreKey, torreNome, andar, final;
    if (horizontal) {
      // Quadra x lote: sem andar. Quadra = bloco do CV quando há mais de um,
      // senão a que está escrita no nome; lote = o do nome ou o número.
      const h = decomporHorizontal(u.nome);
      torreKey = multiBloco ? `b${u.idbloco}` : (h.quadra != null ? `q${h.quadra}` : `b${u.idbloco}`);
      torreNome = multiBloco ? (bloco?.nome || `Quadra ${u.idbloco}`) : (h.quadra != null ? `Quadra ${h.quadra}` : (bloco?.nome || 'Quadra única'));
      andar = null;
      final = h.lote;
    } else {
      const d = decompor(numero, settings);
      // Torre: bloco do CV quando há mais de um; senão o prefixo do número.
      torreKey = multiBloco ? `b${u.idbloco}` : (d.torre != null ? `n${d.torre}` : `b${u.idbloco}`);
      torreNome = multiBloco ? (bloco?.nome || `Bloco ${u.idbloco}`) : (d.torre != null ? `Torre ${d.torre}` : (bloco?.nome || 'Torre única'));
      andar = cvAndarVale && u.andar != null ? Number(u.andar) : d.andar;
      final = cvColunaVale && u.coluna != null ? String(u.coluna) : d.final;
    }

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

    // Preço, em cascata: CV → tabela → R$/m² do andar → R$/m² do final → R$/m² padrão
    const m2Final = cfg.valor_m2 || settings.valor_m2_padrao || null;
    if (valor == null && m2Final && area) { valor = Math.round(m2Final * area * 100) / 100; fonte = 'estimado'; fonteEstimado++; semPreco--; }

    // Adimplência premiada: sai do preço, seja ele de onde for
    const valorCheio = valor;
    const adimpl = descontoDe(valor, adimplencia.get(Number(u.idunidade)));
    if (adimpl) { valor = Math.round((valor - adimpl) * 100) / 100; comAdimplencia++; }

    // Tipologia: cadastro → CV → tipo automático pela área
    const letra = area ? tipoAuto.get(area) : null;
    const tipologia = cfg.tipologia || u.tipologia || (letra ? `Tipo ${letra} · ${fmtArea(area)}` : null);
    // Dormitórios: cadastro → texto da tipologia do CV → faixa de área
    const dorm = cfg.dorm ?? dormDoTexto(u.tipologia) ?? dormPorArea(area, settings.dorm_por_area);
    const vagasCv = u.vagas_garagem_qtde ?? (typeof u.vagas_garagem === 'string' && /^\d+$/.test(u.vagas_garagem) ? Number(u.vagas_garagem) : null);

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
      // Estoque comercial: bloqueada no CV, mas segurada de propósito. A célula
      // continua com status 'bloqueada' (é a verdade do CV) e ganha a marca que
      // a tela usa para pintar e os resumos usam para contar como disponível.
      estoque_comercial: !!motivos.get(u.idunidade)?.conta_estoque,
      motivo_bloqueio: motivos.get(u.idunidade)?.motivo || null,
      motivo_observacao: motivos.get(u.idunidade)?.observacao || null,
      motivo_origem: motivos.get(u.idunidade)?.origem || null,
      area,
      vagas: vagasCv ?? settings.vagas_padrao ?? null,
      vagas_fonte: vagasCv != null ? 'cv' : (settings.vagas_padrao != null ? 'padrao' : null),
      vagas_texto: u.vagas_garagem || null,
      tipologia,
      tipo_auto: letra,
      tipologia_fonte: cfg.tipologia ? 'cadastro' : (u.tipologia ? 'cv' : (letra ? 'area' : null)),
      dorm,
      dorm_fonte: cfg.dorm != null ? 'cadastro' : (dormDoTexto(u.tipologia) != null ? 'cv' : (dorm != null ? 'area' : null)),
      face_sigla: cfg.face || null,
      face: face?.face || null,
      sol: face?.sol || null,
      sol_label: face?.sol_label || null,
      valor,
      valor_fonte: fonte,
      valor_cheio: valorCheio,
      adimplencia_premiada: adimpl,
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
    const r = {
      unidades: arr.length, disponiveis: 0, vendidas: 0, reservadas: 0, bloqueadas: 0,
      // Bloqueadas que seguem sendo estoque (fazem parte de `a_venda` e do VGV).
      estoque_comercial: 0, a_venda: 0,
      vgv_disponivel: 0, area_disponivel: 0,
    };
    for (const c of arr) {
      const aVenda = c.status === 'disponivel' || (c.status === 'bloqueada' && c.estoque_comercial);
      if (c.status === 'disponivel') r.disponiveis++;
      else if (c.status === 'vendida') r.vendidas++;
      else if (c.status === 'bloqueada') { r.bloqueadas++; if (c.estoque_comercial) r.estoque_comercial++; }
      else if (c.status === 'reserva_inicio' || c.status === 'reserva_ativa') r.reservadas++;
      // VGV e área do que está à venda: sem isto, bloquear 229 unidades por
      // estratégia comercial zerava o VGV do empreendimento na tela.
      if (aVenda) { r.a_venda++; if (c.valor) { r.vgv_disponivel += c.valor; r.area_disponivel += c.area || 0; } }
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
        const moda = (vals) => { const m = new Map(); for (const v of vals) if (v != null) m.set(v, (m.get(v) || 0) + 1); return m.size ? [...m.entries()].sort((a, b) => b[1] - a[1])[0][0] : null; };
        return {
          final: f, ...cfg, face_nome: face?.face || null, sol: face?.sol || null, sol_label: face?.sol_label || null,
          area: areaModa,
          tipologia: cfg.tipologia || moda(arr.map((c) => c.tipologia)),
          dorm: cfg.dorm ?? moda(arr.map((c) => c.dorm)),
          areas_distintas: freq.size,
          resumo: resumoDe(arr),
        };
      });
      return { key: t.key, nome: t.nome, finais, colunas, andares, resumo: resumoDe(t.cells) };
    });

  return {
    idempreendimento,
    settings,
    modo,
    tipo_empreendimento: ent?.tipo_empreendimento_nome || null,
    configurado: Boolean(row),
    multi_bloco: multiBloco,
    fonte_preco: {
      cv: fonteCv, tabela: fonteTabela, estimado: fonteEstimado, sem_preco: semPreco,
      com_adimplencia: comAdimplencia,
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
