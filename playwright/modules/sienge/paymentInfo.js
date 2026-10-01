// playwright/modules/sienge/paymentInfo.js
//
// Forma de pagamento da parcela, pela tela do título (Contas a Pagar):
//   Cadastro de Títulos a Pagar (page 1607) -> aba "Inf. Pagamento" ->
//   editar a parcela -> Forma de pagamento -> Salvar.
//
//   boleto: código 2 + linha digitável (+ descrição)
//   pix:    código 11 + "Utilizar dados do credor para favorecido" + chave CNPJ/CPF
//
// Substitui o PATCH payment-information da API, que passou a responder 403
// para a integração em 01/10/2026 (a API do Sienge é só consulta).

import { log, success } from "../../core/logger.js";
import { dismissCommonPopups } from "../../core/popups.js";

const BASE = "https://menin.sienge.com.br/sienge/8/index.html";
const IFRAME = 'iframe[title="iFramePage"]';

async function frameOf(page, timeout = 60000) {
    const h = await page.waitForSelector(IFRAME, { state: "attached", timeout });
    const f = await h.contentFrame();
    if (!f) throw new Error("Iframe principal não encontrado.");
    await f.waitForLoadState("domcontentloaded", { timeout }).catch(() => { });
    return f;
}

async function settle(page, ms = 1500) {
    await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => { });
    await page.waitForTimeout(ms);
    await dismissCommonPopups(page, 2000).catch(() => { });
}

const byId = id => `[id="${id}"]`;

/**
 * @param {import('playwright').Page} page - já logada
 * @param {object} p
 * @param {number|string} p.titulo
 * @param {number|string} [p.parcela=1]
 * @param {string} p.origem         - código de origem do título no Sienge (ME, CP...)
 * @param {'boleto'|'pix'} p.tipo
 * @param {string} [p.linhaDigitavel] - obrigatória no boleto
 * @param {string} [p.descricao]
 */
export async function setPaymentInfo(page, { titulo, parcela = 1, origem = "ME", tipo, linhaDigitavel = "", descricao = "" }) {
    if (!titulo) throw new Error("Forma de pagamento: título não informado.");
    if (!["boleto", "pix"].includes(tipo)) throw new Error(`Forma de pagamento "${tipo}" não suportada.`);
    const linha = String(linhaDigitavel || "").replace(/\D/g, "");
    if (tipo === "boleto" && linha.length < 44) throw new Error("Boleto sem linha digitável válida.");

    const param = Buffer.from(`entity.cdOrigem=${origem}&entity.tituloPK.nuTitulo=${titulo}`).toString("base64");
    log("PAGTO", `Abrindo o título ${titulo} (origem ${origem})...`);
    await page.goto(`${BASE}#/common/page/1607/${param}`, { waitUntil: "domcontentloaded" });
    await settle(page, 4000);
    // Troca só do hash às vezes não monta a página legada: recarrega uma vez.
    let f = await frameOf(page, 25000).catch(() => null);
    if (!f) {
        log("PAGTO", "Tela do título não montou; recarregando...");
        await page.reload({ waitUntil: "domcontentloaded" });
        await settle(page, 5000);
        f = await frameOf(page);
    }
    const nu = await f.locator(byId("entity.tituloPK.nuTitulo")).inputValue().catch(() => "");
    if (String(nu).trim() !== String(titulo)) throw new Error(`O Sienge abriu o título "${nu}" em vez do ${titulo}.`);

    log("PAGTO", "Aba Inf. Pagamento...");
    await f.locator("a").filter({ hasText: /^\s*Inf\. Pagamento\s*$/ }).first().click({ force: true });
    await settle(page, 2500);
    f = await frameOf(page);

    log("PAGTO", `Editando a parcela ${parcela}...`);
    const editar = f.locator(`img[title="Abre a edição do registro"][onclick*="nuParcela=${parcela}"]`).first();
    await editar.waitFor({ state: "attached", timeout: 30000 });
    await editar.click({ force: true });
    await settle(page, 2500);
    f = await frameOf(page);

    const codigo = tipo === "boleto" ? "2" : "11";
    const campoForma = f.locator(byId("entity.cdTipoPagamento"));
    await campoForma.waitFor({ state: "visible", timeout: 30000 });
    await campoForma.fill("");
    await campoForma.fill(codigo);
    await campoForma.press("Tab");
    await settle(page, 2500);
    f = await frameOf(page);

    if (descricao) await f.locator(byId("entity.dePagamento")).fill(String(descricao).slice(0, 250)).catch(() => { });

    if (tipo === "boleto") {
        log("PAGTO", "Boleto: preenchendo a linha digitável...");
        const campo = f.locator(byId("entity.deLinhaDigPEMask"));
        await campo.waitFor({ state: "visible", timeout: 30000 });
        await campo.click();
        await campo.fill("");
        await campo.pressSequentially(linha, { delay: 15 });
        await campo.press("Tab");
        await settle(page, 1500);
    } else {
        log("PAGTO", "PIX: dados do credor, chave CNPJ/CPF...");
        const usar = f.locator("#usoDadosCredorFavorecido");
        await usar.waitFor({ state: "visible", timeout: 30000 });
        if (!(await usar.isChecked())) await usar.check({ force: true });
        await settle(page, 1500);
        f = await frameOf(page);
        await f.locator("#pixCpfCnpj").check({ force: true }).catch(() => { });
        await settle(page, 1000);
    }

    log("PAGTO", "Salvando...");
    f = await frameOf(page);
    await f.locator(byId("pbSalvar")).click();
    await settle(page, 3000);

    // Mensagem de erro do Sienge na própria tela (validação de linha digitável, chave etc.)
    f = await frameOf(page);
    const erro = await f.evaluate(() => {
        const t = document.body.innerText || "";
        const m = t.match(/(Erro|inválid[ao]|obrigatóri[ao])[^\n]{0,200}/i);
        return m && !/Obrigatório informar informações de pagamento/i.test(m[0]) ? m[0] : null;
    }).catch(() => null);
    if (erro) throw new Error(`O Sienge recusou a forma de pagamento: ${erro}`);

    success("PAGTO", `Forma de pagamento ${tipo} salva no título ${titulo}, parcela ${parcela}.`);
    return { ok: true };
}
