// services/sienge/extratoClienteService.js
//
// Extrato do cliente (/financeiro/extrato-cliente, Financeiro > Contas a Receber).
//
// Três fontes, cada uma com um papel:
//   - LISTA, parte 1: a tabela `contracts` do Office (contratos de venda do
//     Sienge, sincronizados de hora em hora).
//   - LISTA, parte 2: o backup diário do Sienge (`ecrctitulo`), para os títulos
//     a receber ligados a uma UNIDADE que não são contrato de venda no Office:
//     adiantamento (AVC) de quem pagou o ato antes de o contrato sair, taxas
//     (TX), IPTU, contrato antigo que a API de contratos não traz... Sem isso o
//     cliente que só tem AVC não aparecia (caso Wagna, título 33721, 15/10/2026).
//     Título sem unidade (mútuo entre empresas, aluguel, nota de serviço) fica de
//     fora: não é de cliente de empreendimento.
//   - EXTRATO: a API do Sienge AO VIVO, `/v1/customer-financial-statements`
//     (o mesmo "Extrato Cliente" do ERP), e o `/pdf` dela para o relatório
//     oficial. Nada é recalculado: parcela, saldo e baixa vêm como o Sienge
//     devolve; aqui só se soma para o resumo do topo.
//
// Alçada: por centro de custo, via accessScopeService (o sub-CC 33058 herda do
// base 33001, a mesma regra do Custos), aplicada nas duas listas antes de sair
// do banco. O título pedido é conferido contra a alçada ANTES de ir ao Sienge -
// o id do título vem do navegador e não vale como prova de nada.
import axios from 'axios';
import db from '../../models/sequelize/index.js';
import apiSienge from '../../lib/apiSienge.js';
import { siengeQuery } from '../../lib/siengeReadDb.js';
import { getScope, isErpAllowed } from '../permissions/accessScopeService.js';

const { sequelize, Sequelize } = db;
const Q = { type: Sequelize.QueryTypes.SELECT };

// Sem empreendimento nem busca, a lista só sai inteira até este tamanho. Acima
// disso a tela pede um filtro (admin sem filtro seriam ~19 mil títulos).
const LIMITE_SEM_FILTRO = 2000;

// Baixas que são DINHEIRO entrando. Reparcelamento, distrato, cancelamento,
// promoção e abatimento de adiantamento também baixam a parcela, mas não são
// pagamento do cliente - somá-los inflava o recebido (medido no Recurso
// Próprio: o Soul aparecia com 3x o que entrou).
const BAIXA_DINHEIRO = new Set(['recebimento', 'adiantamento']);

function erro(status, mensagem) {
    const e = new Error(mensagem);
    e.status = status;
    return e;
}

const soDigitos = (v) => String(v ?? '').replace(/\D/g, '');
const num = (v) => (v == null || v === '' ? 0 : Number(v) || 0);
const centavos = (v) => Math.round(v * 100) / 100;
const hojeIso = () => new Date().toISOString().slice(0, 10);
const dia = (v) => {
    if (!v) return null;
    if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString().slice(0, 10);
    return String(v).slice(0, 10);
};

function parseIds(raw) {
    const lista = Array.isArray(raw) ? raw : String(raw ?? '').split(',');
    return [...new Set(lista.map((s) => Number(String(s).trim())).filter((n) => Number.isInteger(n) && n > 0))];
}

/**
 * Cláusula de alçada sobre `c.enterprise_id`. O sub-centro de custo herda do
 * base (floor(cc/100)*100+1), igual ao isErpAllowed. Admin: sem cláusula.
 * Escopo vazio devolve null = nada a mostrar (fail-closed).
 */
function clausulaEscopo(scope, replacements) {
    if (scope.all) return '';
    if (!scope.erpIds.length) return null;
    replacements.erpIds = scope.erpIds;
    return ' AND (c.enterprise_id IN (:erpIds) OR (c.enterprise_id / 100) * 100 + 1 IN (:erpIds))';
}

