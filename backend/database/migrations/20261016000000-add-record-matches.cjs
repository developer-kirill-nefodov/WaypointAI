"use strict";

/**
 * Cross-checks between event catalogues: the same earthquake reported by two sources (for example INGV and USGS).
 * Derived data computed at import; each pair is stored once with the smaller record ID first. Additive only.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const recordReference = { model: "records", key: "id" };
      await queryInterface.createTable("record_matches", {
        record_id: { type: Sequelize.STRING(120), allowNull: false, primaryKey: true, references: recordReference, onUpdate: "CASCADE", onDelete: "CASCADE" },
        matched_record_id: { type: Sequelize.STRING(120), allowNull: false, primaryKey: true, references: recordReference, onUpdate: "CASCADE", onDelete: "CASCADE" },
        time_delta_ms: { type: Sequelize.INTEGER, allowNull: false },
        distance_meters: { type: Sequelize.INTEGER, allowNull: false },
        magnitude_delta: { type: Sequelize.REAL, allowNull: true },
        depth_delta_km: { type: Sequelize.REAL, allowNull: true },
        consistent: { type: Sequelize.BOOLEAN, allowNull: false },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal("CURRENT_TIMESTAMP") },
        updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal("CURRENT_TIMESTAMP") },
      }, { transaction });
      await queryInterface.addIndex("record_matches", ["matched_record_id"], { name: "record_matches_matched_idx", transaction });
      await queryInterface.sequelize.query(
        "ALTER TABLE record_matches ADD CONSTRAINT record_matches_ordered CHECK (record_id < matched_record_id)",
        { transaction },
      );
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable("record_matches");
  },
};
