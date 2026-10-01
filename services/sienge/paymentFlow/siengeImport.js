// services/sienge/paymentFlow/siengeImport.js
//
// "Importar do Sienge": traz para o Fluxo de Pagamento o que foi medido no
// Sienge por fora do Office (à mão, ou pelo robô fora da esteira), já na etapa
// em que está. SÓ LÊ o Sienge - nada é criado nem alterado lá.
//
// Sem pedir nada a quem clica, o critério é:
//   - medições do período (settings.import_window_days, padrão 120 dias)
//   - em obras do cadastro de empreendimentos do Office (é o que a tela lança)
//     que estejam no escopo de quem importa (accessScopeService)
//   - com documento de contrato de algum tipo de lançamento ativo
//     (ou a lista de settings.import_documents, se configurada)
//   - que o Office ainda não acompanha (doc/contrato/obra/medição)
//
// A etapa vem do Sienge:
//   medição não autorizada        -> "Medição aguardando autorização"
//   autorizada, sem título        -> "Medição autorizada, falta o título"
//   título sem forma de pagamento -> "Título sem boleto"
//   título aberto com pagamento   -> "Aguardando pagamento"
//   todas as parcelas pagas       -> "Pago"
// Os estágios escolhidos NÃO disparam robô sozinho: a medição importada não
// vira título automaticamente (faltaria a nota); só o título aberto passa a ser
// acompanhado até o pagamento, como os lançamentos da esteira.

import db from '../../../models/sequelize/index.js';
import apiSienge from '../../../lib/apiSienge.js';
import { getScope, isErpAllowed } from '../../permissions/accessScopeService.js';

const DEFAULT_WINDOW_DAYS = 120;
const PAGE = 200;

const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/\s+/g, ' ').trim();
const iso = d => d.toISOString().slice(0, 10);

// ── Settings (tabela garantida por ensurePaymentFlowRecipeSchema) ─────────────
export async function getImportSettings() {
    try {
        const [rows] = await db.sequelize.query('SELECT import_window_days, import_documents FROM payment_flow_settings WHERE id = 1');
        const r = rows[0] || {};
        const docs = Array.isArray(r.import_documents) ? r.import_documents : [];
        return {
            windowDays: Number(r.import_window_days) > 0 ? Number(r.import_window_days) : DEFAULT_WINDOW_DAYS,
            documents: docs.map(d => String(d).trim().toUpperCase()).filter(Boolean),
        };
    } catch {
        return { windowDays: DEFAULT_WINDOW_DAYS, documents: [] };
    }
}

export function validateImportSettings(body = {}) {
    const erros = [];
    const out = {};
    if (body.windowDays !== undefined) {
        const n = Number(body.windowDays);
        if (!Number.isInteger(n) || n < 1 || n > 730) erros.push('Período precisa ser um número de dias entre 1 e 730.');
        else out.windowDays = n;
    }
    if (body.documents !== undefined) {
        const list = (Array.isArray(body.documents) ? body.documents : String(body.documents || '').split(/[,;\s]+/))
            .map(d => String(d).trim().toUpperCase()).filter(Boolean);
        const ruins = list.filter(d => !/^[A-Z0-9]{1,10}$/.test(d));
        if (ruins.length) erros.push(`Documento inválido: ${ruins.join(', ')}.`);
        else out.documents = [...new Set(list)];
    }
    return { erros, values: out };
}

export async function saveImportSettings(values) {
    const atual = await getImportSettings();
    const windowDays = values.windowDays ?? atual.windowDays;
    const documents = values.documents ?? atual.documents;
    await db.sequelize.query(
        `INSERT INTO payment_flow_settings (id, import_window_days, import_documents, updated_at)
         VALUES (1, :w, CAST(:d AS JSONB), NOW())
         ON CONFLICT (id) DO UPDATE SET import_window_days = :w, import_documents = CAST(:d AS JSONB), updated_at = NOW()`,
        { replacements: { w: windowDays, d: JSON.stringify(documents) } },
    );
    return getImportSettings();
}

// ── Leitura do Sienge (com nova tentativa quando ele recusa por excesso) ─────
// A API pública limita requisições: sem isto, parte das consultas voltava com
// erro e o candidato saía sem fornecedor nem título - errado e calado.
async function sget(path, params, tentativas = 7) {
    for (let t = 1; ; t++) {
        try {
            const { data } = await apiSienge.get(path, { params });
            return data;
        } catch (err) {
            const st = err.response?.status;
            if (st === 404) return null;
            if (t >= tentativas || !(st === 429 || st >= 500 || !st)) throw err;
            await new Promise(r => setTimeout(r, 1500 * 2 ** Math.min(t - 1, 4)));
        }
    }
}

