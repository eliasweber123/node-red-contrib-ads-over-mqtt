module.exports = function (RED) {
  function AdsOverMqttClientReadSymbols(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    node.symbol = config.symbol;
    node.dateityp = config.dateityp;
    node.stringLength = Number(config.stringLength) || 80;
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

      let value = data;
      if (pending.dateityp) {
        value = decodeData(data, pending.dateityp);
      }

      delete node.pendingRequests[invokeId];
      // send response on first output only
      pending.send([
        { payload: value, symbol: pending.symbol, invokeId, result },
        null,
      ]);
      pending.done();
    });

    node.on("input", (msg, send, done) => {
      const symbol = msg.symbol || node.symbol;
      const dateityp = msg.dateityp || node.dateityp;

      let readLength = Number(msg.readLength) || 0;
      if (dateityp) {
        const type = String(dateityp).toUpperCase();
        const lenMap = {
          BOOL: 1,
          BYTE: 1,
          SINT: 1,
          USINT: 1,
          INT: 2,
          UINT: 2,
          WORD: 2,
          DINT: 4,
          UDINT: 4,
          DWORD: 4,
          REAL: 4,
          LINT: 8,
          ULINT: 8,
          LREAL: 8,
        };
        if (type === "STRING") {
          readLength = node.stringLength;
        } else if (lenMap[type]) {
          readLength = lenMap[type];
        }
      }
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

      const hex = frame.toString('hex');
      node.debug(`Frame: ${hex}`);

      // emit debug information on second output
      send([
        null,
        {
          payload: hex,
          topic: reqTopic,
        },
      ]);

      node.pendingRequests[invokeId] = { symbol, dateityp, send, done };
      node.connection.client.publish(reqTopic, frame);
    });
  }

  RED.nodes.registerType(
    "ads-over-mqtt-client-read-symbols",
    AdsOverMqttClientReadSymbols
  );
};

function decodeData(buf, type) {
  switch (type) {
    case "BOOL":
      return buf[0] !== 0;
    case "BYTE":
    case "USINT":
      return buf.readUInt8(0);
    case "SINT":
      return buf.readInt8(0);
    case "INT":
      return buf.readInt16LE(0);
    case "UINT":
    case "WORD":
      return buf.readUInt16LE(0);
    case "DINT":
      return buf.readInt32LE(0);
    case "UDINT":
    case "DWORD":
      return buf.readUInt32LE(0);
    case "REAL":
      return buf.readFloatLE(0);
    case "LINT":
      return buf.readBigInt64LE(0);
    case "ULINT":
      return buf.readBigUInt64LE(0);
    case "LREAL":
      return buf.readDoubleLE(0);
    case "STRING":
      return buf.toString("ascii").replace(/\0.*$/, "");
    default:
      return buf;
  }
}
