/*
Copyright 2019 The Matrix.org Foundation C.I.C.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

import { Pool } from "pg";

// eslint-disable-next-line @typescript-eslint/no-duplicate-imports

import { MatrixUser, MatrixRoom, RemoteRoom, Entry } from "matrix-appservice-bridge";
import { DataStore, RoomOrigin, ChannelMappings, UserFeatures } from "../DataStore";
import { IrcRoom } from "../../models/IrcRoom";
import { IrcClientConfig } from "../../models/IrcClientConfig";
import { IrcServer, IrcServerConfig } from "../../irc/IrcServer";

import * as logging from "../../logging";
import Bluebird from "bluebird";
import { stat } from "fs";
import { StringCrypto } from "../StringCrypto";

const log = logging.get("PgDatastore");

export class PgDataStore implements DataStore {
    private serverMappings: {[domain: string]: IrcServer} = {};

    public static readonly LATEST_SCHEMA = 1;
    private pgPool: Pool;
    private cryptoStore?: StringCrypto;

    constructor(private bridgeDomain: string, connectionString: string, pkeyPath?: string, min: number = 1, max: number = 4) {
        this.pgPool = new Pool({
            connectionString,
            min,
            max,
        });
        if (pkeyPath) {
            this.cryptoStore = new StringCrypto();
            this.cryptoStore.load(pkeyPath);
        }
        process.on("beforeExit", (e) => {
            // Ensure we clean up on exit
            this.pgPool.end();
        })        
    }

    public async setServerFromConfig(server: IrcServer, serverConfig: IrcServerConfig): Promise<void> {
        this.serverMappings[server.domain] = server;

        for (const channel of Object.keys(serverConfig.mappings)) {
            const ircRoom = new IrcRoom(server, channel);
            for (const roomId of serverConfig.mappings[channel]) {
                const mxRoom = new MatrixRoom(roomId);
                await this.storeRoom(ircRoom, mxRoom, "config");
            }
        }
    }

    public async storeRoom(ircRoom: IrcRoom, matrixRoom: MatrixRoom, origin: RoomOrigin): Promise<void> {
        if (typeof origin !== "string") {
            throw new Error('Origin must be a string = "config"|"provision"|"alias"|"join"');
        }
        log.info("storeRoom (id=%s, addr=%s, chan=%s, origin=%s)",
            matrixRoom.getId(), ircRoom.getDomain(), ircRoom.channel, origin);
        this.upsertRoom(
            origin,
            ircRoom.getType(),
            ircRoom.getDomain(),
            ircRoom.getChannel(),
            matrixRoom.getId(),
            JSON.stringify(ircRoom.serialize()),
            JSON.stringify(matrixRoom.serialize()),
        );
    }

    public async upsertRoom(origin: RoomOrigin, type: string, domain: string, channel: string, roomId: string, ircJson: string, matrixJson: string) {
        const parameters = {
            origin,
            type,
            irc_domain: domain,
            irc_channel: channel,
            room_id: roomId,
            irc_json: ircJson,
            matrix_json: matrixJson,
        };
        const statement = PgDataStore.BuildUpsertStatement("rooms","ON CONSTRAINT cons_rooms_unique", Object.keys(parameters));
        await this.pgPool.query(statement, Object.values(parameters));
    }

    private static pgToRoomEntry(pgEntry: any): Entry {
        return {
            id: "",
            matrix: new MatrixRoom(pgEntry.room_id, JSON.parse(pgEntry.matrix_json)),
            remote: new RemoteRoom("", JSON.parse(pgEntry.irc_json)),
            matrix_id: pgEntry.room_id,
            remote_id: "foobar",
            data: {
                origin: pgEntry.origin,
            },
        };
    }

    public async getRoom(roomId: string, ircDomain: string, ircChannel: string, origin?: RoomOrigin): Promise<Entry | null> {
        let statement = "SELECT * FROM rooms WHERE room_id = $1, irc_domain = $2, irc_channel = $3";
        if (origin) {
            statement += ", origin = $4";
        }
        const pgEntry = await this.pgPool.query(statement, [roomId, ircDomain, ircChannel, origin]);
        if (!pgEntry.rowCount) {
            return null;
        }
        return PgDataStore.pgToRoomEntry(pgEntry.rows[0]);
    }

    public async getAllChannelMappings(): Promise<ChannelMappings> {
        const entries = (await this.pgPool.query("SELECT irc_domain, room_id, irc_channel FROM rooms WHERE type = 'channel'")).rows;

        const mappings: ChannelMappings = {};
        const validDomains = Object.keys(this.serverMappings);
        entries.forEach((e) => {
            if (!e.room_id) {
                return;
            }
            // Filter out servers we don't know about
            if (!validDomains.includes(e.irc_domain)) {
                return;
            }
            if (!mappings[e.room_id]) {
                mappings[e.room_id] = [];
            }
            mappings[e.room_id].push({
                networkId: this.serverMappings[e.irc_domain].getNetworkId(),
                channel: e.irc_channel,
            });
        })
    
        return mappings;
    }

    public getEntriesByMatrixId(roomId: string): Bluebird<Entry[]> {
        return Bluebird.cast(this.pgPool.query("SELECT * FROM rooms WHERE room_id = $1", [
            roomId
        ])).then((result) => result.rows).map((e) => PgDataStore.pgToRoomEntry(e));
    }

    public getProvisionedMappings(roomId: string): Bluebird<Entry[]> {
        return Bluebird.cast(this.pgPool.query("SELECT * FROM rooms WHERE room_id = $1 AND origin = 'provision'", [
            roomId
        ])).then((result) => result.rows).map((e) => PgDataStore.pgToRoomEntry(e));
    }

    public async removeRoom(roomId: string, ircDomain: string, ircChannel: string, origin: RoomOrigin): Promise<void> {
        await this.pgPool.query(
            "DELETE FROM rooms WHERE room_id = $1, irc_domain = $2, irc_channel = $3, origin = $4",
            [roomId, ircDomain, ircChannel, origin]
        );
    }

    public async getIrcChannelsForRoomId(roomId: string): Promise<IrcRoom[]> {
        const entries = await this.pgPool.query("SELECT irc_domain, irc_channel FROM rooms WHERE room_id = $1", [ roomId ]);
        return entries.rows.map((e) => {
            const server = this.serverMappings[e.irc_domain];
            if (!server) {
                // ! is used here because typescript doesn't understand the .filter
                return undefined!;
            }
            return new IrcRoom(server, e.irc_channel);
        }).filter((i) => i !== undefined);
    }

    public async getIrcChannelsForRoomIds(roomIds: string[]): Promise<{ [roomId: string]: IrcRoom[]; }> {
        const entries = await this.pgPool.query("SELECT room_id, irc_domain, irc_channel FROM rooms WHERE room_id IN $1", [
            roomIds
        ]);
        const mapping: { [roomId: string]: IrcRoom[]; } = {};
        entries.rows.forEach((e) => {
            const server = this.serverMappings[e.irc_domain];
            if (!server) {
                // ! is used here because typescript doesn't understand the .filter
                return;
            }
            if (!mapping[e.room_id]) {
                mapping[e.room_id] = [];
            }
            mapping[e.room_id].push(new IrcRoom(server, e.irc_channel));
        });
        return mapping;
    }

    public async getMatrixRoomsForChannel(server: IrcServer, channel: string): Promise<MatrixRoom[]> {
        const entries = await this.pgPool.query("SELECT room_id, matrix_json FROM rooms WHERE irc_domain = $1 AND irc_channel = $2",
        [
            server.domain,
            channel,
        ]);
        return entries.rows.map((e) => new MatrixRoom(e.room_id, JSON.parse(e.matrix_json)));
    }

    public async getMappingsForChannelByOrigin(server: IrcServer, channel: string, origin: RoomOrigin | RoomOrigin[], allowUnset: boolean): Promise<Entry[]> {
        const entries = await this.pgPool.query("SELECT * FROM rooms WHERE irc_domain = $1 AND irc_channel = $2 AND origin = $3",
        [
            server.domain,
            channel,
            origin,
        ]);
        return entries.rows.map((e) => PgDataStore.pgToRoomEntry(e));
    }

    public async getModesForChannel(server: IrcServer, channel: string): Promise<{ [id: string]: string[]; }> {
        const mapping: {[id: string]: string[]} = {};
        const entries = await this.pgPool.query(
            "SELECT room_id, remote_json->>'modes' AS MODES FROM rooms " +
            "WHERE irc_domain = $1 AND irc_channel = $2",
        [
            server.domain,
            channel,
        ]);
        entries.rows.forEach((e) => {
            mapping[e.room_id] = e.modes;
        });
        return mapping;
    }

    public async setModeForRoom(roomId: string, mode: string, enabled: boolean): Promise<void> {
        log.info("setModeForRoom (mode=%s, roomId=%s, enabled=%s)",
            mode, roomId, enabled
        );
        const entries: Entry[] = await this.getEntriesByMatrixId(roomId);
        for (const entry of entries) {
            if (!entry.remote) {
                continue;
            }
            const modes = entry.remote.get("modes") as string[] || [];
            const hasMode = modes.includes(mode);

            if (hasMode === enabled) {
                continue;
            }
            if (enabled) {
                modes.push(mode);
            }
            else {
                modes.splice(modes.indexOf(mode), 1);
            }

            entry.remote.set("modes", modes);
            await this.pgPool.query("UPDATE rooms WHERE room_id = $1, irc_channel = $2, irc_domain = $3 SET irc_json = $4", [
                roomId,
                entry.remote.get("channel"),
                entry.remote.get("domain"),
                JSON.stringify(entry.remote.serialize()),
            ]);
        }
    }

    public async setPmRoom(ircRoom: IrcRoom, matrixRoom: MatrixRoom, userId: string, virtualUserId: string): Promise<void> {
        await this.pgPool.query("INSERT INTO pm_rooms VALUES ($1, $2, $3, $4, $5)", [
            matrixRoom.getId(),
            ircRoom.getDomain(),
            ircRoom.getChannel(),
            userId,
            virtualUserId,
        ]);
    }

    public async getMatrixPmRoom(realUserId: string, virtualUserId: string): Promise<MatrixRoom|null> {
        const res = await this.pgPool.query("SELECT room_id FROM pm_rooms WHERE matrix_user_id = $1 AND virtual_user_id = $2", [
            realUserId,
            virtualUserId,
        ]);
        if (res.rowCount === 0) {
            return null;
        }
        return new MatrixRoom(res.rows[0].room_id);
    }

    public async getTrackedChannelsForServer(domain: string): Promise<string[]> {
        if (this.serverMappings[domain]) {
            return [];
        }
        const chanSet = await this.pgPool.query("SELECT channel FROM rooms WHERE irc_domain = $1", [ domain ]);
        return [...new Set((chanSet.rows).map((e) => e.channel))];
    }

    public async getRoomIdsFromConfig(): Promise<string[]> {
        return (
            await this.pgPool.query("SELECT room_id FROM rooms WHERE origin = 'config'")
        ).rows.map((e) => e.room_id);
    }

    public async removeConfigMappings(): Promise<void> {
        await this.pgPool.query("DELETE FROM rooms WHERE origin = 'config'");
    }

    public async getIpv6Counter(): Promise<number> {
        const res = await this.pgPool.query("SELECT counter FROM ipv6_counter");
        return res ? res.rows[0].counter : 0;
    }

    public async setIpv6Counter(counter: number): Promise<void> {
        await this.pgPool.query("UPDATE ipv6_counter SET count = $1", [ counter ]);
    }

    public async upsertMatrixRoom(room: MatrixRoom): Promise<void> {
        // XXX: This is an upsert operation, but we don't have enough details to go on
        // so this will just update a rooms data entry. We only use this call to update
        // topics on an existing room.
        await this.pgPool.query("UPDATE rooms SET matrix_json = $1 WHERE room_id = $2", [
            JSON.stringify(room.serialize()),
            room.getId(),
        ]);
    }

    public async getAdminRoomById(roomId: string): Promise<MatrixRoom|null> {
        const res = await this.pgPool.query("SELECT room_id FROM admin_rooms WHERE room_id = $1", [ roomId ]);
        if (res.rowCount === 0) {
            return null;
        }
        return new MatrixRoom(roomId);
    }

    public async storeAdminRoom(room: MatrixRoom, userId: string): Promise<void> {
        await this.pgPool.query(PgDataStore.BuildUpsertStatement("admin_rooms", "(room_id)", [
            "room_id",
            "user_id",
        ]), [ room.getId(), userId ]);
    }

    public async getAdminRoomByUserId(userId: string): Promise<MatrixRoom|null> {
        const res = await this.pgPool.query("SELECT room_id FROM admin_rooms WHERE user_id = $1", [ userId ]);
        if (res.rowCount === 0) {
            return null;
        }
        return new MatrixRoom(res.rows[0].room_id);
    }

    public async storeMatrixUser(matrixUser: MatrixUser): Promise<void> {
        const parameters = {
            user_id: matrixUser.getId(),
            data: JSON.stringify(matrixUser.serialize()),
        };
        const statement = PgDataStore.BuildUpsertStatement("matrix_users", "(user_id)", Object.keys(parameters));
        await this.pgPool.query(statement, Object.values(parameters));
    }

    public async getIrcClientConfig(userId: string, domain: string): Promise<IrcClientConfig | null> {
        const res = await this.pgPool.query("SELECT config, password FROM client_config WHERE user_id = $1 and domain = $2", 
        [
            userId,
            domain
        ]);
        if (res.rowCount === 0) {
            return null;
        }
        const row = res.rows[0];
        let config = JSON.parse(row.config);
        if (row.password && this.cryptoStore) {
            config.password = this.cryptoStore.decrypt(row.password);
        }
        return new IrcClientConfig(userId, domain, config);
    }

    public async storeIrcClientConfig(config: IrcClientConfig): Promise<void> {
        const userId = config.getUserId();
        if (!userId) {
            throw Error("IrcClientConfig does not contain a userId");
        }
        let password = undefined;
        if (config.getPassword() && this.cryptoStore) {
            password = this.cryptoStore.encrypt(config.getPassword()!);
        }
        const parameters = {
            user_id: userId,
            domain: config.getDomain(),
            // either use the decrypted password, or whatever is stored already.
            password: password || config.getPassword()!,
            config: JSON.stringify(config.serialize(true)),
        };
        const statement = PgDataStore.BuildUpsertStatement("client_config", "ON CONSTRAINT cons_client_config_unique", Object.keys(parameters));
        await this.pgPool.query(statement, Object.values(parameters));
    }

    public async getMatrixUserByLocalpart(localpart: string): Promise<MatrixUser|null> {
        const res = await this.pgPool.query("SELECT user_id, data FROM matrix_users WHERE user_id = $1", [
            `@${localpart}:${this.bridgeDomain}`,
        ]);
        if (res.rowCount === 0) {
            return null;
        }
        const row = res.rows[0];
        return new MatrixUser(row.user_id, JSON.parse(row.data));
    }

    public async getUserFeatures(userId: string): Promise<UserFeatures> {
        const pgRes = (
            await this.pgPool.query("SELECT features FROM user_features WHERE user_id = $1",
            [ userId ])
        );
        if (pgRes.rowCount === 0) {
            return {};
        }
        return pgRes.rows[0].features;
    }

    public async storeUserFeatures(userId: string, features: UserFeatures): Promise<void> {
        const statement = PgDataStore.BuildUpsertStatement("user_features", "(user_id)", [
            "user_id",
            "features",
        ]);
        await this.pgPool.query(statement, [userId, JSON.stringify(features)]);
    }

    public async storePass(userId: string, domain: string, pass: string, encrypt: boolean = true): Promise<void> {
        let password = pass;
        if (encrypt) {
            if (!this.cryptoStore) {
                throw Error("Password encryption is not configured.")
            }
            password = this.cryptoStore.encrypt(pass);
        }
        const parameters = {
            user_id: userId,
            domain,
            password,
        };
        const statement = PgDataStore.BuildUpsertStatement("client_config", "ON CONSTRAINT cons_client_config_unique", Object.keys(parameters));
        await this.pgPool.query(statement, Object.values(parameters));
    }

    public async removePass(userId: string, domain: string): Promise<void> {
        await this.pgPool.query("DELETE FROM user_password WHERE user_id = ${user_id} AND domain = ${domain}");
    }

    public async getMatrixUserByUsername(domain: string, username: string): Promise<MatrixUser|undefined> {
        // This will need a join
        const res = await this.pgPool.query("SELECT client_config.user_id, matrix_users.data FROM client_config, matrix_users" +
            "WHERE config->>'username' = $1 AND domain = $2 AND client_config.user_id = matrix_users.user_id",
            [username, domain]
        );
        if (res.rowCount === 0) {
            return;
        }
        return new MatrixUser(res.rows[0].user_id, JSON.parse(res.rows[0].data));
    }

    public async ensureSchema() {
        log.info("Starting postgres database engine");
        let currentVersion = await this.getSchemaVersion();
        while (currentVersion < PgDataStore.LATEST_SCHEMA) {
            log.info(`Updating schema to v${currentVersion + 1}`);
            const runSchema = require(`./schema/v${currentVersion + 1}`).runSchema;
            try {
                await runSchema(this.pgPool);
                currentVersion++;
                await this.updateSchemaVersion(currentVersion);
            } catch (ex) {
                log.warn(`Failed to run schema v${currentVersion + 1}:`, ex);
                throw Error("Failed to update database schema");
            }
        }
        log.info(`Database schema is at version v${currentVersion}`);
    }

    private async updateSchemaVersion(version: number) {
        log.debug(`updateSchemaVersion: ${version}`);
        await this.pgPool.query("UPDATE schema SET version = $1;", [ version ]);
    }

    private async getSchemaVersion(): Promise<number> {
        try {
            const { rows } = await this.pgPool.query("SELECT version FROM SCHEMA");
            return rows[0].version;
        } catch (ex) {
            if (ex.code === "42P01") { // undefined_table
                log.warn("Schema table could not be found");
                return 0;
            }
            log.error("Failed to get schema version:", ex);
        }
        throw Error("Couldn't fetch schema version");
    }

    private static BuildUpsertStatement(table: string, constraint: string, keyNames: string[]): string {
        const keys = keyNames.join(", ");
        const keysValues = `\$${keyNames.map((k, i) => i + 1).join(", $")}`;
        const keysSets = keyNames.map((k, i) => `${k} = \$${i + 1}`).join(", ");
        const statement = `INSERT INTO ${table} (${keys}) VALUES (${keysValues}) ON CONFLICT ${constraint} DO UPDATE SET ${keysSets}`;
        return statement;
    }
}