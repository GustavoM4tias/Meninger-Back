// services/sienge/paymentFlow/recipe.js
//
// Receita e regras de um tipo de lançamento do Fluxo de Pagamento.
//
// A esteira é feita de módulos (Fornecedor, Contrato, Medição, Título). A
// RECEITA diz quais módulos um tipo usa e como; as REGRAS dizem o que o portão
// recusa. As duas ficam em launch_type_configs (colunas `receita` e `regras`)
// e são editadas na tela - o que está aqui é só o FALLBACK de quando o tipo
// ainda não foi configurado, e a validação do que chega da tela.
//
// `contrato: 'auto'` é o comportamento de sempre (acha contrato -> aditivo;
// não acha -> cria). Tipo sem receita gravada cai nele, então os tipos que já
// existiam seguem exatamente como estavam.
//
// `contrato: 'nenhum'` = título direto pela API do Sienge, sem contrato nem
// medição (o RB de reembolso: credor PF, pago por PIX).

export const CONTRATO_MODOS = ['auto', 'existente', 'criar', 'nenhum'];
export const PAGAMENTO_MODOS = ['boleto', 'transferencia', 'pix'];
export const PAGAMENTO_LABEL = { boleto: 'boleto', transferencia: 'transferência', pix: 'PIX' };
export const CREDOR_TIPOS = ['qualquer', 'PJ', 'PF'];

export const DEFAULT_RECEITA = Object.freeze({
    contrato: 'auto',
    // Documentos de contrato aceitos na busca. Vazio = qualquer um.
    documentosContrato: [],
    titulo: Object.freeze({
        // Vazio = usa o tipo de documento informado no lançamento (ex.: NFS).
        documento: '',
        pagamento: 'boleto',
    }),
    // Medição antes da nota: o lançamento nasce sem NF, mede, e o título só
    // sai quando o documento for anexado.
    medicaoAntesDoDocumento: false,
});

export const DEFAULT_REGRAS = Object.freeze({
    credorTipo: 'qualquer',
    exigeContratoVigente: true,
    exigeContratoAutorizado: true,
    valorMaximo: null,
    bloquearNfDuplicada: true,
});

const DOC_RE = /^[A-Z0-9]{1,10}$/;

function asBool(v, fallback) {
    if (v === true || v === false) return v;
    if (v === 'true') return true;
    if (v === 'false') return false;
    return fallback;
}

function asDocList(v) {
    const list = Array.isArray(v) ? v : String(v || '').split(/[,;\s]+/);
    return [...new Set(list.map(s => String(s || '').trim().toUpperCase()).filter(Boolean))];
}

/**
 * Normaliza a receita vinda do banco/tela. Nunca lança: campo inválido volta
 * ao default. Use `validateReceita` para recusar entrada ruim na tela.
 */
export function normalizeReceita(raw, { documentoTipo = '' } = {}) {
    const configurada = !!(raw && typeof raw === 'object' && Object.keys(raw).length);
    const r = configurada ? raw : {};
    const contrato = CONTRATO_MODOS.includes(r.contrato) ? r.contrato : DEFAULT_RECEITA.contrato;
    let documentosContrato = asDocList(r.documentosContrato).filter(d => DOC_RE.test(d));
    // Contrato existente sem lista = só o documento do próprio tipo. Sem isso a
    // busca pegaria o "melhor" contrato do fornecedor, que pode ser o RB de
    // reembolso no lugar do CTPJ do salário.
    if (contrato === 'existente' && !documentosContrato.length && documentoTipo) {
        documentosContrato = [String(documentoTipo).toUpperCase()];
    }
    const t = r.titulo && typeof r.titulo === 'object' ? r.titulo : {};
    const docTitulo = String(t.documento || '').trim().toUpperCase();
    return {
        // false = tipo ainda sem receita gravada: roda como sempre rodou, e o
        // portão não passa a exigir o que antes não exigia (nota, boleto).
        configurada,
        contrato,
        documentosContrato,
        titulo: {
            documento: DOC_RE.test(docTitulo) ? docTitulo : '',
            pagamento: PAGAMENTO_MODOS.includes(t.pagamento) ? t.pagamento : DEFAULT_RECEITA.titulo.pagamento,
        },
        medicaoAntesDoDocumento: asBool(r.medicaoAntesDoDocumento, false),
    };
}

