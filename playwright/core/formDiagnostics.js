// playwright/core/formDiagnostics.js
//
// Diagnóstico de formulário quando o Sienge não deixa salvar. O caso que
// motivou (lançamentos 70 e 71, jun-jul/2026): o robô esperava 30 s pelo
// "Salvar Medição" DESABILITADO e desistia com um timeout genérico. Botão
// desabilitado quase sempre é campo obrigatório vazio - ou porque o Sienge
// passou a exigir um campo novo, ou porque um autocomplete não pegou a opção.
// Este helper diz QUAL campo, e o erro gravado no lançamento passa a ser
// acionável ("Obra vazia", "campo novo: Centro de custo").

/**
 * Lista os campos obrigatórios vazios dentro de `root` (Locator do dialog/form).
 * Obrigatório = required / aria-required / aria-invalid, ou rótulo com "*".
 * @returns {Promise<Array<{ label: string, name: string|null }>>}
 */
export async function emptyRequiredFields(root) {
    return root.evaluate((el) => {
        const out = [];
        const seen = new Set();
        const labelOf = (input) => {
            if (input.id) {
                const l = el.querySelector(`label[for="${CSS.escape(input.id)}"]`);
                if (l) return l.innerText;
            }
            const wrap = input.closest('.MuiFormControl-root, .MuiTextField-root, [class*="FormControl"], td, div');
            const l = wrap?.querySelector('label, legend');
            return l?.innerText || input.getAttribute('aria-label') || input.placeholder || input.name || '';
        };
        const inputs = el.querySelectorAll('input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]), select, textarea');
        for (const input of inputs) {
            if (input.disabled || input.readOnly) continue;
            const style = window.getComputedStyle(input);
            if (style.display === 'none' || style.visibility === 'hidden') continue;
            const label = String(labelOf(input) || '').replace(/\s+/g, ' ').trim();
            const required = input.required
                || input.getAttribute('aria-required') === 'true'
                || input.getAttribute('aria-invalid') === 'true'
                || /\*\s*$/.test(label);
            if (!required) continue;
            if (String(input.value || '').trim()) continue;
            const key = label || input.name || input.id;
            if (seen.has(key)) continue;
            seen.add(key);
            out.push({ label: label.replace(/\s*\*\s*$/, '') || '(sem rótulo)', name: input.name || null });
        }
        return out;
    }).catch(() => []);
}

/**
 * Espera o botão habilitar; se não habilitar, lança um erro que diz quais
 * campos obrigatórios estão vazios.
 * @param {Locator} button
 * @param {Locator} root    - formulário/dialog onde procurar os campos
 * @param {string}  what    - nome do botão para a mensagem
 */
export async function assertEnabledOrExplain(button, root, what, timeout = 8000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        if (await button.isEnabled().catch(() => false)) return;
        await new Promise(r => setTimeout(r, 400));
    }
    const vazios = await emptyRequiredFields(root);
    const lista = vazios.length
        ? `Campos obrigatórios vazios: ${vazios.map(v => v.label).join(', ')}.`
        : 'Nenhum campo obrigatório vazio visível - o Sienge pode ter mudado a tela (rode o Vigia do Sienge).';
    throw new Error(`"${what}" ficou desabilitado no Sienge. ${lista}`);
}
