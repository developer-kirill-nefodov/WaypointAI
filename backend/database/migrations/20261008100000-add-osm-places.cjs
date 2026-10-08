"use strict";

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn("data_sources", "source_url", { type: Sequelize.TEXT, allowNull: true });
    await queryInterface.addColumn("data_sources", "license", { type: Sequelize.STRING(120), allowNull: true });
    await queryInterface.createTable("places", {
      id: { type: Sequelize.STRING(120), primaryKey: true, allowNull: false },
      source_id: { type: Sequelize.STRING(120), allowNull: false, references: { model: "data_sources", key: "id" }, onUpdate: "CASCADE", onDelete: "RESTRICT" },
      osm_type: { type: Sequelize.STRING(12), allowNull: false },
      osm_id: { type: Sequelize.STRING(40), allowNull: false },
      name: { type: Sequelize.STRING(240), allowNull: false },
      category: { type: Sequelize.STRING(120), allowNull: true },
      country_code: { type: Sequelize.STRING(2), allowNull: true },
      region: { type: Sequelize.STRING(160), allowNull: true },
      city: { type: Sequelize.STRING(160), allowNull: true },
      postcode: { type: Sequelize.STRING(32), allowNull: true },
      street: { type: Sequelize.STRING(200), allowNull: true },
      house_number: { type: Sequelize.STRING(80), allowNull: true },
      lat: { type: Sequelize.DOUBLE, allowNull: false },
      lon: { type: Sequelize.DOUBLE, allowNull: false },
      tags: { type: Sequelize.JSONB, allowNull: false, defaultValue: {} },
      import_token: { type: Sequelize.STRING(80), allowNull: false },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal("CURRENT_TIMESTAMP") },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal("CURRENT_TIMESTAMP") },
    });
    await queryInterface.addConstraint("places", { fields: ["osm_type", "osm_id", "source_id"], type: "unique", name: "places_source_osm_unique" });
    await queryInterface.addIndex("places", ["source_id", "category"], { name: "places_source_category_idx" });
    await queryInterface.addIndex("places", ["lat", "lon"], { name: "places_lat_lon_idx" });
    await queryInterface.addIndex("places", ["name"], { name: "places_name_idx" });
    await queryInterface.addColumn("records", "place_id", {
      type: Sequelize.STRING(120), allowNull: true,
      references: { model: "places", key: "id" }, onUpdate: "CASCADE", onDelete: "SET NULL",
    });
    await queryInterface.addIndex("records", ["place_id"], { name: "records_place_id_idx" });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn("records", "place_id");
    await queryInterface.dropTable("places");
    await queryInterface.removeColumn("data_sources", "license");
    await queryInterface.removeColumn("data_sources", "source_url");
  },
};