// Mensagem de quem lê, não do HTTP. 403 do Sienge aqui quer dizer que o
// usuário de API perdeu o recurso do extrato no cadastro do ERP.
function erroSienge(e, oQue) {
    const status = e.response?.status;
    console.error(`[extrato-cliente] Sienge ${oQue} ${status ?? 'sem status'}: ${e.message}`);
    if (status === 403) return erro(502, 'O Sienge recusou a consulta: o usuário de API não tem permissão para o extrato do cliente.');
    if (status === 429) return erro(503, 'O Sienge limitou as consultas por alguns segundos. Tente de novo.');
    return erro(502, 'O Sienge não respondeu ao pedido do extrato. Tente de novo em instantes.');
}

// ── Títulos do backup (fora da tabela de contratos) ──────────────────────────

/** Títulos que já são contrato no Office: o backup não os repete. */
async function titulosDeContrato() {
    const rows = await sequelize.query(
        'SELECT DISTINCT receivable_bill_id AS b FROM contracts WHERE receivable_bill_id IS NOT NULL', Q);
    return rows.map((r) => Number(r.b));
}

// Título do backup com a unidade principal, o empreendimento (CC) dela, a
// empresa e o cliente. `$1` = títulos de contrato a excluir.
const SQL_TITULOS = `
    SELECT t.nutitulo, TRIM(t.cddocumento) AS documento, TRIM(t.nudocumento) AS nudocumento,
           t.dtemissao, t.dtdistrato, t.vltotal, t.pemultamora, t.pejuromora,
           t.cdcliente, c.nmcliente,
           emp.cdempresaview, emp.nmempresa,
           e.cdempreendview, e.nmempreend,
           u.nuunidade
      FROM ecrctitulo t
      JOIN LATERAL (
            SELECT un.cdempreend, un.nuunidade FROM ecrcunidade un
             WHERE un.nutitulo = t.nutitulo
             ORDER BY (un.flprincipal = 'S') DESC, un.nuunidade
             LIMIT 1) u ON true
      JOIN ecadempreend e   ON e.cdempreend = u.cdempreend
      JOIN ecadempresa  emp ON emp.cdempresa = t.cdempresa
      LEFT JOIN ecadcliente c ON c.cdcliente = t.cdcliente
     WHERE NOT (t.nutitulo = ANY($1::int[]))`;

/** Mesma regra do clausulaEscopo, em parâmetro posicional para o backup. */
function escopoBackup(scope, add) {
    if (scope.all) return '';
    const p = add(scope.erpIds);
    return ` AND (e.cdempreendview = ANY(${p}::int[]) OR (e.cdempreendview / 100) * 100 + 1 = ANY(${p}::int[]))`;
}

function linhaTitulo(r) {
    const cliente = { id: Number(r.cdcliente), nome: r.nmcliente || '', principal: true, conjuge: false };
    const unidade = r.nuunidade ? { id: null, nome: String(r.nuunidade).trim(), principal: true } : null;
    return {
        chave: `t-${r.nutitulo}`,
        id: null,
        titulo: Number(r.nutitulo),
        contrato: null,
        documento: [r.documento, r.nudocumento].filter(Boolean).join('.'),
        tipoDocumento: r.documento,
        avulso: true,
        situacao: r.dtdistrato ? 'Cancelado' : 'Emitido',
        data: dia(r.dtemissao),
        cancelamento: dia(r.dtdistrato),
        valor: num(r.vltotal),
        empreendimento: { id: Number(r.cdempreendview), nome: r.nmempreend },
        empresa: { id: Number(r.cdempresaview), nome: r.nmempresa },
        clienteId: cliente.id,
        cliente: cliente.nome,
        clientes: [cliente],
        unidade: unidade?.nome || '',
        unidades: unidade ? [unidade] : [],
    };
}

// ── Empreendimentos ──────────────────────────────────────────────────────────