async function getAll(path, params) {
    const out = [];
    let offset = 0;
    for (;;) {
        const data = await sget(path, { ...params, limit: PAGE, offset });
        const r = data?.results || [];
        out.push(...r);
        offset += r.length;
        if (!r.length || offset >= (data?.resultSetMetadata?.count ?? 0)) break;
    }
    return out;
}

async function pool(items, n, fn) {
    const out = new Array(items.length);
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
        while (i < items.length) {
            const k = i++;
            out[k] = await fn(items[k], k).catch(err => ({ __err: err.message }));
        }
    }));
    return out;
}

// ── Tipo de lançamento pelo contrato ──────────────────────────────────────────
// Mesmo documento + item do contrato que começa pelo item do tipo (ou mesmo
// código de serviço). Empate fica com o primeiro e a prévia mostra as opções.
function inferType(types, documentId, items) {
    const doc = String(documentId || '').toUpperCase();
    const doDoc = types.filter(t => String(t.documento || '').toUpperCase() === doc);
    if (!doDoc.length) return { name: null, alternativas: [] };
    const descs = (items || []).map(i => norm(i.description).replace(/^\d+\s*-\s*/, ''));
    const codes = (items || []).map(i => String(i.workItemId || ''));
    const casam = doDoc.filter(t => {
        const nome = norm(t.budgetItem);
        const code = String(t.budgetItemCode || '');
        return (nome && descs.some(d => d.startsWith(nome) || nome.startsWith(d)))
            || (code && codes.includes(code));
    });
    const lista = casam.length ? casam : (doDoc.length === 1 ? doDoc : []);
    return { name: lista[0]?.name || null, alternativas: lista.slice(1).map(t => t.name), porItem: casam.length > 0 };
}

const ETAPAS = {
    // Pendente: o Office acompanha a autorização e, autorizada, pede a nota.
    medicao_pendente: { label: 'Medição aguardando autorização', status: 'medicao', stage: 'awaiting_measurement_authorization' },
    // Autorizada sem título: o cartão oferece 'Anexar nota fiscal', que gera o título.
    medicao_autorizada: { label: 'Medição autorizada, falta o título', status: 'medicao', stage: 'awaiting_document' },
    titulo_sem_boleto: { label: 'Título lançado, sem forma de pagamento', status: 'titulo', stage: 'titulo_created' },
    titulo_aberto: { label: 'Título lançado, aguardando pagamento', status: 'titulo', stage: 'awaiting_titulo_authorization' },
    pago: { label: 'Pago', status: 'titulo_pago', stage: 'titulo_pago' },
};

const keyOf = (doc, num, building, med) => `${String(doc).toUpperCase()}|${num}|${building}|${med}`;


/**
 * Descobre o que dá para importar. Não grava nada.
 * Ordem pensada para gastar pouca consulta no Sienge (que limita requisições):
 *   1. medições do período, filtradas por obra comercial do escopo e documento
 *   2. tira o que o Office já acompanha
 *   3. credores (nome/CNPJ) e títulos SÓ de quem tem medição liberada -
 *      medição não liberada não tem título, não precisa procurar
 *   4. etapa; pago sai (não é pendência)
 *   5. itens do contrato (para o tipo) SÓ do que vai entrar
 * @param {function} [progresso] - recebe { etapa, feito, total }
 */
