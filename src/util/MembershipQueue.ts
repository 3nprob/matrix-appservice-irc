import { BridgeRequest } from "../models/BridgeRequest";
import getLogger from "../logging";
import { QueuePool } from "./QueuePool";
import { Appservice } from "matrix-bot-sdk";
const log = getLogger("MembershipQueue");

const CONCURRENT_ROOM_LIMIT = 8;
const ATTEMPTS_LIMIT = 10;
const JOIN_DELAY_MS = 500;
const JOIN_DELAY_CAP_MS = 30 * 60 * 1000; // 30 mins

interface QueueUserItem {
    type: "join"|"leave";
    kickUser?: string;
    reason?: string;
    attempts: number;
    roomId: string;
    userId?: string;
    retry: boolean;
    req: BridgeRequest;
}

/**
 * This class processes membership changes for rooms in a linearized queue.
 */
export class MembershipQueue {
    private queuePool: QueuePool<QueueUserItem>;

    constructor(private appservice: Appservice) {
        this.queuePool = new QueuePool(CONCURRENT_ROOM_LIMIT, this.serviceQueue.bind(this));
    }

    /**
     * Join a user to a room
     * @param roomId The roomId to join
     * @param userId Leave empty to act as the bot user.
     * @param req The request entry for logging context
     * @param retry Should the request retry if it fails
     */
    public async join(roomId: string, userId: string|undefined, req: BridgeRequest, retry = true) {
        return this.queueMembership({
            roomId,
            userId,
            retry,
            req,
            attempts: 0,
            type: "join",
        });
    }

    /**
     * Leave OR kick a user from a room
     * @param roomId The roomId to leave
     * @param userId Leave empty to act as the bot user.
     * @param req The request entry for logging context
     * @param retry Should the request retry if it fails
     * @param reason Reason for leaving/kicking
     * @param kickUser The user to be kicked. If left blank, this will be a leave.
     */
    public async leave(roomId: string, userId: string, req: BridgeRequest,
                       retry = true, reason?: string, kickUser?: string) {
        return this.queueMembership({
            roomId,
            userId,
            retry,
            req,
            reason,
            kickUser,
            type: "leave",
            attempts: 0,
        })
    }

    public async queueMembership(item: QueueUserItem) {
        try {
            return await this.queuePool.enqueue("", item, this.hashRoomId(item.roomId));
        }
        catch (ex) {
            log.error(`Failed to handle membership: ${ex}`);
            throw ex;
        }
    }

    private hashRoomId(roomId: string) {
        return Array.from(roomId).map((s) => s.charCodeAt(0)).reduce((a, b) => a + b, 0) % CONCURRENT_ROOM_LIMIT;
    }

    private async serviceQueue(item: QueueUserItem): Promise<void> {
        log.debug(`${item.userId}@${item.roomId} -> ${item.type}`);
        const { req, roomId, userId, reason, kickUser, attempts } = item;
        const intentUserId = kickUser || userId;
        const intent = intentUserId ? this.appservice.getIntentForUserId(intentUserId) : this.appservice.botIntent;
        try {
            if (item.type === "join") {
                await intent.joinRoom(roomId);
            }
            else {
                if (kickUser) {
                    intent.underlyingClient.kickUser(userId, roomId, reason);
                } else {
                    intent.leaveRoom(roomId);
                }
            }
        }
        catch (ex) {
            if (!this.shouldRetry(ex, attempts)) {
                throw ex;
            }
            const delay = Math.min(
                (JOIN_DELAY_MS * attempts) + (Math.random() * 500),
                JOIN_DELAY_CAP_MS
            );
            req.log.warn(`Failed to join ${roomId}, delaying for ${delay}ms`);
            req.log.debug(`Failed with: ${ex.errcode} ${ex.message}`);
            await new Promise((r) => setTimeout(r, delay));
            this.queueMembership({...item, attempts: item.attempts + 1});
        }
    }

    private shouldRetry(ex: {code: string; errcode: string; httpStatus: number}, attempts: number): boolean {
        return !(
            attempts === ATTEMPTS_LIMIT ||
            ex.errcode === "M_FORBIDDEN" ||
            ex.httpStatus === 403
        );
    }
}
