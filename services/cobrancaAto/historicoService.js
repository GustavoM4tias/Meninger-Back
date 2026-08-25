// services/cobrancaAto/historicoService.js
//
// Leitura UNIFICADA do histórico do Ato: boleto Caixa + link de cartão Userede.
//
// ── Por que UNION e não duas consultas ────────────────────────────────────────
// Buscar cada tabela e juntar em memória quebra paginação e ordenação: a
// "página 2 por valor decrescente" não é a página 2 de uma somada à da outra.
// O UNION resolve no banco, que é onde a ordenação global existe.
//
// ── Por que duas tabelas ──────────────────────────────────────────────────────
// `boleto_history` tem quase mil linhas em produção com um módulo inteiro em
// cima. Migrar para uma tabela só seria risco sem ganho. As colunas do cartão
// foram nomeadas iguais às do boleto onde o conceito é o mesmo, justamente para
// esta consulta ficar simples.
//
// ── Vocabulário comum ─────────────────────────────────────────────────────────
// Os dois portais falam diferente. Normalizamos na leitura e guardamos o termo
// original em `situacao_origem`:
//
//   boleto: pending | paid  | cancelled (baixado)      | error
//   cartão: pending | paid  | cancelled (excluído)     | expired | denied | refunded | error
//
// `cancelled` cobre "baixado" e "excluído" porque para a operação é a mesma
// coisa: a cobrança deixou de valer sem ter sido paga.
import db from '../../models/sequelize/index.js';
import { allowedEnterpriseNames } from '../boleto/boletoScope.js';
import {
    fetchCvEtapaByReserva,
    fetchCvEtapaFacets,
    fetchReservasMortas,
    resolveCvEtapaFilter,
} from '../../lib/cvEtapaLookup.js';

export const FORMAS = { BOLETO: 'boleto', CARTAO: 'cartao' };

/**
 * SELECT normalizado de cada tabela. As duas devolvem EXATAMENTE as mesmas
 * colunas, na mesma ordem - requisito do UNION.
 *
 * Mantemos os apelidos antigos (`nosso_numero`, `boleto_supabase_url`) além dos
 * canônicos (`documento`, `arquivo_url`) para a tela existente continuar
 * funcionando enquanto migra.
 */
const SELECT_BOLETO = `
    SELECT
        'boleto'::text                  AS forma,
        h.id,
        ('boleto:' || h.id)             AS uid,
        h.idreserva, h.idtransacao, h.idpessoa_cv,
        h.titular_nome, h.empreendimento,
        NULL::varchar                   AS unidade,
        h.valor, h.valor_original, h.comissao_percentual_aplicada,
        h.vencimento::date              AS vencimento,
        h.nosso_numero                  AS documento,
        h.nosso_numero,
        h.boleto_supabase_url           AS arquivo_url,
        h.boleto_supabase_url,
        NULL::int                       AS parcelas_limite,
        NULL::int                       AS parcelas_escolhidas,
        h.status::text                  AS status,
        h.payment_status,
        h.last_check_situation          AS situacao_origem,
        h.error_message,
        h.cv_mensagem_enviada, h.cv_situacao_alterada, h.cv_documento_anexado,
        h.cliente_email_enviado, h.cliente_whatsapp_enviado, h.cliente_envio_em,
        h.ignorado, h.substitui_id, h.substituido_por_id,
        h.last_checked_at, h.paid_at, h.cancelled_at,
        h.created_at, h.updated_at
      FROM boleto_history h`;

const SELECT_CARTAO = `
    SELECT
        'cartao'::text                  AS forma,
        c.id,
        ('cartao:' || c.id)             AS uid,
        c.idreserva, c.idtransacao, c.idpessoa_cv,
        c.titular_nome, c.empreendimento,
        c.unidade,
        c.valor, c.valor_original, c.comissao_percentual_aplicada,
        c.validade::date                AS vencimento,
        c.pedido_id                     AS documento,
        c.pedido_id                     AS nosso_numero,
        c.link_url                      AS arquivo_url,
        c.link_url                      AS boleto_supabase_url,
        c.parcelas_limite, c.parcelas_escolhidas,
        c.status::text                  AS status,
        c.payment_status,
        c.last_check_situation          AS situacao_origem,
        c.error_message,
        c.cv_mensagem_enviada, c.cv_situacao_alterada, c.cv_documento_anexado,
        c.cliente_email_enviado, c.cliente_whatsapp_enviado, c.cliente_envio_em,
        c.ignorado, c.substitui_id, c.substituido_por_id,
        c.last_checked_at, c.paid_at, c.cancelled_at,
        c.created_at, c.updated_at
      FROM userede_link_history c`;