export async function previewSiengeImport(user, progresso = () => {}) {
    const settings = await getImportSettings();
    const avisos = [];
    let falhas = 0;
    const hoje = new Date();
    const inicio = new Date(hoje.getTime() - settings.windowDays * 86400000);

    const types = (await db.LaunchTypeConfig.findAll({ where: { active: true }, order: [['name', 'ASC']] })).map(t => t.toJSON());
    const docs = settings.documents.length
        ? settings.documents
        : [...new Set(types.map(t => String(t.documento || '').toUpperCase()).filter(Boolean))];

    // Obras: empreendimentos do cadastro do Office PAREADOS com o CV - são os
    // centros de custo comerciais, os mesmos que a tela lança. Os centros de
    // custo de obra (engenharia) só existem no Sienge e ficam de fora.
    const scope = await getScope(user);
    const [ents] = await db.sequelize.query(
        `SELECT erp_cost_center_id AS erp, company_id AS company, name
           FROM enterprises
          WHERE active = true AND erp_cost_center_id IS NOT NULL AND cv_id IS NOT NULL`,
    );
    const obras = new Map();
    for (const e of ents) {
        const erp = Number(e.erp);
        if (erp && isErpAllowed(scope, erp)) obras.set(erp, { name: e.name, companyId: e.company ? Number(e.company) : null });
    }
    if (!obras.size) avisos.push('Nenhum empreendimento comercial do cadastro está no seu acesso.');

    // 1. Medições do período
    progresso({ etapa: 'Lendo as medições do período no Sienge' });
    const todas = await getAll('/v1/supply-contracts/measurements/all', {
        measurementStartDate: iso(inicio), measurementEndDate: iso(hoje),
    });
    const doFluxo = todas.filter(m => obras.has(Number(m.buildingId)) && docs.includes(String(m.documentId).toUpperCase()));

    // 2. O que o Office já acompanha
    const [ja] = await db.sequelize.query(
        `SELECT sienge_document_id d, sienge_contract_number c, enterprise_id b, sienge_measurement_number m
           FROM payment_launches WHERE sienge_measurement_number IS NOT NULL`,
    );
    const acompanhadas = new Set(ja.map(r => keyOf(r.d, r.c, r.b, r.m)));
    const novas = doFluxo.filter(m => !acompanhadas.has(keyOf(m.documentId, m.contractNumber, m.buildingId, m.measurementNumber)));

    // 3. Credores e títulos
    const credorIds = [...new Set(novas.map(m => Number(m.contractSupplierId)).filter(Boolean))];
    const comLiberada = new Set(novas.filter(m => m.released).map(m => Number(m.contractSupplierId)));
    const credores = new Map();
    const titulosPorCredor = new Map();
    const desde = new Date(inicio.getTime() - 365 * 86400000); // a nota pode ser bem anterior à medição
    let feito = 0;
    await pool(credorIds, 2, async (id) => {
        const cr = await sget(`/v1/creditors/${id}`, {}).catch(() => { falhas++; return null; });
        if (cr) credores.set(id, cr);
        if (comLiberada.has(id)) {
            const bills = await getAll('/v1/bills', {
                creditorId: id, startDate: iso(desde), endDate: iso(new Date(hoje.getTime() + 365 * 86400000)),
            }).catch(() => { falhas++; return null; });
            titulosPorCredor.set(id, bills ? bills.filter(b => b.originId === 'ME' && b.contractNumber && b.measurementNumber) : null);
        }
        progresso({ etapa: 'Lendo fornecedores e títulos', feito: ++feito, total: credorIds.length });
    });

    // 4. Etapa de cada medição
    const candidatos = [];
    let incompletos = 0;
    let pagos = 0;
    const comTitulo = [];
    for (const m of novas) {
        const credorId = Number(m.contractSupplierId);
        const credor = credores.get(credorId);
        const titulos = titulosPorCredor.get(credorId);
        if (!credor || (m.released && !titulos)) { incompletos++; continue; } // não importa no escuro
        const titulo = m.released
            ? titulos.find(b => String(b.contractNumber) === String(m.contractNumber) && Number(b.measurementNumber) === Number(m.measurementNumber))
            : null;
        const obra = obras.get(Number(m.buildingId)) || {};
        const c = {
            key: keyOf(m.documentId, m.contractNumber, m.buildingId, m.measurementNumber),
            contrato: `${m.documentId}/${m.contractNumber}`,
            documentId: m.documentId, contractNumber: String(m.contractNumber),
            buildingId: Number(m.buildingId), measurementNumber: Number(m.measurementNumber),
            obra: obra.name || String(m.buildingId), companyId: obra.companyId || null,
            fornecedor: credor.name, fornecedorDoc: credor.cnpj || credor.cpf || null, creditorId: credorId,
            medicaoData: m.measurementDate, medicaoVenc: m.dueDate,
            valor: Number(m.totalLaborValue || 0) + Number(m.totalMaterialValue || 0),
            valorLiquido: Number(m.netValue ?? 0),
            autorizada: m.authorized === true, aprovacao: m.statusApproval || null, liberada: m.released === true,
            titulo: titulo ? {
                id: titulo.id, documento: String(titulo.documentIdentificationId || '').trim(),
                numero: titulo.documentNumber, emissao: titulo.issueDate, status: titulo.status,
            } : null,
        };
        candidatos.push(c);
        if (titulo) comTitulo.push(c);
    }

    feito = 0;
    await pool(comTitulo, 2, async (c) => {
        const ps = await getAll(`/v1/bills/${c.titulo.id}/installments`, {}).catch(() => { falhas++; return null; });
        c.titulo.parcelas = ps ? ps.map(p => ({ venc: p.dueDate, valor: p.amount, situacao: p.situation, forma: p.paymentType || null })) : null;
        progresso({ etapa: 'Lendo as parcelas dos títulos', feito: ++feito, total: comTitulo.length });
    });

    const finais = [];
    for (const c of candidatos) {
        let etapa;
        if (c.titulo) {
            const ps = c.titulo.parcelas;
            if (!ps) { incompletos++; continue; }
            if (ps.length && ps.every(p => p.situacao === 'Totalmente paga')) { pagos++; continue; }
            etapa = ps.some(p => !p.forma) ? 'titulo_sem_boleto' : 'titulo_aberto';
            c.vencimento = (ps.find(p => p.situacao !== 'Totalmente paga') || ps[0])?.venc || null;
        } else {
            etapa = c.autorizada ? 'medicao_autorizada' : 'medicao_pendente';
            c.vencimento = c.medicaoVenc || null;
            if (c.liberada) c.observacao = 'O Sienge diz que a medição está liberada, mas o título não foi achado para este fornecedor.';
        }
        c.etapa = etapa;
        c.etapaLabel = ETAPAS[etapa].label;
        finais.push(c);
    }

    // 5. Contrato e itens (tipo, empresa, vigência) só do que vai entrar
    const contratosKeys = [...new Set(finais.map(c => `${c.documentId}|${c.contractNumber}|${c.buildingId}`))];
    const contratos = new Map();
    feito = 0;
    await pool(contratosKeys, 2, async (k) => {
        const [doc, num, building] = k.split('|');
        const ct = await sget('/v1/supply-contracts', { documentId: doc, contractNumber: num }).catch(() => { falhas++; return null; });
        const it = await sget('/v1/supply-contracts/items', {
            documentId: doc, contractNumber: num, buildingId: Number(building), buildingUnitId: 1, limit: 200,
        }).catch(() => { falhas++; return null; });
        contratos.set(k, { ct, items: (it?.results || []).filter(i => i.workItemId || i.laborPrice) });
        progresso({ etapa: 'Lendo os contratos', feito: ++feito, total: contratosKeys.length });
    });
    for (const c of finais) {
        const { ct, items } = contratos.get(`${c.documentId}|${c.contractNumber}|${c.buildingId}`) || {};
        const tipo = inferType(types, c.documentId, items);
        c.tipo = tipo.name;
        c.tipoAlternativas = tipo.alternativas;
        c.companyId = ct?.companyId || c.companyId;
        c.companyName = ct?.companyName || null;
        c.contratoInicio = ct?.startDate || null;
        c.contratoFim = ct?.endDate || null;
        c.contratoAprov = ct?.statusApproval || null;
        c.contratoAutorizado = ct?.isAuthorized === true;
        if (!c.tipo) c.observacao = [c.observacao, 'Tipo de lançamento não identificado pelo item do contrato.'].filter(Boolean).join(' ');
    }

    finais.sort((a, b) => String(b.medicaoData).localeCompare(String(a.medicaoData)));
    const resumo = {};
    for (const c of finais) resumo[c.etapa] = (resumo[c.etapa] || 0) + 1;
    if (falhas) avisos.push(`${falhas} consulta(s) ao Sienge falharam mesmo tentando de novo.`);
    if (incompletos) avisos.push(`${incompletos} medição(ões) ficaram de fora por leitura incompleta no Sienge; rode de novo mais tarde.`);

    return {
        settings: { ...settings, documentsEfetivos: docs },
        periodo: { de: iso(inicio), ate: iso(hoje) },
        analisadas: doFluxo.length,
        jaAcompanhadas: doFluxo.length - novas.length,
        pagosIgnorados: pagos,
        candidatos: finais, resumo, avisos,
        etapas: Object.fromEntries(Object.entries(ETAPAS).map(([k, v]) => [k, v.label])),
    };
}

