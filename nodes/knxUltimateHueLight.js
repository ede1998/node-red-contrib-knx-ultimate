module.exports = function (RED) {
  const dptlib = require('./../KNXEngine/dptlib')
  const hueColorConverter = require('./utils/hueColorConverter')


  async function getLightState(node, _lightID) {
    return new Promise((resolve, reject) => {
      try {
        if (node !== null && node.serverHue !== null && node.serverHue.hueManager !== null) {
          node.serverHue.hueManager.getLight(_lightID).then(ret => {
            node.currentHUEDevice = ret[0]
            resolve(ret)
          })
        }
      } catch (error) {
        reject(error)
      }
    })
  }

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



    // Read the state of the light and store it in the holding object
    try {
      if (config.hueDevice !== undefined && config.hueDevice !== '') getLightState(node, config.hueDevice)
    } catch (error) {
    }



    // Used to call the status update from the config node.
    node.setNodeStatus = ({ fill, shape, text, payload }) => {

    }

    // This function is called by the knx-ultimate config node, to output a msg.payload.
    node.handleSend = msg => {
      let state = {}
      try {
        switch (msg.knx.destination) {
          case config.GALightSwitch:
            msg.payload = dptlib.fromBuffer(msg.knx.rawValue, dptlib.resolve(config.dptLightSwitch))
            state = msg.payload === true ? { on: { on: true } } : { on: { on: false } }
            node.serverHue.hueManager.setLightState(config.hueDevice, state)
            break
          case config.GALightDIM:
            msg.payload = dptlib.fromBuffer(msg.knx.rawValue, dptlib.resolve(config.dptLightDIM))
            state = msg.payload.decr_incr === 1 ? { dimming_delta: { action: 'up', brightness_delta: 20 } } : { dimming_delta: { action: 'down', brightness_delta: 20 } }
            node.serverHue.hueManager.setLightState(config.hueDevice, state)
            break
          case config.GALightBrightness:
            msg.payload = dptlib.fromBuffer(msg.knx.rawValue, dptlib.resolve(config.dptLightBrightness))
            state = { dimming: { brightness: msg.payload } }
            node.serverHue.hueManager.setLightState(config.hueDevice, state)
            break
          case config.GALightColor:
            // Behavior like ISE HUE CONNECT, by setting the brightness and on/off as well
            msg.payload = dptlib.fromBuffer(msg.knx.rawValue, dptlib.resolve(config.dptLightColor))
            const gamut = node.currentHUEDevice.color.gamut_type || null
            const retXY = hueColorConverter.ColorConverter.rgbToXy(msg.payload.red, msg.payload.green, msg.payload.blue, gamut)
            const bright = hueColorConverter.ColorConverter.getBrightnessFromRGB(msg.payload.red, msg.payload.green, msg.payload.blue)
            bright > 0 ? state = { on: { on: true }, dimming: { brightness: bright }, color: { xy: retXY } } : state = { on: { on: false } }
            node.serverHue.hueManager.setLightState(config.hueDevice, state)
            break
          default:
            break
        }
      } catch (error) {
        node.status({ fill: 'red', shape: 'dot', text: 'KNX->HUE error ' + error.message + ' (' + new Date().getDate() + ', ' + new Date().toLocaleTimeString() + ')' })
      }
    }

    node.handleSendHUE = _event => {
      try {
        if (_event.id === config.hueDevice) {
          let knxMsgPayload = {}
          if (_event.hasOwnProperty('on')) {
            knxMsgPayload.topic = config.GALightState
            knxMsgPayload.dpt = config.dptLightState
            knxMsgPayload.payload = _event.on.on
          }
          if (_event.hasOwnProperty('color')) {
            knxMsgPayload.topic = config.GALightColorState
            knxMsgPayload.dpt = config.dptLightColorState
            knxMsgPayload.payload = hueColorConverter.ColorConverter.xyBriToRgb(_event.color.xy.x, _event.color.xy.y, node.currentHUEDevice.dimming.brightness)
          }
          if (_event.hasOwnProperty('dimming')) {
            knxMsgPayload.topic = config.GALightBrightnessState
            knxMsgPayload.dpt = config.dptLightBrightnessState
            knxMsgPayload.payload = _event.dimming.brightness
          }
          // Send to KNX bus
          if (knxMsgPayload.topic !== '' && knxMsgPayload.topic !== undefined) node.server.writeQueueAdd({ grpaddr: knxMsgPayload.topic, payload: knxMsgPayload.payload, dpt: knxMsgPayload.dpt, outputtype: 'write', nodecallerid: node.id })
          node.status({ fill: 'green', shape: 'dot', text: 'HUE->KNX State ' + JSON.stringify(knxMsgPayload.payload) + ' (' + new Date().getDate() + ', ' + new Date().toLocaleTimeString() + ')' })

        }
      } catch (error) {
        node.status({ fill: 'red', shape: 'dot', text: 'HUE->KNX error ' + error.message + ' (' + new Date().getDate() + ', ' + new Date().toLocaleTimeString() + ')' })
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
  }
  RED.nodes.registerType('knxUltimateHueLight', knxUltimateHueLight)
}
