"use strict";

/**
 * Training examples written by the teacher (an OpenAI model) for router fine-tuning, in batches per topic. Every
 * example keeps the result of the automatic checks; accepted batches go into the dataset. Additive only.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.createTable("teacher_batches", {
        id: { type: Sequelize.UUID, primaryKey: true, allowNull: false },
        topic: { type: Sequelize.STRING(40), allowNull: false },
        languages: { type: Sequelize.JSONB, allowNull: false, defaultValue: [] },
        requested: { type: Sequelize.INTEGER, allowNull: false },
        // Examples asked of the teacher, regenerations included: what the daily limit counts.
        generated: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
        model: { type: Sequelize.STRING(80), allowNull: false },
        cross_check: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
        // generating, review, accepted, failed, cancelled, or deleted (examples removed; kept for the daily limit)
        status: { type: Sequelize.STRING(20), allowNull: false, defaultValue: "generating" },
        error_code: { type: Sequelize.STRING(60), allowNull: true },
        prompt_tokens: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
        completion_tokens: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
        finished_at: { type: Sequelize.DATE, allowNull: true },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal("CURRENT_TIMESTAMP") },
        updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal("CURRENT_TIMESTAMP") },
      }, { transaction });
      await queryInterface.addIndex("teacher_batches", ["created_at"], { name: "teacher_batches_created_idx", transaction });

      await queryInterface.createTable("teacher_examples", {
        id: { type: Sequelize.UUID, primaryKey: true, allowNull: false },
        batch_id: { type: Sequelize.UUID, allowNull: false, references: { model: "teacher_batches", key: "id" }, onUpdate: "CASCADE", onDelete: "CASCADE" },
        question: { type: Sequelize.STRING(500), allowNull: false },
        language: { type: Sequelize.STRING(2), allowNull: false },
        tool: { type: Sequelize.STRING(40), allowNull: false },
        args: { type: Sequelize.JSONB, allowNull: false, defaultValue: {} },
        // passed, disputed, rejected, or edited (changed or approved by a person)
        status: { type: Sequelize.STRING(20), allowNull: false },
        reasons: { type: Sequelize.JSONB, allowNull: false, defaultValue: [] },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal("CURRENT_TIMESTAMP") },
        updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal("CURRENT_TIMESTAMP") },
      }, { transaction });
      await queryInterface.addIndex("teacher_examples", ["batch_id", "status"], { name: "teacher_examples_batch_idx", transaction });
    });
  },

  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.dropTable("teacher_examples", { transaction });
      await queryInterface.dropTable("teacher_batches", { transaction });
    });
  },
};