/** Empreendimentos (centros de custo) com título que a pessoa pode consultar. */
async function listarEmpreendimentos(user) {
    const scope = await getScope(user);
    const replacements = {};
    const escopo = clausulaEscopo(scope, replacements);
    if (escopo === null) return [];

    const [contratos, excluir] = await Promise.all([
        sequelize.query(
            `SELECT c.enterprise_id AS id,
                    (ARRAY_AGG(c.enterprise_name ORDER BY c.id DESC))[1] AS nome,
                    COUNT(*)::int AS n
               FROM contracts c
              WHERE c.receivable_bill_id IS NOT NULL ${escopo}
              GROUP BY c.enterprise_id`,
            { replacements, ...Q }
        ),
        titulosDeContrato(),
    ]);

    const params = [excluir];
    const add = (v) => { params.push(v); return `$${params.length}`; };
    let avulsos = [];
    try {
        ({ rows: avulsos } = await siengeQuery(
            `SELECT x.cdempreendview AS id, MAX(x.nmempreend) AS nome, COUNT(*)::int AS n
               FROM (${SQL_TITULOS}${escopoBackup(scope, add)}) x
              GROUP BY x.cdempreendview`, params));
    } catch (e) {
        // Backup fora do ar não pode esconder os contratos: segue só com eles.
        console.error('[extrato-cliente] backup (empreendimentos):', e.message);
    }

    const porId = new Map();
    for (const r of [...contratos, ...avulsos]) {
        const id = Number(r.id);
        const atual = porId.get(id) || { id, nome: r.nome, contratos: 0 };
        atual.contratos += Number(r.n) || 0;
        if (!atual.nome) atual.nome = r.nome;
        porId.set(id, atual);
    }
    return [...porId.values()].sort((a, b) => a.id - b.id);
}

// ── Lista ────────────────────────────────────────────────────────────────────

/** CPF/CNPJ digitado na busca vira código de cliente pelo cadastro do Sienge. */
async function clientesPorDocumento(doc) {
    const params = doc.length === 14 ? { cnpj: doc } : { cpf: doc };
    const { data } = await apiSienge.get('/v1/customers', { params });
    return (data?.results || []).map((c) => Number(c.id)).filter((n) => Number.isInteger(n));
}

function linhaContrato(r) {
    const clientes = (Array.isArray(r.customers) ? r.customers : []).map((c) => ({
        id: Number(c.id),
        nome: c.name || '',
        principal: !!c.main,
        conjuge: !!c.spouse,
    }));
    const principal = clientes.find((c) => c.principal) || clientes[0] || null;
    const unidades = (Array.isArray(r.units) ? r.units : []).map((u) => ({ id: Number(u.id), nome: u.name || '', principal: !!u.main }));
    const unidade = unidades.find((u) => u.principal) || unidades[0] || null;
    return {
        chave: `c-${r.id}`,
        id: Number(r.id),
        titulo: Number(r.receivable_bill_id),
        contrato: r.number,
        documento: `CT.${r.number}`,
        tipoDocumento: 'CT',
        avulso: false,
        situacao: r.situation,
        data: r.contract_date,
        cancelamento: r.cancellation_date,
        valor: num(r.value),
        empreendimento: { id: Number(r.enterprise_id), nome: r.enterprise_name },
        empresa: { id: Number(r.company_id), nome: r.company_name },
        clienteId: principal?.id ?? null,
        cliente: principal?.nome || '',
        clientes,
        unidade: unidade?.nome || '',
        unidades,
    };
}

/**
 * Títulos consultáveis: contratos do Office + títulos com unidade do backup.
 * Filtros: empreendimentos (ids de CC) e busca (nome, contrato, título,
 * documento, unidade; CPF/CNPJ vai ao Sienge).
 */
