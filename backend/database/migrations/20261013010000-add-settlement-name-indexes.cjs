"use strict";

/**
 * Partial expression indexes for resolving settlement names in investigation queries.
 * Only settlement rows (about 26,000 in the demo extracts) are indexed, so the indexes stay small.
 */
const SETTLEMENT_FILTER = "category IN ('place:city', 'place:town', 'place:village', 'place:suburb', 'place:hamlet')";

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`CREATE INDEX IF NOT EXISTS places_settlement_lower_name_idx ON places (lower(name)) WHERE ${SETTLEMENT_FILTER}`);
    await queryInterface.sequelize.query(`CREATE INDEX IF NOT EXISTS places_settlement_lower_name_en_idx ON places (lower(tags->>'name:en')) WHERE ${SETTLEMENT_FILTER}`);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query("DROP INDEX IF EXISTS places_settlement_lower_name_en_idx");
    await queryInterface.sequelize.query("DROP INDEX IF EXISTS places_settlement_lower_name_idx");
  },
};
