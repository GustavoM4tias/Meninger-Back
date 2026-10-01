// services/sienge/paymentFlow/directTitle.js
//
// Peças puras do título direto (RB): corpo do POST /v1/bills, PIX na chave CPF
// e numeração pela data. Sem banco e sem Sienge - testadas em
// tests/paymentFlowDirectTitle.test.mjs. Quem chama a API é modules/tituloDireto.js.

export const PIX_PAYMENT_TYPE = 11;
export const onlyDigits = s => String(s || '').replace(/\D/g, '');
export const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
export const iso = d => d.toISOString().slice(0, 10);

/** "2.02.02.41" -> "2020241" (a API quer o plano financeiro sem máscara). */
export function contaSemMascara(conta) {
    return onlyDigits(conta);
}

/** Número do documento pela data, como os RBs do Sienge: 24/09/2026 -> "24092026". */
export function numeroPorData(isoDate) {
    const [y, m, d] = String(isoDate).slice(0, 10).split('-');
    return `${d}${m}${y}`;
}

export function mascaraCpf(cpf) {
    const d = onlyDigits(cpf);
    return d.length === 11 ? `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}` : '';
}

/** Corpo do POST /v1/bills. Puro: recebe tudo resolvido. */
export function montarTitulo({
    companyId, creditorId, documento, numero, emissao, vencimento, valor, observacao,
    buildingId, conta, departamentoId, itemOrcamento,
}) {
    const base = `${String(emissao).slice(0, 7)}-01`;
    const body = {
        debtorId: Number(companyId),
        creditorId: Number(creditorId),
        documentIdentificationId: documento,
        documentNumber: String(numero).slice(0, 20),
        issueDate: emissao,
        installmentsNumber: 1,
        indexId: 0,
        baseDate: base,
        dueDate: vencimento,
        billDate: emissao,
        totalInvoiceAmount: Math.round(Number(valor) * 100) / 100,
        notes: String(observacao || '').slice(0, 500),
        discount: 0,
        budgetCategories: [{ costCenterId: Number(buildingId), paymentCategoriesId: contaSemMascara(conta), percentage: 100 }],
    };
    if (departamentoId) body.departmentsCost = [{ departmentId: Number(departamentoId), percentage: 100 }];
    if (itemOrcamento) {
        body.buildingsCost = [{
            buildingId: Number(buildingId), buildingUnitId: 1,
            costEstimationSheetId: itemOrcamento, percentage: 100,
        }];
    }
    return body;
}

/** PIX na chave CPF do credor (o mesmo que o Sienge grava com "usar dados do credor"). */
export function montarPix({ nome, cpf }) {
    const c = mascaraCpf(cpf);
    return {
        paymentTypeId: PIX_PAYMENT_TYPE,
        isUsingCreditorData: 'S',
        keyPixType: 'C',
        keyPix: c,
        beneficiaryName: String(nome || '').slice(0, 80),
        beneficiaryCPFNumber: c,
        notes: `Pagamento via PIX: ${c}\nFavorecido: ${nome}\nCPF/CNPJ Favorecido: ${c}`,
    };
}
