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

      const frame = Buffer.concat([amsHeader, adsRead]);

      node.pendingRequests[invokeId] = { callback: cb };
      const reqTopic = `${namespace}/${node.connection.targetAmsNetId}/ams`;
      node.send([
        null,
        { payload: frame.toString("hex"), topic: reqTopic },
        { payload: frame, topic: reqTopic },
      ]);
      node.connection.client.publish(reqTopic, frame, { qos: 0, retain: false });
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
      node.symbolsAvailable = false;

      function readSymbols(symSize, datatypeSize) {
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
          if (datatypeSize > 0) {
            sendAdsRead(0xf00e, 0, datatypeSize, () => {});
          }
          node.symbolsAvailable = true;
        });
      }

      // UploadInfo2 (0xF00F) – aktuell deaktiviert, da nicht von allen Targets
      // unterstützt. Kann später wieder aktiviert werden.
      // sendAdsRead(0xf00f, 0, 24, (err, info) => {
      //   if (!err && info && info.length >= 24) {
      //     const symSize = info.readUInt32LE(4);
      //     const datatypeSize = info.readUInt32LE(16);
      //     readSymbols(symSize, datatypeSize);
      //   } else {
      //     sendAdsRead(0xf00c, 0, 24, (err2, info2) => {
      //       if (err2 || !info2 || info2.length < 24) {
      //         node.warn("Failed to read symbol upload info");
      //         return;
      //       }
      //       const symSize = info2.readUInt32LE(0);
      //       readSymbols(symSize, 0);
      //     });
      //   }
      // });

      sendAdsRead(0xf00c, 0, 24, (err, info) => {
        if (err || !info || info.length < 24) {
          node.warn("Failed to read symbol upload info");
          return;
        }
        const symSize = info.readUInt32LE(0);
        readSymbols(symSize, 0);
      });
    }

    node.on("input", () => {
      loadSymbols();
    });

    node.interval = setInterval(() => {
      node.send([
        {
          payload: node.symbolsAvailable
            ? "Symbols available"
            : "Symbols not available",
        },
        null,
        null,
      ]);
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
