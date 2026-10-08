"use strict";

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable("assistant_conversations", {
      id: { type: Sequelize.UUID, primaryKey: true, allowNull: false },
      workspace_id: { type: Sequelize.STRING(120), allowNull: false },
      messages: { type: Sequelize.JSONB, allowNull: false, defaultValue: [] },
      expires_at: { type: Sequelize.DATE, allowNull: false },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal("CURRENT_TIMESTAMP") },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal("CURRENT_TIMESTAMP") },
    });
    await queryInterface.addIndex("assistant_conversations", ["workspace_id", "expires_at"], { name: "assistant_conversations_workspace_expiry_idx" });
  },

  async down(queryInterface) {
    await queryInterface.dropTable("assistant_conversations");
  },
};
