"use strict";

/**
 * Teaching the assistant without changing model weights: lessons (rules and approved examples) that the backend adds
 * to the prompt, and an exam (cases, runs, results) that measures how answers change. Additive only.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const timestamps = {
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal("CURRENT_TIMESTAMP") },
        updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal("CURRENT_TIMESTAMP") },
      };
      await queryInterface.createTable("lessons", {
        id: { type: Sequelize.UUID, primaryKey: true, allowNull: false },
        kind: { type: Sequelize.STRING(20), allowNull: false },
        topic: { type: Sequelize.STRING(20), allowNull: false },
        title: { type: Sequelize.STRING(120), allowNull: false },
        // Rule text, or the user's question of an example.
        text: { type: Sequelize.STRING(500), allowNull: false },
        example_tool: { type: Sequelize.STRING(40), allowNull: true },
        example_args: { type: Sequelize.JSONB, allowNull: true },
        example_answer: { type: Sequelize.STRING(600), allowNull: true },
        enabled: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
        version: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 1 },
        applied_count: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
        last_applied_at: { type: Sequelize.DATE, allowNull: true },
        ...timestamps,
      }, { transaction });

      await queryInterface.createTable("eval_cases", {
        id: { type: Sequelize.STRING(80), primaryKey: true, allowNull: false },
        question: { type: Sequelize.STRING(300), allowNull: false },
        language: { type: Sequelize.STRING(2), allowNull: false },
        // Checks: expected tool and argument subset, required and forbidden text, citations, sentence limit.
        expect: { type: Sequelize.JSONB, allowNull: false },
        enabled: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
        ...timestamps,
      }, { transaction });

      await queryInterface.createTable("eval_runs", {
        id: { type: Sequelize.UUID, primaryKey: true, allowNull: false },
        status: { type: Sequelize.STRING(20), allowNull: false },
        with_lessons: { type: Sequelize.BOOLEAN, allowNull: false },
        // Lessons enabled when the run started, so a score can be tied to what the model was taught.
        lesson_ids: { type: Sequelize.JSONB, allowNull: false, defaultValue: [] },
        model: { type: Sequelize.STRING(120), allowNull: false },
        label: { type: Sequelize.STRING(120), allowNull: true },
        case_count: { type: Sequelize.INTEGER, allowNull: false },
        cases_done: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
        checks_total: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
        checks_passed: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
        cases_passed: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
        error_code: { type: Sequelize.STRING(60), allowNull: true },
        started_at: { type: Sequelize.DATE, allowNull: false },
        finished_at: { type: Sequelize.DATE, allowNull: true },
        ...timestamps,
      }, { transaction });
      await queryInterface.addIndex("eval_runs", ["started_at"], { name: "eval_runs_started_idx", transaction });

      await queryInterface.createTable("eval_results", {
        run_id: { type: Sequelize.UUID, allowNull: false, primaryKey: true, references: { model: "eval_runs", key: "id" }, onUpdate: "CASCADE", onDelete: "CASCADE" },
        case_id: { type: Sequelize.STRING(80), allowNull: false, primaryKey: true },
        // The case as it was asked, so later edits to the case do not rewrite history.
        question: { type: Sequelize.STRING(300), allowNull: false },
        passed: { type: Sequelize.BOOLEAN, allowNull: false },
        checks: { type: Sequelize.JSONB, allowNull: false },
        tool_calls: { type: Sequelize.JSONB, allowNull: false },
        answer: { type: Sequelize.TEXT, allowNull: false },
        applied_lessons: { type: Sequelize.JSONB, allowNull: false, defaultValue: [] },
        duration_ms: { type: Sequelize.INTEGER, allowNull: false },
        error_code: { type: Sequelize.STRING(60), allowNull: true },
        ...timestamps,
      }, { transaction });
    });
  },

  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.dropTable("eval_results", { transaction });
      await queryInterface.dropTable("eval_runs", { transaction });
      await queryInterface.dropTable("eval_cases", { transaction });
      await queryInterface.dropTable("lessons", { transaction });
    });
  },
};
