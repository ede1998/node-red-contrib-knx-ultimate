//const knx = require('knx');
//const dptlib = require('knx/src/dptlib');
const knx = require('knxultimate-api');
const dptlib = require('knxultimate-api/src/dptlib');

const oOS = require('os')

//Helpers
sortBy = (field) => (a, b) => {
    if (a[field] > b[field]) { return 1 } else { return -1 }
};


onlyDptKeys = (kv) => {
    return kv[0].startsWith("DPT")
};

extractBaseNo = (kv) => {
    return {
        subtypes: kv[1].subtypes,
        base: parseInt(kv[1].id.replace("DPT", ""))
    }
};

convertSubtype = (baseType) => (kv) => {
    let value = `${baseType.base}.${kv[0]}`
    return {
        value: value
        , text: value + ` (${kv[1].name})`
    }
}

// 06/02/2020 To be tested
// convertSubtype = (baseType) => (kv) => {
//     let value = `${baseType.base}.${kv[0]}`
//     return {
//         value: value
//         , text: value + ` (${kv[1].name}${kv[1].unit !== undefined?" - " + kv[1].unit:""})`
//     }
// }


toConcattedSubtypes = (acc, baseType) => {
    let subtypes =
        Object.entries(baseType.subtypes)
            .sort(sortBy(0))
            .map(convertSubtype(baseType))

    return acc.concat(subtypes)
};


