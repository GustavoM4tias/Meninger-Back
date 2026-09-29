// services/sienge/paymentFlow/measurementItem.js
//
// Qual linha do contrato a medição preenche. Função pura sobre o retorno de
// SiengeContractService.validateItems (itens com `_balanceEstimate`).
//
// O grid da medição no Sienge só deixa editar linha com saldo, na mesma ordem
// da API; por isso a resposta é a POSIÇÃO entre as linhas com saldo (1-based).
//
// Antes o critério era só o saldo ("o menor que cobre o valor"). Num contrato
// com vários itens isso mede no item errado: no CTPJ/32 (salário da Helena) a
// linha de Premiação tem saldo menor que a de Contratos PJ e seria escolhida.
// Agora o item de orçamento do tipo manda; o saldo só desempata.

const norm = s => String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toUpperCase().replace(/\s+/g, ' ').trim();

const EPS = 0.005;

/**
 * @param {object[]} items  - itens do contrato (validateItems().items), na ordem da API
 * @param {object}   opts
 * @param {string}   [opts.budgetItem]      - descrição do item de orçamento do tipo (ex.: "Contratos PJ")
 * @param {string}   [opts.budgetItemCode]  - código do serviço (workItemId) do tipo
 * @param {number}   opts.value             - valor a medir
 * @param {boolean}  [opts.strict]          - true = sem item do tipo, não mede (recusa)
 * @returns {{ rowIndex: number|null, item: object|null, balance: number, motivo: string|null, porItem: boolean }}
 */
export function pickMeasurementItem(items, { budgetItem = null, budgetItemCode = null, value = 0, strict = false } = {}) {
    const alvo = Number(value) || 0;
    const withBalance = (items || [])
        .map((item, pos) => ({ item, pos, saldo: Number(item._balanceEstimate) || 0 }))
        .filter(x => x.saldo > EPS);

    if (!withBalance.length) {
        return { rowIndex: null, item: null, balance: 0, motivo: 'O contrato não tem item com saldo.', porItem: false };
    }

    const nome = norm(budgetItem);
    const code = String(budgetItemCode || '').trim();
    const doTipo = withBalance.filter(({ item }) =>
        (code && String(item.workItemId || '') === code)
        || (nome && (norm(item.description) === nome || norm(item.description).startsWith(nome))));

    let pool = withBalance;
    let porItem = false;
    if (doTipo.length) {
        pool = doTipo;
        porItem = true;
    } else if (strict) {
        const tem = (items || []).some(({ description, workItemId }) =>
            (code && String(workItemId || '') === code) || (nome && norm(description).startsWith(nome)));
        return {
            rowIndex: null, item: null, balance: 0, porItem: false,
            motivo: tem
                ? `O item "${budgetItem || code}" do contrato está sem saldo. O contrato precisa de aditivo antes.`
                : `O contrato não tem o item "${budgetItem || code}" deste tipo de lançamento.`,
        };
    }

    const exato = pool.find(x => Math.abs(x.saldo - alvo) < 0.01);
    const suficientes = pool.filter(x => x.saldo >= alvo - EPS).sort((a, b) => a.saldo - b.saldo);
    const escolhido = exato || suficientes[0] || pool[0];

    if (strict && escolhido.saldo < alvo - EPS) {
        return {
            rowIndex: null, item: null, balance: escolhido.saldo, porItem,
            motivo: `Saldo do item "${escolhido.item.description}" (R$ ${escolhido.saldo.toFixed(2)}) não cobre R$ ${alvo.toFixed(2)}. O contrato precisa de aditivo antes.`,
        };
    }

    return {
        rowIndex: withBalance.findIndex(x => x.pos === escolhido.pos) + 1,
        item: escolhido.item,
        balance: escolhido.saldo,
        motivo: null,
        porItem,
    };
}
