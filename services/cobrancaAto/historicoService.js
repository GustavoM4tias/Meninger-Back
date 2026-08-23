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
        h.valor, h.valor_original,
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
        c.valor, c.valor_original,
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
};

function listaCsv(v) {
    if (v == null || v === '') return null;
    const arr = Array.isArray(v) ? v : String(v).split(',');
    const limpo = arr.map(x => String(x).trim()).filter(Boolean);
    return limpo.length ? limpo : null;
}

/**
 * Monta o WHERE comum, aplicado DEPOIS do UNION (sobre a view normalizada).
 * Filtrar depois evita escrever a mesma condição duas vezes com nomes
 * diferentes de coluna.
 */
function montarFiltros(f, nomesPermitidos) {
    const cond = [];
    const rep = {};

    // Recorte por empreendimento: mesmo contrato das outras telas. `null` = admin.
    // Lista vazia = nenhuma linha (fail-closed), nunca a base inteira.
    if (nomesPermitidos !== null) {
        cond.push('lower(coalesce(empreendimento, \'\')) IN (:escopo)');
        rep.escopo = nomesPermitidos.length ? nomesPermitidos : [''];
    }

    const formas = listaCsv(f.forma);
    if (formas) { cond.push('forma IN (:formas)'); rep.formas = formas; }

    const status = listaCsv(f.status);
    if (status) { cond.push('status IN (:status)'); rep.status = status; }

    const pgto = listaCsv(f.paymentStatus);
    if (pgto) { cond.push('payment_status IN (:pgto)'); rep.pgto = pgto; }

    const emps = listaCsv(f.empreendimento);
    if (emps) { cond.push('empreendimento IN (:emps)'); rep.emps = emps; }

    if (f.idreserva) { cond.push('idreserva = :idreserva'); rep.idreserva = Number(f.idreserva); }
    if (f.dateFrom) { cond.push('created_at >= :dateFrom'); rep.dateFrom = `${f.dateFrom} 00:00:00`; }
    if (f.dateTo) { cond.push('created_at <= :dateTo'); rep.dateTo = `${f.dateTo} 23:59:59`; }

    if (f.q) {
        cond.push(`(
            unaccent(lower(coalesce(titular_nome, ''))) LIKE unaccent(lower(:q))
            OR coalesce(documento, '') ILIKE :q
            OR CAST(idreserva AS text) LIKE :q
        )`);
        rep.q = `%${String(f.q).trim()}%`;
    }

    return { sql: cond.length ? `WHERE ${cond.join(' AND ')}` : '', replacements: rep };
}

/** Listagem paginada, já unificada e ordenada. */
export async function listar(user, filtros = {}) {
    const nomes = await allowedEnterpriseNames(user);
    const { sql: whereSql, replacements } = montarFiltros(filtros, nomes);

    const page = Math.max(1, Number(filtros.page) || 1);
    const limit = Math.min(200, Math.max(1, Number(filtros.limit) || 20));
    const coluna = ORDENAVEIS[filtros.sortBy] || 'created_at';
    const direcao = String(filtros.sortDir).toLowerCase() === 'asc' ? 'ASC' : 'DESC';

    const base = `FROM ( ${SELECT_BOLETO} UNION ALL ${SELECT_CARTAO} ) t ${whereSql}`;

    const [[{ total }]] = await db.sequelize.query(
        `SELECT count(*)::int AS total ${base}`,
        { replacements },
    );

    // Desempate por uid: sem ele, duas linhas com o mesmo created_at podem
    // trocar de lugar entre páginas e um registro some da listagem.
    const [rows] = await db.sequelize.query(
        `SELECT * ${base} ORDER BY ${coluna} ${direcao} NULLS LAST, uid DESC
         LIMIT :limit OFFSET :offset`,
        { replacements: { ...replacements, limit, offset: (page - 1) * limit } },
    );

    return { total, page, limit, rows };
}

/**
 * Agregados para os cartões do topo, com os MESMOS filtros da listagem.
 * Devolve por forma e no total, para a tela mostrar as duas cobranças juntas
 * sem perder de vista qual é qual.
 */
export async function estatisticas(user, filtros = {}) {
    const nomes = await allowedEnterpriseNames(user);
    const { sql: whereSql, replacements } = montarFiltros(filtros, nomes);
    const base = `FROM ( ${SELECT_BOLETO} UNION ALL ${SELECT_CARTAO} ) t ${whereSql}`;

    const [linhas] = await db.sequelize.query(
        `SELECT forma, status, payment_status, count(*)::int AS qty,
                coalesce(sum(valor), 0)::numeric AS total
           ${base}
       GROUP BY forma, status, payment_status`,
        { replacements },
    );

    const vazio = () => ({ qty: 0, valor: 0 });
    const acc = {
        total: vazio(),
        emitidos: vazio(), pagos: vazio(), pendentes: vazio(),
        cancelados: vazio(), expirados: vazio(), negados: vazio(),
        estornados: vazio(), erros: vazio(), agendados: vazio(), ignorados: vazio(),
        porForma: { boleto: vazio(), cartao: vazio() },
    };
    const soma = (alvo, qty, valor) => { alvo.qty += qty; alvo.valor += valor; };

    for (const l of linhas) {
        const qty = Number(l.qty);
        const valor = Number(l.total) || 0;
        soma(acc.total, qty, valor);
        soma(acc.porForma[l.forma] || (acc.porForma[l.forma] = vazio()), qty, valor);

        if (l.status === 'error') { soma(acc.erros, qty, valor); continue; }
        if (l.status === 'queued') { soma(acc.agendados, qty, valor); continue; }
        if (l.status === 'skipped') { soma(acc.ignorados, qty, valor); continue; }
        if (l.status !== 'success') continue;

        soma(acc.emitidos, qty, valor);
        const destino = {
            paid: acc.pagos,
            pending: acc.pendentes,
            cancelled: acc.cancelados,
            expired: acc.expirados,
            denied: acc.negados,
            refunded: acc.estornados,
        }[l.payment_status];
        if (destino) soma(destino, qty, valor);
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
    const { sql: whereSql, replacements } = montarFiltros({}, nomes);
    const base = `FROM ( ${SELECT_BOLETO} UNION ALL ${SELECT_CARTAO} ) t ${whereSql}`;

    const [emps] = await db.sequelize.query(
        `SELECT empreendimento AS name, count(*)::int AS qty ${base}
          ${whereSql ? 'AND' : 'WHERE'} empreendimento IS NOT NULL AND empreendimento <> ''
       GROUP BY empreendimento ORDER BY empreendimento ASC`,
        { replacements },
    );
    const [formas] = await db.sequelize.query(
        `SELECT forma, count(*)::int AS qty ${base} GROUP BY forma`, { replacements },
    );
    const [status] = await db.sequelize.query(
        `SELECT status, count(*)::int AS qty ${base} GROUP BY status`, { replacements },
    );
    const [pagamentos] = await db.sequelize.query(
        `SELECT payment_status, count(*)::int AS qty ${base} GROUP BY payment_status`, { replacements },
    );

    return { empreendimentos: emps, formas, status, pagamentos };
}

export default { listar, estatisticas, facetas, FORMAS };