// ── Busca em segundo plano (uma por pessoa) ───────────────────────────────────
// A leitura pode levar minutos (o Sienge limita requisições). A tela dispara,
// acompanha o progresso e mostra o resultado; o "Importar" usa este resultado.
const jobs = new Map(); // userId -> { status, startedAt, finishedAt, progresso, result, error }
const VALIDADE_MS = 30 * 60 * 1000;

export function startImportScan(user) {
    const atual = jobs.get(user.id);
    if (atual?.status === 'running') return atual;
    const job = { status: 'running', startedAt: Date.now(), progresso: { etapa: 'Começando' }, result: null, error: null };
    jobs.set(user.id, job);
    previewSiengeImport(user, (p) => { job.progresso = p; })
        .then((r) => { job.status = 'done'; job.result = r; job.finishedAt = Date.now(); })
        .catch((err) => { job.status = 'error'; job.error = err.message; job.finishedAt = Date.now(); });
    return job;
}

export function getImportScan(user) {
    const job = jobs.get(user.id);
    if (!job) return { status: 'idle' };
    const vencido = job.status === 'done' && Date.now() - job.finishedAt > VALIDADE_MS;
    return {
        status: vencido ? 'expired' : job.status,
        startedAt: job.startedAt, finishedAt: job.finishedAt || null,
        progresso: job.progresso, error: job.error, result: vencido ? null : job.result,
    };
}

