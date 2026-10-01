// services/sienge/paymentFlow/gate.js
//
// Portão de regras do Fluxo de Pagamento. Roda ANTES de cada módulo e recusa
// com o motivo escrito - é o mesmo portão para a tela e para a Eme, então o
// que a tela não deixaria passar a Eme também não passa.
//
// Funções puras (sem banco, sem Sienge): recebem o que já foi buscado e
// devolvem { ok, motivos[], avisos[] }. Quem chama decide o que fazer.

const onlyDigits = s => String(s || '').replace(/\D/g, '');

function result(motivos, avisos = []) {
    return { ok: motivos.length === 0, motivos, avisos };
}

function isoDay(v) {
    if (!v) return null;
    const s = String(v).slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

/** PJ = CNPJ (14 dígitos); PF = CPF (11). */
export function tipoDoDocumento(doc) {
    const d = onlyDigits(doc);
    if (d.length === 14) return 'PJ';
    if (d.length === 11) return 'PF';
    return null;
}

/**
 * Dados do lançamento antes de qualquer consulta ao Sienge.
 * @param {object} launch  - campos do lançamento (model ou rascunho)
 * @param {object} receita - normalizada (recipe.normalizeReceita)
 * @param {object} regras  - normalizadas (recipe.normalizeRegras)
 */
export function checkLaunchInput(launch, receita, regras) {
    const motivos = [];
    const avisos = [];
    const valor = Number(launch.unitPrice);

    if (!launch.launchType) motivos.push('Tipo de lançamento não informado.');
    if (!Number.isFinite(valor) || valor <= 0) motivos.push('Valor do lançamento não informado.');
    if (regras.valorMaximo && valor > regras.valorMaximo) {
        motivos.push(`Valor R$ ${valor.toFixed(2)} acima do máximo do tipo (R$ ${regras.valorMaximo.toFixed(2)}).`);
    }

    const tipoDoc = tipoDoDocumento(launch.providerCnpj);
    if (!tipoDoc) motivos.push('CNPJ/CPF do fornecedor ausente ou inválido.');
    else if (regras.credorTipo !== 'qualquer' && tipoDoc !== regras.credorTipo) {
        motivos.push(
            `O tipo "${launch.launchType}" só aceita fornecedor ${regras.credorTipo === 'PJ' ? 'pessoa jurídica (CNPJ)' : 'pessoa física (CPF)'}; o documento informado é ${tipoDoc === 'PJ' ? 'CNPJ' : 'CPF'}.`,
        );
    }

    if (!launch.enterpriseId && !launch.enterpriseName) motivos.push('Empreendimento não informado.');

    // Documento fiscal: obrigatório já na criação, a não ser que a receita meça antes.
    const docExigido = !receita.medicaoAntesDoDocumento;
    const docMotivos = checkDocument(launch, receita);
    if (docExigido) motivos.push(...docMotivos);
    else if (!launch.nfNumber) avisos.push('Sem documento fiscal: a medição roda e o título espera a nota ser anexada.');
    else motivos.push(...docMotivos);

    if (launch.nfIssueDate && launch.contractEndDate && isoDay(launch.nfIssueDate) > isoDay(launch.contractEndDate)) {
        avisos.push('Emissão da nota depois do término informado para o contrato.');
    }
    return result(motivos, avisos);
}

/**
 * Documento fiscal e pagamento - usado na criação e de novo ao anexar a nota
 * (medição antes do documento).
 */
export function checkDocument(launch, receita) {
    const motivos = [];
    const esperado = receita.titulo.documento;
    const informado = String(launch.nfType || '').trim().toUpperCase();
    if (esperado && informado && informado !== esperado) {
        motivos.push(`Este tipo lança título ${esperado}; o documento informado é ${informado}.`);
    }
    // Tipo sem receita configurada: só a checagem acima (que nem dispara, sem
    // documento esperado). Nota e boleto seguem opcionais como sempre foram.
    if (!receita.configurada) return motivos;

    // Título direto (RB): sem número, o módulo numera pela data (ddmmaaaa), como no Sienge.
    if (!launch.nfNumber && receita.contrato !== 'nenhum') motivos.push('Número do documento fiscal não informado.');
    const docEfetivo = esperado || informado;
    if (docEfetivo === 'NFE' && onlyDigits(launch.nfAccessKey).length !== 44) {
        motivos.push('NF-e precisa da chave de acesso com 44 dígitos.');
    }
    if (receita.titulo.pagamento === 'boleto') {
        if (!launch.boletoBarcode) motivos.push('Pagamento por boleto sem a linha digitável do boleto.');
        if (!launch.boletoDueDate) motivos.push('Pagamento por boleto sem a data de vencimento.');
    }
    return motivos;
}

/** Credor achado no Sienge x regras do tipo. */
export function checkCreditor(creditor, regras, launch) {
    const motivos = [];
    if (!creditor) return result(['Credor não encontrado no Sienge.']);
    if (creditor.active === false) motivos.push(`Credor ${creditor.name} está inativo no Sienge.`);
    const tipo = creditor.cnpj ? 'PJ' : creditor.cpf ? 'PF' : tipoDoDocumento(launch?.providerCnpj);
    if (regras.credorTipo !== 'qualquer' && tipo && tipo !== regras.credorTipo) {
        motivos.push(`Credor ${creditor.name} é ${tipo}; este tipo exige ${regras.credorTipo}.`);
    }
    return result(motivos);
}

/**
 * Escolhe, entre os contratos do fornecedor, o que a receita aceita, e diz por
 * que os outros ficaram de fora. Usado pelo módulo Contrato Existente.
 * @param {object[]} contracts - retorno de /supply-contracts/all já filtrado pelo fornecedor
 * @param {object}   opts      - { receita, regras, buildingId, today }
 * @returns {{ contract: object|null, motivos: string[], descartados: object[] }}
 */
export function pickExistingContract(contracts, { receita, regras, buildingId = null, today = null }) {
    const hoje = today || new Date().toISOString().slice(0, 10);
    const docs = receita.documentosContrato;
    const descartados = [];
    const aceitos = [];

    for (const c of contracts || []) {
        const label = `${c.documentId}/${c.contractNumber}`;
        const porque = [];
        if (docs.length && !docs.includes(String(c.documentId).toUpperCase())) porque.push(`documento ${c.documentId} fora de ${docs.join('/')}`);
        if (regras.exigeContratoAutorizado && !(c.isAuthorized && c.statusApproval === 'APPROVED')) porque.push('não está aprovado e autorizado');
        if (regras.exigeContratoVigente) {
            const ini = isoDay(c.startDate);
            const fim = isoDay(c.endDate);
            if ((ini && ini > hoje) || (fim && fim < hoje)) porque.push(`fora da vigência (${ini || '?'} a ${fim || '?'})`);
        }
        if (['COMPLETED', 'CANCELED', 'CANCELLED', 'RESCINDED'].includes(String(c.status || '').toUpperCase())) {
            porque.push(`situação ${c.status}`);
        }
        if (buildingId && Array.isArray(c.buildings) && c.buildings.length
            && !c.buildings.some(b => Number(b.buildingId) === Number(buildingId))) {
            porque.push(`não tem a obra ${buildingId}`);
        }
        if (porque.length) descartados.push({ contrato: label, motivo: porque.join('; ') });
        else aceitos.push(c);
    }

    if (!aceitos.length) {
        const motivos = [descartados.length
            ? 'Nenhum contrato do fornecedor atende a este tipo.'
            : 'O fornecedor não tem contrato no Sienge.'];
        return { contract: null, motivos, descartados };
    }
    if (aceitos.length > 1) {
        // Mais de um válido: fica com o de término mais distante (o vigente mais novo)
        // e registra os outros - a tela mostra, ninguém escolhe no escuro.
        aceitos.sort((a, b) => String(b.endDate || '').localeCompare(String(a.endDate || '')));
        for (const c of aceitos.slice(1)) {
            descartados.push({ contrato: `${c.documentId}/${c.contractNumber}`, motivo: 'também válido; usado o de término mais distante' });
        }
    }
    return { contract: aceitos[0], motivos: [], descartados };
}

/** Saldo do contrato para a medição (itens de /supply-contracts/items). */
export function checkBalance(balanceAvailable, valor) {
    const v = Number(valor) || 0;
    const saldo = Number(balanceAvailable) || 0;
    if (saldo + 0.005 < v) {
        return result([`Saldo do contrato (R$ ${saldo.toFixed(2)}) não cobre o lançamento (R$ ${v.toFixed(2)}). O contrato precisa de aditivo antes.`]);
    }
    return result([]);
}

/** Junta vários resultados num só (motivos e avisos na ordem). */
export function mergeResults(...parts) {
    const motivos = parts.flatMap(p => p?.motivos || []);
    const avisos = parts.flatMap(p => p?.avisos || []);
    return result(motivos, avisos);
}
