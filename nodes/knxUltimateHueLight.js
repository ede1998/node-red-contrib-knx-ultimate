module.exports = function (RED) {
  const dptlib = require('./../KNXEngine/dptlib')


  function knxUltimateHueLight(config) {
    RED.nodes.createNode(this, config)
    const node = this
    node.server = RED.nodes.getNode(config.server)
    node.serverHue = RED.nodes.getNode(config.serverHue)
    node.topic = node.name
    node.name = config.name === undefined ? 'Hue' : config.name
    node.outputtopic = node.name
    node.dpt = ''
    node.notifyreadrequest = false
    node.notifyreadrequestalsorespondtobus = 'false'
    node.notifyreadrequestalsorespondtobusdefaultvalueifnotinitialized = ''
    node.notifyresponse = false
    node.notifywrite = true
    node.initialread = true
    node.listenallga = true // Don't remove
    node.outputtype = 'write'
    node.outputRBE = false // Apply or not RBE to the output (Messages coming from flow)
    node.inputRBE = false // Apply or not RBE to the input (Messages coming from BUS)
    node.currentPayload = '' // Current value for the RBE input and for the .previouspayload msg
    node.passthrough = 'no'
    node.formatmultiplyvalue = 1
    node.formatnegativevalue = 'leave'
    node.formatdecimalsvalue = 2

    // Used to call the status update from the config node.
    node.setNodeStatus = ({ fill, shape, text, payload }) => {

    }

    // This function is called by the knx-ultimate config node, to output a msg.payload.
    node.handleSend = msg => {
      let state
      try {
        switch (msg.knx.destination) {
          case config.GALightSwitch:
            msg.payload = dptlib.fromBuffer(msg.knx.rawValue, dptlib.resolve(config.dptLightSwitch))
            state = msg.payload === true ? { on: { on: true } } : { on: { on: false } }
            node.serverHue.setLightState(config.hueLight.split('#')[1], state)
            break
          case config.GALightDIM:
            msg.payload = dptlib.fromBuffer(msg.knx.rawValue, dptlib.resolve(config.dptLightDIM))
            state = msg.payload.decr_incr === 1 ? { dimming_delta: { action: 'up', brightness_delta: 20 } } : { dimming_delta: { action: 'down', brightness_delta: 20 } }
            node.serverHue.setLightState(config.hueLight.split('#')[1], state)
            break
          default:
            break
        }
      } catch (error) {

      }
      //node.exposedGAs.push({ address: msg.knx.destination, addressRAW: sAddressRAW, dpt: msg.knx.dpt, payload: msg.payload, devicename: sDeviceName, lastupdate: new Date(), rawPayload: 'HEX Raw: ' + msg.knx.rawValue.toString('hex') || '?', payloadmeasureunit: (msg.payloadmeasureunit !== 'unknown' ? ' ' + msg.payloadmeasureunit : '') })
    }


    node.handleSendHUE = _event => {
      if (_event.id === config.hueLight.split('#')[1]) {
        let knxMsgPayload = undefined
        if (_event.hasOwnProperty('on')) knxMsgPayload = _event.on.on
        // Send to KNX bus
        if (knxMsgPayload !== undefined) {
          node.status({ fill: 'green', shape: 'dot', text: 'HUE Status ' + knxMsgPayload + ' (' + new Date().getDate() + ', ' + new Date().toLocaleTimeString() + ')' })
          if (config.GALightState !== '') node.server.writeQueueAdd({ grpaddr: config.GALightState, payload: knxMsgPayload, dpt: config.dptLightState, outputtype: 'write', nodecallerid: node.id })
        }
      }
    }

    // On each deploy, unsubscribe+resubscribe
    if (node.server) {
      node.server.removeClient(node)
      node.server.addClient(node)
    }
    if (node.serverHue) {
      node.serverHue.removeClient(node)
      node.serverHue.addClient(node)
    }

    node.on('input', function (msg) {

    })

    node.on('close', function (done) {
      if (node.server) {
        node.server.removeClient(node)
      }
      done()
    })

    // On each deploy, unsubscribe+resubscribe
    if (node.server) {
      node.server.removeClient(node)
      node.server.addClient(node)
    }
  }
  RED.nodes.registerType('knxUltimateHueLight', knxUltimateHueLight)
}