async function listarContratos(user, filtros = {}) {
    const scope = await getScope(user);
    const replacements = {};
    const escopo = clausulaEscopo(scope, replacements);
    const vazio = { contratos: [], total: 0, precisaFiltro: false, aviso: null };
    if (escopo === null) return vazio;

    const empreendimentos = parseIds(filtros.empreendimento);
    const busca = String(filtros.q || '').trim();

    // Filtros nas duas fontes: `where` (Office, nomeado) e `extra` (backup, posicional).
    let where = `c.receivable_bill_id IS NOT NULL ${escopo}`;
    const params = [null]; // $1 = títulos de contrato a excluir, preenchido abaixo
    const add = (v) => { params.push(v); return `$${params.length}`; };
    let extra = escopoBackup(scope, add);

    if (empreendimentos.length) {
        replacements.emps = empreendimentos;
        where += ' AND c.enterprise_id IN (:emps)';
        extra += ` AND e.cdempreendview = ANY(${add(empreendimentos)}::int[])`;
    }

    let aviso = null;
    if (busca) {
        const doc = soDigitos(busca);
        const ehDocumento = (doc.length === 11 || doc.length === 14) && doc.length >= busca.replace(/[\s.\-/]/g, '').length;
        if (ehDocumento) {
            let ids = [];
            try {
                ids = await clientesPorDocumento(doc);
            } catch (e) {
                console.error(`[extrato-cliente] busca por documento: ${e.response?.status ?? ''} ${e.message}`);
                aviso = 'Não deu para procurar o CPF/CNPJ no Sienge agora. Busque pelo nome do cliente.';
            }
            if (!ids.length) return { ...vazio, aviso: aviso || 'Nenhum cliente com esse CPF/CNPJ no Sienge.' };
            replacements.clienteIds = ids.map(String);
            where += ` AND EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(c.customers, '[]'::jsonb)) x
                                    WHERE x->>'id' IN (:clienteIds))`;
            extra += ` AND t.cdcliente = ANY(${add(ids)}::int[])`;
        } else {
            replacements.q = `%${busca}%`;
            where += ` AND (
                unaccent(upper(c.number)) LIKE unaccent(upper(:q))
                OR c.receivable_bill_id::text LIKE :q
                OR EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(c.customers, '[]'::jsonb)) x
                            WHERE unaccent(upper(COALESCE(x->>'name', ''))) LIKE unaccent(upper(:q)))
                OR EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(c.units, '[]'::jsonb)) u
                            WHERE unaccent(upper(COALESCE(u->>'name', ''))) LIKE unaccent(upper(:q))))`;
            const q = add(`%${busca}%`);
            extra += ` AND (
                unaccent(upper(COALESCE(c.nmcliente, ''))) LIKE unaccent(upper(${q}))
                OR t.nutitulo::text LIKE ${q}
                OR upper(TRIM(t.cddocumento) || '.' || COALESCE(TRIM(t.nudocumento), '')) LIKE upper(${q})
                OR unaccent(upper(COALESCE(u.nuunidade, ''))) LIKE unaccent(upper(${q})))`;
        }
    }

    const semFiltro = !empreendimentos.length && !busca;
    const limite = semFiltro ? LIMITE_SEM_FILTRO + 1 : null;
    if (limite) replacements.limite = limite;

    const [contratos, excluir] = await Promise.all([
        sequelize.query(
            `SELECT c.id, c.receivable_bill_id, c.number, c.situation, c.contract_date, c.cancellation_date,
                    c.value, c.enterprise_id, c.enterprise_name, c.company_id, c.company_name,
                    c.customers, c.units
               FROM contracts c
              WHERE ${where}
              ORDER BY c.contract_date DESC NULLS LAST, c.id DESC
              ${limite ? 'LIMIT :limite' : ''}`,
            { replacements, ...Q }
        ),
        titulosDeContrato(),
    ]);
    if (limite && contratos.length >= limite) return { ...vazio, precisaFiltro: true };

    params[0] = excluir;
    let avulsos = [];
    try {
        ({ rows: avulsos } = await siengeQuery(
            `${SQL_TITULOS}${extra} ORDER BY t.dtemissao DESC NULLS LAST, t.nutitulo DESC${limite ? ` LIMIT ${limite}` : ''}`,
            params));
    } catch (e) {
        console.error('[extrato-cliente] backup (títulos):', e.message);
        aviso = aviso || 'Os títulos sem contrato (adiantamento, taxas) não carregaram agora. Os contratos estão completos.';
    }

    const linhas = [...contratos.map(linhaContrato), ...avulsos.map(linhaTitulo)];
    if (limite && linhas.length >= limite) return { ...vazio, precisaFiltro: true };
    return { contratos: linhas, total: linhas.length, precisaFiltro: false, aviso };
}

