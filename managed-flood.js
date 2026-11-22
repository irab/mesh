/**
 * Discrete-event LoRa PHY/MAC + routing simulator for Meshtastic and MeshCore.
 *
 * Grounded in:
 * - meshtastic/firmware (v2.6.4 snapshot through v2.7.26 / 2.8 develop):
 *   RadioInterface.cpp, RadioLibInterface.cpp, FloodingRouter.cpp, NextHopRouter.cpp,
 *   Router.cpp, PacketHistory.cpp.
 * - meshtastic/Meshtasticator: phy.py, mac.py, node.py (Semtech SX126x airtime,
 *   preamble overlap timing collision, 6 dB LoRa co-channel capture, CAD busy check).
 * - meshcore-dev/MeshCore (v1.6.0 through v1.18.0):
 *   Mesh.cpp, Dispatcher.cpp, simple_repeater/MyMesh.cpp (Repeater vs silent Companion,
 *   variable path-hash wire format growing on flood and shrinking on direct routing).
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.ManagedFlood = factory();
    }
})(typeof self !== 'undefined' ? self : this, function () {
    var SNR_MIN = -20;
    var SNR_MAX = 10;
    var CW_MIN = 3;
    var CW_MAX = 8;

    var CAPTURE_DB = 6;
    var EDGE_SNR_DB = -12.25;
    var PATH_LOSS_SLOPE = 35;

    var DEFAULT_HOP_LIMIT = 3;
    var MAX_HOP_LIMIT = 7;
    var DEFAULT_TEXT_BYTES = 20;

    var LORA_PRESETS = {
        LONG_FAST: {
            id: 'LONG_FAST',
            label: 'SF11 / BW250 (Meshtastic LONG_FAST)',
            sf: 11,
            bw: 250000,
            cr: 1,      // CR 4/5 -> cr + 4 = 5
            nPream: 16
        },
        SF10_250: {
            id: 'SF10_250',
            label: 'SF10 / BW250 (MeshCore Default)',
            sf: 10,
            bw: 250000,
            cr: 1,
            nPream: 16
        },
        MEDIUM_FAST: {
            id: 'MEDIUM_FAST',
            label: 'SF9 / BW250 (MEDIUM_FAST)',
            sf: 9,
            bw: 250000,
            cr: 1,
            nPream: 16
        }
    };

    function resolvePreset(presetOrId) {
        if (presetOrId && typeof presetOrId === 'object' && presetOrId.sf) return presetOrId;
        return LORA_PRESETS[presetOrId] || LORA_PRESETS.LONG_FAST;
    }

    /**
     * Exact Semtech SX126x / Meshtasticator::airtime LoRa time-on-air in ms.
     */
    function loraAirtimeMs(totalFrameBytes, presetOrId) {
        var p = resolvePreset(presetOrId);
        var sf = p.sf;
        var bw = p.bw;
        var cr = p.cr;
        var nPream = p.nPream || 16;
        var de = (bw === 125000 && sf >= 11) ? 1 : 0;
        var tSym = Math.pow(2, sf) / bw; // seconds
        var tPream = (nPream + 4.25) * tSym;
        var num = 8 * totalFrameBytes - 4 * sf + 28 + 16;
        var den = 4 * (sf - 2 * de);
        var payloadSymb = 8 + Math.max(Math.ceil(num / den) * (cr + 4), 0);
        return Math.round((tPream + payloadSymb * tSym) * 1000);
    }

    /**
     * Exact RadioInterface::computeSlotTimeMsec (sub-GHz LoRa).
     */
    function slotTimeMs(presetOrId) {
        var p = resolvePreset(presetOrId);
        var tSymMs = (Math.pow(2, p.sf) / p.bw) * 1000;
        return Math.round(2.5 * tSymMs + 7.6);
    }

    /**
     * Preamble overlap tolerance from Meshtasticator::timing_collision:
     * first (NPREAM - 5) symbols can overlap the tail of an earlier frame.
     */
    function preambleSafeMs(presetOrId) {
        var p = resolvePreset(presetOrId);
        var tSymMs = (Math.pow(2, p.sf) / p.bw) * 1000;
        return Math.round(Math.max(1, (p.nPream || 16) - 5) * tSymMs);
    }

    /**
     * Meshtastic on-air frame length in bytes (RadioInterface.h):
     * - 16-byte PacketHeader (to, from, id, flags, channel, next_hop, relay_node)
     * - Protobuf Data wrapper (~6 bytes) + UTF-8 text payload
     * - DM PKC adds 12 bytes (MESHTASTIC_PKC_OVERHEAD); channel AES-CTR adds 0
     * - Routing ACK (ROUTING_APP error_reason=NONE) is 16 + 10 = 26 bytes
     */
    function meshtasticFrameBytes(kind, textBytes) {
        var txt = Math.max(1, textBytes == null ? DEFAULT_TEXT_BYTES : textBytes);
        if (kind === 'ack') return 26;
        if (kind === 'dm') return 16 + 6 + 12 + txt;
        return 16 + 6 + txt;
    }

    /**
     * MeshCore on-air frame length in bytes (Dispatcher.cpp / Mesh.cpp):
     * - 2-byte base header (header + path_len; unscoped, 0 transport code bytes)
     * - Variable path field: pathHops * pathHashSize bytes (1 byte/hop default)
     *   grows by pathHashSize per repeater on flood, shrinks by pathHashSize per hop on direct
     * - Encrypted TXT_MSG payload: destHash(1) + srcHash(1) + MAC(2) + AES-128 block-padded(ts(4)+flags(1)+text)
     * - Path return / ACK payload: ~20 bytes encrypted path/ack block
     */
    function meshCoreFrameBytes(kind, pathHops, textBytes, pathHashSize) {
        var txt = Math.max(1, textBytes == null ? DEFAULT_TEXT_BYTES : textBytes);
        var hashSize = pathHashSize || 1;
        var pathBytes = Math.max(0, pathHops || 0) * hashSize;
        if (kind === 'path-ack') {
            return 2 + pathBytes + 20;
        }
        var paddedCipher = Math.ceil((5 + txt) / 16) * 16;
        var payloadLen = 4 + paddedCipher;
        return 2 + pathBytes + payloadLen;
    }

    /**
     * Exact C++ integer map((int32_t)snr, -20, 10, 3, 8) from RadioInterface::getCWsize.
     */
    function cwSize(snr) {
        var clamped = Math.max(SNR_MIN, Math.min(SNR_MAX, snr));
        var x = Math.trunc(clamped);
        return Math.trunc(((x - SNR_MIN) * (CW_MAX - CW_MIN)) / (SNR_MAX - SNR_MIN)) + CW_MIN;
    }

    /**
     * Unclamped reciprocal link SNR in dB based on log-distance path loss.
     */
    function linkSnrUnclamped(tx, rx) {
        var dx = tx.x - rx.x;
        var dy = tx.y - rx.y;
        var dist = Math.max(Math.sqrt(dx * dx + dy * dy), 1);
        var reach = Math.max(tx.range || 1, rx.range || 1, dist);
        return EDGE_SNR_DB + PATH_LOSS_SLOPE * (Math.log(reach / dist) / Math.LN10);
    }

    /**
     * Clamped SNR in [-20, 10] dB as used by firmware contention-window sizing.
     */
    function snrAt(tx, rx) {
        var raw = linkSnrUnclamped(tx, rx);
        return Math.max(SNR_MIN, Math.min(SNR_MAX, raw));
    }

    function randInt(random, maxExclusive) {
        if (maxExclusive <= 0) return 0;
        return Math.floor(random() * maxExclusive);
    }

    function relayDelaySlots(snr, role, random) {
        var cw = cwSize(snr);
        if (role === 'ROUTER') {
            return randInt(random, 2 * cw);
        }
        return 2 * CW_MAX + randInt(random, Math.pow(2, cw));
    }

    function worstDelaySlots(snr) {
        var cw = cwSize(snr);
        return 2 * CW_MAX + Math.pow(2, cw);
    }

    function linkEnd(end) {
        if (end && typeof end === 'object') return end.id;
        return end;
    }

    function buildAdjacency(nodes, links) {
        var nodeMap = {};
        var adjacency = {};
        nodes.forEach(function (node) {
            nodeMap[node.id] = node;
            adjacency[node.id] = [];
        });
        (links || []).forEach(function (link) {
            var a = linkEnd(link.source);
            var b = linkEnd(link.target);
            if (!nodeMap[a] || !nodeMap[b] || a === b) return;
            if (adjacency[a].indexOf(b) === -1) adjacency[a].push(b);
            if (adjacency[b].indexOf(a) === -1) adjacency[b].push(a);
        });
        return { nodeMap: nodeMap, adjacency: adjacency };
    }

    function shortestPath(nodes, adjacency, sourceId, destId) {
        if (!adjacency[sourceId]) return [];
        var queue = [sourceId];
        var prev = {};
        var seen = {};
        seen[sourceId] = true;
        while (queue.length) {
            var u = queue.shift();
            if (u === destId) {
                var path = [];
                var cur = destId;
                while (cur != null) {
                    path.push(cur);
                    cur = prev[cur];
                }
                path.reverse();
                return path;
            }
            var nbs = adjacency[u] || [];
            for (var i = 0; i < nbs.length; i++) {
                var v = nbs[i];
                if (!seen[v]) {
                    seen[v] = true;
                    prev[v] = u;
                    queue.push(v);
                }
            }
        }
        return [];
    }

    function countReachable(adjacency, sourceId) {
        if (!adjacency[sourceId]) return 0;
        var seen = {};
        seen[sourceId] = true;
        var queue = [sourceId];
        var count = 0;
        while (queue.length) {
            var u = queue.shift();
            count++;
            var nbs = adjacency[u] || [];
            for (var i = 0; i < nbs.length; i++) {
                var v = nbs[i];
                if (!seen[v]) {
                    seen[v] = true;
                    queue.push(v);
                }
            }
        }
        return count;
    }

    function isInfraRole(role) {
        return role === 'ROUTER' || role === 'ROUTER_LATE' || role === 'CLIENT_BASE';
    }

    /**
     * Deterministic repeater backbone selector for MeshCore:
     * Picks ~25% largest-range hub nodes PLUS any intermediate nodes along the
     * shortest A->Z path so a realistic repeater backbone exists while ~70% of
     * nodes act as silent companions that never repeat.
     */
    function selectMeshCoreRepeaters(nodes, links, sourceId, destId, ratio) {
        sourceId = sourceId || 'A';
        destId = destId || 'Z';
        ratio = ratio == null ? 0.25 : ratio;
        var graph = buildAdjacency(nodes, links);
        var optPath = shortestPath(nodes, graph.adjacency, sourceId, destId);
        var repeaters = {};
        var ranked = nodes
            .filter(function (n) { return n.id !== sourceId && n.id !== destId; })
            .slice()
            .sort(function (a, b) { return (b.range || 0) - (a.range || 0); });
        var targetCount = Math.max(1, Math.round(ranked.length * ratio));
        for (var i = 0; i < Math.min(targetCount, ranked.length); i++) {
            repeaters[ranked[i].id] = true;
        }
        for (var j = 1; j < optPath.length - 1; j++) {
            repeaters[optPath[j]] = true;
        }
        return Object.keys(repeaters);
    }

    /**
     * Simulate Meshtastic NextHopRouter directed forwarding along a learned path.
     */
    function simulateNextHopDm(nodes, adjacency, nodeMap, roleMap, options, preset, textBytes) {
        var random = options.random || Math.random;
        var hopLimit = options.hopLimit == null ? DEFAULT_HOP_LIMIT : options.hopLimit;
        var sourceId = options.sourceId || 'A';
        var destId = options.destId || 'Z';
        var preserveRouterHops = !!options.preserveRouterHops;
        var slotMs = slotTimeMs(preset);
        var frameBytes = meshtasticFrameBytes('dm', textBytes);
        var airtimeMs = loraAirtimeMs(frameBytes, preset);

        var path = options.learnedPath && options.learnedPath.length >= 2
            ? options.learnedPath
            : shortestPath(nodes, adjacency, sourceId, destId);

        var reachableCount = countReachable(adjacency, sourceId);
        var shortestHops = path.length >= 2 ? path.length - 1 : null;

        if (path.length < 2) {
            return emptyResult(destId, hopLimit, 'dm-nexthop', null, reachableCount, preset, textBytes);
        }

        var playback = [];
        var tMs = 0;
        var remainingHop = hopLimit;
        var deliveredMs = null;
        var hopsToDest = null;
        var heardNodes = {};
        var totalBytes = 0;
        var totalAirtimeMs = 0;
        heardNodes[sourceId] = true;

        for (var i = 0; i < path.length - 1; i++) {
            var senderId = path[i];
            var nextHopId = path[i + 1];
            var senderRole = roleMap[senderId] || 'CLIENT';
            var nextRole = roleMap[nextHopId] || 'CLIENT';

            if (i > 0) {
                var prevSnr = linkSnrUnclamped(nodeMap[path[i - 1]], nodeMap[senderId]);
                tMs += relayDelaySlots(prevSnr, senderRole, random) * slotMs;
            }

            var tStart = tMs;
            var tEnd = tStart + airtimeMs;
            totalBytes += frameBytes;
            totalAirtimeMs += airtimeMs;

            var ignored = [];
            var pending = [];
            var exhausted = [];
            var delivered = false;

            (adjacency[senderId] || []).forEach(function (nbId) {
                heardNodes[nbId] = true;
                if (nbId === nextHopId) {
                    if (nbId === destId) {
                        delivered = true;
                        deliveredMs = tEnd;
                        hopsToDest = i + 1;
                        exhausted.push(nbId);
                    } else {
                        var dec = !(i > 0 && preserveRouterHops && isInfraRole(senderRole) && isInfraRole(nextRole));
                        var nextRemaining = dec ? remainingHop - 1 : remainingHop;
                        if (remainingHop > 0) {
                            pending.push(nbId);
                        } else {
                            exhausted.push(nbId);
                        }
                        remainingHop = nextRemaining;
                    }
                } else if (nbId !== path[i - 1]) {
                    ignored.push(nbId);
                }
            });

            playback.push({
                id: senderId,
                nextHopId: nextHopId,
                packetKind: 'data',
                time: Math.round(tStart / slotMs),
                timeMs: tStart,
                tEndMs: tEnd,
                frameBytes: frameBytes,
                frameBits: frameBytes * 8,
                airtimeMs: airtimeMs,
                hopLimit: i === 0 ? hopLimit : remainingHop,
                role: senderRole,
                pending: pending,
                exhausted: exhausted,
                suppressed: [],
                ignoredNextHop: ignored,
                upgraded: [],
                clamped: [],
                collided: [],
                delivered: delivered
            });

            tMs = tEnd;
            if (delivered || (nextHopId !== destId && playback[playback.length - 1].pending.length === 0)) {
                break;
            }
        }

        return {
            protocol: 'meshtastic',
            mode: 'dm-nexthop',
            preset: preset,
            textBytes: textBytes,
            playback: playback,
            transmissions: playback.length,
            dataTransmissions: playback.length,
            totalBytes: totalBytes,
            totalBits: totalBytes * 8,
            totalAirtimeMs: totalAirtimeMs,
            avgFrameBytes: playback.length ? Math.round(totalBytes / playback.length) : frameBytes,
            cancelled: 0,
            collisions: 0,
            csmaDefers: 0,
            csmaDeferrals: 0,
            hopsToDest: hopsToDest,
            deliveredSlot: deliveredMs != null ? Math.round(deliveredMs / slotMs) : null,
            deliveredMs: deliveredMs,
            reachedDest: deliveredMs != null,
            destId: destId,
            hopLimit: hopLimit,
            shortestHops: shortestHops,
            learnedPath: path,
            nodesHeard: Object.keys(heardNodes).length,
            reachableNodes: reachableCount,
            constants: {
                snrMin: SNR_MIN,
                snrMax: SNR_MAX,
                cwMin: CW_MIN,
                cwMax: CW_MAX,
                slotMs: slotMs,
                packetAirtimeMs: airtimeMs,
                defaultHopLimit: DEFAULT_HOP_LIMIT,
                maxHopLimit: MAX_HOP_LIMIT
            }
        };
    }

    /**
     * Simulate Meshtastic Managed Flooding / NextHopRouter.
     */
    function simulate(nodes, links, options) {
        options = options || {};
        var random = options.random || Math.random;
        var hopLimit = options.hopLimit == null ? DEFAULT_HOP_LIMIT : options.hopLimit;
        var sourceId = options.sourceId || 'A';
        var destId = options.destId || 'Z';
        var mode = options.mode || 'broadcast';
        var unicast = mode === 'dm-first' || mode === 'dm-nexthop';
        var preserveRouterHops = !!options.preserveRouterHops;
        var preset = resolvePreset(options.preset);
        var textBytes = options.textBytes == null ? DEFAULT_TEXT_BYTES : options.textBytes;

        var slotMs = slotTimeMs(preset);
        var preamSafeMs = preambleSafeMs(preset);
        var dataFrameBytes = meshtasticFrameBytes(unicast ? 'dm' : 'broadcast', textBytes);
        var ackFrameBytes = meshtasticFrameBytes('ack', textBytes);
        var dataAirtimeMs = loraAirtimeMs(dataFrameBytes, preset);
        var ackAirtimeMs = loraAirtimeMs(ackFrameBytes, preset);

        var roleMap = {};
        nodes.forEach(function (n) {
            roleMap[n.id] = (options.roles && options.roles[n.id]) || n.role || 'CLIENT';
        });
        (options.routerIds || []).forEach(function (id) {
            if (!options.roles || !options.roles[id]) {
                roleMap[id] = 'ROUTER';
            }
        });

        var graph = buildAdjacency(nodes, links);
        var nodeMap = graph.nodeMap;
        var adjacency = graph.adjacency;

        var optPath = shortestPath(nodes, adjacency, sourceId, destId);
        var shortestHops = optPath.length >= 2 ? optPath.length - 1 : null;
        var reachableCount = countReachable(adjacency, sourceId);

        if (!nodeMap[sourceId]) {
            return emptyResult(destId, hopLimit, mode, shortestHops, reachableCount, preset, textBytes);
        }

        if (mode === 'dm-nexthop') {
            return simulateNextHopDm(nodes, adjacency, nodeMap, roleMap, options, preset, textBytes);
        }

        var state = {};
        nodes.forEach(function (node) {
            state[node.id] = {
                role: roleMap[node.id] || 'CLIENT',
                seen: false,
                status: 'idle',
                token: 0,
                highestHop: -1,
                outgoingHop: 0,
                rxSnr: 0,
                radioHops: null,
                firstRelayFrom: null,
                clampedLate: false,
                ackSent: false,
                txIntervals: [],
                rxFrames: []
            };
        });

        var tokenSeq = 1;
        var evSeq = 0;
        var flightSeq = 0;
        var events = [];
        var activeFlights = {};
        var playback = [];
        var cancelled = 0;
        var collisions = 0;
        var csmaDefers = 0;
        var deliveredMs = null;
        var hopsToDest = null;
        var totalBytes = 0;
        var totalAirtimeMs = 0;

        function pushEvent(time, priority, payload) {
            payload.time = time;
            payload.priority = priority;
            payload.seq = ++evSeq;
            events.push(payload);
        }

        function scheduleTx(nodeId, dueTimeMs, packetKind) {
            var st = state[nodeId];
            var token = ++tokenSeq;
            st.token = token;
            st.txDueTime = dueTimeMs;
            st.packetKind = packetKind || 'data';
            pushEvent(dueTimeMs, 1, {
                type: 'TX_TRY',
                nodeId: nodeId,
                token: token
            });
        }

        function isChannelBusyFor(nodeId, tMs) {
            var ids = Object.keys(activeFlights);
            for (var i = 0; i < ids.length; i++) {
                var f = activeFlights[ids[i]];
                if (f.tStart + slotMs <= tMs && tMs < f.tEnd && f.neighborSet[nodeId]) {
                    return true;
                }
            }
            return false;
        }

        function overlappedTx(st, tStart, tEnd) {
            for (var i = 0; i < st.txIntervals.length; i++) {
                var iv = st.txIntervals[i];
                if (iv[0] < tEnd && iv[1] > tStart) return true;
            }
            return false;
        }

        function timingCollides(frame, other) {
            var first = frame.tStart <= other.tStart ? frame : other;
            var second = frame.tStart <= other.tStart ? other : frame;
            return (second.tStart + preamSafeMs) < first.tEnd;
        }

        var srcState = state[sourceId];
        srcState.seen = true;
        srcState.status = 'pending';
        srcState.highestHop = hopLimit;
        srcState.outgoingHop = hopLimit;
        srcState.radioHops = 0;
        scheduleTx(sourceId, 0, 'data');

        while (events.length) {
            events.sort(function (a, b) {
                return a.time - b.time || a.priority - b.priority || a.seq - b.seq;
            });
            var ev = events.shift();

            if (ev.type === 'TX_TRY') {
                var st = state[ev.nodeId];
                if (st.status !== 'pending' || st.token !== ev.token) continue;

                if (isChannelBusyFor(ev.nodeId, ev.time)) {
                    csmaDefers++;
                    var deferSlots = st.packetKind === 'ack'
                        ? randInt(random, Math.pow(2, CW_MIN))
                        : relayDelaySlots(st.rxSnr, st.role, random);
                    scheduleTx(ev.nodeId, ev.time + Math.max(1, deferSlots) * slotMs, st.packetKind);
                    continue;
                }

                var isAckPkt = st.packetKind === 'ack';
                var frameBytes = isAckPkt ? ackFrameBytes : dataFrameBytes;
                var durationMs = isAckPkt ? ackAirtimeMs : dataAirtimeMs;
                var tStart = ev.time;
                var tEnd = tStart + durationMs;
                st.status = 'transmitting';
                st.txIntervals.push([tStart, tEnd]);
                totalBytes += frameBytes;
                totalAirtimeMs += durationMs;

                var flightId = ++flightSeq;
                var neighborList = adjacency[ev.nodeId] || [];
                var neighborSet = {};
                neighborList.forEach(function (nb) {
                    neighborSet[nb] = true;
                });

                var step = {
                    id: ev.nodeId,
                    packetKind: st.packetKind,
                    time: Math.round(tStart / slotMs),
                    timeMs: tStart,
                    tEndMs: tEnd,
                    frameBytes: frameBytes,
                    frameBits: frameBytes * 8,
                    airtimeMs: durationMs,
                    hopLimit: st.outgoingHop,
                    role: st.role,
                    pending: [],
                    exhausted: [],
                    suppressed: [],
                    upgraded: [],
                    clamped: [],
                    collided: [],
                    delivered: false
                };

                var flight = {
                    flightId: flightId,
                    senderId: ev.nodeId,
                    packetKind: st.packetKind,
                    senderRole: st.role,
                    hopLimit: st.outgoingHop,
                    senderRadioHops: st.radioHops || 0,
                    tStart: tStart,
                    tEnd: tEnd,
                    neighborList: neighborList,
                    neighborSet: neighborSet,
                    step: step
                };
                activeFlights[flightId] = flight;
                playback.push(step);

                neighborList.forEach(function (nbId) {
                    state[nbId].rxFrames.push({
                        flightId: flightId,
                        packetKind: st.packetKind,
                        senderId: ev.nodeId,
                        senderRole: st.role,
                        tStart: tStart,
                        tEnd: tEnd,
                        hopLimit: st.outgoingHop,
                        snr: linkSnrUnclamped(nodeMap[ev.nodeId], nodeMap[nbId]),
                        radioHops: (st.radioHops || 0) + 1
                    });
                });

                pushEvent(tEnd, 0, {
                    type: 'TX_END',
                    flightId: flightId
                });
            } else if (ev.type === 'TX_END') {
                var doneFlight = activeFlights[ev.flightId];
                delete activeFlights[ev.flightId];
                if (!doneFlight) continue;

                state[doneFlight.senderId].status = 'relayed';

                doneFlight.neighborList.forEach(function (nbId) {
                    var nbSt = state[nbId];
                    var frame = null;
                    for (var i = 0; i < nbSt.rxFrames.length; i++) {
                        if (nbSt.rxFrames[i].flightId === doneFlight.flightId) {
                            frame = nbSt.rxFrames[i];
                            break;
                        }
                    }
                    if (!frame) return;

                    if (overlappedTx(nbSt, frame.tStart, frame.tEnd)) return;

                    var captured = true;
                    for (var j = 0; j < nbSt.rxFrames.length; j++) {
                        var other = nbSt.rxFrames[j];
                        if (other.flightId === frame.flightId) continue;
                        if (timingCollides(frame, other) && (frame.snr - other.snr) < CAPTURE_DB) {
                            captured = false;
                            break;
                        }
                    }
                    if (!captured) {
                        collisions++;
                        doneFlight.step.collided.push(nbId);
                        return;
                    }

                    if (frame.packetKind === 'ack') {
                        if (nbSt.status === 'pending' && nbSt.packetKind === 'data') {
                            nbSt.status = 'cancelled';
                            nbSt.token = ++tokenSeq;
                            cancelled++;
                            doneFlight.step.suppressed.push(nbId);
                        }
                        return;
                    }

                    var incomingHop = frame.hopLimit;
                    var isFirstHop = frame.senderId === sourceId;
                    var zeroCost = !isFirstHop && preserveRouterHops && isInfraRole(frame.senderRole) && isInfraRole(nbSt.role);
                    var nextOutgoingHop = zeroCost ? incomingHop : incomingHop - 1;
                    var canRelayRole = nbSt.role !== 'CLIENT_MUTE';

                    if (nbId === destId && deliveredMs == null) {
                        deliveredMs = doneFlight.tEnd;
                        hopsToDest = frame.radioHops;
                        doneFlight.step.delivered = true;
                        nbSt.firstRelayFrom = frame.senderId;
                    }

                    if (unicast && nbId === destId) {
                        nbSt.seen = true;
                        nbSt.highestHop = Math.max(nbSt.highestHop, incomingHop);
                        if (!nbSt.ackSent) {
                            nbSt.ackSent = true;
                            nbSt.status = 'pending';
                            nbSt.outgoingHop = Math.min(hopLimit, Math.max(1, frame.radioHops));
                            nbSt.rxSnr = frame.snr;
                            scheduleTx(nbId, doneFlight.tEnd + slotMs, 'ack');
                        }
                        return;
                    }

                    if (!nbSt.seen) {
                        nbSt.seen = true;
                        nbSt.highestHop = incomingHop;
                        nbSt.rxSnr = frame.snr;
                        nbSt.radioHops = frame.radioHops;
                        nbSt.firstRelayFrom = frame.senderId;

                        if (incomingHop > 0 && canRelayRole) {
                            nbSt.status = 'pending';
                            nbSt.outgoingHop = Math.max(0, nextOutgoingHop);
                            var delaySlots = relayDelaySlots(frame.snr, nbSt.role, random);
                            scheduleTx(nbId, doneFlight.tEnd + delaySlots * slotMs, 'data');
                            doneFlight.step.pending.push(nbId);
                        } else {
                            nbSt.status = 'exhausted';
                            doneFlight.step.exhausted.push(nbId);
                        }
                        return;
                    }

                    if (incomingHop > nbSt.highestHop && nbSt.status === 'pending' && canRelayRole) {
                        nbSt.highestHop = incomingHop;
                        nbSt.outgoingHop = Math.max(0, nextOutgoingHop);
                        nbSt.rxSnr = frame.snr;
                        nbSt.radioHops = frame.radioHops;
                        var upgradeDelay = relayDelaySlots(frame.snr, nbSt.role, random);
                        scheduleTx(nbId, doneFlight.tEnd + upgradeDelay * slotMs, 'data');
                        doneFlight.step.upgraded.push(nbId);
                        return;
                    }

                    if (nbSt.status === 'pending') {
                        if (nbSt.role === 'CLIENT') {
                            nbSt.status = 'cancelled';
                            nbSt.token = ++tokenSeq;
                            cancelled++;
                            doneFlight.step.suppressed.push(nbId);
                        } else if (nbSt.role === 'ROUTER_LATE' && !nbSt.clampedLate) {
                            nbSt.clampedLate = true;
                            var lateDue = doneFlight.tEnd + worstDelaySlots(nbSt.rxSnr) * slotMs;
                            if (lateDue > nbSt.txDueTime) {
                                scheduleTx(nbId, lateDue, 'data');
                            }
                            doneFlight.step.clamped.push(nbId);
                        }
                    }
                });
            }
        }

        var deliveredPath = [];
        if (deliveredMs != null) {
            var cur = destId;
            var guard = 0;
            while (cur != null && guard++ < nodes.length + 2) {
                deliveredPath.push(cur);
                if (cur === sourceId) break;
                cur = state[cur] ? state[cur].firstRelayFrom : null;
            }
            deliveredPath.reverse();
            if (deliveredPath[0] !== sourceId) deliveredPath = [];
        }

        var nodesHeard = 0;
        nodes.forEach(function (n) {
            if (state[n.id].seen) nodesHeard++;
        });
        var dataTransmissions = playback.filter(function (s) { return s.packetKind !== 'ack'; }).length;

        return {
            protocol: 'meshtastic',
            mode: mode,
            preset: preset,
            textBytes: textBytes,
            playback: playback,
            transmissions: playback.length,
            dataTransmissions: dataTransmissions,
            totalBytes: totalBytes,
            totalBits: totalBytes * 8,
            totalAirtimeMs: totalAirtimeMs,
            avgFrameBytes: playback.length ? Math.round(totalBytes / playback.length) : dataFrameBytes,
            cancelled: cancelled,
            collisions: collisions,
            csmaDefers: csmaDefers,
            csmaDeferrals: csmaDefers,
            hopsToDest: hopsToDest,
            deliveredSlot: deliveredMs != null ? Math.round(deliveredMs / slotMs) : null,
            deliveredMs: deliveredMs,
            reachedDest: deliveredMs != null,
            destId: destId,
            hopLimit: hopLimit,
            shortestHops: shortestHops,
            learnedPath: deliveredPath.length >= 2 ? deliveredPath : optPath,
            nodesHeard: nodesHeard,
            reachableNodes: reachableCount,
            constants: {
                snrMin: SNR_MIN,
                snrMax: SNR_MAX,
                cwMin: CW_MIN,
                cwMax: CW_MAX,
                slotMs: slotMs,
                packetAirtimeMs: dataAirtimeMs,
                defaultHopLimit: DEFAULT_HOP_LIMIT,
                maxHopLimit: MAX_HOP_LIMIT
            }
        };
    }

    /**
     * Discrete-event MeshCore simulator on the exact same LoRa PHY/MAC clock.
     *
     * Key MeshCore behaviors (meshcore-dev/MeshCore Mesh.cpp / Dispatcher.cpp):
     * - Companions do NOT repeat; only Repeaters forward flood or direct packets.
     * - Discovery ('discovery'): ROUTE_TYPE_FLOOD; each repeater appends its 1-byte
     *   hash (growing the on-air frame by +1 byte per hop), never cancels on hearing
     *   another repeater, and retransmits once after random jitter. When Z decodes
     *   the flood, Z returns a ROUTE_TYPE_DIRECT path/ACK back along the reverse path
     *   (shrinking by 1 byte per hop).
     * - Direct ('direct'): ROUTE_TYPE_DIRECT carrying explicit path hashes; only the
     *   matching next repeater pops its hash (shrinking frame by 1 byte/hop) and
     *   forwards. Off-path repeaters & companions drop without transmitting.
     */
    function simulateMeshCore(nodes, links, options) {
        options = options || {};
        var random = options.random || Math.random;
        var sourceId = options.sourceId || 'A';
        var destId = options.destId || 'Z';
        var mode = options.mode || 'discovery'; // 'discovery' | 'direct'
        var floodMax = options.floodMax == null ? 64 : options.floodMax;
        var pathHashSize = options.pathHashSize || 1;
        var preset = resolvePreset(options.preset);
        var textBytes = options.textBytes == null ? DEFAULT_TEXT_BYTES : options.textBytes;

        var slotMs = slotTimeMs(preset);
        var preamSafeMs = preambleSafeMs(preset);
        var graph = buildAdjacency(nodes, links);
        var nodeMap = graph.nodeMap;
        var adjacency = graph.adjacency;
        var optPath = shortestPath(nodes, adjacency, sourceId, destId);
        var shortestHops = optPath.length >= 2 ? optPath.length - 1 : null;
        var reachableCount = countReachable(adjacency, sourceId);

        if (!nodeMap[sourceId]) {
            return emptyResult(destId, floodMax, 'meshcore-' + mode, shortestHops, reachableCount, preset, textBytes);
        }

        var repeaterSet = {};
        var repeaterList = options.repeaterIds
            ? options.repeaterIds
            : selectMeshCoreRepeaters(nodes, links, sourceId, destId, options.repeaterRatio);
        repeaterList.forEach(function (id) { repeaterSet[id] = true; });
        var repeaterCount = Object.keys(repeaterSet).length;
        var companionCount = Math.max(0, nodes.length - 2 - repeaterCount);

        // --- Direct Routing (Phase 2) ---
        if (mode === 'direct') {
            var path = options.learnedPath && options.learnedPath.length >= 2
                ? options.learnedPath
                : optPath;
            if (path.length < 2) {
                return emptyResult(destId, floodMax, 'meshcore-direct', null, reachableCount, preset, textBytes);
            }
            var playback = [];
            var tMs = 0;
            var totalBytes = 0;
            var totalAirtimeMs = 0;
            var deliveredMs = null;
            var heardNodes = {};
            heardNodes[sourceId] = true;

            // Number of intermediate repeater hashes remaining in header starts at path.length - 2
            for (var i = 0; i < path.length - 1; i++) {
                var senderId = path[i];
                var nextId = path[i + 1];
                if (i > 0) {
                    // Direct retransmit delay: minimal TX/RX turnaround (~1-2 slots)
                    tMs += slotMs;
                }
                var remainingHashes = Math.max(0, (path.length - 2) - i);
                var frameBytes = meshCoreFrameBytes('direct', remainingHashes, textBytes, pathHashSize);
                var airMs = loraAirtimeMs(frameBytes, preset);
                var tStart = tMs;
                var tEnd = tStart + airMs;
                totalBytes += frameBytes;
                totalAirtimeMs += airMs;

                var droppedOffPath = [];
                (adjacency[senderId] || []).forEach(function (nbId) {
                    heardNodes[nbId] = true;
                    if (nbId !== nextId && nbId !== path[i - 1]) {
                        droppedOffPath.push(nbId);
                    }
                });

                var delivered = nextId === destId;
                if (delivered) deliveredMs = tEnd;

                playback.push({
                    id: senderId,
                    nextHopId: nextId,
                    packetKind: 'direct',
                    time: Math.round(tStart / slotMs),
                    timeMs: tStart,
                    tEndMs: tEnd,
                    frameBytes: frameBytes,
                    frameBits: frameBytes * 8,
                    airtimeMs: airMs,
                    pathLen: remainingHashes,
                    role: senderId === sourceId ? 'COMPANION' : 'REPEATER',
                    pending: delivered ? [] : [nextId],
                    droppedOffPath: droppedOffPath,
                    suppressed: [],
                    exhausted: delivered ? [destId] : [],
                    collided: [],
                    delivered: delivered
                });
                tMs = tEnd;
            }

            return {
                protocol: 'meshcore',
                mode: 'meshcore-direct',
                preset: preset,
                textBytes: textBytes,
                playback: playback,
                transmissions: playback.length,
                dataTransmissions: playback.length,
                totalBytes: totalBytes,
                totalBits: totalBytes * 8,
                totalAirtimeMs: totalAirtimeMs,
                avgFrameBytes: playback.length ? Math.round(totalBytes / playback.length) : 0,
                cancelled: 0,
                collisions: 0,
                csmaDefers: 0,
                csmaDeferrals: 0,
                hopsToDest: path.length - 1,
                deliveredSlot: deliveredMs != null ? Math.round(deliveredMs / slotMs) : null,
                deliveredMs: deliveredMs,
                ackReturnedMs: null,
                reachedDest: deliveredMs != null,
                destId: destId,
                hopLimit: floodMax,
                shortestHops: shortestHops,
                learnedPath: path,
                repeaterIds: Object.keys(repeaterSet),
                repeaterCount: repeaterCount,
                companionCount: companionCount,
                nodesHeard: Object.keys(heardNodes).length,
                reachableNodes: reachableCount,
                constants: {
                    slotMs: slotMs,
                    packetAirtimeMs: playback.length ? playback[0].airtimeMs : loraAirtimeMs(meshCoreFrameBytes('direct', 0, textBytes, pathHashSize), preset)
                }
            };
        }

        // --- Discovery Flood + Direct Path Return (Phase 1) ---
        var state = {};
        nodes.forEach(function (n) {
            state[n.id] = {
                isRepeater: !!repeaterSet[n.id],
                seenFlood: false,
                status: 'idle',
                token: 0,
                pathSoFar: [],
                txIntervals: [],
                rxFrames: []
            };
        });

        var tokenSeq = 1;
        var evSeq = 0;
        var flightSeq = 0;
        var events = [];
        var activeFlights = {};
        var playback = [];
        var collisions = 0;
        var csmaDefers = 0;
        var deliveredMs = null;
        var ackReturnedMs = null;
        var hopsToDest = null;
        var learnedPath = [];
        var totalBytes = 0;
        var totalAirtimeMs = 0;

        function pushEvent(time, priority, payload) {
            payload.time = time;
            payload.priority = priority;
            payload.seq = ++evSeq;
            events.push(payload);
        }

        function isChannelBusyFor(nodeId, tMs) {
            var ids = Object.keys(activeFlights);
            for (var i = 0; i < ids.length; i++) {
                var f = activeFlights[ids[i]];
                if (f.tStart + slotMs <= tMs && tMs < f.tEnd && f.neighborSet[nodeId]) {
                    return true;
                }
            }
            return false;
        }

        function overlappedTx(st, tStart, tEnd) {
            for (var i = 0; i < st.txIntervals.length; i++) {
                var iv = st.txIntervals[i];
                if (iv[0] < tEnd && iv[1] > tStart) return true;
            }
            return false;
        }

        function timingCollides(frame, other) {
            var first = frame.tStart <= other.tStart ? frame : other;
            var second = frame.tStart <= other.tStart ? other : frame;
            return (second.tStart + preamSafeMs) < first.tEnd;
        }

        function scheduleFloodTx(nodeId, dueMs, pathList) {
            var st = state[nodeId];
            var token = ++tokenSeq;
            st.token = token;
            st.status = 'pending';
            st.outPath = pathList;
            pushEvent(dueMs, 1, {
                type: 'MC_TX_TRY',
                packetKind: 'flood',
                nodeId: nodeId,
                token: token
            });
        }

        state[sourceId].seenFlood = true;
        scheduleFloodTx(sourceId, 0, []);

        while (events.length) {
            events.sort(function (a, b) {
                return a.time - b.time || a.priority - b.priority || a.seq - b.seq;
            });
            var ev = events.shift();

            if (ev.type === 'MC_TX_TRY') {
                var st = state[ev.nodeId];
                if (st.status !== 'pending' || st.token !== ev.token) continue;

                var pathLen = st.outPath.length;
                var frameBytes = meshCoreFrameBytes('flood', pathLen, textBytes, pathHashSize);
                var airMs = loraAirtimeMs(frameBytes, preset);

                if (isChannelBusyFor(ev.nodeId, ev.time)) {
                    csmaDefers++;
                    // MeshCore Dispatcher backs off with small jitter when CAD detects channel busy
                    var deferMs = Math.max(slotMs, Math.round((0.25 + random() * 0.5) * airMs));
                    scheduleFloodTx(ev.nodeId, ev.time + deferMs, st.outPath);
                    continue;
                }

                var tStart = ev.time;
                var tEnd = tStart + airMs;
                st.status = 'transmitting';
                st.txIntervals.push([tStart, tEnd]);
                totalBytes += frameBytes;
                totalAirtimeMs += airMs;

                var flightId = ++flightSeq;
                var neighborList = adjacency[ev.nodeId] || [];
                var neighborSet = {};
                neighborList.forEach(function (nb) { neighborSet[nb] = true; });

                var step = {
                    id: ev.nodeId,
                    packetKind: 'flood',
                    time: Math.round(tStart / slotMs),
                    timeMs: tStart,
                    tEndMs: tEnd,
                    frameBytes: frameBytes,
                    frameBits: frameBytes * 8,
                    airtimeMs: airMs,
                    pathLen: pathLen,
                    role: ev.nodeId === sourceId ? 'COMPANION' : 'REPEATER',
                    pending: [],
                    companionsHeard: [],
                    exhausted: [],
                    suppressed: [],
                    collided: [],
                    delivered: false
                };

                activeFlights[flightId] = {
                    flightId: flightId,
                    senderId: ev.nodeId,
                    outPath: st.outPath.slice(),
                    tStart: tStart,
                    tEnd: tEnd,
                    neighborList: neighborList,
                    neighborSet: neighborSet,
                    step: step
                };
                playback.push(step);

                neighborList.forEach(function (nbId) {
                    state[nbId].rxFrames.push({
                        flightId: flightId,
                        senderId: ev.nodeId,
                        outPath: st.outPath.slice(),
                        tStart: tStart,
                        tEnd: tEnd,
                        snr: linkSnrUnclamped(nodeMap[ev.nodeId], nodeMap[nbId])
                    });
                });

                pushEvent(tEnd, 0, { type: 'MC_TX_END', flightId: flightId });
            } else if (ev.type === 'MC_TX_END') {
                var done = activeFlights[ev.flightId];
                delete activeFlights[ev.flightId];
                if (!done) continue;
                state[done.senderId].status = 'relayed';

                done.neighborList.forEach(function (nbId) {
                    var nbSt = state[nbId];
                    var frame = null;
                    for (var i = 0; i < nbSt.rxFrames.length; i++) {
                        if (nbSt.rxFrames[i].flightId === done.flightId) {
                            frame = nbSt.rxFrames[i];
                            break;
                        }
                    }
                    if (!frame) return;
                    if (overlappedTx(nbSt, frame.tStart, frame.tEnd)) return;

                    var captured = true;
                    for (var j = 0; j < nbSt.rxFrames.length; j++) {
                        var other = nbSt.rxFrames[j];
                        if (other.flightId === frame.flightId) continue;
                        if (timingCollides(frame, other) && (frame.snr - other.snr) < CAPTURE_DB) {
                            captured = false;
                            break;
                        }
                    }
                    if (!captured) {
                        collisions++;
                        done.step.collided.push(nbId);
                        return;
                    }

                    if (nbSt.seenFlood) return;
                    nbSt.seenFlood = true;

                    if (nbId === destId) {
                        if (deliveredMs == null) {
                            deliveredMs = done.tEnd;
                            hopsToDest = frame.outPath.length + 1;
                            learnedPath = [sourceId].concat(frame.outPath).concat([destId]);
                            done.step.delivered = true;
                        }
                        done.step.exhausted.push(nbId);
                        return;
                    }

                    // Companions receive and never repeat in MeshCore!
                    if (!nbSt.isRepeater) {
                        done.step.companionsHeard.push(nbId);
                        return;
                    }

                    // Repeater appends its own hash byte & rebroadcasts once (no duplicate cancel)
                    if (frame.outPath.length < floodMax) {
                        var nextPath = frame.outPath.concat([nbId]);
                        var estAir = loraAirtimeMs(meshCoreFrameBytes('flood', nextPath.length, textBytes, pathHashSize), preset);
                        // Mesh::getRetransmitDelay: ~0..5 * (airtime/2) random jitter
                        var jitterMs = Math.round(slotMs + random() * (estAir * 0.5));
                        scheduleFloodTx(nbId, done.tEnd + jitterMs, nextPath);
                        done.step.pending.push(nbId);
                    } else {
                        done.step.exhausted.push(nbId);
                    }
                });
            }
        }

        // If Z decoded the discovery flood, model Z's ROUTE_TYPE_DIRECT PATH/ACK return to A
        if (learnedPath.length >= 2) {
            var revPath = learnedPath.slice().reverse(); // [Z, ..., A]
            var ackT = deliveredMs + slotMs;
            for (var k = 0; k < revPath.length - 1; k++) {
                var sId = revPath[k];
                var nId = revPath[k + 1];
                var remHashes = Math.max(0, (revPath.length - 2) - k);
                var ackBytes = meshCoreFrameBytes('path-ack', remHashes, textBytes, pathHashSize);
                var ackAir = loraAirtimeMs(ackBytes, preset);
                var aStart = ackT;
                var aEnd = aStart + ackAir;
                totalBytes += ackBytes;
                totalAirtimeMs += ackAir;
                if (nId === sourceId) ackReturnedMs = aEnd;

                playback.push({
                    id: sId,
                    nextHopId: nId,
                    packetKind: 'path-ack',
                    time: Math.round(aStart / slotMs),
                    timeMs: aStart,
                    tEndMs: aEnd,
                    frameBytes: ackBytes,
                    frameBits: ackBytes * 8,
                    airtimeMs: ackAir,
                    pathLen: remHashes,
                    role: sId === destId ? 'COMPANION' : 'REPEATER',
                    pending: nId === sourceId ? [] : [nId],
                    companionsHeard: [],
                    exhausted: nId === sourceId ? [sourceId] : [],
                    suppressed: [],
                    collided: [],
                    delivered: false,
                    ackDelivered: nId === sourceId
                });
                ackT = aEnd + slotMs;
            }
            playback.sort(function (a, b) { return a.timeMs - b.timeMs; });
        }

        var nodesHeard = 0;
        nodes.forEach(function (n) {
            if (state[n.id].seenFlood) nodesHeard++;
        });
        var dataTx = playback.filter(function (s) { return s.packetKind === 'flood'; }).length;

        return {
            protocol: 'meshcore',
            mode: 'meshcore-discovery',
            preset: preset,
            textBytes: textBytes,
            playback: playback,
            transmissions: playback.length,
            dataTransmissions: dataTx,
            totalBytes: totalBytes,
            totalBits: totalBytes * 8,
            totalAirtimeMs: totalAirtimeMs,
            avgFrameBytes: playback.length ? Math.round(totalBytes / playback.length) : 0,
            cancelled: 0,
            collisions: collisions,
            csmaDefers: csmaDefers,
            csmaDeferrals: csmaDefers,
            hopsToDest: hopsToDest,
            deliveredSlot: deliveredMs != null ? Math.round(deliveredMs / slotMs) : null,
            deliveredMs: deliveredMs,
            ackReturnedMs: ackReturnedMs,
            reachedDest: deliveredMs != null,
            destId: destId,
            hopLimit: floodMax,
            shortestHops: shortestHops,
            learnedPath: learnedPath.length >= 2 ? learnedPath : optPath,
            repeaterIds: Object.keys(repeaterSet),
            repeaterCount: repeaterCount,
            companionCount: companionCount,
            nodesHeard: nodesHeard,
            reachableNodes: reachableCount,
            constants: {
                slotMs: slotMs,
                packetAirtimeMs: loraAirtimeMs(meshCoreFrameBytes('flood', 0, textBytes, pathHashSize), preset)
            }
        };
    }

    /**
     * Naive flooding reference (what the old simulator modeled: every reachable
     * node within hopLimit rebroadcasts once, with zero duplicate suppression).
     */
    function simulateNaiveReference(nodes, links, optionsOrHopLimit, sourceId, destId) {
        var hopLimit = optionsOrHopLimit;
        var preset = LORA_PRESETS.LONG_FAST;
        var textBytes = DEFAULT_TEXT_BYTES;
        if (optionsOrHopLimit && typeof optionsOrHopLimit === 'object') {
            hopLimit = optionsOrHopLimit.hopLimit;
            sourceId = optionsOrHopLimit.sourceId;
            destId = optionsOrHopLimit.destId;
            preset = resolvePreset(optionsOrHopLimit.preset);
            if (optionsOrHopLimit.textBytes != null) textBytes = optionsOrHopLimit.textBytes;
        }
        sourceId = sourceId || 'A';
        destId = destId || 'Z';
        hopLimit = hopLimit == null ? MAX_HOP_LIMIT : hopLimit;
        var graph = buildAdjacency(nodes, links);
        var adjacency = graph.adjacency;
        var frameBytes = meshtasticFrameBytes('broadcast', textBytes);
        var airMs = loraAirtimeMs(frameBytes, preset);
        if (!adjacency[sourceId]) {
            return { transmissions: 0, totalBytes: 0, totalBits: 0, totalAirtimeMs: 0, nodesHeard: 0, reachedDest: false, hopsToDest: null };
        }

        var seen = {};
        seen[sourceId] = 0;
        var frontier = [sourceId];
        var tx = 0;
        for (var depth = 0; depth <= hopLimit && frontier.length > 0; depth++) {
            var next = [];
            for (var i = 0; i < frontier.length; i++) {
                var u = frontier[i];
                tx++;
                var nbs = adjacency[u] || [];
                for (var j = 0; j < nbs.length; j++) {
                    var v = nbs[j];
                    if (seen[v] == null) {
                        seen[v] = depth + 1;
                        if (depth < hopLimit) {
                            next.push(v);
                        }
                    }
                }
            }
            frontier = next;
        }
        return {
            transmissions: tx,
            totalBytes: tx * frameBytes,
            totalBits: tx * frameBytes * 8,
            totalAirtimeMs: tx * airMs,
            nodesHeard: Object.keys(seen).length,
            reachedDest: seen[destId] != null,
            hopsToDest: seen[destId] != null ? seen[destId] : null
        };
    }

    /**
     * Apples-to-apples multi-message comparison across routing approaches
     * on the exact same topology, LoRa preset, and text payload length.
     */
    function compareApproaches(nodes, links, options) {
        options = options || {};
        var preset = resolvePreset(options.preset);
        var textBytes = options.textBytes == null ? DEFAULT_TEXT_BYTES : options.textBytes;
        var hopLimit = options.hopLimit == null ? MAX_HOP_LIMIT : options.hopLimit;
        var messageCount = options.messageCount || 10;
        var sourceId = options.sourceId || 'A';
        var destId = options.destId || 'Z';

        var bcast = simulate(nodes, links, {
            hopLimit: hopLimit,
            sourceId: sourceId,
            destId: destId,
            mode: 'broadcast',
            roles: options.roles,
            preserveRouterHops: options.preserveRouterHops,
            preset: preset,
            textBytes: textBytes,
            random: options.random
        });

        var dmFirst = simulate(nodes, links, {
            hopLimit: hopLimit,
            sourceId: sourceId,
            destId: destId,
            mode: 'dm-first',
            roles: options.roles,
            preserveRouterHops: options.preserveRouterHops,
            preset: preset,
            textBytes: textBytes,
            random: options.random
        });

        var dmNext = simulate(nodes, links, {
            hopLimit: hopLimit,
            sourceId: sourceId,
            destId: destId,
            mode: 'dm-nexthop',
            roles: options.roles,
            preserveRouterHops: options.preserveRouterHops,
            learnedPath: dmFirst.learnedPath,
            preset: preset,
            textBytes: textBytes,
            random: options.random
        });

        var mcDisc = simulateMeshCore(nodes, links, {
            sourceId: sourceId,
            destId: destId,
            mode: 'discovery',
            repeaterIds: options.repeaterIds,
            preset: preset,
            textBytes: textBytes,
            random: options.random
        });

        var mcDirect = simulateMeshCore(nodes, links, {
            sourceId: sourceId,
            destId: destId,
            mode: 'direct',
            repeaterIds: mcDisc.repeaterIds,
            learnedPath: mcDisc.learnedPath,
            preset: preset,
            textBytes: textBytes,
            random: options.random
        });

        var naive = simulateNaiveReference(nodes, links, {
            hopLimit: hopLimit,
            sourceId: sourceId,
            destId: destId,
            preset: preset,
            textBytes: textBytes
        });

        var nSub = Math.max(0, messageCount - 1);

        return {
            preset: preset,
            textBytes: textBytes,
            messageCount: messageCount,
            meshtasticBroadcast: {
                first: bcast,
                multi: {
                    tx: bcast.transmissions * messageCount,
                    bytes: bcast.totalBytes * messageCount,
                    bits: bcast.totalBits * messageCount,
                    airtimeMs: bcast.totalAirtimeMs * messageCount,
                    avgPropMs: bcast.deliveredMs
                }
            },
            meshtasticDm: {
                first: dmFirst,
                subsequent: dmNext,
                multi: {
                    tx: dmFirst.transmissions + nSub * dmNext.transmissions,
                    bytes: dmFirst.totalBytes + nSub * dmNext.totalBytes,
                    bits: dmFirst.totalBits + nSub * dmNext.totalBits,
                    airtimeMs: dmFirst.totalAirtimeMs + nSub * dmNext.totalAirtimeMs,
                    avgPropMs: (dmFirst.deliveredMs != null && dmNext.deliveredMs != null)
                        ? Math.round((dmFirst.deliveredMs + nSub * dmNext.deliveredMs) / messageCount)
                        : dmFirst.deliveredMs
                }
            },
            meshcore: {
                first: mcDisc,
                subsequent: mcDirect,
                multi: {
                    tx: mcDisc.transmissions + nSub * mcDirect.transmissions,
                    bytes: mcDisc.totalBytes + nSub * mcDirect.totalBytes,
                    bits: mcDisc.totalBits + nSub * mcDirect.totalBits,
                    airtimeMs: mcDisc.totalAirtimeMs + nSub * mcDirect.totalAirtimeMs,
                    avgPropMs: (mcDisc.deliveredMs != null && mcDirect.deliveredMs != null)
                        ? Math.round((mcDisc.deliveredMs + nSub * mcDirect.deliveredMs) / messageCount)
                        : mcDisc.deliveredMs
                }
            },
            naiveFlood: {
                first: naive,
                multi: {
                    tx: naive.transmissions * messageCount,
                    bytes: naive.totalBytes * messageCount,
                    bits: naive.totalBits * messageCount,
                    airtimeMs: naive.totalAirtimeMs * messageCount,
                    avgPropMs: null
                }
            }
        };
    }

    function emptyResult(destId, hopLimit, mode, shortestHops, reachableCount, preset, textBytes) {
        var p = resolvePreset(preset);
        var txt = textBytes == null ? DEFAULT_TEXT_BYTES : textBytes;
        return {
            protocol: (mode && mode.indexOf('meshcore') === 0) ? 'meshcore' : 'meshtastic',
            mode: mode || 'broadcast',
            preset: p,
            textBytes: txt,
            playback: [],
            transmissions: 0,
            dataTransmissions: 0,
            totalBytes: 0,
            totalBits: 0,
            totalAirtimeMs: 0,
            avgFrameBytes: 0,
            cancelled: 0,
            collisions: 0,
            csmaDefers: 0,
            csmaDeferrals: 0,
            hopsToDest: null,
            deliveredSlot: null,
            deliveredMs: null,
            ackReturnedMs: null,
            reachedDest: false,
            destId: destId,
            hopLimit: hopLimit == null ? DEFAULT_HOP_LIMIT : hopLimit,
            shortestHops: shortestHops == null ? null : shortestHops,
            learnedPath: [],
            nodesHeard: 0,
            reachableNodes: reachableCount || 0,
            constants: { defaultHopLimit: DEFAULT_HOP_LIMIT, maxHopLimit: MAX_HOP_LIMIT, slotMs: slotTimeMs(p) }
        };
    }

    return {
        simulate: simulate,
        simulateMeshCore: simulateMeshCore,
        simulateNaiveReference: simulateNaiveReference,
        compareApproaches: compareApproaches,
        selectMeshCoreRepeaters: selectMeshCoreRepeaters,
        LORA_PRESETS: LORA_PRESETS,
        loraAirtimeMs: loraAirtimeMs,
        slotTimeMs: slotTimeMs,
        preambleSafeMs: preambleSafeMs,
        meshtasticFrameBytes: meshtasticFrameBytes,
        meshCoreFrameBytes: meshCoreFrameBytes,
        cwSize: cwSize,
        snrAt: snrAt,
        linkSnrUnclamped: linkSnrUnclamped,
        DEFAULT_HOP_LIMIT: DEFAULT_HOP_LIMIT,
        MAX_HOP_LIMIT: MAX_HOP_LIMIT
    };
});