const ORDENAVEIS = {
    data: 'created_at',
    reserva: 'idreserva',
    titular: 'titular_nome',
    valor: 'valor',
    vencimento: 'vencimento',
    status: 'status',
    pagamento: 'payment_status',
    forma: 'forma',
    tentativas: 'attempts_count',
};

function listaCsv(v) {
    if (v == null || v === '') return null;
    const arr = Array.isArray(v) ? v : String(v).split(',');
    const limpo = arr.map(x => String(x).trim()).filter(Boolean);
    return limpo.length ? limpo : null;
}

/**
 * Filtros de ESCOPO: escolhem QUAIS RESERVAS entram na conta. Rodam sobre
 * todas as tentativas, antes do agrupamento.
 *
 * `null` em nomesPermitidos = admin (sem recorte). Lista vazia = nenhuma linha
 * (fail-closed), nunca a base inteira.
 */
function filtrosEscopo(f, nomesPermitidos, cvIds) {
    const cond = [];
    const rep = {};

    if (nomesPermitidos !== null) {
        cond.push("lower(coalesce(empreendimento, '')) IN (:escopo)");
        rep.escopo = nomesPermitidos.length ? nomesPermitidos : [''];
    }

    const emps = listaCsv(f.empreendimento);
    if (emps) { cond.push('empreendimento IN (:emps)'); rep.emps = emps; }

    if (f.idreserva) { cond.push('idreserva = :idreserva'); rep.idreserva = Number(f.idreserva); }

    // Data de EMISSÃO (padrão) ou de PAGAMENTO — a tela escolhe.
    const dateCol = String(f.dateField) === 'paid_at' ? 'paid_at' : 'created_at';
    if (f.dateFrom) { cond.push(`${dateCol} >= :dateFrom`); rep.dateFrom = `${f.dateFrom} 00:00:00`; }
    if (f.dateTo) { cond.push(`${dateCol} <= :dateTo`); rep.dateTo = `${f.dateTo} 23:59:59`; }

    if (f.q) {
        cond.push(`(
            unaccent(lower(coalesce(titular_nome, ''))) LIKE unaccent(lower(:q))
            OR coalesce(documento, '') ILIKE :q
            OR CAST(idreserva AS text) LIKE :q
        )`);
        rep.q = `%${String(f.q).trim()}%`;
    }

    // Etapa CV (reserva/repasse): vem resolvida em lista de idreserva.
    // Array vazio = nada casa, e aí o recorte tem de ser vazio de verdade.
    if (cvIds) {
        cond.push('idreserva IN (:cvIds)');
        rep.cvIds = cvIds.length ? cvIds : [-1];
    }

    return { sql: cond.length ? `WHERE ${cond.join(' AND ')}` : '', replacements: rep };
}

/**
 * Filtros de ESTADO: aplicados DEPOIS do agrupamento, sobre a linha ATUAL da
 * reserva. Filtrar antes redefiniria qual é a situação de agora — era isso que
 * fazia um erro velho ressuscitar quando a tela escondia `skipped`.
 */
function filtrosEstado(f) {
    const cond = [];
    const rep = {};

    const formas = listaCsv(f.forma);
    if (formas) { cond.push('forma IN (:formas)'); rep.formas = formas; }

    const status = listaCsv(f.status);
    if (status) { cond.push('status IN (:status)'); rep.status = status; }

    const pgto = listaCsv(f.paymentStatus);
    if (pgto) { cond.push('payment_status IN (:pgto)'); rep.pgto = pgto; }

    return { sql: cond.length ? `WHERE ${cond.join(' AND ')}` : '', replacements: rep };
}

/**
 * UMA LINHA POR RESERVA — a "linha atual".
 *
 * A tela do Ato é fila de trabalho, não diário de bordo: o que importa é como
 * a cobrança está AGORA, não quantas tentativas foram precisas. Contando
 * linha, uma reserva que falhou três vezes e depois emitiu aparecia como três
 * erros mais um emitido — o cartão "Com erro" mostrava 231 onde havia 26
 * reservas de fato sem cobrança.
 *
 * Regra (a mesma que o endpoint antigo do boleto usava):
 *   tem cobrança emitida -> a VIA FINAL (o `success` mais recente)
 *   não tem              -> a última tentativa DE VERDADE
 *
 * "De verdade" exclui `ignorado`: essa linha é espelho de um re-disparo do
 * webhook, não tentativa. Sendo a de id mais alto, era eleita a atual e
 * escondia o boleto que existia. Se a reserva SÓ tem linha ignorada, ela ainda
 * assim aparece (a última delas) — sumir da tela é pior que aparecer.
 *
 * O escopo escolhe QUAIS reservas entram; a linha atual é procurada entre
 * TODAS as tentativas da reserva, inclusive fora da janela de data. O estado é
 * o de agora, mesmo que a linha que o comprova seja anterior ao recorte.
 */
