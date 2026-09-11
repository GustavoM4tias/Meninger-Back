// services/OfficeAI/MemoryTools.js
//
// Memória da Eme: preferências que a PESSOA confirmou.
//
// A regra que resolve o medo de "erro virar perfil do usuário": a Eme nunca
// grava sozinha. A tool `lembrar_preferencia` só PROPÕE - devolve um card no
// chat com o que ela entendeu, e a preferência só existe quando a pessoa
// clica em Guardar (POST /office-chat/memories). Tudo o que foi guardado fica
// visível e apagável no modal Configurações do chat, e cada pessoa liga ou
// desliga a própria memória.
//
// No prompt, as preferências entram como preferência de apresentação e
// contexto pessoal - nunca como fato do sistema. Se conflitarem com o
// resultado de uma tool, a tool vale (ver blocoDeMemoria).
import db from '../../models/sequelize/index.js';
import { registerTool } from './ToolRegistry.js';

const { UserAIMemory, EmeUserSetting } = db;

export const MEMORY_CATEGORIES = ['preference', 'context', 'fact'];
const MAX_KEY = 100;
const MAX_VALUE = 400;
const MAX_MEMORIES = 40;

const normKey = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, MAX_KEY);

/** Valida uma memória vinda da tool ou da API. Devolve { ok, erro?, memoria? }. */
export function validarMemoria({ key, value, category } = {}) {
    const k = normKey(key);
    const v = String(value || '').replace(/\s+/g, ' ').trim().slice(0, MAX_VALUE);
    if (!k) return { ok: false, erro: 'Informe uma chave curta (ex.: "empreendimento_padrao").' };
    if (!v) return { ok: false, erro: 'Informe o valor da preferência.' };
    const c = MEMORY_CATEGORIES.includes(category) ? category : 'preference';
    return { ok: true, memoria: { key: k, value: v, category: c } };
}

/** Configuração da pessoa (memória ligada? modo do modelo?), com padrões. */
export async function userEmeSettings(userId) {
    const row = await EmeUserSetting.findByPk(userId, { raw: true }).catch(() => null);
    return {
        memory_enabled: row ? row.memory_enabled !== false : true,
        model_mode: ['auto', 'fast', 'smart'].includes(row?.model_mode) ? row.model_mode : 'auto',
        // null = segue o padrão do Cérebro (Recuperação > Período).
        default_period: row?.default_period || null,
    };
}

/** Memórias CONFIRMADAS e ativas da pessoa, para o prompt. */
export async function memoriasAtivas(userId) {
    return UserAIMemory.findAll({
        where: { user_id: userId, enabled: true },
        attributes: ['key', 'value', 'category'],
        order: [['updated_at', 'DESC']],
        limit: MAX_MEMORIES,
        raw: true,
    });
}

/**
 * Bloco do prompt. Vai mesmo sem memória guardada (só a orientação), para a
 * Eme saber que pode OFERECER guardar - e que nunca afirma ter guardado.
 */
export function blocoDeMemoria(memorias = []) {
    const linhas = memorias.map(m => `- ${m.key}: ${m.value}`);
    return `\n\n## PREFERÊNCIAS CONFIRMADAS PELA PESSOA\n`
        + (linhas.length
            ? `Cada linha abaixo foi confirmada pela própria pessoa num botão. São preferências de apresentação e contexto pessoal - NÃO são dados do sistema: se uma delas conflitar com o resultado de uma tool, a tool vale, e você nunca cita uma preferência como se fosse fato consultado.\n${linhas.join('\n')}\n`
            : `Nenhuma preferência guardada ainda.\n`)
        + `Quando a pessoa expressar uma preferência estável e reutilizável (formato de valor, empreendimento que acompanha, como quer ser chamada, unidade padrão), OFEREÇA guardar chamando \`lembrar_preferencia\`. A tool só propõe: a pessoa confirma num botão. NUNCA diga que guardou, e não ofereça para dado que muda (um número de hoje, uma lista de clientes).\n`;
}

registerTool({
    name: 'lembrar_preferencia',
    description: 'PROPÕE guardar uma preferência estável da pessoa (formato de valor, empreendimento que ela acompanha, como quer ser chamada, unidade padrão de resposta). Não grava nada: devolve um card em que ELA confirma. Use quando a pessoa disser algo como "sempre me mostra em VGV sem DC", "meu empreendimento é o Ingá", "me chama de Gu", "prefiro tabela a gráfico". NÃO use para dado do sistema (número, lista, situação de hoje) nem para algo dito uma vez só. Depois de chamar, diga em uma frase que pode guardar isso e que ela confirma no botão - nunca diga que já guardou.',
    parameters: {
        type: 'object',
        properties: {
            chave: { type: 'string', description: 'Nome curto e estável da preferência, em snake_case. Ex.: "empreendimento_padrao", "formato_valor", "como_chamar".' },
            valor: { type: 'string', description: 'A preferência, em uma frase curta e objetiva. Ex.: "VGV sem DC", "Residencial Ingá", "Gu".' },
            categoria: { type: 'string', enum: MEMORY_CATEGORIES, description: '"preference" (padrão): como apresentar. "context": contexto pessoal (área, cidade que acompanha). "fact": fato sobre a pessoa que ela pediu para lembrar.' },
        },
        required: ['chave', 'valor'],
    },
    requiredPermissions: [],
    contexts: ['OFFICE'],
    async handler(user, args) {
        const cfg = await userEmeSettings(user.id);
        if (!cfg.memory_enabled) {
            return { result: { message: 'A pessoa desligou a memória da Eme nas Configurações do chat. Diga isso em uma frase e siga sem guardar - não insista.' }, resultCount: 0 };
        }
        const v = validarMemoria({ key: args?.chave, value: args?.valor, category: args?.categoria });
        if (!v.ok) return { result: { error: v.erro }, resultCount: 0 };

        const total = await UserAIMemory.count({ where: { user_id: user.id } });
        if (total >= MAX_MEMORIES) {
            return { result: { message: `A pessoa já tem ${MAX_MEMORIES} preferências guardadas (o máximo). Diga que ela pode apagar alguma nas Configurações do chat.` }, resultCount: 0 };
        }
        const existente = await UserAIMemory.findOne({ where: { user_id: user.id, key: v.memoria.key }, attributes: ['value'], raw: true });

        return {
            result: {
                type: 'memory_proposal',
                proposta: v.memoria,
                substitui: existente ? existente.value : null,
                message: `Card de confirmação JÁ está na UI com "${v.memoria.key}: ${v.memoria.value}"${existente ? ` (substituiria "${existente.value}")` : ''}. Diga em UMA frase que pode guardar isso e que a pessoa confirma no botão. NÃO diga que guardou.`,
            },
            resultCount: 1,
        };
    },
});

export default { validarMemoria, userEmeSettings, memoriasAtivas, blocoDeMemoria, MEMORY_CATEGORIES };
