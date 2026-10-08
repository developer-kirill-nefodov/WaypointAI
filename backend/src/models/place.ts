import { DataTypes, Model, type Sequelize } from "sequelize";

export class Place extends Model {
  declare id: string;
  declare sourceId: string;
  declare osmType: string;
  declare osmId: string;
  declare name: string;
  declare category: string | null;
  declare countryCode: string | null;
  declare region: string | null;
  declare city: string | null;
  declare postcode: string | null;
  declare street: string | null;
  declare houseNumber: string | null;
  declare lat: number;
  declare lon: number;
  declare tags: Record<string, unknown>;
  declare importToken: string;
}

export function initPlaceModel(sequelize: Sequelize): void {
  Place.init({
    id: { type: DataTypes.STRING(120), primaryKey: true },
    sourceId: { type: DataTypes.STRING(120), allowNull: false, field: "source_id" },
    osmType: { type: DataTypes.STRING(12), allowNull: false, field: "osm_type" },
    osmId: { type: DataTypes.STRING(40), allowNull: false, field: "osm_id" },
    name: { type: DataTypes.STRING(240), allowNull: false },
    category: { type: DataTypes.STRING(120), allowNull: true },
    countryCode: { type: DataTypes.STRING(2), allowNull: true, field: "country_code" },
    region: { type: DataTypes.STRING(160), allowNull: true },
    city: { type: DataTypes.STRING(160), allowNull: true },
    postcode: { type: DataTypes.STRING(32), allowNull: true },
    street: { type: DataTypes.STRING(200), allowNull: true },
    houseNumber: { type: DataTypes.STRING(80), allowNull: true, field: "house_number" },
    lat: { type: DataTypes.DOUBLE, allowNull: false },
    lon: { type: DataTypes.DOUBLE, allowNull: false },
    tags: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
    importToken: { type: DataTypes.STRING(80), allowNull: false, field: "import_token" },
  }, { sequelize, tableName: "places", underscored: true, timestamps: true });
}
