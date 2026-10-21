"use strict";

/**
 * The journal of real chat turns (kept on this machine only, for a limited time): what was asked, which tools the
 * model called with which arguments, and signals that the turn went wrong. Reviewed entries become benchmark cases
 * and training examples. Settlement aliases let the server resolve names users actually write ("Норча" → Norcia).
 * Additive only.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.createTable("turn_journal", {
        id: { type: Sequelize.UUID, primaryKey: true, allowNull: false },
        request_id: { type: Sequelize.STRING(120), allowNull: false, unique: true },
        conversation_id: { type: Sequelize.STRING(120), allowNull: false },
        workspace_id: { type: Sequelize.STRING(120), allowNull: false },
        language: { type: Sequelize.STRING(2), allowNull: true },
        message: { type: Sequelize.STRING(2000), allowNull: false },
        model: { type: Sequelize.STRING(120), allowNull: false },
        tool_calls: { type: Sequelize.JSONB, allowNull: false, defaultValue: [] },
        first_tool: { type: Sequelize.STRING(40), allowNull: true },
        outcome: { type: Sequelize.STRING(20), allowNull: false },
        error_code: { type: Sequelize.STRING(60), allowNull: true },
        signals: { type: Sequelize.JSONB, allowNull: false, defaultValue: {} },
        feedback: { type: Sequelize.SMALLINT, allowNull: true },
        duration_ms: { type: Sequelize.INTEGER, allowNull: false },
        review_status: { type: Sequelize.STRING(20), allowNull: false, defaultValue: "new" },
        // The right first tool call, as confirmed by a person.
        corrected: { type: Sequelize.JSONB, allowNull: true },
        reviewed_at: { type: Sequelize.DATE, allowNull: true },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal("CURRENT_TIMESTAMP") },
        updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal("CURRENT_TIMESTAMP") },
      }, { transaction });
      await queryInterface.addIndex("turn_journal", ["created_at"], { name: "turn_journal_created_idx", transaction });
      await queryInterface.addIndex("turn_journal", ["conversation_id", "created_at"], { name: "turn_journal_conversation_idx", transaction });
      await queryInterface.addIndex("turn_journal", ["review_status"], { name: "turn_journal_review_idx", transaction });

      await queryInterface.createTable("settlement_aliases", {
        alias: { type: Sequelize.STRING(120), primaryKey: true, allowNull: false },
        place_id: { type: Sequelize.STRING(120), allowNull: false, references: { model: "places", key: "id" }, onUpdate: "CASCADE", onDelete: "CASCADE" },
        origin: { type: Sequelize.STRING(20), allowNull: false, defaultValue: "manual" },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal("CURRENT_TIMESTAMP") },
        updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal("CURRENT_TIMESTAMP") },
      }, { transaction });
      // Aliases are matched case-insensitively; the key is stored lower-cased by the application.
      await queryInterface.addIndex("settlement_aliases", ["place_id"], { name: "settlement_aliases_place_idx", transaction });
    });
  },

  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.dropTable("settlement_aliases", { transaction });
      await queryInterface.dropTable("turn_journal", { transaction });
    });
  },
};