// ── Extrato ──────────────────────────────────────────────────────────────────

/**
 * O título pedido, já conferido contra a alçada: primeiro como contrato do
 * Office; se não for, como título com unidade do backup. Mais de uma linha de
 * contrato para o mesmo título acontece (contrato refeito): vale a emitida
 * mais recente.
 * @returns {{ linha, condicoes: Array, multa, juros }}
 */
async function tituloConferido(user, titulo) {
    const id = Number(titulo);
    if (!Number.isInteger(id) || id <= 0) throw erro(400, 'Informe o título.');

    const [r] = await sequelize.query(
        `SELECT c.id, c.receivable_bill_id, c.number, c.situation, c.contract_date, c.cancellation_date,
                c.value, c.enterprise_id, c.enterprise_name, c.company_id, c.company_name,
                c.customers, c.units, c.payment_conditions, c.fine_rate, c.interest_percentage
           FROM contracts c
          WHERE c.receivable_bill_id = :id
          ORDER BY (c.situation = 'Emitido') DESC, c.id DESC
          LIMIT 1`,
        { replacements: { id }, ...Q }
    );

    let achado;
    if (r) {
        achado = {
            linha: linhaContrato(r),
            condicoes: Array.isArray(r.payment_conditions) ? r.payment_conditions : [],
            multa: num(r.fine_rate),
            juros: num(r.interest_percentage),
        };
    } else {
        const { rows } = await siengeQuery(`${SQL_TITULOS} AND t.nutitulo = $2`, [[], id]);
        if (!rows[0]) throw erro(404, 'Título não encontrado entre os contratos do Office nem no backup do Sienge.');
        achado = {
            linha: linhaTitulo(rows[0]),
            condicoes: await condicoesConhecidas(),
            multa: num(rows[0].pemultamora),
            juros: num(rows[0].pejuromora),
        };
    }

    const scope = await getScope(user);
    if (!isErpAllowed(scope, achado.linha.empreendimento.id)) {
        throw erro(403, 'Este título é de um empreendimento fora da sua alçada.');
    }
    return achado;
}

// Nome das condições (PM = Parcelas Mensais...) para título sem contrato no
// Office: o mesmo dicionário que os contratos usam, lido de todos eles.
let _condicoes = null;
async function condicoesConhecidas() {
    if (_condicoes && Date.now() - _condicoes.t < 60 * 60_000) return _condicoes.lista;
    const lista = await sequelize.query(
        `SELECT DISTINCT ON (pc->>'conditionTypeId') pc->>'conditionTypeId' AS "conditionTypeId", pc->>'conditionTypeName' AS "conditionTypeName"
           FROM contracts, jsonb_array_elements(COALESCE(payment_conditions, '[]'::jsonb)) pc
          WHERE pc->>'conditionTypeName' IS NOT NULL`, Q);
    _condicoes = { t: Date.now(), lista };
    return lista;
}

/** Cliente do extrato: o pedido, se for do título; senão o principal. */
function clienteDoTitulo(linha, clienteId) {
    const pedido = Number(clienteId);
    if (Number.isInteger(pedido) && linha.clientes.some((c) => c.id === pedido)) return pedido;
    return linha.clienteId;
}

function situacaoParcela(p, hoje) {
    const pago = p.baixas.some((b) => b.dinheiro);
    if (p.saldo > 0) {
        if (p.vencimento && p.vencimento < hoje) return { chave: 'vencida', rotulo: pago ? 'Vencida, paga em parte' : 'Vencida' };
        return { chave: 'aberta', rotulo: pago ? 'Paga em parte' : 'A vencer' };
    }
    if (pago) return { chave: 'paga', rotulo: 'Paga' };
    // Baixada sem dinheiro: diz por quê (reparcelada, distratada...).
    const tipo = p.baixas[p.baixas.length - 1]?.tipo;
    return { chave: 'baixada', rotulo: tipo ? `Baixa por ${tipo.toLowerCase()}` : 'Baixada' };
}

