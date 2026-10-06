// playwright/modules/sienge/paymentInfo.js
//
// Forma de pagamento da parcela, pela tela do título (Contas a Pagar):
//   Cadastro de Títulos a Pagar (page 1607) -> aba "Inf. Pagamento" ->
//   editar a parcela -> Forma de pagamento -> Salvar.
//
//   boleto: código 2 + linha digitável (+ descrição)
//   pix:    código 11 + "Utilizar dados do credor para favorecido" + chave CNPJ/CPF
//
// Anexos do título: aba "Anexos" -> Adicionar -> Descrição + Arquivo -> Salvar.
//
// Substitui o PATCH payment-information e o POST attachments da API, que
// respondem 403 para a integração desde 01/10/2026 (a API do Sienge é só consulta).

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
 * Espera o seletor existir no iframe ATUAL e devolve esse frame. Trocar de aba
 * ou abrir um registro recarrega o iframe; procurar no frame antigo dava
 * timeout (título "", "Adicionar" ausente, lápis da parcela).
 */
async function noFrame(page, selector, { timeout = 60000, oque = selector } = {}) {
    const fim = Date.now() + timeout;
    while (Date.now() < fim) {
        const f = await frameOf(page, 15000).catch(() => null);
        if (f && await f.locator(selector).count().catch(() => 0)) return f;
        await page.waitForTimeout(1000);
    }
    throw new Error(`A tela do Sienge não mostrou ${oque} a tempo.`);
}

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

    let f = await abrirTitulo(page, titulo, origem);
    return preencherPagamento(page, f, { titulo, parcela, tipo, linha, descricao });
}

/** Abre o Cadastro de Títulos a Pagar (page 1607) no título e confere o número. */
export async function abrirTitulo(page, titulo, origem = "ME") {
    const param = Buffer.from(`entity.cdOrigem=${origem}&entity.tituloPK.nuTitulo=${titulo}`).toString("base64");
    const alvo = `${BASE}#/common/page/1607/${param}`;
    log("PAGTO", `Abrindo o título ${titulo} (origem ${origem})...`);
    // Mesmo endereço já aberto (pagamento -> anexo) NÃO remonta a página: o
    // robô lia a aba anterior e via título "". Cada tentativa força a carga:
    // 1ª goto; depois reload; e confere o número do título na tela.
    let nu = "";
    for (let tentativa = 1; tentativa <= 3; tentativa++) {
        if (tentativa === 1 && page.url() !== alvo) await page.goto(alvo, { waitUntil: "domcontentloaded" });
        else {
            if (page.url() !== alvo) await page.goto(alvo, { waitUntil: "domcontentloaded" });
            await page.reload({ waitUntil: "domcontentloaded" });
        }
        await settle(page, 4000);
        const f = await frameOf(page, 30000).catch(() => null);
        if (f) {
            const campo = f.locator(byId("entity.tituloPK.nuTitulo"));
            await campo.waitFor({ state: "attached", timeout: 20000 }).catch(() => { });
            nu = String(await campo.inputValue().catch(() => "")).trim();
            if (nu === String(titulo)) return f;
        }
        log("PAGTO", `Tela do título não carregou certo (tentativa ${tentativa}, título "${nu}"); recarregando...`);
    }
    throw new Error(`O Sienge abriu o título "${nu}" em vez do ${titulo}.`);
}

/**
 * Vencimento da parcela: aba "Parcelas" do título -> campo Data de vencimento
 * da linha -> Salvar. Só a data; valor e demais parcelas ficam como estão.
 * @param {string} vencimento - 'YYYY-MM-DD' ou 'DD/MM/YYYY'
 */