function sqlAtual(escopoSql) {
    return `
    WITH base AS ( ${SELECT_BOLETO} UNION ALL ${SELECT_CARTAO} ),
    alvo AS ( SELECT DISTINCT idreserva FROM base ${escopoSql} ),
    tudo AS ( SELECT b.* FROM base b JOIN alvo a ON a.idreserva = b.idreserva ),
    atual AS (
        SELECT DISTINCT ON (t.idreserva) t.*,
               count(*) OVER (PARTITION BY t.idreserva)::int AS attempts_count,
               bool_or(t.status = 'success' AND NOT coalesce(t.ignorado, false))
                   OVER (PARTITION BY t.idreserva) AS has_boleto
          FROM tudo t
         ORDER BY t.idreserva,
                  coalesce(t.ignorado, false) ASC,
                  (t.status = 'success') DESC,
                  t.created_at DESC,
                  t.id DESC
    )`;
}

/** Situações CV que marcam reserva morta — configuração do módulo, não constante. */
async function situacoesMortas() {
    const s = await db.BoletoSettings.findByPk(1);
    return s?.cv_situacoes_reserva_morta || [];
}

/**
 * Acrescenta às linhas da PÁGINA a etapa CV atual (reserva + repasse, com as
 * cores do workflow) e a marca de reserva morta.
 */
async function enriquecer(rows) {
    if (!rows.length) return rows;
    const ids = rows.map(r => Number(r.idreserva));
    const [etapas, mortas] = await Promise.all([
        fetchCvEtapaByReserva(ids),
        situacoesMortas().then(sits => fetchReservasMortas(ids, sits)),
    ]);
    for (const r of rows) {
        Object.assign(r, etapas.get(Number(r.idreserva)) || {});
        r.reserva_morta = mortas.has(Number(r.idreserva));
    }
    return rows;
}

/** Listagem paginada: uma linha por reserva, já unificada e ordenada. */
export async function listar(user, filtros = {}) {
    const nomes = await allowedEnterpriseNames(user);
    const cvIds = await resolveCvEtapaFilter(filtros);
    const escopo = filtrosEscopo(filtros, nomes, cvIds);
    const estado = filtrosEstado(filtros);
    const replacements = { ...escopo.replacements, ...estado.replacements };
    const cte = sqlAtual(escopo.sql);

    const page = Math.max(1, Number(filtros.page) || 1);
    const limit = Math.min(200, Math.max(1, Number(filtros.limit) || 20));
    const coluna = ORDENAVEIS[filtros.sortBy] || 'created_at';
    const direcao = String(filtros.sortDir).toLowerCase() === 'asc' ? 'ASC' : 'DESC';

    const [[{ total }]] = await db.sequelize.query(
        `${cte} SELECT count(*)::int AS total FROM atual ${estado.sql}`,
        { replacements },
    );

    // Desempate por uid: sem ele, duas linhas com o mesmo created_at podem
    // trocar de lugar entre páginas e um registro some da listagem.
    const [rows] = await db.sequelize.query(
        `${cte} SELECT * FROM atual ${estado.sql}
          ORDER BY ${coluna} ${direcao} NULLS LAST, uid DESC
          LIMIT :limit OFFSET :offset`,
        { replacements: { ...replacements, limit, offset: (page - 1) * limit } },
    );

    await enriquecer(rows);
    return { total, page, limit, rows, grouped: true };
}

/**
 * Agregados para os cartões do topo, com os MESMOS filtros da listagem e sobre
 * as MESMAS linhas: cada cartão conta RESERVA, e clicar nele mostra na tabela
 * exatamente a conta que ele exibe.
 */
