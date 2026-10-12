"use strict";

/**
 * Investigation workspace: idempotent event imports, sync history, and event-place links.
 * Additive only: existing tables keep their data, and every new column is nullable.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.addColumn("records", "external_id", { type: Sequelize.STRING(120), allowNull: true }, { transaction });
      await queryInterface.addColumn("records", "source_revision", { type: Sequelize.STRING(80), allowNull: true }, { transaction });
      // NULL external IDs stay allowed for records that are not imported from an external source.
      await queryInterface.addConstraint("records", {
        fields: ["source_id", "external_id"],
        type: "unique",
        name: "records_source_external_unique",
        transaction,
      });
      await queryInterface.addIndex("records", ["observed_at"], { name: "records_observed_at_idx", transaction });
      await queryInterface.addIndex("records", ["lat", "lon"], { name: "records_lat_lon_idx", transaction });

      await queryInterface.createTable("source_sync_runs", {
        id: { type: Sequelize.UUID, primaryKey: true, allowNull: false },
        source_id: {
          type: Sequelize.STRING(120),
          allowNull: false,
          references: { model: "data_sources", key: "id" },
          onUpdate: "CASCADE",
          onDelete: "RESTRICT",
        },
        status: { type: Sequelize.ENUM("running", "succeeded", "failed"), allowNull: false },
        started_at: { type: Sequelize.DATE, allowNull: false },
        finished_at: { type: Sequelize.DATE, allowNull: true },
        window_start: { type: Sequelize.DATE, allowNull: false },
        window_end: { type: Sequelize.DATE, allowNull: false },
        fetched_count: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
        inserted_count: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
        updated_count: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
        skipped_count: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
        error_code: { type: Sequelize.STRING(60), allowNull: true },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal("CURRENT_TIMESTAMP") },
        updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal("CURRENT_TIMESTAMP") },
      }, { transaction });
      await queryInterface.addIndex("source_sync_runs", ["source_id", "started_at"], { name: "source_sync_runs_source_started_idx", transaction });
      // At most one running import per source, enforced by the database rather than application timing.
      await queryInterface.addIndex("source_sync_runs", ["source_id"], {
        name: "source_sync_runs_one_running_idx",
        unique: true,
        where: { status: "running" },
        transaction,
      });

      await queryInterface.createTable("record_place_links", {
        record_id: {
          type: Sequelize.STRING(120),
          allowNull: false,
          primaryKey: true,
          references: { model: "records", key: "id" },
          onUpdate: "CASCADE",
          onDelete: "CASCADE",
        },
        place_id: {
          type: Sequelize.STRING(120),
          allowNull: false,
          primaryKey: true,
          references: { model: "places", key: "id" },
          onUpdate: "CASCADE",
          onDelete: "CASCADE",
        },
        relation: { type: Sequelize.STRING(40), allowNull: false, primaryKey: true },
        distance_meters: { type: Sequelize.INTEGER, allowNull: false },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal("CURRENT_TIMESTAMP") },
        updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal("CURRENT_TIMESTAMP") },
      }, { transaction });
      await queryInterface.addIndex("record_place_links", ["place_id"], { name: "record_place_links_place_idx", transaction });
    });
  },

  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.dropTable("record_place_links", { transaction });
      await queryInterface.dropTable("source_sync_runs", { transaction });
      await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_source_sync_runs_status";', { transaction });
      await queryInterface.removeIndex("records", "records_lat_lon_idx", { transaction });
      await queryInterface.removeIndex("records", "records_observed_at_idx", { transaction });
      await queryInterface.removeConstraint("records", "records_source_external_unique", { transaction });
      await queryInterface.removeColumn("records", "source_revision", { transaction });
      await queryInterface.removeColumn("records", "external_id", { transaction });
    });
  },
};
