// utils/userEmail.js
//
// E-mail de usuário SEMPRE minúsculo e comparado sem case.
//
// O UNIQUE de users.email no Postgres diferencia maiúsculas ("Fulano@..." e
// "fulano@..." convivem), e o login Microsoft devolve o mail com a
// capitalização do Azure. Sem normalizar, o mesmo funcionário cadastrado à mão
// pelo admin vira um SEGUNDO usuário no primeiro login Microsoft — cai na fila
// de aprovação e duplica a pessoa no organograma.
import db from '../models/sequelize/index.js';

export function normalizeEmail(value) {
    return String(value || '').trim().toLowerCase();
}

/** Busca usuário por e-mail SEM diferenciar maiúsculas/minúsculas. */
export async function findUserByEmailCI(email, { excludeId = null } = {}) {
    const norm = normalizeEmail(email);
    if (!norm) return null;
    const { fn, col, where, Op } = db.Sequelize;
    const conditions = [where(fn('lower', col('email')), norm)];
    if (excludeId != null) conditions.push({ id: { [Op.ne]: Number(excludeId) } });
    return db.User.findOne({ where: { [Op.and]: conditions } });
}
