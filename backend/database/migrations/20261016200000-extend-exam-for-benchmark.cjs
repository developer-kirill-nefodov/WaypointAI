"use strict";

/**
 * The exam becomes a benchmark: cases record the skill they test and where they came from (hand-written, generated
 * from the database, or confirmed from the journal), and runs can check only the first step (the tool call) and keep
 * per-skill metrics. Additive only; existing cases become hand-written "starter" cases.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.addColumn("eval_cases", "skill", { type: Sequelize.STRING(20), allowNull: false, defaultValue: "other" }, { transaction });
      await queryInterface.addColumn("eval_cases", "origin", { type: Sequelize.STRING(20), allowNull: false, defaultValue: "manual" }, { transaction });
      await queryInterface.addIndex("eval_cases", ["origin"], { name: "eval_cases_origin_idx", transaction });
      await queryInterface.sequelize.query(
        `UPDATE eval_cases SET origin = 'starter',
           skill = CASE
             WHEN expect->>'tool' = 'search_places' THEN 'places'
             WHEN expect->>'tool' = 'search_events' THEN 'events'
             WHEN expect->>'tool' = 'plan_trip' THEN 'trips'
             WHEN expect->>'tool' = 'list_sources' THEN 'sources'
             WHEN expect->>'tool' = 'reply' THEN 'reply'
             ELSE 'other' END
         WHERE id LIKE 'starter-%'`,
        { transaction },
      );
      await queryInterface.addColumn("eval_runs", "mode", { type: Sequelize.STRING(20), allowNull: false, defaultValue: "full" }, { transaction });
      // Which cases were asked (origins), and the per-skill metrics computed when the run ends.
      await queryInterface.addColumn("eval_runs", "case_origins", { type: Sequelize.JSONB, allowNull: false, defaultValue: [] }, { transaction });
      await queryInterface.addColumn("eval_runs", "metrics", { type: Sequelize.JSONB, allowNull: true }, { transaction });
      await queryInterface.addColumn("eval_results", "skill", { type: Sequelize.STRING(20), allowNull: false, defaultValue: "other" }, { transaction });
      await queryInterface.addColumn("eval_results", "language", { type: Sequelize.STRING(2), allowNull: true }, { transaction });
    });
  },

  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.removeColumn("eval_results", "language", { transaction });
      await queryInterface.removeColumn("eval_results", "skill", { transaction });
      await queryInterface.removeColumn("eval_runs", "metrics", { transaction });
      await queryInterface.removeColumn("eval_runs", "case_origins", { transaction });
      await queryInterface.removeColumn("eval_runs", "mode", { transaction });
      await queryInterface.removeIndex("eval_cases", "eval_cases_origin_idx", { transaction });
      await queryInterface.removeColumn("eval_cases", "origin", { transaction });
      await queryInterface.removeColumn("eval_cases", "skill", { transaction });
    });
  },
};
