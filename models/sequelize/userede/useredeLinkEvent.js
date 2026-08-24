// models/sequelize/userede/useredeLinkEvent.js
//
// Timeline do link de cartão - espelho append-only do `boleto_events`.
//
// Tabela separada em vez de coluna `forma` no boleto_events pelo mesmo motivo
// do histórico: aquela tabela é produção e a coluna se chama
// `boleto_history_id`. Guardar id de cartão nela seria uma mentira no nome.
// A leitura junta as duas - ver services/cobrancaAto/eventoService.js.
//
// Tipos canônicos (os mesmos do boleto, mais os próprios do cartão):
//   emitted, link_created, cv_message_sent/failed, cv_situation[_changed/failed],
//   client_email[_skipped], client_whatsapp[_skipped],
//   payment_check[_error], paid, expired, denied, refunded,
//   link_deleted, ignored_duplicate, replaced
export default (sequelize, DataTypes) => {
    const UseredeLinkEvent = sequelize.define('UseredeLinkEvent', {
        id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
        link_history_id: { type: DataTypes.INTEGER, allowNull: false },
        idreserva: { type: DataTypes.INTEGER, allowNull: false },
        type: { type: DataTypes.STRING(40), allowNull: false },
        severity: { type: DataTypes.STRING(10), defaultValue: 'info' },
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
        tableName: 'userede_link_events',
        underscored: true,
        timestamps: true,
        updatedAt: false,   // append-only: evento não se edita
    });

    UseredeLinkEvent.associate = () => {};
    return UseredeLinkEvent;
};
