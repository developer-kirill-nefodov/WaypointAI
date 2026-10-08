import { Sequelize } from "sequelize";
import { env } from "../config/env.js";

export const database = new Sequelize(env.DATABASE_URL, {
  dialect: "postgres",
  logging: false,
  pool: { max: 3, min: 0, acquire: 10_000, idle: 10_000 },
});