function montarExtrato({ linha, condicoes, multa, juros }, clienteId, bills, cadastro) {
    const hoje = hojeIso();
    const nomesCondicao = new Map(
        condicoes
            .map((pc) => [String(pc.conditionTypeId || '').trim(), String(pc.conditionTypeName || '').trim()])
            .filter(([k, v]) => k && v)
    );

    const parcelas = [];
    for (const bill of bills) {
        for (const i of bill.installments || []) {
            const cond = String(i.conditionType || '').trim();
            const baixas = (i.receipts || []).map((rc) => ({
                data: rc.receiptDate || null,
                calculo: rc.calculationDate || null,
                credito: rc.creditDate || null,
                tipo: rc.receiptType || '',
                valor: num(rc.receiptValue),
                juros: num(rc.interestValue),
                acrescimo: num(rc.additionalValue),
                desconto: num(rc.discountValue),
                taxa: num(rc.administrativeFee),
                seguro: num(rc.insuranceAmount),
                liquido: num(rc.netReceiptValue),
                conta: rc.accountNumber || '',
                dinheiro: BAIXA_DINHEIRO.has(String(rc.receiptType || '').trim().toLowerCase()),
            }));
            const p = {
                chave: `${bill.billReceivableId}-${i.installmentId}`,
                titulo: Number(bill.billReceivableId),
                id: Number(i.installmentId),
                numero: i.installmentNumber || String(i.installmentId),
                condicao: { id: cond, nome: nomesCondicao.get(cond) || cond },
                vencimento: i.dueDate || null,
                valorOriginal: num(i.originalValue),
                saldo: num(i.currentBalance),
                boleto: !!i.generatedBillet,
                baixas,
            };
            p.recebido = centavos(baixas.filter((b) => b.dinheiro).reduce((s, b) => s + b.liquido, 0));
            p.ultimaBaixa = baixas.reduce((m, b) => (b.data && (!m || b.data > m) ? b.data : m), null);
            p.situacao = situacaoParcela(p, hoje);
            parcelas.push(p);
        }
    }
    parcelas.sort((a, b) => String(a.vencimento || '').localeCompare(String(b.vencimento || '')) || a.id - b.id);

    const conta = (chave) => parcelas.filter((p) => p.situacao.chave === chave);
    const vencidas = conta('vencida');
    const aVencer = conta('aberta');
    const pagamentos = parcelas.flatMap((p) => p.baixas.filter((b) => b.dinheiro));
    const outrasBaixas = {};
    for (const b of parcelas.flatMap((p) => p.baixas.filter((x) => !x.dinheiro))) {
        outrasBaixas[b.tipo || 'Outra'] = centavos((outrasBaixas[b.tipo || 'Outra'] || 0) + b.liquido);
    }
    const proxima = aVencer[0] || null;

    const cliente = linha.clientes.find((c) => c.id === clienteId) || { id: clienteId, nome: linha.cliente };

    return {
        consultadoEm: new Date().toISOString(),
        cliente: { ...cliente, documento: cadastro?.documento || null },
        contrato: {
            numero: linha.contrato,
            documento: linha.documento,
            tipoDocumento: linha.tipoDocumento,
            avulso: linha.avulso,
            titulo: linha.titulo,
            situacao: linha.situacao,
            data: linha.data,
            cancelamento: linha.cancelamento,
            valor: linha.valor,
            multaPct: multa || num(bills[0]?.finePercent),
            jurosPct: juros || num(bills[0]?.interestPercent),
            subJudice: bills.some((b) => b.subJudice),
        },
        empreendimento: linha.empreendimento,
        empresa: linha.empresa,
        unidades: linha.unidades,
        clientes: linha.clientes,
        resumo: {
            parcelas: parcelas.length,
            pagas: conta('paga').length,
            aVencer: aVencer.length,
            vencidas: vencidas.length,
            baixadas: conta('baixada').length,
            recebido: centavos(pagamentos.reduce((s, b) => s + b.liquido, 0)),
            saldoAberto: centavos([...aVencer, ...vencidas].reduce((s, p) => s + p.saldo, 0)),
            saldoVencido: centavos(vencidas.reduce((s, p) => s + p.saldo, 0)),
            ultimoPagamento: pagamentos.reduce((m, b) => (b.data && (!m || b.data > m) ? b.data : m), null),
            proximoVencimento: proxima ? { data: proxima.vencimento, valor: proxima.saldo, numero: proxima.numero } : null,
            outrasBaixas,
        },
        parcelas,
    };
}

