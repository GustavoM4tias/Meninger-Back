// services/boleto/titularValidator.js
//
// Valida os dados do titular da reserva ANTES de tentar emitir o boleto no Ecobrança.
// Cobre os campos exigidos pelo portal legado da Caixa, com mensagens claras para
// o admin saber exatamente o que ajustar no cadastro do CV.

const STATE_NAME_TO_UF = {
    'acre': 'AC', 'alagoas': 'AL', 'amapa': 'AP', 'amazonas': 'AM',
    'bahia': 'BA', 'ceara': 'CE', 'distrito federal': 'DF', 'espirito santo': 'ES',
    'goias': 'GO', 'maranhao': 'MA', 'mato grosso': 'MT', 'mato grosso do sul': 'MS',
    'minas gerais': 'MG', 'para': 'PA', 'paraiba': 'PB', 'parana': 'PR',
    'pernambuco': 'PE', 'piaui': 'PI', 'rio de janeiro': 'RJ', 'rio grande do norte': 'RN',
    'rio grande do sul': 'RS', 'rondonia': 'RO', 'roraima': 'RR', 'santa catarina': 'SC',
    'sao paulo': 'SP', 'sergipe': 'SE', 'tocantins': 'TO',
};
const VALID_UFS = new Set(Object.values(STATE_NAME_TO_UF));

const normalize = (s) => String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().trim();

function isValidCPF(cpf) {
    const d = String(cpf || '').replace(/\D/g, '');
    if (d.length !== 11 || /^(\d)\1{10}$/.test(d)) return false;
    let sum = 0;
    for (let i = 0; i < 9; i++) sum += parseInt(d[i], 10) * (10 - i);
    let dv = (sum * 10) % 11;
    if (dv === 10) dv = 0;
    if (dv !== parseInt(d[9], 10)) return false;
    sum = 0;
    for (let i = 0; i < 10; i++) sum += parseInt(d[i], 10) * (11 - i);
    dv = (sum * 10) % 11;
    if (dv === 10) dv = 0;
    return dv === parseInt(d[10], 10);
}

function isValidCNPJ(cnpj) {
    const d = String(cnpj || '').replace(/\D/g, '');
    if (d.length !== 14 || /^(\d)\1{13}$/.test(d)) return false;
    const calc = (n) => {
        const weights = n === 12
            ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]
            : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
        let sum = 0;
        for (let i = 0; i < n; i++) sum += parseInt(d[i], 10) * weights[i];
        const r = sum % 11;
        return r < 2 ? 0 : 11 - r;
    };
    return calc(12) === parseInt(d[12], 10) && calc(13) === parseInt(d[13], 10);
}

function resolveUF(estado) {
    const raw = String(estado || '').trim();
    if (!raw) return null;
    if (raw.length === 2) {
        const upper = raw.toUpperCase();
        return VALID_UFS.has(upper) ? upper : null;
    }
    return STATE_NAME_TO_UF[normalize(raw)] || null;
}

/**
 * Valida os campos do titular exigidos pelo Ecobrança.
 *
 * @param {object} titular - bloco `titular` da reserva CV
 * @returns {{ valid: boolean, errors: Array<{campo: string, motivo: string, atual?: string}> }}
 */
export function validateTitular(titular) {
    const errors = [];
    const t = titular || {};

    // ── Nome ──────────────────────────────────────────────────────────────────
    const nome = String(t.nome || '').trim();
    if (!nome) {
        errors.push({ campo: 'Nome do titular', motivo: 'não preenchido' });
    } else if (nome.length < 3) {
        errors.push({ campo: 'Nome do titular', motivo: 'muito curto (mínimo 3 caracteres)', atual: nome });
    }

    // ── Documento (CPF / CNPJ) ────────────────────────────────────────────────
    const docDigits = String(t.documento || '').replace(/\D/g, '');
    if (!docDigits) {
        errors.push({ campo: 'CPF/CNPJ', motivo: 'não preenchido' });
    } else if (docDigits.length === 11) {
        if (!isValidCPF(docDigits)) {
            errors.push({ campo: 'CPF', motivo: 'dígitos verificadores inválidos', atual: t.documento });
        }
    } else if (docDigits.length === 14) {
        if (!isValidCNPJ(docDigits)) {
            errors.push({ campo: 'CNPJ', motivo: 'dígitos verificadores inválidos', atual: t.documento });
        }
    } else {
        errors.push({
            campo: 'CPF/CNPJ',
            motivo: `tem ${docDigits.length} dígitos (esperado 11 para CPF ou 14 para CNPJ)`,
            atual: t.documento,
        });
    }

    // ── Endereço ──────────────────────────────────────────────────────────────
    const endereco = String(t.endereco || '').trim();
    if (!endereco) {
        errors.push({ campo: 'Endereço', motivo: 'não preenchido' });
    } else if (endereco.length < 3) {
        errors.push({ campo: 'Endereço', motivo: 'muito curto', atual: endereco });
    }

    // Número — não bloqueante (pode ser SN), mas avisa se vier algo estranho
    // (vazio é tolerado e substituído por "SN" no createBoleto).

    // ── Bairro ────────────────────────────────────────────────────────────────
    const bairro = String(t.bairro || '').trim();
    if (!bairro) {
        errors.push({ campo: 'Bairro', motivo: 'não preenchido' });
    }

    // ── CEP ───────────────────────────────────────────────────────────────────
    const cepDigits = String(t.cep || '').replace(/\D/g, '');
    if (!cepDigits) {
        errors.push({ campo: 'CEP', motivo: 'não preenchido' });
    } else if (cepDigits.length !== 8) {
        errors.push({
            campo: 'CEP',
            motivo: `tem ${cepDigits.length} dígitos (esperado 8)`,
            atual: t.cep,
        });
    } else if (/^(\d)\1{7}$/.test(cepDigits)) {
        errors.push({ campo: 'CEP', motivo: 'sequência repetida (inválido)', atual: t.cep });
    }

    // ── Cidade ────────────────────────────────────────────────────────────────
    const cidade = String(t.cidade || '').trim();
    if (!cidade) {
        errors.push({ campo: 'Cidade', motivo: 'não preenchida' });
    }

    // ── Estado (UF) ───────────────────────────────────────────────────────────
    const estado = String(t.estado || '').trim();
    if (!estado) {
        errors.push({ campo: 'Estado', motivo: 'não preenchido' });
    } else if (!resolveUF(estado)) {
        errors.push({
            campo: 'Estado',
            motivo: 'não corresponde a uma UF válida do Brasil',
            atual: estado,
        });
    }

    return { valid: errors.length === 0, errors };
}

/**
 * Formata a lista de erros como uma mensagem multi-linha pronta para enviar
 * ao CV via /v2/comercial/reservas/mensagens.
 */
export function formatTitularErrorsMessage(errors) {
    const linhas = errors.map(e => {
        const base = `• ${e.campo}: ${e.motivo}`;
        return e.atual ? `${base} (valor atual: "${e.atual}")` : base;
    });
    return [
        '❌ Boleto não emitido: divergência nos dados do titular.',
        '',
        'Corrija os campos abaixo no cadastro do cliente no CV e reprocesse:',
        '',
        ...linhas,
    ].join('\n');
}
