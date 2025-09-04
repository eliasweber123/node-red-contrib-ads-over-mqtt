module.exports = function (RED) {
  function AdsOverMqttWriteSymbols(config) {
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

    function encodeValue(typeName, size, payload) {
      if (Buffer.isBuffer(payload)) {
        return payload.length === size ? payload : null;
      }
      const buf = Buffer.alloc(size);
      switch (typeName) {
        case "BOOL":
          if (typeof payload === "boolean" || typeof payload === "number") {
            buf.writeUInt8(payload ? 1 : 0);
            return buf;
          }
          return null;
        case "BYTE":
          if (typeof payload === "number") {
            buf.writeUInt8(payload);
            return buf;
          }
          return null;
        case "WORD":
          if (typeof payload === "number") {
            buf.writeUInt16LE(payload);
            return buf;
          }
          return null;
        case "DWORD":
          if (typeof payload === "number") {
            buf.writeUInt32LE(payload);
            return buf;
          }
          return null;
        case "REAL":
          if (typeof payload === "number") {
            buf.writeFloatLE(payload);
            return buf;
          }
          return null;
        case "STRING":
          if (typeof payload === "string") {
            const strBuf = Buffer.from(payload, "utf8");
            if (strBuf.length >= size) {
              strBuf.slice(0, size - 1).copy(buf);
              buf[size - 1] = 0;
            } else {
              strBuf.copy(buf);
              buf[strBuf.length] = 0;
            }
            return buf;
          }
          return null;
        default:
          if (typeof payload === "number") {
            if (size === 1) {
              buf.writeUInt8(payload);
              return buf;
            }
            if (size === 2) {
              buf.writeUInt16LE(payload);
              return buf;
            }
            if (size === 4) {
              buf.writeUInt32LE(payload);
              return buf;
            }
            if (size === 8) {
              buf.writeDoubleLE(payload);
              return buf;
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

      const valueBuf = encodeValue(typeName, size, msg.payload);
      if (!valueBuf) {
        done(new Error("Unsupported payload format"));
        return;
      }

      const reqTopic = `${namespace}/${targetAms}/ams`;

      const adsWrite = Buffer.alloc(12 + valueBuf.length);
      adsWrite.writeUInt32LE(ig, 0);
      adsWrite.writeUInt32LE(io, 4);
      adsWrite.writeUInt32LE(size, 8);
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

      const frame = Buffer.concat([amsHeader, adsWrite]);
      const hex = frame.toString("hex");

      send([
        null,
        { payload: hex, topic: reqTopic },
        { payload: frame, topic: reqTopic },
      ]);

      node.pendingRequests[invokeId] = { symbol, send, done };
      node.connection.client.publish(reqTopic, frame, {
        qos: 0,
        retain: false,
      });
    });
  }

  RED.nodes.registerType(
    "ads-over-mqtt-write-symbols",
    AdsOverMqttWriteSymbols
  );
};