export async function estatisticas(user, filtros = {}) {
    const nomes = await allowedEnterpriseNames(user);
    const cvIds = await resolveCvEtapaFilter(filtros);
    const escopo = filtrosEscopo(filtros, nomes, cvIds);
    const estado = filtrosEstado(filtros);
    const replacements = { ...escopo.replacements, ...estado.replacements };
    const cte = sqlAtual(escopo.sql);

    const [linhas] = await db.sequelize.query(
        `${cte} SELECT idreserva, forma, status, payment_status,
                       coalesce(valor, 0)::numeric AS valor
           FROM atual ${estado.sql}`,
        { replacements },
    );

    // Reserva cancelada/vencida no CV não é erro a resolver nem evasão: o
    // cliente desistiu e nenhuma retentativa muda isso. Sai dos baldes de
    // trabalho e vai para `mortas`, senão a fila mistura problema real com
    // reserva encerrada há semanas.
    const mortas = await fetchReservasMortas(
        linhas.map(l => Number(l.idreserva)), await situacoesMortas(),
    );

    const vazio = () => ({ qty: 0, valor: 0 });
    const acc = {
        total: vazio(),
        emitidos: vazio(), pagos: vazio(), pendentes: vazio(),
        cancelados: vazio(), expirados: vazio(), negados: vazio(),
        estornados: vazio(), erros: vazio(), agendados: vazio(),
        ignorados: vazio(), processando: vazio(), mortas: vazio(),
        porForma: { boleto: vazio(), cartao: vazio() },
    };
    const soma = (alvo, valor) => { alvo.qty += 1; alvo.valor += valor; };

    for (const l of linhas) {
        const valor = Number(l.valor) || 0;
        const morta = mortas.has(Number(l.idreserva));
        soma(acc.total, valor);
        soma(acc.porForma[l.forma] || (acc.porForma[l.forma] = vazio()), valor);

        if (l.status === 'error') { soma(morta ? acc.mortas : acc.erros, valor); continue; }
        if (l.status === 'queued') { soma(acc.agendados, valor); continue; }
        if (l.status === 'processing') { soma(acc.processando, valor); continue; }
        if (l.status === 'skipped') { soma(acc.ignorados, valor); continue; }
        if (l.status !== 'success') continue;

        soma(acc.emitidos, valor);
        // Baixado/expirado de reserva morta também não é evasão.
        if ((l.payment_status === 'cancelled' || l.payment_status === 'expired') && morta) {
            soma(acc.mortas, valor);
            continue;
        }
        const destino = {
            paid: acc.pagos,
            pending: acc.pendentes,
            cancelled: acc.cancelados,
            expired: acc.expirados,
            denied: acc.negados,
            refunded: acc.estornados,
        }[l.payment_status] || acc.pendentes; // payment_status nulo = pendente
        soma(destino, valor);
    }

    const pct = (n) => (acc.emitidos.qty ? Number(((n / acc.emitidos.qty) * 100).toFixed(1)) : 0);
    acc.percentuais = {
        pagos: pct(acc.pagos.qty),
        pendentes: pct(acc.pendentes.qty),
        perdidos: pct(acc.cancelados.qty + acc.expirados.qty + acc.negados.qty),
    };
    return acc;
}

/** Valores distintos para alimentar os selects do filtro. */
export async function facetas(user) {
    const nomes = await allowedEnterpriseNames(user);
    const { sql: whereSql, replacements } = filtrosEscopo({}, nomes, null);
    const base = `FROM ( ${SELECT_BOLETO} UNION ALL ${SELECT_CARTAO} ) t ${whereSql}`;

    const [emps] = await db.sequelize.query(
        `SELECT empreendimento AS name, count(DISTINCT idreserva)::int AS qty ${base}
          ${whereSql ? 'AND' : 'WHERE'} empreendimento IS NOT NULL AND empreendimento <> ''
       GROUP BY empreendimento ORDER BY empreendimento ASC`,
        { replacements },
    );
    const [formas] = await db.sequelize.query(
        `SELECT forma, count(DISTINCT idreserva)::int AS qty ${base} GROUP BY forma`, { replacements },
    );
    const [status] = await db.sequelize.query(
        `SELECT status, count(DISTINCT idreserva)::int AS qty ${base} GROUP BY status`, { replacements },
    );
    const [pagamentos] = await db.sequelize.query(
        `SELECT payment_status, count(DISTINCT idreserva)::int AS qty ${base} GROUP BY payment_status`, { replacements },
    );

    // Etapas CV das DUAS formas: sem isso os selects "Etapa (reserva)" e
    // "Etapa (repasse)" abriam vazios e o filtro não filtrava nada.
    let cvSituacoes = [];
    let cvRepasses = [];
    try {
        ({ cvSituacoes, cvRepasses } = await fetchCvEtapaFacets(
            `(SELECT idreserva FROM boleto_history
              UNION ALL
              SELECT idreserva FROM userede_link_history)`,
        ));
    } catch (err) {
        console.warn('[COBRANCA_ATO] facetas de etapa CV indisponíveis:', err.message);
    }

    return { empreendimentos: emps, formas, status, pagamentos, cvSituacoes, cvRepasses };
}

export default { listar, estatisticas, facetas, FORMAS };
