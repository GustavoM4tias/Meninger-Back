// models/sequelize/reservaCancel/reservaCancelEvent.js
//
// Timeline append-only do processamento de um cancelamento. Nenhuma row é
// editada/apagada — só inserida. Alimenta o modal de detalhe no frontend.
//
// Tipos previstos (não-exaustivo):
//   received            Webhook recebido / disparo manual
//   reserva_loaded      Reserva consultada no CV (com evidência de cancelamento)
//   contract_found      Contrato localizado no Sienge (externalId)
//   contract_none       Nenhum contrato ativo p/ a reserva no Sienge
//   check_passed        Validação individual aprovada
//   check_failed        Validação individual reprovada (gera blocked)
//   unit_stock          Consulta de disponibilidade da unidade no Sienge
//   contract_deleted    DELETE executado no Sienge
//   delete_confirmed    Releitura confirmou que o contrato sumiu
//   cv_unit_released    Unidade disponibilizada no CV
//   cv_message_sent     Mensagem registrada na reserva CV
//   blocked             Fluxo barrado (pendência manual)
//   error               Erro técnico
export default (sequelize, DataTypes) => {
    const ReservaCancelEvent = sequelize.define('ReservaCancelEvent', {
        id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },

        history_id: {
            type: DataTypes.INTEGER,
            allowNull: false,
            comment: 'FK lógica pra reserva_cancel_history.id (sem constraint pra simplificar deletes).',
        },
        idreserva: {
            type: DataTypes.INTEGER,
            allowNull: false,
            comment: 'Duplicado pra facilitar query por reserva sem join.',
        },
        type: { type: DataTypes.STRING(40), allowNull: false },
        severity: {
            type: DataTypes.STRING(10),
            defaultValue: 'info',
            comment: 'info | warning | error | success',
        },
        message: { type: DataTypes.TEXT, allowNull: true },
        data: {
            type: DataTypes.TEXT,
            allowNull: true,
            get() {
                const raw = this.getDataValue('data');
                if (!raw) return null;
                try { return JSON.parse(raw); } catch { return null; }
            },
            set(val) {
                if (val == null) { this.setDataValue('data', null); return; }
                this.setDataValue('data', JSON.stringify(val));
            },
        },
    }, {
        tableName: 'reserva_cancel_events',
        underscored: true,
        timestamps: true,
        updatedAt: false, // append-only
        indexes: [
            { fields: ['history_id'] },
            { fields: ['idreserva'] },
        ],
    });

    ReservaCancelEvent.associate = () => {};
    return ReservaCancelEvent;
};
