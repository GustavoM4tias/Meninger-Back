// services/comercial/conditionManagers.js
//
// Quem é o gestor responsável por cada módulo da Ficha Comercial.
//
// O campo tem dois modos (ver enterpriseConditionModule.js):
//   'sistema' → manager_user_id aponta para um usuário do Office;
//   'manual'  → contato EXTERNO digitado à mão (nome/e-mail/telefone).
//
// Resolver o id exige ler `users` incluindo os INATIVOS. A tela sempre ofereceu
// só usuários ativos no select, então quando alguém sai da empresa o gestor da
// ficha simplesmente sumia do formulário e do PDF - a ficha parecia não ter
// responsável. Aqui ele continua aparecendo, com `ativo: false`, para a tela
// poder cobrar a troca em vez de esconder o buraco.
import db from '../../models/sequelize/index.js';

const { User } = db;

/**
 * Mapa id → { id, nome, cargo, ativo } dos gestores citados nos módulos.
 *
 * @param {Array} modules linhas de enterprise_condition_modules (ou plains)
 * @returns {Promise<Map<number, {id:number, nome:string, cargo:string|null, ativo:boolean}>>}
 */
export async function loadManagerMap(modules = []) {
    const ids = [...new Set(
        modules.map(m => Number(m?.manager_user_id)).filter(n => Number.isFinite(n) && n > 0)
    )];
    if (!ids.length || !User) return new Map();

    const rows = await User.findAll({
        where: { id: ids },
        attributes: ['id', 'username', 'position', 'status'],
    });
    return new Map(rows.map(u => [Number(u.id), {
        id: Number(u.id),
        nome: u.username,
        cargo: u.position || null,
        ativo: u.status !== false,
    }]));
}

/**
 * O gestor de UM módulo, já resolvido, ou null quando o módulo não tem um.
 *
 * @returns {{nome:string, cargo:string|null, ativo:boolean, externo:boolean, user_id:number|null}|null}
 */
export function managerOf(mod, map) {
    if (!mod) return null;

    // Contato externo: não é usuário, não loga, não recebe notificação.
    if (mod.manager_mode === 'manual' || (!mod.manager_user_id && mod.manager_name)) {
        const nome = String(mod.manager_name || '').trim();
        return nome ? { nome, cargo: null, ativo: true, externo: true, user_id: null } : null;
    }

    const id = Number(mod.manager_user_id);
    if (!Number.isFinite(id) || id <= 0) return null;

    const u = map?.get(id);
    // Id órfão (usuário apagado): sem nome para mostrar, mas não é "sem gestor".
    if (!u) return { nome: `Usuário #${id}`, cargo: null, ativo: false, externo: false, user_id: id };

    return { nome: u.nome, cargo: u.cargo, ativo: u.ativo, externo: false, user_id: id };
}

/** Gestores distintos de uma ficha inteira, na ordem dos módulos. */
export function managersOfCondition(modules = [], map) {
    const out = [];
    const vistos = new Set();
    for (const mod of modules) {
        const g = managerOf(mod, map);
        if (!g) continue;
        const chave = g.user_id ? `u:${g.user_id}` : `x:${g.nome.toLowerCase()}`;
        if (vistos.has(chave)) continue;
        vistos.add(chave);
        out.push(g);
    }
    return out;
}

export default { loadManagerMap, managerOf, managersOfCondition };