/** Extrato de um título, lido ao vivo do Sienge. */
async function getExtrato(user, titulo, clienteIdPedido) {
    const achado = await tituloConferido(user, titulo);
    const { linha } = achado;
    const clienteId = clienteDoTitulo(linha, clienteIdPedido);
    if (!clienteId) throw erro(422, 'O título não tem cliente no Sienge.');

    const [extrato, cadastro] = await Promise.all([
        apiSienge.get('/v1/customer-financial-statements', { params: { customerId: clienteId, billReceivableId: linha.titulo } })
            .then((r) => r.data)
            .catch((e) => { throw erroSienge(e, 'extrato'); }),
        // CPF/CNPJ só enfeita o cabeçalho: falhar aqui não derruba o extrato.
        apiSienge.get(`/v1/customers/${clienteId}`)
            .then(({ data }) => ({ documento: data?.cpf || data?.cnpj || null }))
            .catch(() => null),
    ]);

    const bills = (extrato?.results?.[0]?.billsReceivable || []).filter((b) => Number(b.billReceivableId) === linha.titulo);
    return montarExtrato(achado, clienteId, bills, cadastro);
}

/**
 * O PDF oficial do extrato (relatório "Extrato Cliente" do Sienge). O Sienge
 * devolve um link que expira em 5 minutos; o arquivo é baixado aqui e repassado,
 * para a tela poder mostrar e salvar sem expor nem depender desse link.
 */
async function getPdf(user, titulo, clienteIdPedido) {
    const { linha } = await tituloConferido(user, titulo);
    const clienteId = clienteDoTitulo(linha, clienteIdPedido);
    if (!clienteId) throw erro(422, 'O título não tem cliente no Sienge.');

    let url;
    try {
        const { data } = await apiSienge.get('/v1/customer-financial-statements/pdf', {
            params: { customerId: clienteId, billReceivableId: linha.titulo },
        });
        url = data?.results?.[0]?.urlReport;
    } catch (e) {
        throw erroSienge(e, 'pdf');
    }

    // O link volta do Sienge, mas é o servidor que vai buscá-lo: só aceita o
    // próprio Sienge, senão uma resposta adulterada viraria porta para a rede interna.
    let alvo;
    try { alvo = new URL(url); } catch { alvo = null; }
    if (!alvo || alvo.protocol !== 'https:' || !alvo.hostname.endsWith('.sienge.com.br')) {
        throw erro(502, 'O Sienge não devolveu o PDF do extrato.');
    }

    let arquivo;
    try {
        const r = await axios.get(alvo.toString(), { responseType: 'arraybuffer', timeout: 60000 });
        arquivo = Buffer.from(r.data);
    } catch (e) {
        throw erroSienge(e, 'download do pdf');
    }
    if (arquivo.subarray(0, 4).toString() !== '%PDF') throw erro(502, 'O Sienge não devolveu o PDF do extrato.');

    const slug = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
        .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
    const cliente = linha.clientes.find((c) => c.id === clienteId)?.nome || linha.cliente;
    return { arquivo, nome: `extrato-${slug(cliente) || clienteId}-titulo-${linha.titulo}.pdf` };
}

export default { listarEmpreendimentos, listarContratos, getExtrato, getPdf };
