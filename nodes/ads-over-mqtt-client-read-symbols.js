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

    const namespace = node.connection.topic;
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
      pending.send([
        { payload: data, symbol: pending.symbol, invokeId, result },
        null,
        null,
      ]);
      pending.done();
    });

    node.on("input", (msg, send, done) => {
      const symbol = msg.symbol || node.symbol;
      const targetAms = node.connection.targetAmsNetId;
      if (!symbol) {
        done(new Error("No symbol specified"));
        return;
      }
      if (!targetAms) {
        done(new Error("No target AMS Net ID specified"));
        return;
      }

      const globalContext = node.context().global;
      const symbols = globalContext.get("symbols") || {};
      const connSymbols = symbols[node.connection.id] || {};
      const targetSymbols = connSymbols[targetAms] || {};
      const symInfo = targetSymbols[symbol];
      if (!symInfo) {
        done(new Error("Symbol not found in cache"));
        return;
      }

      const reqTopic = `${namespace}/${targetAms}/ams`;

      const adsRead = Buffer.alloc(12);
      adsRead.writeUInt32LE(symInfo.ig, 0);
      adsRead.writeUInt32LE(symInfo.io, 4);
      adsRead.writeUInt32LE(symInfo.size, 8);

      const amsHeader = Buffer.alloc(32);
      amsNetIdToBuffer(targetAms).copy(amsHeader, 0);
      amsHeader.writeUInt16LE(node.connection.port, 6);
      amsNetIdToBuffer(node.connection.amsNetId).copy(amsHeader, 8);
      amsHeader.writeUInt16LE(node.connection.sourcePort, 14);
      amsHeader.writeUInt16LE(0x0002, 16); // CmdID Read
      amsHeader.writeUInt16LE(0x0004, 18); // StateFlags
      amsHeader.writeUInt32LE(adsRead.length, 20);
      amsHeader.writeUInt32LE(0, 24);
      const invokeId = node._invokeId++ & 0xffffffff;
      amsHeader.writeUInt32LE(invokeId, 28);

      const tcpHeader = Buffer.alloc(6);
      tcpHeader.writeUInt16LE(0, 0);
      tcpHeader.writeUInt32LE(amsHeader.length + adsRead.length, 2);

      const frame = Buffer.concat([tcpHeader, amsHeader, adsRead]);
      const hex = frame.toString("hex");

      send([
        null,
        { payload: hex, topic: reqTopic },
        { payload: frame, topic: reqTopic },
      ]);

      node.pendingRequests[invokeId] = { symbol, send, done };
      node.connection.client.publish(reqTopic, frame);
    });
  }

  RED.nodes.registerType(
    "ads-over-mqtt-client-read-symbols",
    AdsOverMqttClientReadSymbols
  );
};