/**
 * Importa a partir do resultado da última busca (o cliente só escolhe as
 * chaves, nunca manda dados). Busca vencida ou inexistente: pede para buscar.
 * @param {string[]|null} keys - null = todos os candidatos
 */
export async function applySiengeImport(user, keys = null) {
    const scan = getImportScan(user);
    if (scan.status !== 'done' || !scan.result) {
        const e = new Error('Faça a busca no Sienge de novo antes de importar (a anterior não existe ou passou de 30 minutos).');
        e.status = 409;
        throw e;
    }
    const wanted = keys ? new Set(keys) : null;
    const escolhidos = scan.result.candidatos.filter(c => !wanted || wanted.has(c.key));

    // Alguém pode ter importado no meio do caminho: confere de novo no banco.
    const [ja] = await db.sequelize.query(
        `SELECT sienge_document_id d, sienge_contract_number c, enterprise_id b, sienge_measurement_number m
           FROM payment_launches WHERE sienge_measurement_number IS NOT NULL`,
    );
    const acompanhadas = new Set(ja.map(r => keyOf(r.d, r.c, r.b, r.m)));

    const hoje = new Date().toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    const types = new Map((await db.LaunchTypeConfig.findAll()).map(t => [t.name, t]));
    const criados = [];
    for (const c of escolhidos) {
        if (acompanhadas.has(c.key)) continue;
        const e = ETAPAS[c.etapa];
        const tipo = c.tipo ? types.get(c.tipo) : null;
        const semBoleto = c.etapa === 'titulo_sem_boleto';
        const launch = await db.PaymentLaunch.create({
            companyName: c.companyName || null, companyId: c.companyId || null,
            enterpriseName: c.obra, enterpriseId: c.buildingId,
            providerName: c.fornecedor, providerCnpj: c.fornecedorDoc ? String(c.fornecedorDoc).replace(/\D/g, '') : null,
            siengeCreditorId: c.creditorId, siengeCreditorName: c.fornecedor, siengeCreditorStatus: 'found',
            siengeDocumentId: c.documentId, siengeContractNumber: c.contractNumber,
            siengeContractStatus: 'found', siengeContractApproval: c.contratoAprov || null,
            siengeContractAuthorized: !!c.contratoAutorizado,
            contractStartDate: c.contratoInicio || null, contractEndDate: c.contratoFim || null,
            siengeMeasurementNumber: c.measurementNumber,
            siengeMeasurementAuthorized: c.autorizada, siengeMeasurementApproval: c.aprovacao,
            siengeTituloNumber: c.titulo?.id || null, siengeTituloStatus: c.titulo?.status || null,
            siengeTituloError: semBoleto ? 'Título sem forma de pagamento no Sienge: envie o boleto para registrar.' : null,
            nfType: c.titulo?.documento || null, nfNumber: c.titulo?.numero || null, nfIssueDate: c.titulo?.emissao || null,
            boletoDueDate: c.vencimento || null,
            launchType: c.tipo || 'Importado do Sienge',
            budgetItem: tipo?.budgetItem || null, budgetItemCode: tipo?.budgetItemCode || null,
            financialAccountNumber: tipo?.financialAccountNumber || null,
            unitPrice: c.valor,
            status: e.status, pipelineStage: e.stage,
            origin: 'sienge',
            notes: `Importado do Sienge em ${hoje} (${c.etapaLabel}).${c.observacao ? ` ${c.observacao}` : ''}`,
            createdBy: user.id, createdByName: user.username || user.name || 'Sistema',
        });
        acompanhadas.add(c.key);
        criados.push({ id: launch.id, key: c.key, contrato: c.contrato, medicao: c.measurementNumber, etapa: c.etapaLabel });
    }
    return { importados: criados.length, criados, ignorados: escolhidos.length - criados.length };
}