export function normalizeRegras(raw) {
    const r = raw && typeof raw === 'object' ? raw : {};
    const max = r.valorMaximo === '' || r.valorMaximo == null ? null : Number(r.valorMaximo);
    return {
        credorTipo: CREDOR_TIPOS.includes(r.credorTipo) ? r.credorTipo : DEFAULT_REGRAS.credorTipo,
        exigeContratoVigente: asBool(r.exigeContratoVigente, DEFAULT_REGRAS.exigeContratoVigente),
        exigeContratoAutorizado: asBool(r.exigeContratoAutorizado, DEFAULT_REGRAS.exigeContratoAutorizado),
        valorMaximo: Number.isFinite(max) && max > 0 ? Math.round(max * 100) / 100 : null,
        bloquearNfDuplicada: asBool(r.bloquearNfDuplicada, DEFAULT_REGRAS.bloquearNfDuplicada),
    };
}

/** Erros legíveis para a tela; lista vazia = pode gravar. */
export function validateReceita(raw) {
    const erros = [];
    if (raw == null) return erros;
    if (typeof raw !== 'object') return ['Receita inválida.'];
    if (raw.contrato != null && !CONTRATO_MODOS.includes(raw.contrato)) {
        erros.push(`Modo de contrato "${raw.contrato}" não existe (use: ${CONTRATO_MODOS.join(', ')}).`);
    }
    const docs = asDocList(raw.documentosContrato);
    const ruins = docs.filter(d => !DOC_RE.test(d));
    if (ruins.length) erros.push(`Documento de contrato inválido: ${ruins.join(', ')}.`);
    const pag = raw.titulo?.pagamento;
    if (pag != null && !PAGAMENTO_MODOS.includes(pag)) {
        erros.push(`Forma de pagamento "${pag}" não existe (use: ${PAGAMENTO_MODOS.join(', ')}).`);
    }
    const docT = String(raw.titulo?.documento || '').trim();
    if (docT && !DOC_RE.test(docT.toUpperCase())) erros.push(`Documento do título "${docT}" inválido.`);
    return erros;
}

export function validateRegras(raw) {
    const erros = [];
    if (raw == null) return erros;
    if (typeof raw !== 'object') return ['Regras inválidas.'];
    if (raw.credorTipo != null && !CREDOR_TIPOS.includes(raw.credorTipo)) {
        erros.push(`Tipo de credor "${raw.credorTipo}" não existe (use: ${CREDOR_TIPOS.join(', ')}).`);
    }
    if (raw.valorMaximo != null && raw.valorMaximo !== '') {
        const n = Number(raw.valorMaximo);
        if (!Number.isFinite(n) || n <= 0) erros.push('Valor máximo precisa ser um número maior que zero.');
    }
    return erros;
}

/** Receita + regras do tipo, já normalizadas (aceita a instância do model ou JSON). */
export function recipeOf(typeConfig) {
    const t = typeConfig?.toJSON ? typeConfig.toJSON() : (typeConfig || {});
    return {
        receita: normalizeReceita(t.receita, { documentoTipo: t.documento }),
        regras: normalizeRegras(t.regras),
    };
}

/**
 * Sequência de módulos que a receita executa - é o que a tela e a Eme mostram
 * como "vai acontecer". Cada item: { key, label }.
 */
export function stepsOf(receita) {
    const r = normalizeReceita(receita);
    const steps = [{ key: 'fornecedor', label: 'Fornecedor' }];
    if (r.contrato === 'existente') {
        const docs = r.documentosContrato.length ? ` (${r.documentosContrato.join('/')})` : '';
        steps.push({ key: 'contrato_existente', label: `Contrato existente${docs}` });
    } else if (r.contrato === 'criar') {
        steps.push({ key: 'contrato_criacao', label: 'Contrato - criação' });
    } else if (r.contrato === 'nenhum') {
        const doc = r.titulo.documento || 'documento do lançamento';
        steps.push({ key: 'titulo_direto', label: `Título ${doc} direto, sem contrato - ${PAGAMENTO_LABEL[r.titulo.pagamento]}` });
        return steps;
    } else {
        steps.push({ key: 'contrato_auto', label: 'Contrato - aditivo ou criação' });
    }
    steps.push({ key: 'medicao', label: 'Medição' });
    if (r.medicaoAntesDoDocumento) steps.push({ key: 'aguarda_documento', label: 'Aguarda documento' });
    const doc = r.titulo.documento || 'documento do lançamento';
    const pag = PAGAMENTO_LABEL[r.titulo.pagamento];
    steps.push({ key: 'titulo', label: `Título ${doc} - ${pag}` });
    return steps;
}
