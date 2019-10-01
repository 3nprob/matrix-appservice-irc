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

import net from "net";
import { promisify } from "util";

const log = require("../logging").get("irc-ident");



interface IdentConfig {
    port: number;
    address: string;
}

const DEFAULT_CONFIG = {
    port: 113,
    address: "0.0.0.0"
};

const CLIENT_CONNECTION_TIMEOUT_MS = 120000;

/**
 * Runs an ident server to auth a list of usernames.
 *
 * This purposefully has no dependencies on any other library and is kept as
 * generic as possible. It consists of three functions:
 *
 * configure(opts) : opts => { port: {Number} }
 *      Configure the ident server.
 *
 * run()
 *      Start listening on the configured port for incoming requests.
 *
 * setMapping(username, port) : username => {String}, port => {Number}
 *      Assign a username/port mapping. Setting a port of 0 removes the mapping.
 **/
class IdentSrv {
    private config: IdentConfig = DEFAULT_CONFIG;
    private portMappings: {[port: string]: string} = {};
    private pendingConnections: Set<Promise<void>> = new Set();

    constructor() {

    }

    public run() {
        net.createServer(
            this.onConnection.bind(this)
        ).listen(this.config.port, this.config.address);
    }

    public configure(opts: IdentConfig) {
        log.info("Configuring ident server => %s", JSON.stringify(opts));
        this.config = opts;
    }

    public setMapping(username: string, port: number) {
        if (port > 0) {
            this.portMappings[port] = username;
            log.debug("Set user %s on port %s", username, port);
        }
        else if (port === 0) {
            Object.keys(this.portMappings)
            .filter((portNum: string) => this.portMappings[portNum] === username)
            .forEach((portNum) => {
                if (this.portMappings[portNum] === username) {
                    delete this.portMappings[portNum];
                    log.debug("Remove user %s from port %s", username, portNum);
                }
            });
        }
    }

    private onConnection(sock: net.Socket) {
        log.debug("CONNECT %s %s", sock.remoteAddress, sock.remotePort);
        sock.on("data", (data) => {
            log.debug("DATA " + data);
            const ports = data.toString().split(",");
            const remoteConnectPort = Number(ports[1]);
            const localOutgoingPort = Number(ports[0]);
            if (!remoteConnectPort || !localOutgoingPort) {
                log.debug("BAD DATA");
                sock.end();
                return;
            }
            this.tryRespond(sock,
                String(localOutgoingPort),
                String(remoteConnectPort)).catch((ex) => {
                    // Just close the connection
                    sock.end();
                });
        });
        sock.on("close", () => {
            log.debug("CLOSE");
        });
        sock.on("error", (err) => {
            log.error("connection error: " + err);
            if (err && err.stack) {
                log.error(err.stack);
            }
        });
    }

    public clientBegin(): () => void { 
        log.debug("IRC client started connection");
        let res!: () => void;
        const p: Promise<void> = new Promise((resolve) => {
            res = resolve;
            setTimeout(resolve, CLIENT_CONNECTION_TIMEOUT_MS);
        });
        this.pendingConnections.add(p);
        p.then(() => {
            log.debug("IRC client connected");
            this.pendingConnections.delete(p);
        })
        return res;
    }

    private async tryRespond(sock: net.Socket, localPort: string, remotePort: string) {
        const username = this.portMappings[localPort];
        if (username) {
            log.debug("Port %s is %s", localPort, username);
            this.respond(sock, localPort, remotePort, username);
            return;
        }
        // Wait for pending connections to finish first.
        await Promise.all([...this.pendingConnections]);
        log.debug("No user on port %s", localPort);
        this.respond(sock, localPort, remotePort);
    }

    private respond(sock: net.Socket, localPort: string, remotePort: string, username?: string) {
        let response;
        if (username) {
            response = `${localPort},${remotePort}:USERID:UNIX:${username}\r\n`;
        }
        else {
            response = `${localPort},${remotePort}:ERROR:NO-USER\r\n`;
        }    
        log.debug(response);
        sock.end(response);
    }
}

const staticInstance = new IdentSrv();
module.exports = staticInstance;