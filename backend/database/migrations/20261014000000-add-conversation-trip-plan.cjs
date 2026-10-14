"use strict";

/** The current trip plan of a conversation, so later turns can edit it instead of rebuilding it from scratch. */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn("assistant_conversations", "trip_plan", { type: Sequelize.JSONB, allowNull: true });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn("assistant_conversations", "trip_plan");
  },
};
