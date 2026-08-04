export default (sequelize, DataTypes) => {
  const EmeValidationIncident = sequelize.define('EmeValidationIncident', {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    session_id: { type: DataTypes.UUID, allowNull: true },
    message_id: { type: DataTypes.UUID, allowNull: true },
    user_id: { type: DataTypes.INTEGER, allowNull: true },
    // Desfecho do turno após a validação anti-alucinação:
    //  corrected - a reescrita automática limpou todas as divergências
    //  blocked   - divergência persistiu e o texto foi SUBSTITUÍDO pelos dados reais
    //  warned    - divergência sem dados autoritativos p/ reescrever; entregue com aviso
    outcome: { type: DataTypes.ENUM('corrected', 'blocked', 'warned'), allowNull: false },
    attempts: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    // Valores/nomes acusados pelo detector: [{ value, parsed, kind }]
    suspicious: { type: DataTypes.JSONB, allowNull: true, defaultValue: null },
    original_text: { type: DataTypes.TEXT, allowNull: true },
    final_text: { type: DataTypes.TEXT, allowNull: true },
    // Snapshot do turno: pergunta do usuário, modelo/pool, tools chamadas, latência.
    context: { type: DataTypes.JSONB, allowNull: true, defaultValue: null },
    // Triagem no Brain Studio (aba Validação): admin marca como revisado.
    reviewed: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  }, {
    tableName: 'eme_validation_incidents',
    underscored: true,
    timestamps: true,
  });
  return EmeValidationIncident;
};
