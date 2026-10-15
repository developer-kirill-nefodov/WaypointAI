"use strict";

/**
 * An import job started from the app: one or more event sources over a period, with progress per source.
 * Each source still records its own audit row in source_sync_runs; the job ties them together for the UI.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable("import_jobs", {
      id: { type: Sequelize.UUID, primaryKey: true },
      workspace_id: { type: Sequelize.STRING(120), allowNull: false },
      status: { type: Sequelize.STRING(20), allowNull: false },
      params: { type: Sequelize.JSONB, allowNull: false },
      progress: { type: Sequelize.REAL, allowNull: false, defaultValue: 0 },
      sources: { type: Sequelize.JSONB, allowNull: false, defaultValue: [] },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
      finished_at: { type: Sequelize.DATE, allowNull: true },
    });
    await queryInterface.addIndex("import_jobs", ["workspace_id", "created_at"], { name: "import_jobs_workspace_created_idx" });
  },

  async down(queryInterface) {
    await queryInterface.dropTable("import_jobs");
  },
};
