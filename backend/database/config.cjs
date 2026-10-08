require("dotenv").config({ path: require("node:path").resolve(__dirname, "../../.env") });

const common = {
  dialect: "postgres",
  logging: false,
  dialectOptions: {},
};

module.exports = {
  development: { ...common, use_env_variable: "DATABASE_URL" },
  test: { ...common, use_env_variable: "DATABASE_URL" },
  production: { ...common, use_env_variable: "DATABASE_URL", dialectOptions: { ssl: { require: true, rejectUnauthorized: true } } },
};
