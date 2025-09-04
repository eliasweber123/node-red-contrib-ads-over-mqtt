module.exports = function (RED) {
  function AdsOverMqttClientReadSymbols(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    node.symbol = config.symbol;
    node.ig =
      config.ig !== undefined && config.ig !== "" ? parseInt(config.ig, 10) : undefined;
    node.io =
      config.io !== undefined && config.io !== "" ? parseInt(config.io, 10) : undefined;
    node.size =
      config.size !== undefined && config.size !== "" ? parseInt(config.size, 10) : undefined;
    node.typeName = config.typeName;
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

    function decodeValue(typeName, size, buffer) {
      if (!Buffer.isBuffer(buffer)) return buffer;
      switch (typeName) {
        case "BOOL":
          return buffer.readUInt8(0) !== 0;
        case "BYTE":
          return buffer.readUInt8(0);
        case "WORD":
          return buffer.readUInt16LE(0);
        case "DWORD":
          return buffer.readUInt32LE(0);
        case "REAL":
          return buffer.readFloatLE(0);
        case "STRING": {
          let end = buffer.indexOf(0);
          if (end === -1 || end > size) end = size;
          return buffer.slice(0, end).toString("utf8");
        }
        default:
          return buffer;
      }
    }

    node.connection.client.on("message", (topic, message) => {
      if (topic !== resTopic) return;
      if (!Buffer.isBuffer(message) || message.length < 40) {
        node.error("Invalid AMS response frame");
        return;
      }
      const invokeId = message.readUInt32LE(28);
      const pending = node.pendingRequests[invokeId];
      if (!pending) return;

      const result = message.readUInt32LE(32);
      const len = message.readUInt32LE(36);
      const data = message.slice(40, 40 + len);

      delete node.pendingRequests[invokeId];
      const value = decodeValue(pending.typeName, pending.size || len, data);
      pending.send([
        { payload: value, symbol: pending.symbol, invokeId, result },
        null,
        null,
      ]);
      pending.done();
    });

    node.on("input", (msg, send, done) => {
      const symbol = msg.symbol || node.symbol;
      const targetAms = node.connection.targetAmsNetId;
      if (!targetAms) {
        done(new Error("No target AMS Net ID specified"));
        return;
      }

      let ig = node.ig;
      let io = node.io;
      let size = node.size;
      let typeName = node.typeName;

      if (ig === undefined || io === undefined || size === undefined || !typeName) {
        if (!symbol) {
          done(new Error("No symbol specified"));
          return;
        }
        const flowContext = node.context().flow;
        const symbols = flowContext.get("symbols") || {};
        const key = `${namespace}/${targetAms}`;
        const symArray = symbols[key] || [];
        const symInfo = symArray.find((s) => s.name === symbol);
        if (!symInfo) {
          done(new Error("Symbol not found in cache"));
          return;
        }
        if (ig === undefined) ig = symInfo.indexGroup;
        if (io === undefined) io = symInfo.indexOffset;
        if (size === undefined) size = symInfo.size;
        if (!typeName) typeName = symInfo.typeName;
      }

      if (ig === undefined || io === undefined || size === undefined || !typeName) {
        done(new Error("Index Group, Offset, Size or Type missing"));
        return;
      }

      const reqTopic = `${namespace}/${targetAms}/ams`;

      const adsRead = Buffer.alloc(12);
      adsRead.writeUInt32LE(ig, 0);
      adsRead.writeUInt32LE(io, 4);
      adsRead.writeUInt32LE(size, 8);

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

      const frame = Buffer.concat([amsHeader, adsRead]);
      const hex = frame.toString("hex");

      send([
        null,
        { payload: hex, topic: reqTopic },
        { payload: frame, topic: reqTopic },
      ]);

      node.pendingRequests[invokeId] = { symbol, send, done, size, typeName };
      node.connection.client.publish(reqTopic, frame, {
        qos: 0,
        retain: false,
      });
    });
  }

  RED.nodes.registerType(
    "ads-over-mqtt-client-read-symbols",
    AdsOverMqttClientReadSymbols
  );
};
