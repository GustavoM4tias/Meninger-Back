// models/sequelize/contractAdjustment.js
//
// Ajustes contábeis sobre o dado do contrato (Faturamento).
//
// É uma MÁSCARA: nada é gravado na tabela `contracts` (que é espelho do backup
// do Sienge e é reescrita a cada sync). O ajuste vive aqui e é aplicado na
// leitura, sempre no backend, para que dashboard, modal de detalhe, exportação,
// fechamento mensal e as tools da Eme enxerguem exatamente o mesmo número.
//
// Tipos:
//   FI_DATE    → troca a data da instituição financeira do contrato. Como essa
//                data é o recorte do período no dashboard, o ajuste MOVE a venda
//                de mês. Aplicado no SQL (WHERE + SELECT).
//   SERIE_ADD  → acrescenta uma condição de pagamento (série) que não existe no
//                Sienge. A série entra marcada como adicionada.
//   SERIE_EDIT → sobrescreve campos de uma série existente. Só os campos
//                presentes no payload substituem o original.
//
// A série alvo do SERIE_EDIT é identificada por índice + código (o payload do
// Sienge não tem id próprio por condição). Se o índice deixar de casar com o
// código depois de um sync, o ajuste vira ÓRFÃO: não é aplicado em silêncio,
// aparece como pendência na aba de Ajustes contábeis.
export default (sequelize, DataTypes) => {
    return sequelize.define('ContractAdjustment', {
        id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },

        // contracts.id é BIGINT
        contract_id: { type: DataTypes.BIGINT, allowNull: false },

        // STRING (não ENUM) para não travar o sync({ alter: true }).
        type: { type: DataTypes.STRING(24), allowNull: false },

        // Snapshots para filtro/rótulo sem precisar de join no contrato.
        enterprise_id: { type: DataTypes.INTEGER, allowNull: true },
        enterprise_name: { type: DataTypes.STRING(255), allowNull: true },
        customer_name: { type: DataTypes.STRING(255), allowNull: true },
        unit_name: { type: DataTypes.STRING(255), allowNull: true },

        // Alvo da edição de série
        target_index: { type: DataTypes.INTEGER, allowNull: true },
        target_code: { type: DataTypes.STRING(32), allowNull: true },

        payload: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
        original: { type: DataTypes.JSONB, allowNull: true },

        // Motivo contábil — obrigatório, é o que sustenta a auditoria.
        reason: { type: DataTypes.TEXT, allowNull: false },

        active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },

        // Vigilância do dado de origem. O ajuste é criado sobre uma foto do
        // contrato (`original`); se o Sienge mudar depois, ninguém pode
        // descobrir isso por acaso.
        //   active        → origem igual à foto, máscara valendo
        //   needs_review  → a origem mudou (ou a série sumiu): a máscara CONTINUA
        //                   valendo, para o número não se mexer sozinho, e o
        //                   admin é notificado para decidir
        //   auto_resolved → o Sienge passou a trazer exatamente o valor ajustado;
        //                   a máscara vira redundante e sai de cena em silêncio
        status: { type: DataTypes.STRING(24), allowNull: false, defaultValue: 'active' },
        // Explicação em português do que mudou — é o que a tela mostra.
        status_message: { type: DataTypes.STRING(500), allowNull: true },
        source_current: { type: DataTypes.JSONB, allowNull: true },
        source_changed_at: { type: DataTypes.DATE, allowNull: true },
        checked_at: { type: DataTypes.DATE, allowNull: true },
        reviewed_at: { type: DataTypes.DATE, allowNull: true },
        reviewed_by_id: { type: DataTypes.INTEGER, allowNull: true },
        reviewed_by_name: { type: DataTypes.STRING(255), allowNull: true },

        created_by_id: { type: DataTypes.INTEGER, allowNull: true },
        created_by_name: { type: DataTypes.STRING(255), allowNull: true },
        updated_by_id: { type: DataTypes.INTEGER, allowNull: true },
        updated_by_name: { type: DataTypes.STRING(255), allowNull: true }
    }, {
        tableName: 'contract_adjustments',
        underscored: true,
        timestamps: true
    })
}
