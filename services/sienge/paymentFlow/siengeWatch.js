// services/sienge/paymentFlow/siengeWatch.js
//
// Vigia das telas do Sienge usadas pela esteira. Abre cada tela com as
// credenciais Sienge de quem clicou, confere se os campos que o robô usa
// continuam lá e FECHA SEM SALVAR NADA. A ideia é a mudança de tela do Sienge
// aparecer aqui, num clique, antes de derrubar um lançamento de verdade.
//
// O que ele NÃO faz: preencher e salvar. O "Nova Medição" é aberto e
// cancelado; nenhuma outra ação de gravação é tocada.

import { siengeLogin } from '../../../playwright/modules/sienge/login.js';
import { dismissCommonPopups } from '../../../playwright/core/popups.js';
import { emptyRequiredFields } from '../../../playwright/core/formDiagnostics.js';
import { getUserSiengeCredentials } from './shared.js';

const BASE = 'https://menin.sienge.com.br/sienge/8/index.html';
const IFRAME = 'iframe[title="iFramePage"]';

// Campos do modal "Nova Medição" que o robô preenche. Qualquer outro
// obrigatório vazio é campo NOVO do Sienge - é o que trava o "Salvar Medição".
const MEDICAO_CAMPOS_CONHECIDOS = ['contrato', 'codigoObra', 'dataVencimento'];

async function settle(page) {
    await page.waitForLoadState('domcontentloaded', { timeout: 60000 }).catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    await dismissCommonPopups(page, 2000).catch(() => {});
}

async function mainFrame(page, timeout = 45000) {
    const h = await page.waitForSelector(IFRAME, { state: 'attached', timeout });
    const f = await h.contentFrame();
    if (!f) throw new Error('iframe principal sem conteúdo');
    await f.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
    return f;
}

async function check(nome, fn) {
    const t0 = Date.now();
    try {
        const detalhe = await fn();
        return { tela: nome, ok: true, detalhe: detalhe || 'OK', ms: Date.now() - t0 };
    } catch (err) {
        return { tela: nome, ok: false, detalhe: String(err.message || err).split('\n')[0].slice(0, 300), ms: Date.now() - t0 };
    }
}

async function visible(target, selector, what, timeout = 20000) {
    const ok = await target.locator(selector).first().isVisible({ timeout }).catch(() => false);
    if (!ok) throw new Error(`${what} não encontrado (${selector})`);
}

/**
 * @param {number} userId - dono das credenciais Sienge usadas no login
 * @returns {Promise<{ ok: boolean, rodadoEm: string, telas: object[] }>}
 */
export async function runSiengeWatch(userId) {
    const credentials = await getUserSiengeCredentials(userId);
    const rodadoEm = new Date().toISOString();
    if (!credentials.email) {
        return {
            ok: false, rodadoEm,
            telas: [{ tela: 'Login', ok: false, detalhe: 'Você não tem credenciais do Sienge salvas no Office.', ms: 0 }],
        };
    }

    let browser;
    let page;
    const telas = [];
    const login = await check('Login', async () => {
        ({ browser, page } = await siengeLogin(credentials));
        page.on('dialog', d => d.dismiss().catch(() => {}));
        await settle(page);
        return 'Entrou no Sienge';
    });
    telas.push(login);
    if (!login.ok) return { ok: false, rodadoEm, telas };

    try {
        // ── Medições: lista + modal "Nova Medição" (aberto e cancelado) ──────
        telas.push(await check('Medição - Nova Medição', async () => {
            await page.goto(`${BASE}#/suprimentos/contratos-e-medicoes/medicoes/cadastros`, { waitUntil: 'domcontentloaded' });
            await settle(page);
            const nova = page.locator('button:has-text("Nova Medição")');
            await nova.waitFor({ state: 'visible', timeout: 30000 });
            await nova.click({ timeout: 8000 });
            const dialog = page.locator('[role="dialog"]');
            await dialog.waitFor({ state: 'visible', timeout: 15000 });
            try {
                await visible(dialog, '[name="contrato"] input[type="text"]', 'Campo Contrato');
                await visible(dialog, '[name="codigoObra"] input[type="text"]', 'Campo Obra');
                await visible(dialog, 'input[name="dataVencimento"]', 'Campo Data de vencimento');
                await visible(dialog, 'button:has-text("Salvar Medição")', 'Botão Salvar Medição');
                const novos = (await emptyRequiredFields(dialog))
                    .filter(f => !MEDICAO_CAMPOS_CONHECIDOS.includes(f.name || ''))
                    .filter(f => !/contrato|obra|vencimento/i.test(f.label));
                if (novos.length) {
                    throw new Error(`Campo obrigatório novo no modal: ${novos.map(n => n.label).join(', ')}. O robô não preenche e o "Salvar Medição" vai travar.`);
                }
                return 'Contrato, Obra, Vencimento e Salvar Medição presentes; nenhum obrigatório novo';
            } finally {
                const cancelar = dialog.locator('button:has-text("Cancelar"), button:has-text("Fechar"), button[aria-label*="echar"]').first();
                if (await cancelar.isVisible({ timeout: 800 }).catch(() => false)) await cancelar.click().catch(() => {});
                else await page.keyboard.press('Escape').catch(() => {});
            }
        }));

        // ── Liberação de medições (título) ───────────────────────────────────
        telas.push(await check('Título - Liberação de medições', async () => {
            await page.goto(`${BASE}#/common/page/1961`, { waitUntil: 'domcontentloaded' });
            await settle(page);
            const f = await mainFrame(page);
            await visible(f, '#labelContrato', 'Filtro de contrato');
            await visible(f, 'input[name="btFiltrar"]', 'Botão Filtrar');
            return 'Filtro de contrato e botão Filtrar presentes';
        }));

        // ── Contratos (aditivo) ──────────────────────────────────────────────
        telas.push(await check('Contrato - Cadastros (aditivo)', async () => {
            await page.goto(`${BASE}#/suprimentos/contratos-e-medicoes/contratos/cadastros`, { waitUntil: 'domcontentloaded' });
            await settle(page);
            const hasIframe = await page.locator(IFRAME).count().catch(() => 0);
            const hasList = await page.locator('table, [role="grid"]').count().catch(() => 0);
            if (!hasIframe && !hasList) throw new Error('A tela de contratos não carregou a lista nem o iframe legado');
            return hasIframe ? 'Tela carregada (iframe legado)' : 'Tela carregada (nova interface)';
        }));

        // ── Contrato novo ────────────────────────────────────────────────────
        telas.push(await check('Contrato - Criação', async () => {
            await page.goto(`${BASE}#/common/page/1309`, { waitUntil: 'domcontentloaded' });
            await settle(page);
            await mainFrame(page);
            return 'Tela carregada';
        }));
    } finally {
        await browser?.close().catch(() => {});
    }

    return { ok: telas.every(t => t.ok), rodadoEm, telas };
}
