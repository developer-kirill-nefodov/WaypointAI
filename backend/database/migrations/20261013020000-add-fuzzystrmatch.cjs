"use strict";

/**
 * fuzzystrmatch (PostgreSQL contrib) provides levenshtein() for approximate settlement-name matching
 * when a model transliterates a name slightly differently, for example "Norchi" for Norcia.
 */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query("CREATE EXTENSION IF NOT EXISTS fuzzystrmatch");
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query("DROP EXTENSION IF EXISTS fuzzystrmatch");
  },
};
