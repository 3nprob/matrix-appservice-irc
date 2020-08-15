import logger from "../logging";
import { IrcBridge } from "./IrcBridge";
import { IrcServer } from "../irc/IrcServer";

const log = logger("PublicitySyncer");

// This class keeps the +s state of every channel bridged synced with the RoomVisibility
// of any rooms that are connected to the channels, regardless of the number of hops
// required to traverse the mapping graph (rooms to channels).
//
// NB: This is only in the direction I->M
//
// +s = 'private'
// -s = 'public'
// Modes received, but +s missing = 'public'

export class PublicitySyncer {

    // Cache the mode of each channel, the visibility of each room and the
    // known mappings between them. When any of these change, any inconsistencies
    // should be resolved by keeping the matrix side as private as necessary
    private visibilityMap: {
        mappings: {
            [roomId: string]: string[];
        };
        networkToRooms: {
            [networkId: string]: string[];
        };
        channelIsSecret: {
            [networkId: string]: boolean;
            // '$networkId $channel': true | false
        };
        roomVisibilities: {
            [roomId: string]: "private"|"public";
        };
    } = {
        mappings: {},
        networkToRooms: {},
        channelIsSecret: {},
        roomVisibilities: {},
    };
    constructor (private ircBridge: IrcBridge) { }


    public async initModeForChannel(server: IrcServer, chan: string) {
        try {
            const botClient = await this.ircBridge.getBotClient(server);
            log.info(`Bot requesting mode for ${chan} on ${server.domain}`);
            await botClient.mode(chan);
        }
        catch (err) {
            log.error(`Could not request mode of ${chan} (${err.message})`);
        }
    }

    public async initModes (server: IrcServer) {
        //Get all channels and call modes for each one

        const channels = await this.ircBridge.getStore().getTrackedChannelsForServer(server.domain);

        await Promise.all([...new Set(channels)].map((chan) => {
            // Request mode for channel
            return this.initModeForChannel(server, chan).catch((err) => {
                log.error(err.stack);
            });
        }));
    }

    /**
     * Returns the key used when calling `updateVisibilityMap` for updating an IRC channel
     * visibility mode (+s or -s).
     * ```
     * // Set channel on server to be +s
     * const key = publicitySyncer.getIRCVisMapKey(server.getNetworkId(), channel);
     * publicitySyncer.updateVisibilityMap(true, key, true);
     * ```
     * @param {string} networkId
     * @param {string} channel
     * @returns {string}
     */
    public getIRCVisMapKey(networkId: string, channel: string) {
        return `${networkId} ${channel}`;
    }

    public updateVisibilityMap(isMode: boolean, key: string, value: boolean, channel: string, server: IrcServer) {
        let hasChanged = false;
        if (isMode) {
            if (typeof value !== 'boolean') {
                throw new Error('+s state must be indicated with a boolean');
            }
            if (this.visibilityMap.channelIsSecret[key] !== value) {
                this.visibilityMap.channelIsSecret[key] = value;
                hasChanged = true;
            }
        }
        else {
            if (typeof value !== 'string' || (value !== "private" && value !== "public")) {
                throw new Error('Room visibility must = "private" | "public"');
            }

            if (this.visibilityMap.roomVisibilities[key] !== value) {
                this.visibilityMap.roomVisibilities[key] = value;
                hasChanged = true;
            }
        }

        if (hasChanged) {
            this.solveVisibility(channel, server).catch((err: Error) => {
                log.error(`Failed to sync publicity for ${channel}: ` + err.message);
            });
        }
    }

    /* Solve any inconsistencies between the currently known state of channels '+s' modes
       and rooms 'visibility' states. This does full graph traversal to prevent any +s
       channels ever escaping into a 'public' room. This function errs on the side of
       caution by assuming an unknown channel state is '+s'. This just means that if the
       modes of a channel are not received yet (e.g when no virtual user is in said channel)
       then the room is assumed secret (+s).

       The bare minimum is done to make sure no private channels are leaked into public
       matrix rooms. If ANY +s channel is somehow being bridged into a room, that room
       is updated to private. If ALL channels somehow being bridged into a room are NOT +s,
       that room is allowed to be public.
    */
    private async solveVisibility (channel: string, server: IrcServer) {
        // For each room, do a big OR on all of the channels that are linked in any way
        const mappings = await this.ircBridge.getStore().getMatrixRoomsForChannel(server, channel);
        const roomIds = mappings.map((m) => m.getId());

        this.visibilityMap.mappings = {};

        roomIds.forEach((roomId) => {
            const key = this.getIRCVisMapKey(server.getNetworkId(), channel);
            // also assign reverse mapping for lookup speed later
            if (!this.visibilityMap.networkToRooms[key]) {
                this.visibilityMap.networkToRooms[key] = [];
            }
            this.visibilityMap.networkToRooms[key].push(roomId);
            return key;
        });

        const cli = this.ircBridge.getAppServiceBridge().getBot().getClient();
        // Update rooms to correct visibilities
        let currentStates: {[roomId: string]: "public"|"private"} = {};

        // Assume private by default
        roomIds.forEach((r) => { currentStates[r] = "private" });

        currentStates = {
            ...currentStates,
            ...await this.ircBridge.getStore().getRoomsVisibility(roomIds),
        };

        const correctState = this.visibilityMap.channelIsSecret[channel] ? 'private' : 'public';

        log.info(`Solved visibility rules for ${channel} (${server.getNetworkId()}): ${correctState}`);

        return Promise.all(roomIds.map(async (roomId) => {
            const currentState = currentStates[roomId];

            // Use the server network ID of the first mapping
            // 'funNetwork #channel1' => 'funNetwork'
            const networkId = this.visibilityMap.mappings[roomId][0].split(' ')[0];

            if (currentState !== correctState) {
                try {
                    await cli.setRoomDirectoryVisibilityAppService(networkId, roomId, correctState);
                    await this.ircBridge.getStore().setRoomVisibility(roomId, correctState);
                    // Update cache
                    this.visibilityMap.roomVisibilities[roomId] = correctState;
                }
                catch (ex) {
                    log.error(`Failed to setRoomDirectoryVisibility (${ex.message})`);
                }
            }
        }));
    }
}
