module.exports = function (RED) {
  function AdsOverMqttSymbolLoader(config) {
    RED.nodes.createNode(this, config);
    const node = this;
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
    node.symbolsAvailable = false;

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
      if (result !== 0) {
        pending.callback(new Error(`ADS error ${result}`));
      } else {
        pending.callback(null, data);
      }
    });

    function sendAdsRead(ig, io, length, cb) {
      const adsRead = Buffer.alloc(12);
      adsRead.writeUInt32LE(ig, 0);
      adsRead.writeUInt32LE(io, 4);
      adsRead.writeUInt32LE(length, 8);

      const amsHeader = Buffer.alloc(32);
      amsNetIdToBuffer(node.connection.targetAmsNetId).copy(amsHeader, 0);
      amsHeader.writeUInt16LE(node.connection.port, 6);
      amsNetIdToBuffer(node.connection.amsNetId).copy(amsHeader, 8);
      amsHeader.writeUInt16LE(node.connection.sourcePort, 14);
      amsHeader.writeUInt16LE(0x0002, 16); // CmdID Read
      amsHeader.writeUInt16LE(0x0004, 18);
      amsHeader.writeUInt32LE(adsRead.length, 20);
      amsHeader.writeUInt32LE(0, 24);
      const invokeId = node._invokeId++ & 0xffffffff;
      amsHeader.writeUInt32LE(invokeId, 28);

      const tcpHeader = Buffer.alloc(6);
      tcpHeader.writeUInt16LE(0, 0);
      tcpHeader.writeUInt32LE(amsHeader.length + adsRead.length, 2);

      const frame = Buffer.concat([tcpHeader, amsHeader, adsRead]);

      node.pendingRequests[invokeId] = { callback: cb };
      const reqTopic = `${namespace}/${node.connection.targetAmsNetId}/ams`;
      node.connection.client.publish(reqTopic, frame);
    }

    function parseSymbols(buffer) {
      const symbols = {};
      let offset = 0;
      while (offset < buffer.length) {
        const entryLen = buffer.readUInt32LE(offset);
        const indexGroup = buffer.readUInt32LE(offset + 4);
        const indexOffset = buffer.readUInt32LE(offset + 8);
        const size = buffer.readUInt32LE(offset + 12);
        const dataType = buffer.readUInt32LE(offset + 16);
        // skip flags
        const nameLength = buffer.readUInt16LE(offset + 24);
        const typeLength = buffer.readUInt16LE(offset + 26);
        const commentLength = buffer.readUInt16LE(offset + 28);
        const nameStart = offset + 30;
        const name = buffer
          .slice(nameStart, nameStart + nameLength - 1)
          .toString("utf8");
        symbols[name] = {
          ig: indexGroup,
          io: indexOffset,
          size,
          datatype: dataType,
        };
        offset += entryLen;
      }
      return symbols;
    }

    function loadSymbols() {
      // Step 1: get upload info
      sendAdsRead(0xf00c, 0, 24, (err, info) => {
        if (err || !info || info.length < 24) {
          node.warn("Failed to read symbol upload info");
          return;
        }
        const symSize = info.readUInt32LE(0);
        // Step 2: read symbol table
        sendAdsRead(0xf00b, 0, symSize, (err2, table) => {
          if (err2 || !table) {
            node.warn("Failed to read symbol table");
            return;
          }
          const symbols = parseSymbols(table);
          const globalContext = node.context().global;
          const all = globalContext.get("symbols") || {};
          if (!all[node.connection.id]) all[node.connection.id] = {};
          all[node.connection.id][node.connection.targetAmsNetId] = symbols;
          globalContext.set("symbols", all);
          node.symbolsAvailable = true;
        });
      });
    }

    loadSymbols();

    node.interval = setInterval(() => {
      node.send({
        payload: node.symbolsAvailable
          ? "Symbols available"
          : "Symbols not available",
      });
    }, 5000);

    node.on("close", () => {
      if (node.interval) clearInterval(node.interval);
    });
  }

  RED.nodes.registerType(
    "ads-over-mqtt-symbol-loader",
    AdsOverMqttSymbolLoader
  );
};
