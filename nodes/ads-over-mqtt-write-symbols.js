module.exports = function (RED) {
  function AdsOverMqttWriteSymbols(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    node.symbol = config.symbol;
    node.connection = RED.nodes.getNode(config.connection);

    if (!node.connection || !node.connection.client) {
      node.error("No ADS connection configured");
      return;
    }

    const networkName = "VirtualAmsNetwork1";
    const reqTopic = `${networkName}/${node.connection.targetAmsNetId}/ams`;
    const resTopic = `${networkName}/${node.connection.targetAmsNetId}/ams/res`;
    const oldResTopic = `${node.connection.clientId}/${node.connection.targetAmsNetId}/ams/res`;

    if (!node.connection._subscribedRes) {
      node.connection.client.subscribe(resTopic);
      if (oldResTopic !== resTopic) {
        node.connection.client.subscribe(oldResTopic);
      }
      node.connection._subscribedRes = true;
    }

    node.pendingRequests = {};
    node._invokeId = 1;

    function amsNetIdToBuffer(id) {
      return Buffer.from(id.split('.').map((n) => parseInt(n, 10)));
    }

    function decodePayload(payload) {
      if (Buffer.isBuffer(payload)) return payload;
      if (
        payload &&
        payload.type === "ams" &&
        payload.encoding === "base64" &&
        typeof payload.data === "string"
      ) {
        try {
          return Buffer.from(payload.data, "base64");
        } catch (_) {
          return null;
        }
      }
      return null;
    }

    node.connection.client.on("message", (topic, message) => {
      if (topic !== resTopic && topic !== oldResTopic) return;
      if (topic === oldResTopic) {
        node.warn(`Received message on deprecated topic ${topic}`);
      }
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
      if (!symbol) {
        done(new Error("No symbol specified"));
        return;
      }

      const valueBuf = decodePayload(msg.payload);
      if (!valueBuf) {
        const err = new Error("Unsupported payload format");
        node.error(err, msg);
        done(err);
        return;
      }

      const symbolBuf = Buffer.from(symbol + "\0", "ascii");
      const writeBuf = Buffer.concat([symbolBuf, valueBuf]);
      const adsRw = Buffer.alloc(16 + writeBuf.length);
      adsRw.writeUInt32LE(0xF003, 0); // IndexGroup
      adsRw.writeUInt32LE(0, 4); // IndexOffset
      adsRw.writeUInt32LE(0, 8); // readLength
      adsRw.writeUInt32LE(writeBuf.length, 12); // writeLength
      writeBuf.copy(adsRw, 16);

      const amsHeader = Buffer.alloc(32);
      amsNetIdToBuffer(node.connection.targetAmsNetId).copy(amsHeader, 0);
      amsHeader.writeUInt16LE(node.connection.port, 6);
      amsNetIdToBuffer(node.connection.amsNetId).copy(amsHeader, 8);
      amsHeader.writeUInt16LE(node.connection.port, 14);
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

      node.pendingRequests[invokeId] = { symbol, send, done };
      node.connection.client.publish(reqTopic, frame);
    });
  }

  RED.nodes.registerType("ads-over-mqtt-write-symbols", AdsOverMqttWriteSymbols);
};
