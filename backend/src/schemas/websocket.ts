import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const Ajv2020 = require("ajv/dist/2020.js") as typeof import("ajv/dist/2020.js").default;
const addFormats = require("ajv-formats") as typeof import("ajv-formats").default;
const schemaPath = fileURLToPath(new URL("../../../contracts/websocket.schema.json", import.meta.url));
const protocolSchema = JSON.parse(readFileSync(schemaPath, "utf8")) as { $id: string };
const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
ajv.addSchema(protocolSchema);

export const validateClientFrame = ajv.getSchema(`${protocolSchema.$id}#/$defs/clientFrame`);