export async function setDueDate(page, { titulo, parcela = 1, origem = "ME", vencimento }) {
    const m = String(vencimento || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
    const data = m ? `${m[3]}/${m[2]}/${m[1]}` : String(vencimento || "");
    if (!/^\d{2}\/\d{2}\/\d{4}$/.test(data)) throw new Error(`Vencimento inválido: "${vencimento}".`);

    let f = await abrirTitulo(page, titulo, origem);
    log("PAGTO", "Aba Parcelas...");
    await f.getByText("Parcelas", { exact: true }).first().click({ force: true });
    await settle(page, 2000);

    // A linha da parcela: o número fica em row[i].parcelaPK.nuParcela_i.
    f = await noFrame(page, '[id$=".dtVencto_0"]', { oque: "as parcelas do título" });
    let idx = null;
    for (let i = 0; i < 60 && idx == null; i++) {
        const nu = f.locator(byId(`row[${i}].parcelaPK.nuParcela_${i}`));
        if (!(await nu.count())) break;
        if (String(await nu.inputValue()).trim() === String(parcela)) idx = i;
    }
    if (idx == null) throw new Error(`Parcela ${parcela} não encontrada no título ${titulo}.`);

    const campo = f.locator(byId(`row[${idx}].dtVencto_${idx}`));
    const antes = String(await campo.inputValue()).trim();
    if (antes === data) {
        log("PAGTO", `Vencimento já é ${data}.`);
        return { ok: true, antes, depois: data, alterado: false };
    }
    log("PAGTO", `Vencimento da parcela ${parcela}: ${antes} -> ${data}...`);
    await campo.click();
    await campo.fill("");
    await campo.pressSequentially(data.replace(/\D/g, ""), { delay: 30 });
    await campo.press("Tab");
    await settle(page, 1000);
    // A máscara às vezes guarda a data sem as barras: confere antes de salvar.
    const digitado = String(await campo.inputValue()).trim();
    if (digitado.replace(/\D/g, "") !== data.replace(/\D/g, "")) {
        throw new Error(`O campo de vencimento ficou "${digitado}" em vez de ${data}; nada foi salvo.`);
    }

    // A tela tem texto fixo com "não pode ser alterado" (06/10 deu alarme falso
    // com a data já salva): só conta mensagem que apareceu DEPOIS do Salvar.
    const linhasDaTela = (fr) => fr.evaluate(() =>
        (document.body.innerText || "").split("\n").map(l => l.trim()).filter(Boolean)).catch(() => []);
    const antesDeSalvar = new Set(await linhasDaTela(f));

    log("PAGTO", "Salvando...");
    await f.locator(byId("btSalvar")).click();
    await settle(page, 3000);
    f = await frameOf(page);
    const erro = (await linhasDaTela(f))
        .find(x => !antesDeSalvar.has(x) && /erro|inválid[ao]|não é permitid[ao]|não pode/i.test(x));
    if (erro) throw new Error(`O Sienge recusou o novo vencimento: ${erro.slice(0, 300)}`);

    // Quem decide é o campo depois de salvar (a API ainda confere no service).
    f = await noFrame(page, byId(`row[${idx}].dtVencto_${idx}`), { oque: "a parcela depois de salvar" }).catch(() => f);
    const salvo = String(await f.locator(byId(`row[${idx}].dtVencto_${idx}`)).inputValue().catch(() => "")).trim();
    if (salvo && salvo !== data) throw new Error(`Depois de salvar, a parcela ficou com vencimento ${salvo} em vez de ${data}.`);

    success("PAGTO", `Vencimento do título ${titulo}, parcela ${parcela}: ${data}.`);
    return { ok: true, antes, depois: data, alterado: true };
}

async function preencherPagamento(page, f, { titulo, parcela, tipo, linha, descricao }) {

    log("PAGTO", "Aba Inf. Pagamento...");
    await f.getByText("Inf. Pagamento", { exact: true }).first().click({ force: true });
    await settle(page, 2000);
    const lapis = `img[title="Abre a edição do registro"][onclick*="nuParcela=${parcela}"]`;
    f = await noFrame(page, lapis, { oque: `a parcela ${parcela} na aba Inf. Pagamento` });

    log("PAGTO", `Editando a parcela ${parcela}...`);
    await f.locator(lapis).first().click({ force: true });
    await settle(page, 2000);
    f = await noFrame(page, byId("entity.cdTipoPagamento"), { oque: "o campo Forma de pagamento" });

    const codigo = tipo === "boleto" ? "2" : "11";
    const campoForma = f.locator(byId("entity.cdTipoPagamento"));
    await campoForma.waitFor({ state: "visible", timeout: 30000 });
    await campoForma.fill("");
    await campoForma.fill(codigo);
    await campoForma.press("Tab");
    await settle(page, 2000);
    f = await noFrame(page, tipo === "boleto" ? byId("entity.deLinhaDigPEMask") : "#usoDadosCredorFavorecido",
        { oque: tipo === "boleto" ? "o campo Linha digitável" : "as opções do PIX" });

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

/**
 * Anexa arquivos ao título (aba Anexos). Pula o que já estiver anexado com o
 * mesmo nome de arquivo, para reprocessar sem duplicar.
 * @param {object[]} anexos - [{ descricao, nome, buffer, mimeType }]
 */
export async function anexarNoTitulo(page, params) {
    // Às vezes o Sienge salva a tela sem o arquivo (upload ainda em curso):
    // uma segunda volta reabre o título e manda só o que faltou.
    try {
        return await anexarUmaVez(page, params);
    } catch (err) {
        if (!/não apareceu no título/.test(err.message)) throw err;
        log("ANEXO", `Primeira tentativa não gravou (${err.message}); tentando de novo...`);
        return anexarUmaVez(page, params);
    }
}

async function anexarUmaVez(page, { titulo, origem = "ME", anexos = [] }) {
    if (!anexos.length) return { anexados: 0 };
    let f = await abrirTitulo(page, titulo, origem);
    log("ANEXO", "Aba Anexos...");
    await f.getByText("Anexos", { exact: true }).first().click({ force: true });
    await settle(page, 2000);
    f = await noFrame(page, "#btNovaLinhaAnexos", { oque: 'o botão "Adicionar" da aba Anexos' });

    const jaTem = await f.locator('input[type="hidden"][name$=".nmAnexo"]').evaluateAll(els => els.map(e => (e.value || "").toLowerCase()));
    const novos = anexos.filter(a => !jaTem.includes(String(a.nome || "").toLowerCase()));
    if (!novos.length) { success("ANEXO", "Arquivos já estavam anexados."); return { anexados: 0 }; }

    for (const a of novos) {
        await f.locator("#btNovaLinhaAnexos").click();
        await page.waitForTimeout(800);
        const idx = await f.locator('input[type="file"][name^="anexos["]').evaluateAll(els =>
            Math.max(...els.map(e => Number((e.name.match(/anexos\[(\d+)\]/) || [])[1] ?? -1))));
        log("ANEXO", `Linha ${idx}: ${a.nome}`);
        await f.locator(`[id="anexos[${idx}].deAnexo_${idx}"]`).fill(String(a.descricao || a.nome).slice(0, 100));
        await f.locator(`[id="anexos[${idx}].file_${idx}"]`).setInputFiles({
            name: String(a.nome || "anexo.pdf").slice(0, 100), mimeType: a.mimeType || "application/pdf", buffer: a.buffer,
        });
        await page.waitForTimeout(1500);
    }

    await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => { });
    log("ANEXO", "Salvando...");
    await f.locator('input[name="pbEnviar"]').click();
    await settle(page, 4000);

    // Conferência: os nomes aparecem na lista depois de salvar.
    f = await frameOf(page);
    const depois = await f.locator('input[type="hidden"][name$=".nmAnexo"]').evaluateAll(els => els.map(e => (e.value || "").toLowerCase())).catch(() => []);
    const faltando = novos.filter(a => !depois.some(n => n.includes(String(a.nome || "").toLowerCase().replace(/\.pdf$/, ""))));
    if (faltando.length) {
        const msg = await f.evaluate(() => {
            const t = (document.body.innerText || "").replace(/\s+/g, " ");
            const m = t.match(/Informação (.{0,250}?)IDENTIFICAÇÃO/i) || t.match(/(Erro|inválid|obrigatóri|não foi|não é)[^.]{0,200}/i);
            return m ? (m[1] || m[0]).trim() : null;
        }).catch(() => null);
        throw new Error(`Anexo não apareceu no título depois de salvar: ${faltando.map(a => a.nome).join(", ")}${msg ? ` (Sienge: ${msg})` : ""}.`);
    }
    success("ANEXO", `${novos.length} arquivo(s) anexado(s) ao título ${titulo}.`);
    return { anexados: novos.length };
}

/**
 * Finaliza a liberação da medição (Liberações de Medições, page 1961). O robô
 * do título clica em Finalizar logo depois de salvar, mas o Sienge só finaliza
 * quando o título está completo (forma de pagamento + anexo) - então a
 * liberação ficava "em andamento". Roda DEPOIS de pagamento e anexos.
 * @returns {{ finalizada: boolean, jaEstava?: boolean }}
 */
export async function finalizarLiberacao(page, { documentType, contractNumber, measurementNumber }) {
    const contrato = `${documentType}/${contractNumber}`;
    const dialogos = [];
    const onDialog = d => dialogos.push(d.message());
    page.on("dialog", onDialog);
    try {
        const listar = async (situacao) => {
            await page.goto(`${BASE}#/common/page/1961`, { waitUntil: "domcontentloaded" });
            await settle(page, 2500);
            // Mesma URL não remonta a página: sem o filtro na tela, recarrega.
            let f = await frameOf(page, 25000).catch(() => null);
            if (!f || !(await f.locator("#labelContrato").count().catch(() => 0))) {
                await page.reload({ waitUntil: "domcontentloaded" });
                await settle(page, 4000);
                f = await frameOf(page);
                await f.locator("#labelContrato").waitFor({ state: "visible", timeout: 30000 });
            }
            await f.locator("#labelContrato").fill(contrato);
            await f.locator("#dtInicioPeriodo").fill("01/01/2020");
            await f.locator("#flSitMedicoes").selectOption(situacao);
            await f.locator('input[name="btFiltrar"]').click();
            await settle(page, 2500);
            f = await frameOf(page);
            const rowId = await f.evaluate((n) => {
                for (const r of document.querySelectorAll('tr[id^="linhaRow_"]:not([id$="-1"])')) {
                    const s = r.querySelector('span[tipo="NUMBER"]');
                    if (s && parseInt(s.innerText, 10) === n) return r.id;
                }
                return null;
            }, Number(measurementNumber));
            return { f, rowId };
        };

        log("LIBERACAO", `Procurando ${contrato} medição ${measurementNumber} com liberação em andamento...`);
        let { f, rowId } = await listar("A");
        if (!rowId) {
            const fin = await listar("F");
            if (fin.rowId) { success("LIBERACAO", "Liberação já estava finalizada."); return { finalizada: true, jaEstava: true }; }
            throw new Error(`Medição ${measurementNumber} do ${contrato} não está com liberação em andamento nem finalizada.`);
        }
        await f.locator(`tr#${rowId} img[name_="editar"]`).first().click({ force: true });
        await settle(page, 2500);
        f = await frameOf(page);

        log("LIBERACAO", "Finalizando...");
        const bt = f.locator("#btFinalizar");
        await bt.waitFor({ state: "visible", timeout: 30000 });
        await bt.click();
        await settle(page, 4000);

        const conferido = await listar("F");
        if (!conferido.rowId) {
            const motivo = dialogos.filter(Boolean).pop();
            throw new Error(`O Sienge não finalizou a liberação${motivo ? `: ${motivo}` : ""}.`);
        }
        success("LIBERACAO", `Liberação do ${contrato} medição ${measurementNumber} finalizada.`);
        return { finalizada: true };
    } finally {
        page.off("dialog", onDialog);
    }
}
