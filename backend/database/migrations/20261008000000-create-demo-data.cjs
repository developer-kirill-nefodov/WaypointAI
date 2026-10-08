"use strict";

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable("data_sources", {
      id: { type: Sequelize.STRING(120), primaryKey: true, allowNull: false },
      label: { type: Sequelize.STRING(200), allowNull: false },
      mode: { type: Sequelize.ENUM("synthetic_local", "public_snapshot", "approved_live", "client_api"), allowNull: false },
      status: { type: Sequelize.ENUM("ready", "unavailable"), allowNull: false, defaultValue: "ready" },
      attribution: { type: Sequelize.TEXT, allowNull: true },
      snapshot_date: { type: Sequelize.DATEONLY, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal("CURRENT_TIMESTAMP") },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal("CURRENT_TIMESTAMP") },
    });

    await queryInterface.createTable("records", {
      id: { type: Sequelize.STRING(120), primaryKey: true, allowNull: false },
      source_id: { type: Sequelize.STRING(120), allowNull: false, references: { model: "data_sources", key: "id" }, onUpdate: "CASCADE", onDelete: "RESTRICT" },
      observed_at: { type: Sequelize.DATE, allowNull: false },
      lat: { type: Sequelize.DOUBLE, allowNull: false },
      lon: { type: Sequelize.DOUBLE, allowNull: false },
      accuracy_meters: { type: Sequelize.DOUBLE, allowNull: true },
      category: { type: Sequelize.STRING(120), allowNull: false },
      attributes: { type: Sequelize.JSONB, allowNull: false, defaultValue: {} },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal("CURRENT_TIMESTAMP") },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal("CURRENT_TIMESTAMP") },
    });
    await queryInterface.addIndex("records", ["source_id", "observed_at"]);
    await queryInterface.addIndex("records", ["category"]);
  },

  async down(queryInterface) {
    await queryInterface.dropTable("records");
    await queryInterface.dropTable("data_sources");
    await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_data_sources_mode";');
    await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_data_sources_status";');
  },
};
