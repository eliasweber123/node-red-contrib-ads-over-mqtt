module.exports = function (RED) {
  function AdsOverMqttWriteSymbols(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    node.symbol = config.symbol;
    node.targetAmsNetId = config.targetAmsNetId;
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

    function encodeValue(datatype, size, payload) {
      if (Buffer.isBuffer(payload)) {
        if (payload.length !== size) return null;
        return payload;
      }
      const buf = Buffer.alloc(size);
      if (typeof payload === "number") {
        switch (size) {
          case 1:
            buf.writeUInt8(payload);
            return buf;
          case 2:
            buf.writeUInt16LE(payload);
            return buf;
          case 4:
            buf.writeUInt32LE(payload);
            return buf;
          case 8:
            buf.writeDoubleLE(payload);
            return buf;
          default:
            return null;
        }
      }
      if (typeof payload === "boolean" && size === 1) {
        buf.writeUInt8(payload ? 1 : 0);
        return buf;
      }
      if (typeof payload === "string") {
        const strBuf = Buffer.from(payload, "ascii");
        if (strBuf.length > size) return null;
        strBuf.copy(buf);
        return buf;
      }
      return null;
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
      const targetAms =
        msg.targetAmsNetId || node.targetAmsNetId || node.connection.targetAmsNetId;
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

      const valueBuf = encodeValue(symInfo.datatype, symInfo.size, msg.payload);
      if (!valueBuf) {
        done(new Error("Unsupported payload format"));
        return;
      }

      const reqTopic = `${namespace}/${targetAms}/ams`;

      const adsWrite = Buffer.alloc(12 + valueBuf.length);
      adsWrite.writeUInt32LE(symInfo.ig, 0);
      adsWrite.writeUInt32LE(symInfo.io, 4);
      adsWrite.writeUInt32LE(symInfo.size, 8);
      valueBuf.copy(adsWrite, 12);

      const amsHeader = Buffer.alloc(32);
      amsNetIdToBuffer(targetAms).copy(amsHeader, 0);
      amsHeader.writeUInt16LE(node.connection.port, 6);
      amsNetIdToBuffer(node.connection.amsNetId).copy(amsHeader, 8);
      amsHeader.writeUInt16LE(node.connection.sourcePort, 14);
      amsHeader.writeUInt16LE(0x0003, 16); // CmdID Write
      amsHeader.writeUInt16LE(0x0004, 18);
      amsHeader.writeUInt32LE(adsWrite.length, 20);
      amsHeader.writeUInt32LE(0, 24);
      const invokeId = node._invokeId++ & 0xffffffff;
      amsHeader.writeUInt32LE(invokeId, 28);

      const tcpHeader = Buffer.alloc(6);
      tcpHeader.writeUInt16LE(0, 0);
      tcpHeader.writeUInt32LE(amsHeader.length + adsWrite.length, 2);

      const frame = Buffer.concat([tcpHeader, amsHeader, adsWrite]);
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
    "ads-over-mqtt-write-symbols",
    AdsOverMqttWriteSymbols
  );
};
