module.exports = function (RED) {
  function AdsOverMqttClientReadSymbols(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    node.symbol = config.symbol;
    node.connection = RED.nodes.getNode(config.connection);

    if (!node.connection || !node.connection.client) {
      node.error("No ADS connection configured");
      return;
    }

    // Use the connection's clientId as MQTT namespace
    const namespace = node.connection.clientId;
    const reqTopic = `${namespace}/${node.connection.targetAmsNetId}/ams`;
    const resTopic = `${namespace}/${node.connection.amsNetId}/ams/res`;

    if (!node.connection._subscribedRes) {
      node.connection.client.subscribe(resTopic);
      node.connection._subscribedRes = true;
    }

    node.pendingRequests = {};
    node._invokeId = 1;

    function amsNetIdToBuffer(id) {
      return Buffer.from(id.split('.').map((n) => parseInt(n, 10)));
    }

    node.connection.client.on("message", (topic, message) => {
      if (topic !== resTopic) return;
      if (!Buffer.isBuffer(message) || message.length < 46) {
        node.error("Invalid AMS response frame");
        return;
      }
      const invokeId = message.readUInt32LE(34);
      const pending = node.pendingRequests[invokeId];
      if (!pending) return;

      const result = message.readUInt32LE(38);
      const len = message.readUInt32LE(42);
      const data = message.slice(46, 46 + len);

      delete node.pendingRequests[invokeId];
      pending.send({ payload: data, symbol: pending.symbol, invokeId, result });
      pending.done();
    });

    node.on("input", (msg, send, done) => {
      const symbol = msg.symbol || node.symbol;
      const readLength = Number(msg.readLength) || 0;
      if (!symbol) {
        done(new Error("No symbol specified"));
        return;
      }

      const symbolBuf = Buffer.from(symbol + "\0", "ascii");
      // ADS ReadWrite request: read value of symbol by name
      const adsRw = Buffer.alloc(16 + symbolBuf.length);
      adsRw.writeUInt32LE(0xF004, 0); // IndexGroup: ADSIGRP_SYM_VALBYNAME
      adsRw.writeUInt32LE(0, 4); // IndexOffset
      adsRw.writeUInt32LE(readLength, 8); // number of bytes to read
      adsRw.writeUInt32LE(symbolBuf.length, 12); // length of symbol name
      symbolBuf.copy(adsRw, 16); // null-terminated symbol name

      const amsHeader = Buffer.alloc(32);
      amsNetIdToBuffer(node.connection.targetAmsNetId).copy(amsHeader, 0);
      amsHeader.writeUInt16LE(node.connection.port, 6);
      amsNetIdToBuffer(node.connection.amsNetId).copy(amsHeader, 8);
      amsHeader.writeUInt16LE(node.connection.sourcePort, 14);
      amsHeader.writeUInt16LE(0x0009, 16); // CmdID ReadWrite
      amsHeader.writeUInt16LE(0x0004, 18); // StateFlags: ADS command
      amsHeader.writeUInt32LE(adsRw.length, 20);
      amsHeader.writeUInt32LE(0, 24); // ErrorCode
      const invokeId = node._invokeId++ & 0xffffffff;
      amsHeader.writeUInt32LE(invokeId, 28);

      const tcpHeader = Buffer.alloc(6);
      tcpHeader.writeUInt16LE(0, 0);
      tcpHeader.writeUInt32LE(amsHeader.length + adsRw.length, 2);

      const frame = Buffer.concat([tcpHeader, amsHeader, adsRw]);

      node.debug(`Frame: ${frame.toString('hex')}`);

      node.pendingRequests[invokeId] = { symbol, send, done };
      node.connection.client.publish(reqTopic, frame);
    });
  }

  RED.nodes.registerType(
    "ads-over-mqtt-client-read-symbols",
    AdsOverMqttClientReadSymbols
  );
};