module.exports = (RED) => {


    RED.httpAdmin.get("/knxUltimateDpts", RED.auth.needsPermission('knxUltimate-config.read'), function (req, res) {
        const dpts =
            Object.entries(dptlib)
                .filter(onlyDptKeys)
                .map(extractBaseNo)
                .sort(sortBy("base"))
                .reduce(toConcattedSubtypes, [])

        res.json(dpts)
    });

    function knxUltimateConfigNode(config) {
        RED.nodes.createNode(this, config)
        var node = this
        node.host = config.host
        node.port = config.port
        node.physAddr = config.physAddr || "15.15.22"; // the KNX physical address we'd like to use
        node.suppressACKRequest = typeof config.suppressACKRequest === "undefined" ? false : config.suppressACKRequest; // enable this option to suppress the acknowledge flag with outgoing L_Data.req requests. LoxOne needs this
        node.linkStatus = "disconnected";
        node.nodeClients = [] // Stores the registered clients
        node.KNXEthInterface = typeof config.KNXEthInterface === "undefined" ? "Auto" : config.KNXEthInterface;
        node.KNXEthInterfaceManuallyInput = typeof config.KNXEthInterfaceManuallyInput === "undefined" ? "" : config.KNXEthInterfaceManuallyInput; // If you manually set the interface name, it will be wrote here
        node.statusDisplayLastUpdate = config.statusDisplayLastUpdate || true;
        node.statusDisplayDeviceNameWhenALL = config.statusDisplayDeviceNameWhenALL || false;
        node.statusDisplayDataPoint = config.statusDisplayDataPoint || false;
        node.telegramsQueue = [];  // 02/01/2020 Queue containing telegrams
        node.timerSendTelegramFromQueue = setInterval(handleTelegramQueue, 50); // 02/01/2020 Start the timer that handles the queue of telegrams
        node.timerDoInitialRead = null; // 17/02/2020 Timer (timeout) to do initial read of all nodes requesting initial read, after all nodes have been registered to the sercer
        node.stopETSImportIfNoDatapoint = typeof config.stopETSImportIfNoDatapoint === "undefined" ? "stop" : config.stopETSImportIfNoDatapoint; // 09/01/2020 Stop or Skip the import if a group address has unset datapoint
        node.csv = readCSV(config.csv); // Array from ETS CSV Group Addresses
        node.loglevel = config.loglevel !== undefined ? config.loglevel : "error"; // 18/02/2020 Loglevel default error

        // Endpoint for reading csv from the other nodes
        RED.httpAdmin.get("/knxUltimatecsv", RED.auth.needsPermission('knxUltimate-config.read'), function (req, res) {
            res.json(RED.nodes.getNode(node.id).csv);
        });

        // 14/08/2019 Endpoint for retrieving the ethernet interfaces
        RED.httpAdmin.get("/knxUltimateETHInterfaces", RED.auth.needsPermission('knxUltimate-config.read'), function (req, res) {
            var oiFaces = oOS.networkInterfaces();
            var jListInterfaces = [];
            try {
                Object.keys(oiFaces).forEach(ifname => {
                    // Interface with single IP
                    if (Object.keys(oiFaces[ifname]).length === 1) {
                        if (Object.keys(oiFaces[ifname])[0].internal == false) jListInterfaces.push({ name: ifname, address: Object.keys(oiFaces[ifname])[0].address });
                    } else {
                        var sAddresses = "";
                        oiFaces[ifname].forEach(function (iface) {
                            if (iface.internal == false) sAddresses += "+" + iface.address;
                        });
                        if (sAddresses !== "") jListInterfaces.push({ name: ifname, address: sAddresses });
                    }
                })
            } catch (error) { }
            res.json(jListInterfaces)
        });

        // 14/02/2020 Endpoint for retrieving all nodes in all flows
        RED.httpAdmin.get("/nodeList", RED.auth.needsPermission('knxUltimate-config.read'), function (req, res) {
            var sNodes = "\"Group Address\"\t\"Datapoint\"\t\"Node ID\"\t\"Device Name\"\n"; // Contains the text with nodes
            var sGA = "";
            var sDPT = "";
            var sName = "";
            var sNodeID = "";
            try {
                node.nodeClients
                    //.map( a => a.topic.indexOf("/") !== -1 ? a.topic.split('/').map( n => +n+100000 ).join('/'):0 ).sort().map( a => a.topic.indexOf("/") !== -1 ? a.topic.split('/').map( n => +n-100000 ).join('/'):0 )
                    .sort((a, b) => {
                        if (a.topic.indexOf("/") === -1) return -1;
                        if (b.topic.indexOf("/") === -1) return -1;
                        var date1 = a.topic.split("/");
                        var date2 = b.topic.split("/");
                        date1 = date1[0].padStart(2, "0") + date1[1].padStart(2, "0") + date1[2].padStart(2, "0");
                        date2 = date2[0].padStart(2, "0") + date2[1].padStart(2, "0") + date2[2].padStart(2, "0");
                        return date1.localeCompare(date2);
                    })
                    .forEach(input => {
                        sNodeID = "\"" + input.id + "\"";
                        sName = "\"" + input.name + "\"";
                        if (input.listenallga == true) {
                            // Is a ListenallGA
                            sGA = "\"Universal Node\"";
                            sDPT = "\"Any\"";
                        } else {
                            sGA = "\"" + input.topic + "\"";
                            sDPT = "\"" + input.dpt + "\"";
                            if (input.hasOwnProperty("isWatchDog")) {
                                // Is a watchdog node

                            } else {
                                // Is a device node

                            };
                        };
                        sNodes += sGA + "\t" + sDPT + "\t" + sNodeID + "\t" + sName + "\n";
                    });
                res.json(sNodes)
            } catch (error) {
            }
        });


        node.setAllClientsStatus = (_status, _color, _text) => {
            function nextStatus(oClient) {
                oClient.setNodeStatus({ fill: _color, shape: "dot", text: _status + " " + _text, payload: "", GA: oClient.topic, dpt: "", devicename: "" })
            }
            node.nodeClients.map(nextStatus);
        }

        // 16/02/2020 KNX-Ultimate nodes calls this function, then this funcion calls the same function on the Watchdog
        node.reportToWatchdogCalledByKNXUltimateNode = (_oError) => {
            var readHistory = [];
            let delay = 0;
            node.nodeClients
                .filter(oClient => (oClient.isWatchDog !== undefined && oClient.isWatchDog === true))
                .forEach(oClient => {
                    oClient.signalNodeErrorCalledByConfigNode(_oError);
                })
        }

        node.Disconnect = () => {
            if (node.timerDoInitialRead !== null) clearTimeout(node.timerDoInitialRead); // 17/02/2020 Stop the initial read timer
            node.telegramsQueue = []; // 02/01/2020 clear the telegram queue
            node.setAllClientsStatus("Waiting", "grey", "")
            // Remove listener
            try {
                node.knxConnection.removeListener("event");
            } catch (error) {

            }
            try {
                node.knxConnection.off("event");
            } catch (error) {

            }
            node.linkStatus = "disconnected"; // 29/08/2019 signal disconnection
            try {
                node.knxConnection.Disconnect();
            } catch (error) {
            }

            node.knxConnection = null;
        }

        node.addClient = (_Node) => {
            // Check if node already exists
            if (node.nodeClients.filter(x => x.id === _Node.id).length === 0) {
                // Check if the node has a valid topic and dpt
                if (_Node.listenallga == false) {
                    if (typeof _Node.topic == "undefined" || typeof _Node.dpt == "undefined") {
                        _Node.setNodeStatus({ fill: "red", shape: "dot", text: "Empty Group Addr. or datapoint.", payload: "", GA: "", dpt: "", devicename: "" })
                        return;
                    } else {

                        // topic must be in formar x/x/x
                        if (_Node.topic.split("\/").length < 3) {
                            _Node.setNodeStatus({ fill: "red", shape: "dot", text: "Wrong group address (topic: " + _Node.topic + ") format.", payload: "", GA: "", dpt: "", devicename: "" })
                            return;
                        }
                    }
                }
                // Add _Node to the clients array
                node.nodeClients.push(_Node)
            }
            // At first node client connection, this node connects to the bus
            if (node.nodeClients.length === 1) {
                // 14/08/2018 Initialize the connection
                node.initKNXConnection();
            }
        }

        node.removeClient = (_Node) => {
            // Remove the client node from the clients array
            //RED.log.info( "BEFORE Node " + _Node.id + " has been unsubscribed from receiving KNX messages. " + node.nodeClients.length);
            try {
                node.nodeClients = node.nodeClients.filter(x => x.id !== _Node.id)
            } catch (error) { }
            //RED.log.info("AFTER Node " + _Node.id + " has been unsubscribed from receiving KNX messages. " + node.nodeClients.length);

            // If no clien nodes, disconnect from bus.
            if (node.nodeClients.length === 0) {
                node.linkStatus = "disconnected";
                node.Disconnect();
            }
        }


        // 17/02/2020 Do initial read (called by node.timerDoInitialRead timer)
        function readInitialValues() {
            if (node.linkStatus !== "connected") return; // 29/08/2019 If not connected, exit
            RED.log.info("knxUltimate: Do readInitialValues");
            if (node.knxConnection) {
                var readHistory = [];
                node.nodeClients
                    .filter(oClient => oClient.initialread)
                    .filter(oClient => oClient.hasOwnProperty("isWatchDog") === false)
                    .forEach(oClient => {
                        if (oClient.listenallga == true) {
                            for (let index = 0; index < node.csv.length; index++) {
                                const element = node.csv[index];
                                if (readHistory.includes(element.ga)) return;
                                node.writeQueueAdd({ grpaddr: element.ga, payload: "", dpt: "", outputtype: "read" });
                                readHistory.push(element.ga)
                            }
                        } else {
                            if (readHistory.includes(oClient.topic)) return;
                            node.writeQueueAdd({ grpaddr: oClient.topic, payload: "", dpt: "", outputtype: "read" });
                            readHistory.push(oClient.topic)
                        }
                    })
            }
        }


        // 01/02/2020 Dinamic change of the KNX Gateway IP, Port and Physical Address
        // This new thing has been requested by proServ RealKNX staff.
        node.setGatewayConfig = (_sIP, _iPort, _sPhysicalAddress, _sBindToEthernetInterface) => {
            if (typeof _sIP !== "undefined" && _sIP !== "") node.host = _sIP;
            if (typeof _iPort !== "undefined" && _iPort !== 0) node.port = _iPort;
            if (typeof _sPhysicalAddress !== "undefined" && _sPhysicalAddress !== "") node.physAddr = _sPhysicalAddress;
            if (typeof _sBindToEthernetInterface !== "undefined") node.KNXEthInterface = _sBindToEthernetInterface;
            setTimeout(() => node.setAllClientsStatus("CONFIG", "yellow", "Node's main config setting has been changed."), 1000);
            setTimeout(() => node.setAllClientsStatus("CONFIG", "green", "New config: IP " + node.host + " Port " + node.port + " PhysicalAddress " + node.physAddr + " BindToInterface " + node.KNXEthInterface), 2000)
            RED.log.info("Node's main config setting has been changed. New config: IP " + node.host + " Port " + node.port + " PhysicalAddress " + node.physAddr + " BindToInterface " + node.KNXEthInterface);
            if (node.knxConnection) {
                node.initKNXConnection();
            };
        };

        node.initKNXConnection = () => {
            node.Disconnect();
            node.setAllClientsStatus("Waiting", "grey", "")

            var knxConnectionProperties = {
                ipAddr: node.host,
                ipPort: node.port,
                physAddr: node.physAddr, // the KNX physical address we'd like to use
                suppress_ack_ldatareq: node.suppressACKRequest,
                loglevel: node.loglevel,
                // wait at least 60 millisec between each datagram
                //minimumDelay: 60, // 02/01/2020 Removed becuse it doesn't respect the message sequence, it sends messages random.
                handlers: {
                    connected: () => {
                        node.linkStatus = "connected";
                        node.setAllClientsStatus("Connected", "green", "Waiting for telegram.")
                        // Start the timer to do initial read.
                        if (node.timerDoInitialRead !== null) clearTimeout(node.timerDoInitialRead);
                        node.timerDoInitialRead = setTimeout(readInitialValues, 5000); // 17/02/2020 Do initial read of all nodes requesting initial read, after all nodes have been registered to the sercer
                    },
                    error: function (connstatus) {
                        // NO_ERROR: 0x00, // E_NO_ERROR - The connection was established succesfully
                        // E_HOST_PROTOCOL_TYPE: 0x01,
                        // E_VERSION_NOT_SUPPORTED: 0x02,
                        // E_SEQUENCE_NUMBER: 0x04,
                        // E_CONNSTATE_LOST: 0x15, // typo in eibd/libserver/eibnetserver.cpp:394, forgot 0x prefix ??? "uchar res = 21;"
                        // E_CONNECTION_ID: 0x21, // - The KNXnet/IP server device could not find an active data connection with the given ID
                        // E_CONNECTION_TYPE: 0x22, // - The requested connection type is not supported by the KNXnet/IP server device
                        // E_CONNECTION_OPTION: 0x23, // - The requested connection options is not supported by the KNXnet/IP server device
                        // E_NO_MORE_CONNECTIONS: 0x24, //  - The KNXnet/IP server could not accept the new data connection (Maximum reached)
                        // E_DATA_CONNECTION: 0x26,// - The KNXnet/IP server device detected an erro concerning the Dat connection with the given ID
                        // E_KNX_CONNECTION: 0x27,  // - The KNXnet/IP server device detected an error concerning the KNX Bus with the given ID
                        // E_TUNNELING_LAYER: 0x29,
                        node.linkStatus = "disconnected";
                        if (connstatus == "E_KNX_CONNECTION") {
                            setTimeout(() => node.setAllClientsStatus(connstatus, "grey", "Error on KNX BUS. Check KNX red/black connector and cable."), 2000)
                            RED.log.error("knxUltimate: Bind KNX Bus to interface error: " + connstatus);
                        } else {
                            setTimeout(() => node.setAllClientsStatus(connstatus, "grey", "Error"), 2000)
                            RED.log.error("knxUltimate: knxConnection error: " + connstatus);
                        }

                    }
                }
            };

            if (node.KNXEthInterface !== "Auto") {
                var sIfaceName = "";
                if (node.KNXEthInterface === "Manual") {
                    sIfaceName = node.KNXEthInterfaceManuallyInput;
                    RED.log.info("knxUltimate: Bind KNX Bus to interface : " + sIfaceName + " (Interface's name entered by hand)");
                } else {
                    sIfaceName = node.KNXEthInterface;
                    RED.log.info("knxUltimate: Bind KNX Bus to interface : " + sIfaceName + " (Interface's name selected from dropdown list)");
                }
                knxConnectionProperties.interface = sIfaceName;
            } else {
                RED.log.info("knxUltimate: Bind KNX Bus to interface (Auto)");
            }

            node.knxConnection = new knx.Connection(knxConnectionProperties);

            // Handle BUS events
            node.knxConnection.on("event", function (evt, src, dest, rawValue) {
                switch (evt) {
                    case "GroupValue_Write": {
                        node.nodeClients
                            .filter(input => input.notifywrite == true)
                            .forEach(input => {
                                if (input.listenallga == true) {
                                    // Get the GA from CVS
                                    let oGA;
                                    try {
                                        oGA = node.csv.filter(sga => sga.ga == dest)[0];
                                    } catch (error) { }

                                    // 25/10/2019 TRY TO AUTO DECODE IF Group address not found in the CSV
                                    let msg = buildInputMessage({ _srcGA: src, _destGA: dest, _event: evt, _Rawvalue: rawValue, _inputDpt: (typeof oGA === "undefined") ? null : oGA.dpt, _devicename: (typeof oGA === "undefined") ? input.name || "" : oGA.devicename, _outputtopic: dest, _oNode: input });
                                    input.setNodeStatus({ fill: "green", shape: "dot", text: (typeof oGA === "undefined") ? "Try to decode" : "", payload: msg.payload, GA: msg.knx.destination, dpt: msg.knx.dpt, devicename: msg.devicename });
                                    input.send(msg)

                                } else if (input.topic == dest) {
                                    // 04/02/2020 Watchdog implementation
                                    if (input.hasOwnProperty("isWatchDog")) {
                                        // Is a watchdog node
                                        input.evalCalledByConfigNode("Write");
                                    } else {
                                        let msg = buildInputMessage({ _srcGA: src, _destGA: dest, _event: evt, _Rawvalue: rawValue, _inputDpt: input.dpt, _devicename: input.name ? input.name : "", _outputtopic: input.outputtopic, _oNode: input })
                                        // Check RBE INPUT from KNX Bus, to avoid send the payload to the flow, if it's equal to the current payload
                                        if (!checkRBEInputFromKNXBusAllowSend(input, msg.payload)) {
                                            input.setNodeStatus({ fill: "grey", shape: "ring", text: "rbe block (" + msg.payload + ") from KNX", payload: "", GA: "", dpt: "", devicename: "" })
                                            return;
                                        };
                                        msg.previouspayload = typeof input.currentPayload !== "undefined" ? input.currentPayload : ""; // 24/01/2020 Added previous payload
                                        input.currentPayload = msg.payload;// Set the current value for the RBE input
                                        input.setNodeStatus({ fill: "green", shape: "dot", text: "", payload: msg.payload, GA: input.topic, dpt: input.dpt, devicename: "" });
                                        input.send(msg);
                                    };
                                };
                            });
                        break;
                    };
                    case "GroupValue_Response": {

                        node.nodeClients
                            .filter(input => input.notifyresponse == true)
                            .forEach(input => {
                                if (input.listenallga == true) {
                                    // Get the DPT
                                    let oGA;
                                    try {
                                        oGA = node.csv.filter(sga => sga.ga == dest)[0];
                                    } catch (error) { }

                                    // 25/10/2019 TRY TO AUTO DECODE IF Group address not found in the CSV
                                    let msg = buildInputMessage({ _srcGA: src, _destGA: dest, _event: evt, _Rawvalue: rawValue, _inputDpt: (typeof oGA === "undefined") ? null : oGA.dpt, _devicename: (typeof oGA === "undefined") ? input.name || "" : oGA.devicename, _outputtopic: dest, _oNode: input });
                                    input.setNodeStatus({ fill: "green", shape: "dot", text: (typeof oGA === "undefined") ? "Try to decode" : "", payload: msg.payload, GA: msg.knx.destination, dpt: msg.knx.dpt, devicename: msg.devicename });
                                    input.send(msg)

                                } else if (input.topic == dest) {
                                    // 04/02/2020 Watchdog implementation
                                    if (input.hasOwnProperty("isWatchDog")) {
                                        // Is a watchdog node
                                        input.evalCalledByConfigNode("Response");
                                    } else {
                                        let msg = buildInputMessage({ _srcGA: src, _destGA: dest, _event: evt, _Rawvalue: rawValue, _inputDpt: input.dpt, _devicename: input.name ? input.name : "", _outputtopic: input.outputtopic, _oNode: input })
                                        // Check RBE INPUT from KNX Bus, to avoid send the payload to the flow, if it's equal to the current payload
                                        if (!checkRBEInputFromKNXBusAllowSend(input, msg.payload)) {
                                            input.setNodeStatus({ fill: "grey", shape: "ring", text: "rbe INPUT filter applied on " + msg.payload })
                                            return;
                                        };
                                        msg.previouspayload = typeof input.currentPayload !== "undefined" ? input.currentPayload : ""; // 24/01/2020 Added previous payload
                                        input.currentPayload = msg.payload; // Set the current value for the RBE input
                                        input.setNodeStatus({ fill: "blue", shape: "dot", text: "", payload: msg.payload, GA: input.topic, dpt: msg.knx.dpt, devicename: msg.devicename });
                                        input.send(msg)
                                    };
                                };
                            });
                        break;
                    };
                    case "GroupValue_Read": {

                        node.nodeClients
                            .filter(input => input.notifyreadrequest == true)
                            .forEach(input => {

                                if (input.listenallga == true) {
                                    // Get the DPT
                                    let oGA;
                                    try {
                                        oGA = node.csv.filter(sga => sga.ga == dest)[0];
                                    } catch (error) { }

                                    // 25/10/2019 TRY TO AUTO DECODE IF Group address not found in the CSV
                                    let msg = buildInputMessage({ _srcGA: src, _destGA: dest, _event: evt, _Rawvalue: null, _inputDpt: (typeof oGA === "undefined") ? null : oGA.dpt, _devicename: (typeof oGA === "undefined") ? input.name || "" : oGA.devicename, _outputtopic: dest, _oNode: input });
                                    input.setNodeStatus({ fill: "green", shape: "dot", text: (typeof oGA === "undefined") ? "Try to decode" : "", payload: msg.payload, GA: msg.knx.destination, dpt: msg.knx.dpt, devicename: msg.devicename });
                                    input.send(msg)

                                } else if (input.topic == dest) {

                                    // 04/02/2020 Watchdog implementation
                                    if (input.hasOwnProperty("isWatchDog")) {
                                        // Is a watchdog node
                                        input.evalCalledByConfigNode("Read");
                                    } else {
                                        let msg = buildInputMessage({ _srcGA: src, _destGA: dest, _event: evt, _Rawvalue: null, _inputDpt: input.dpt, _devicename: input.name ? input.name : "", _outputtopic: input.outputtopic, _oNode: input })
                                        msg.previouspayload = typeof input.currentPayload !== "undefined" ? input.currentPayload : ""; // 24/01/2020 Reset previous payload
                                        // 24/09/2019 Autorespond to BUS
                                        if (input.notifyreadrequestalsorespondtobus === true) {
                                            if (typeof input.currentPayload === "undefined" || input.currentPayload === "") {
                                                setTimeout(() => {
                                                    node.knxConnection.respond(dest, input.notifyreadrequestalsorespondtobusdefaultvalueifnotinitialized, input.dpt);
                                                    input.setNodeStatus({ fill: "blue", shape: "ring", text: "Read & Autorespond with default", payload: input.notifyreadrequestalsorespondtobusdefaultvalueifnotinitialized, GA: input.topic, dpt: msg.knx.dpt, devicename: "" });
                                                }, 200);
                                            } else {
                                                setTimeout(() => {
                                                    node.knxConnection.respond(dest, input.currentPayload, input.dpt);
                                                    input.setNodeStatus({ fill: "blue", shape: "ring", text: "Read & Autorespond", payload: input.currentPayload, GA: input.topic, dpt: msg.knx.dpt, devicename: "" });
                                                }, 200);
                                            };
                                        } else {
                                            input.setNodeStatus({ fill: "grey", shape: "dot", text: "Read", payload: msg.payload, GA: input.topic, dpt: msg.knx.dpt, devicename: "" });
                                        };
                                        input.send(msg);
                                    };
                                };
                            });
                        break;
                    };
                    default: return
                };
            });
        };


        // 02/01/2020 All sent messages are queued, to allow at least 50 milliseconds between each telegram sent to the bus
        node.writeQueueAdd = _oKNXMessage => {
            // _oKNXMessage is { grpaddr, payload,dpt,outputtype (write or response)}
            node.telegramsQueue.unshift(_oKNXMessage); // Add _oKNXMessage as first in the buffer
        }

        function handleTelegramQueue() {
            if (node.knxConnection) {
                if (node.telegramsQueue.length == 0) {
                    return;
                }
                // Retrieving oKNXMessage  { grpaddr, payload,dpt,outputtype (write or response)}
                var oKNXMessage = node.telegramsQueue[node.telegramsQueue.length - 1]; // Get the last message in the queue
                node.telegramsQueue.pop();// Remove the last message from the queue.
                if (oKNXMessage.outputtype === "response") {
                    node.knxConnection.respond(oKNXMessage.grpaddr, oKNXMessage.payload, oKNXMessage.dpt);
                } else if (oKNXMessage.outputtype === "read") {
                    node.knxConnection.read(oKNXMessage.grpaddr);
                } else {
                    node.knxConnection.write(oKNXMessage.grpaddr, oKNXMessage.payload, oKNXMessage.dpt);
                }
            }
        }

        // 14/08/2019 If the node has payload same as the received telegram, return false
        checkRBEInputFromKNXBusAllowSend = (_node, _KNXTelegramPayload) => {
            if (_node.inputRBE !== true) return true;
            if (typeof _node.currentPayload === "undefined") return true;
            var curVal = _node.currentPayload.toString().toLowerCase();
            var newVal = _KNXTelegramPayload.toString().toLowerCase();
            if (curVal === "false") {
                curVal = "0";
            }
            if (curVal === "true") {
                curVal = "1";
            }
            if (newVal === "false") {
                newVal = "0";
            }
            if (newVal === "true") {
                newVal = "1";
            }
            if (curVal === newVal) {
                return false;
            }
            return true;
        }

        // 26/10/2019 Try to figure out the datapoint type from raw value
        function tryToFigureOutDataPointFromRawValue(_rawValue) {
            // 25/10/2019 Try some Datapoints
            if (_rawValue === null) return "1.001";
            if (_rawValue.length == 1) {
                if (_rawValue[0].toString() == "0" || _rawValue[0].toString() == "1") {
                    return "1.001"; // True/False?
                } else {
                    return "5.001"; // Absolute Brightness ?
                }
            } else if (_rawValue.length == 4) {
                return "14.056"; // Watt ?
            } else if (_rawValue.length == 2) {
                return "9.001";
            } else if (_rawValue.length == 14) {
                return "16.001"; // Text ?
            } else {
                // Dont' know, try until no errors
                let dpts =
                    Object.entries(dptlib)
                        .filter(onlyDptKeys)
                        .map(extractBaseNo)
                        .sort(sortBy("base"))
                        .reduce(toConcattedSubtypes, []);
                for (let index = 0; index < dpts.length; index++) {
                    const element = dpts[index];
                    try {
                        //dpt.value)
                        //dpt.text))
                        var dpt = dptlib.resolve(element.value);
                        if (typeof dpt !== "undefined") {
                            var jsValue = dptlib.fromBuffer(_rawValue, dpt)
                            if (typeof jsValue !== "undefined") {
                                //RED.log.info("Trying for " + dest + ". FOUND " + element.value);
                                return element.value;
                            }
                        }
                    } catch (error) {

                    }
                }
            }
        }

        function buildInputMessage({ _srcGA, _destGA, _event, _Rawvalue, _inputDpt, _devicename, _outputtopic, _oNode }) {
            var sPayloadmeasureunit = "unknown";
            var sDptdesc = "unknown";
            var sPayloadsubtypevalue = "unknown";
            var jsValue = null;

            // Resolve DPT and convert value if available
            if (_Rawvalue !== null) {
                sInputDpt = (_inputDpt === null) ? tryToFigureOutDataPointFromRawValue(_Rawvalue) : _inputDpt;

                var dpt = dptlib.resolve(sInputDpt);
                if (dpt && _Rawvalue !== null) {
                    var jsValue = dptlib.fromBuffer(_Rawvalue, dpt)
                }

                // Formatting the msg output value
                if (_oNode !== null && jsValue !== null) {
                    if (typeof jsValue === "number") {
                        // multiplier
                        jsValue = jsValue * _oNode.formatmultiplyvalue;
                        // Number of decimals
                        if (_oNode.formatdecimalsvalue == 999) {
                            // Leave as is
                        } else {
                            // Round
                            jsValue = +(Math.round(jsValue + "e+" + _oNode.formatdecimalsvalue) + "e-" + _oNode.formatdecimalsvalue);
                        }
                        // leave, zero or abs
                        if (jsValue < 0) {
                            if (_oNode.formatnegativevalue == "zero") {
                                jsValue = 0;
                            } else if (_oNode.formatnegativevalue == "abs") {
                                jsValue = Math.abs(jsValue);
                            }
                        }
                    }
                }

                if (dpt.subtype !== undefined) {
                    sPayloadmeasureunit = dpt.subtype.unit !== undefined ? dpt.subtype.unit : "unknown";
                    sDptdesc = dpt.subtype.desc !== undefined ? dpt.subtype.desc.charAt(0).toUpperCase() + dpt.subtype.desc.slice(1) : "unknown";
                    if (dpt.subtype.enc !== undefined) {
                        try {
                            if (!Boolean(jsValue)) sPayloadsubtypevalue = dpt.subtype.enc[0];
                            if (Boolean(jsValue)) sPayloadsubtypevalue = dpt.subtype.enc[1];
                        } catch (error) {
                        }
                    }
                };
            }

            // Build final input message object
            return {
                topic: _outputtopic
                , payload: jsValue
                , payloadmeasureunit: sPayloadmeasureunit
                , payloadsubtypevalue: sPayloadsubtypevalue
                , devicename: (typeof _devicename !== 'undefined') ? _devicename : ""
                , knx:
                {
                    event: _event
                    , dpt: sInputDpt
                    //, details: dpt
                    , dptdesc: sDptdesc
                    , source: _srcGA
                    , destination: _destGA
                    , rawValue: _Rawvalue
                }
            };
        };


        node.on("close", function () {
            if (node.timerSendTelegramFromQueue !== undefined) clearInterval(node.timerSendTelegramFromQueue); // 02/01/2020 Stop queue timer
            node.Disconnect();
        })

        function readCSV(_csvText) {

            // 24/02/2020, in the middle of Coronavirus emergency in Italy. Check if it a CSV ETS Export of group addresses, or if it's an EFS
            if (_csvText.split("\n")[0].toUpperCase().indexOf("GROUP NAME") == -1) return readESF(_csvText);

            var ajsonOutput = new Array(); // Array: qui va l'output totale con i nodi per node-red

            if (_csvText == "") {
                RED.log.info('knxUltimate: no csv ETS found');
                return;
            } else {
                RED.log.info('knxUltimate: csv ETS found !');
                // 23/08/2019 Delete inwanted CRLF in the GA description
                let sTemp = correctCRLFInCSV(_csvText);

                // Read and decode the CSV in an Array containing:  "group address", "DPT", "Device Name"
                let fileGA = sTemp.split("\n");
                // Controllo se le righe dei gruppi contengono il separatore di tabulazione
                if (fileGA[0].search("\t") == -1) {
                    RED.log.error('knxUltimate: ERROR: the csv ETS file must have the tabulation as separator')
                    return;
                }

                var sFirstGroupName = "";
                var sSecondGroupName = "";
                var sFather = "";
                for (let index = 0; index < fileGA.length; index++) {
                    var element = fileGA[index];
                    element = element.replace(/\"/g, ""); // Rimuovo le virgolette

                    if (element !== "") {

                        // Main and secondary group names
                        if ((element.split("\t")[1].match(/-/g) || []).length == 2) {
                            // Found main group family name (Example Light Actuators)
                            sFirstGroupName = element.split("\t")[0] || "";
                            sSecondGroupName = "";
                        }
                        if ((element.split("\t")[1].match(/-/g) || []).length == 1) {
                            // Found second group family name (Example First Floor light)
                            sSecondGroupName = element.split("\t")[0] || "";
                        }
                        if (sFirstGroupName !== "" && sSecondGroupName !== "") { sFather = "(" + sFirstGroupName + "->" + sSecondGroupName + ") " }

                        if (element.split("\t")[1].search("-") == -1 && element.split("\t")[1].search("/") !== -1) {
                            // Ho trovato una riga contenente un GA valido, cioè con 2 "/"
                            if (element.split("\t")[5] == "") {
                                RED.log.error("knxUltimate: ERROR: Datapoint not set in ETS CSV. Please set the datapoint with ETS and export the group addresses again. ->" + element.split("\t")[0] + " " + element.split("\t")[1])
                                if (node.stopETSImportIfNoDatapoint === "stop") {
                                    RED.log.error("knxUltimate: ABORT IMPORT OF ETS CSV FILE. To skip the invalid datapoint and continue import, change the related setting, located in the config node in the ETS import section.");
                                    return;
                                }
                            } else {
                                var DPTa = element.split("\t")[5].split("-")[1];
                                var DPTb = element.split("\t")[5].split("-")[2];
                                if (typeof DPTb == "undefined") {
                                    RED.log.warn("knxUltimate: WARNING: Datapoint not fully set (there is only the first part on the left of the '.'). I applied a default .001, but please set the datapoint with ETS and export the group addresses again. ->" + element.split("\t")[0] + " " + element.split("\t")[1] + " Datapoint: " + element.split("\t")[5]);
                                    DPTb = "001"; // default
                                }
                                // Trailing zeroes
                                if (DPTb.length == 1) {
                                    DPTb = "00" + DPTb;
                                } else if (DPTb.length == 2) {
                                    DPTb = "0" + DPTb;
                                } if (DPTb.length == 3) {
                                    DPTb = "" + DPTb; // stupid, but for readability
                                }
                                ajsonOutput.push({ ga: element.split("\t")[1], dpt: DPTa + "." + DPTb, devicename: sFather + element.split("\t")[0] });
                            }
                        }
                    }
                }

                return ajsonOutput;
            }

        }

        function readESF(_esfText) {
            // 24/02/2020 must do an EIS to DPT conversion.
            // Format: Attuatori luci.Luci primo piano.0/0/1	Luce camera da letto	EIS 1 'Switching' (1 Bit)	Low
            var ajsonOutput = new Array(); // Array: qui va l'output totale con i nodi per node-red

            if (_esfText == "") {
                RED.log.info('knxUltimate: no ESF found');
                return;
            } else {
                RED.log.info('knxUltimate: esf ETS found !');
                // Read and decode the CSV in an Array containing:  "group address", "DPT", "Device Name"
                let fileGA = _esfText.split("\n");
                var sGA = "";
                var sFirstGroupName = "";
                var sSecondGroupName = ""; // Fake, because EIS datapoints are unprecise.
                var sDeviceName = "";
                var sEIS = "";
                var sDPT = "";

                for (let index = 1; index < fileGA.length; index++) {
                    var element = fileGA[index];
                    element = element.replace(/\"/g, ""); // Rimuovo evetuali virgolette
                    element = element.replace(/[^\x00-\x7F]/g, ""); // Remove non ascii chars

                    if (element !== "") {

                        sFirstGroupName = element.split("\t")[0].split(".")[0] || "";
                        sSecondGroupName = element.split("\t")[0].split(".")[1] || "";
                        sGA = element.split("\t")[0].split(".")[2] || "";
                        sDeviceName = element.split("\t")[1] || "";
                        sEIS = element.split("\t")[2] || "";
                        // Transform EIS to DPT
                        if (sEIS.toUpperCase().includes("EIS 1")) {
                            sDPT = "1.001";
                        } else if (sEIS.toUpperCase().includes("EIS 2")) {
                            sDPT = "3.007";
                        } else if (sEIS.toUpperCase().includes("EIS 3")) {
                            sDPT = "10.001";
                        } else if (sEIS.toUpperCase().includes("EIS 4")) {
                            sDPT = "11.001";
                        } else if (sEIS.toUpperCase().includes("EIS 5")) {
                            sDPT = "9.001";
                        } else if (sEIS.toUpperCase().includes("EIS 6")) {
                            sDPT = "5.001";
                        } else if (sEIS.toUpperCase().includes("EIS 7")) {
                            sDPT = "1.001";
                        } else if (sEIS.toUpperCase().includes("EIS 8")) {
                            sDPT = "2.001";
                        } else if (sEIS.toUpperCase().includes("EIS 9")) {
                            sDPT = "14.007";
                        } else if (sEIS.toUpperCase().includes("EIS 10")) {
                            sDPT = "7.001";
                        } else if (sEIS.toUpperCase().includes("EIS 11")) {
                            sDPT = "12.001";
                        } else if (sEIS.toUpperCase().includes("EIS 12")) {
                            sDPT = "15.000";
                        } else if (sEIS.toUpperCase().includes("EIS 13")) {
                            sDPT = "4.001";
                        } else if (sEIS.toUpperCase().includes("EIS 14")) {
                            sDPT = "5.001";
                        } else if (sEIS.toUpperCase().includes("EIS 15")) {
                            sDPT = "16.001";
                        } else {
                            sDPT = "5.004"; // Maybe.
                            RED.log.error("knxUltimate: ERROR: Found an UNCERTAIN datapoint in ESF ETS. Please set the datapoint with ETS and export the group addresses again. ->" + sGA + ". An ideal datapoint has been set: " + sDPT)
                            if (node.stopETSImportIfNoDatapoint === "stop") {
                                RED.log.error("knxUltimate: ABORT IMPORT OF ETS ESF FILE. To skip the invalid datapoint and continue import, change the related setting, located in the config node in the ETS import section.");
                                return;
                            }
                        }
                        ajsonOutput.push({ ga: sGA, dpt: sDPT, devicename: "(" + sFirstGroupName + "->" + sSecondGroupName + ") " + sDeviceName });
                    }
                }
            }

            return ajsonOutput;

        }


        // 23/08/2019 Delete unwanted CRLF in the GA description
        function correctCRLFInCSV(_csv) {

            var sOut = ""; // fixed output text to return
            var sChar = "";
            var bStart = false;
            for (let index = 0; index < _csv.length; index++) {
                sChar = _csv.substr(index, 1);
                if (sChar == "\"") {
                    if (!bStart) {
                        bStart = true;
                    } else {
                        bStart = false;
                    }
                    sOut += sChar;

                } else {
                    if (bStart) {
                        // i'm in the phrase, delimited by "". No CRLF should be there
                        if (sChar !== "\n" && sChar !== "\r") {
                            sOut += sChar;
                        } else {
                            sOut += " "; // Where it was a CRLF, i put a space
                        }
                    } else {
                        sOut += sChar;
                    }

                }
            }

            // Replace all parenthesis with []
            sOut = sOut.replace(/\(/g, "[").replace(/\)/g, "]");
            return sOut;
        }

    }



    RED.nodes.registerType("knxUltimate-config", knxUltimateConfigNode);
}