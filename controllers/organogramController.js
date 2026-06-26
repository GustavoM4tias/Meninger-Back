// controllers/organogramController.js
//
// Ajustes de exibição do organograma (camada sobre o layout automático).
// Leitura: qualquer autenticado (o organograma é visível a todos).
// Escrita: apenas admin (requireAdmin nas rotas). Não toca em manager_id/position.
import db from '../models/sequelize/index.js';
import responseHandler from '../utils/responseHandler.js';

const { OrganogramOverride } = db;

// GET /api/organogram/overrides
export const listOverrides = async (req, res) => {
    try {
        const overrides = await OrganogramOverride.findAll();
        return responseHandler.success(res, overrides);
    } catch (error) {
        return responseHandler.error(res, error);
    }
};

// Normaliza um campo opcional: undefined = não mexe; '' / null = limpa; resto = Number.
function normNullableNumber(value) {
    if (value === undefined) return undefined;
    if (value === null || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

// PUT /api/organogram/overrides/:userId  (upsert — admin)
// userId === 0 é a linha-sentinela do nó-raiz "empresa" (só guarda posição).
export const upsertOverride = async (req, res) => {
    const userId = Number(req.params.userId);
    if (!Number.isInteger(userId) || userId < 0) return responseHandler.error(res, 'Usuário inválido');

    const display_parent_id = normNullableNumber(req.body.display_parent_id);
    const display_order = normNullableNumber(req.body.display_order);
    const pos_x = normNullableNumber(req.body.pos_x);
    const pos_y = normNullableNumber(req.body.pos_y);

    if (display_parent_id === userId) {
        return responseHandler.error(res, 'Uma pessoa não pode ser posicionada sob ela mesma.');
    }

    try {
        // Raiz (0) não é um usuário real — pula a validação de existência.
        if (userId !== 0) {
            const user = await db.User.findByPk(userId);
            if (!user) return responseHandler.error(res, 'Usuário não encontrado', 404);
        }

        if (display_parent_id != null) {
            const parent = await db.User.findByPk(display_parent_id);
            if (!parent) return responseHandler.error(res, 'Pai visual inválido');

            // Previne ciclo direto A↔B (o pai escolhido já está posicionado sob este user).
            const parentOv = await OrganogramOverride.findOne({ where: { user_id: display_parent_id } });
            if (parentOv && parentOv.display_parent_id === userId) {
                return responseHandler.error(res, 'Isso criaria um ciclo no organograma.');
            }
        }

        // Upsert manual (não depende de ON CONFLICT) — só aplica os campos enviados.
        let ov = await OrganogramOverride.findOne({ where: { user_id: userId } });
        if (ov) {
            if (display_parent_id !== undefined) ov.display_parent_id = display_parent_id;
            if (display_order !== undefined) ov.display_order = display_order;
            if (pos_x !== undefined) ov.pos_x = pos_x;
            if (pos_y !== undefined) ov.pos_y = pos_y;
            await ov.save();
        } else {
            ov = await OrganogramOverride.create({
                user_id: userId,
                display_parent_id: display_parent_id ?? null,
                display_order: display_order ?? null,
                pos_x: pos_x ?? null,
                pos_y: pos_y ?? null,
            });
        }
        return responseHandler.success(res, ov);
    } catch (error) {
        return responseHandler.error(res, error);
    }
};

// DELETE /api/organogram/overrides/:userId  (reset de uma pessoa — admin; 0 = raiz)
export const deleteOverride = async (req, res) => {
    const userId = Number(req.params.userId);
    if (!Number.isInteger(userId) || userId < 0) return responseHandler.error(res, 'Usuário inválido');
    try {
        await OrganogramOverride.destroy({ where: { user_id: userId } });
        return responseHandler.success(res, { message: 'Ajustes removidos.' });
    } catch (error) {
        return responseHandler.error(res, error);
    }
};
